import { spawn } from 'child_process'
import express, { type Request, type Response } from 'express'
import rateLimit from 'express-rate-limit'
import fs from 'fs'
import path from 'path'

const PORT = Number(process.env.PORT || 8080)
const PLANETILER_JAR =
  process.env.PLANETILER_JAR || path.join(__dirname, 'planetiler.jar')
const JAVA_XMX = process.env.JAVA_XMX || '4G'
const INPUT_FILE = process.env.INPUT_FILE || '/data/input/input.osm.pbf'
const OUTPUT_DIR = process.env.OUTPUT_DIR || '/data/output'
const PLANETILER_DOWNLOAD_DIR =
  process.env.PLANETILER_DOWNLOAD_DIR || '/data/sources'
const GENERATE_RATE_LIMIT_MS = Number(
  process.env.GENERATE_RATE_LIMIT_MS || 10000
)
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 5)
const PLANETILER_MAX_ZOOM = 16
const PLANETILER_AUTO_DOWNLOAD_AUX =
  process.env.PLANETILER_AUTO_DOWNLOAD_AUX !== 'false'
const MAIN_OSM_URL =
  process.env.MAIN_OSM_URL ||
  'https://download.geofabrik.de/europe/germany/baden-wuerttemberg-latest.osm.pbf'

fs.mkdirSync(OUTPUT_DIR, { recursive: true })
fs.mkdirSync(path.dirname(INPUT_FILE), { recursive: true })
fs.mkdirSync(PLANETILER_DOWNLOAD_DIR, { recursive: true })

const app = express()
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))
app.use('/output', express.static(OUTPUT_DIR))
app.set('trust proxy', 1)

const clients = new Set<Response>()
let currentProcess: ReturnType<typeof spawn> | null = null
let generationInProgress = false
let downloadInProgress = false

const actionRateLimiter = rateLimit({
  windowMs: GENERATE_RATE_LIMIT_MS,
  limit: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please wait before retrying' }
})

function parseAndValidateExtraArgs(extraArgsInput: unknown): {
  args: string[]
  error?: string
} {
  if (extraArgsInput == null || extraArgsInput === '') {
    return { args: [] }
  }
  if (typeof extraArgsInput !== 'string') {
    return { args: [], error: 'extraArgs must be a string' }
  }

  const entries = extraArgsInput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  if (entries.length > 100) {
    return { args: [], error: 'Too many extra args (max 100 lines)' }
  }

  const protectedArgKeys = new Set([
    '--osm_path',
    '--output',
    '--bounds',
    '--download_dir',
    '--minzoom',
    '--maxzoom'
  ])

  for (const entry of entries) {
    if (entry.length > 200) {
      return { args: [], error: `Argument too long: ${entry.slice(0, 40)}...` }
    }
    if (!entry.startsWith('--')) {
      return { args: [], error: `Invalid argument format: ${entry}` }
    }
    const keyPart = entry.includes('=')
      ? entry.slice(0, entry.indexOf('='))
      : entry
    if (/\s/.test(keyPart)) {
      return { args: [], error: `Invalid argument key: ${entry}` }
    }
    if (protectedArgKeys.has(keyPart)) {
      return {
        args: [],
        error: `Overriding protected argument is not allowed: ${entry}`
      }
    }
  }

  return { args: entries }
}

function hasArg(args: string[], key: string): boolean {
  return args.some((arg) => arg === key || arg.startsWith(`${key}=`))
}

async function downloadToFile(
  stream: ReadableStream<Uint8Array>,
  destination: string
): Promise<void> {
  const reader = stream.getReader()
  const fileStream = fs.createWriteStream(destination)

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      if (!value) {
        continue
      }
      if (!fileStream.write(Buffer.from(value))) {
        await new Promise<void>((resolve, reject) => {
          fileStream.once('drain', resolve)
          fileStream.once('error', reject)
        })
      }
    }
  } finally {
    reader.releaseLock()
  }

  await new Promise<void>((resolve, reject) => {
    fileStream.end(() => resolve())
    fileStream.once('error', reject)
  })
}

function broadcast(payload: unknown): void {
  const message = `data: ${JSON.stringify(payload)}\n\n`
  for (const client of clients) {
    client.write(message)
  }
}

app.get('/events', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  clients.add(res)
  res.write(
    `data: ${JSON.stringify({ type: 'status', message: 'connected' })}\n\n`
  )

  const keepAlive = setInterval(() => {
    res.write(`data: ${JSON.stringify({ type: 'ping', ts: Date.now() })}\n\n`)
  }, 25000)

  req.on('close', () => {
    clearInterval(keepAlive)
    clients.delete(res)
  })
})

app.post('/generate', actionRateLimiter, (req: Request, res: Response) => {
  if (generationInProgress) {
    return res
      .status(409)
      .json({ error: 'A generation process is already running' })
  }
  if (!fs.existsSync(INPUT_FILE)) {
    return res
      .status(400)
      .json({ error: 'Input file is missing. Download it first.' })
  }

  const minX = Number(req.body?.minX)
  const minY = Number(req.body?.minY)
  const maxX = Number(req.body?.maxX)
  const maxY = Number(req.body?.maxY)
  const minZoomRaw = req.body?.minZoom
  const maxZoomRaw = req.body?.maxZoom

  if (
    ![minX, minY, maxX, maxY].every(Number.isFinite) ||
    minX >= maxX ||
    minY >= maxY
  ) {
    return res.status(400).json({ error: 'Invalid bbox coordinates' })
  }
  const minZoom =
    minZoomRaw === '' || minZoomRaw == null ? undefined : Number(minZoomRaw)
  const maxZoom =
    maxZoomRaw === '' || maxZoomRaw == null ? undefined : Number(maxZoomRaw)
  if (
    minZoom !== undefined &&
    (!Number.isInteger(minZoom) || minZoom < 0 || minZoom > PLANETILER_MAX_ZOOM)
  ) {
    return res.status(400).json({
      error: `minZoom must be an integer between 0 and ${PLANETILER_MAX_ZOOM}`
    })
  }
  if (
    maxZoom !== undefined &&
    (!Number.isInteger(maxZoom) || maxZoom < 0 || maxZoom > PLANETILER_MAX_ZOOM)
  ) {
    return res.status(400).json({
      error: `maxZoom must be an integer between 0 and ${PLANETILER_MAX_ZOOM}`
    })
  }
  if (minZoom !== undefined && maxZoom !== undefined && minZoom > maxZoom) {
    return res
      .status(400)
      .json({ error: 'minZoom must not be greater than maxZoom' })
  }

  const parsedExtraArgs = parseAndValidateExtraArgs(req.body?.extraArgs)
  if (parsedExtraArgs.error) {
    return res.status(400).json({ error: parsedExtraArgs.error })
  }

  const bbox = `${minX},${minY},${maxX},${maxY}`
  const timestamp = Math.floor(Date.now() / 1000)
  const filename = `export_${timestamp}.pmtiles`
  const outputFile = path.join(OUTPUT_DIR, filename)

  generationInProgress = true

  const args = [
    `-Xmx${JAVA_XMX}`,
    '-jar',
    PLANETILER_JAR,
    `--osm_path=${INPUT_FILE}`,
    `--output=${outputFile}`,
    `--download_dir=${PLANETILER_DOWNLOAD_DIR}`,
    `--bounds=${bbox}`,
    `--nodata`,
    `--building=true`,
    `--boundary=true`,
    `--water=true`,
    `--transportation=true`
  ]
  if (minZoom !== undefined) {
    args.push(`--minzoom=${minZoom}`)
  }
  if (maxZoom !== undefined) {
    args.push(`--maxzoom=${maxZoom}`)
  }
  if (
    PLANETILER_AUTO_DOWNLOAD_AUX &&
    !hasArg(parsedExtraArgs.args, '--download') &&
    !hasArg(parsedExtraArgs.args, '--only-download')
  ) {
    // OpenMapTiles profile requires additional source files (e.g. lake centerlines).
    args.push('--download')
  }
  args.push(...parsedExtraArgs.args)

  let child: ReturnType<typeof spawn>
  try {
    child = spawn('java', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    generationInProgress = false
    return res.status(500).json({ error: (error as Error).message })
  }
  if (!child.stdout || !child.stderr) {
    generationInProgress = false
    return res
      .status(500)
      .json({ error: 'Failed to capture Planetiler process streams' })
  }
  currentProcess = child

  broadcast({ type: 'status', message: 'generation_started', filename })
  broadcast({
    type: 'log',
    stream: 'system',
    line: `Started: java ${args.join(' ')}`
  })

  child.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) {
        broadcast({ type: 'log', stream: 'stdout', line })
      }
    }
  })

  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) {
        broadcast({ type: 'log', stream: 'stderr', line })
      }
    }
  })

  child.on('error', (error: Error) => {
    broadcast({ type: 'error', message: error.message })
    currentProcess = null
    generationInProgress = false
  })

  child.on('close', (code: number | null) => {
    if (code === 0) {
      broadcast({
        type: 'done',
        message: 'generation_finished',
        filename,
        downloadUrl: `/output/${filename}`
      })
    } else {
      broadcast({
        type: 'error',
        message: `Planetiler exited with code ${code}`
      })
    }
    currentProcess = null
    generationInProgress = false
  })

  return res.status(202).json({
    started: true,
    filename,
    bbox,
    args: [
      ...(minZoom !== undefined ? [`--minzoom=${minZoom}`] : []),
      ...(maxZoom !== undefined ? [`--maxzoom=${maxZoom}`] : []),
      ...(PLANETILER_AUTO_DOWNLOAD_AUX &&
      !hasArg(parsedExtraArgs.args, '--download') &&
      !hasArg(parsedExtraArgs.args, '--only-download')
        ? ['--download']
        : []),
      ...parsedExtraArgs.args
    ]
  })
})

app.get('/input-status', actionRateLimiter, (_req: Request, res: Response) => {
  if (!fs.existsSync(INPUT_FILE)) {
    return res.json({
      exists: false,
      downloading: downloadInProgress,
      inputFile: INPUT_FILE,
      sourceUrl: MAIN_OSM_URL
    })
  }
  const stats = fs.statSync(INPUT_FILE)
  return res.json({
    exists: true,
    downloading: downloadInProgress,
    inputFile: INPUT_FILE,
    sourceUrl: MAIN_OSM_URL,
    sizeBytes: stats.size
  })
})

app.post(
  '/download-main-osm',
  actionRateLimiter,
  (_req: Request, res: Response) => {
    if (downloadInProgress) {
      return res
        .status(409)
        .json({ error: 'Input download already in progress' })
    }

    downloadInProgress = true
    const tempInputFile = `${INPUT_FILE}.part`
    broadcast({ type: 'status', message: 'input_download_started' })
    broadcast({
      type: 'log',
      stream: 'system',
      line: `Downloading input from ${MAIN_OSM_URL}`
    })

    const downloadTask = async () => {
      try {
        const response = await fetch(MAIN_OSM_URL)
        if (!response.ok || !response.body) {
          throw new Error(`Download failed with status ${response.status}`)
        }
        await downloadToFile(response.body, tempInputFile)
        fs.renameSync(tempInputFile, INPUT_FILE)
        const stats = fs.statSync(INPUT_FILE)
        broadcast({ type: 'status', message: 'input_download_finished' })
        broadcast({
          type: 'log',
          stream: 'system',
          line: `Input ready at ${INPUT_FILE} (${stats.size} bytes)`
        })
      } catch (error) {
        fs.rmSync(tempInputFile, { force: true })
        broadcast({
          type: 'error',
          message: `Input download failed: ${(error as Error).message}`
        })
      } finally {
        downloadInProgress = false
      }
    }
    downloadTask()

    return res
      .status(202)
      .json({ started: true, sourceUrl: MAIN_OSM_URL, inputFile: INPUT_FILE })
  }
)

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Planetiler GUI backend listening on http://localhost:${PORT}`)
})
