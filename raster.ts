import { spawn, type ChildProcess } from 'child_process'
import { createHash } from 'crypto'
import fs from 'fs'
import { gzipSync } from 'zlib'

// Entry point of tileserver-gl inside the maptiler/tileserver-gl base image.
const TILESERVER_ENTRY = process.env.TILESERVER_ENTRY || '/usr/src/app/'
const TILESERVER_PORT = Number(process.env.TILESERVER_PORT || 8091)
// OpenMapTiles-schema style bundled with tileserver-gl; it matches Planetiler's default profile.
const STYLE_ID = 'basic-preview'
const RENDER_CONCURRENCY = 6
// All rendered tiles are held in memory until the archive is written.
export const RASTER_MAX_TILES = 20000
export const RASTER_MAX_ZOOM = 19
// CC-BY 4.0 (OpenMapTiles style) and ODbL (OSM data) both require this credit on the map.
const ATTRIBUTION =
  '<a href="https://www.openmaptiles.org/" target="_blank">&copy; OpenMapTiles</a> ' +
  '<a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>'

const HEADER_BYTES = 127
// The PMTiles spec requires header and root directory within the first 16 KiB.
const ROOT_DIRECTORY_LIMIT = 16384 - HEADER_BYTES

export type RasterFormat = 'png' | 'webp'

export interface Bbox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

interface TileRange {
  z: number
  minX: number
  maxX: number
  minY: number
  maxY: number
}

interface Entry {
  tileId: number
  offset: number
  length: number
  runLength: number
}

export function isRasterRendererAvailable(): boolean {
  return fs.existsSync(TILESERVER_ENTRY)
}

function lonToTileX(lon: number, z: number): number {
  const x = Math.floor(((lon + 180) / 360) * 2 ** z)
  return Math.min(2 ** z - 1, Math.max(0, x))
}

function latToTileY(lat: number, z: number): number {
  const rad = (lat * Math.PI) / 180
  const y = Math.floor(((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * 2 ** z)
  return Math.min(2 ** z - 1, Math.max(0, y))
}

function tileRanges(bbox: Bbox, minZoom: number, maxZoom: number): TileRange[] {
  const ranges: TileRange[] = []
  for (let z = minZoom; z <= maxZoom; z++) {
    ranges.push({
      z,
      minX: lonToTileX(bbox.minX, z),
      maxX: lonToTileX(bbox.maxX, z),
      // Tile rows count from the north.
      minY: latToTileY(bbox.maxY, z),
      maxY: latToTileY(bbox.minY, z)
    })
  }
  return ranges
}

export function countRasterTiles(
  bbox: Bbox,
  minZoom: number,
  maxZoom: number
): number {
  return tileRanges(bbox, minZoom, maxZoom).reduce(
    (sum, r) => sum + (r.maxX - r.minX + 1) * (r.maxY - r.minY + 1),
    0
  )
}

// PMTiles v3 tile id: all tiles of lower zooms first, then the Hilbert index within z.
export function zxyToTileId(z: number, x: number, y: number): number {
  const n = 2 ** z
  let tx = x
  let ty = y
  let d = 0
  for (let s = n / 2; s >= 1; s /= 2) {
    const rx = (tx & s) > 0 ? 1 : 0
    const ry = (ty & s) > 0 ? 1 : 0
    d += s * s * ((3 * rx) ^ ry)
    if (ry === 0) {
      if (rx === 1) {
        tx = n - 1 - tx
        ty = n - 1 - ty
      }
      ;[tx, ty] = [ty, tx]
    }
  }
  return (4 ** z - 1) / 3 + d
}

function writeVarint(bytes: number[], value: number): void {
  let rest = value
  while (rest >= 0x80) {
    bytes.push((rest % 0x80) | 0x80)
    rest = Math.floor(rest / 0x80)
  }
  bytes.push(rest)
}

function serializeDirectory(entries: Entry[]): Buffer {
  const bytes: number[] = []
  writeVarint(bytes, entries.length)
  let lastId = 0
  for (const entry of entries) {
    writeVarint(bytes, entry.tileId - lastId)
    lastId = entry.tileId
  }
  for (const entry of entries) writeVarint(bytes, entry.runLength)
  for (const entry of entries) writeVarint(bytes, entry.length)
  entries.forEach((entry, i) => {
    const previous = entries[i - 1]
    const contiguous =
      previous !== undefined && entry.offset === previous.offset + previous.length
    writeVarint(bytes, contiguous ? 0 : entry.offset + 1)
  })
  return gzipSync(Buffer.from(bytes))
}

function buildDirectories(entries: Entry[]): { root: Buffer; leaves: Buffer } {
  const root = serializeDirectory(entries)
  if (root.length <= ROOT_DIRECTORY_LIMIT) {
    return { root, leaves: Buffer.alloc(0) }
  }
  for (let leafSize = 4096; ; leafSize *= 2) {
    const rootEntries: Entry[] = []
    const leaves: Buffer[] = []
    let offset = 0
    for (let i = 0; i < entries.length; i += leafSize) {
      const chunk = entries.slice(i, i + leafSize)
      const leaf = serializeDirectory(chunk)
      // runLength 0 marks a pointer to a leaf directory.
      rootEntries.push({ tileId: chunk[0].tileId, offset, length: leaf.length, runLength: 0 })
      leaves.push(leaf)
      offset += leaf.length
    }
    const leafRoot = serializeDirectory(rootEntries)
    if (leafRoot.length <= ROOT_DIRECTORY_LIMIT) {
      return { root: leafRoot, leaves: Buffer.concat(leaves) }
    }
  }
}

export function writeRasterPmtiles(
  file: string,
  tiles: Map<number, Buffer>,
  info: { format: RasterFormat; minZoom: number; maxZoom: number; bbox: Bbox }
): void {
  const tileIds = [...tiles.keys()].sort((a, b) => a - b)
  const entries: Entry[] = []
  const contents: Buffer[] = []
  const offsetByHash = new Map<string, number>()
  let dataLength = 0

  // Tile data in tile-id order is what makes the archive clustered.
  for (const tileId of tileIds) {
    const data = tiles.get(tileId) as Buffer
    const hash = createHash('sha1').update(data).digest('hex')
    let offset = offsetByHash.get(hash)
    if (offset === undefined) {
      offset = dataLength
      offsetByHash.set(hash, offset)
      contents.push(data)
      dataLength += data.length
    }
    const last = entries[entries.length - 1]
    if (last && last.offset === offset && last.tileId + last.runLength === tileId) {
      last.runLength++
    } else {
      entries.push({ tileId, offset, length: data.length, runLength: 1 })
    }
  }

  const { root, leaves } = buildDirectories(entries)
  const metadata = gzipSync(
    Buffer.from(
      JSON.stringify({
        name: 'planetiler-web raster',
        format: info.format,
        type: 'baselayer',
        attribution: ATTRIBUTION
      })
    )
  )

  const metadataOffset = HEADER_BYTES + root.length
  const leavesOffset = metadataOffset + metadata.length
  const dataOffset = leavesOffset + leaves.length
  const header = Buffer.alloc(HEADER_BYTES)
  header.write('PMTiles', 0, 'ascii')
  header.writeUInt8(3, 7)
  const sections = [
    HEADER_BYTES, root.length,
    metadataOffset, metadata.length,
    leavesOffset, leaves.length,
    dataOffset, dataLength,
    tileIds.length, entries.length, contents.length
  ]
  sections.forEach((value, i) => header.writeBigUInt64LE(BigInt(value), 8 + i * 8))
  header.writeUInt8(1, 96) // clustered
  header.writeUInt8(2, 97) // gzip for directories and metadata
  header.writeUInt8(1, 98) // tile images stored as-is
  header.writeUInt8(info.format === 'png' ? 2 : 4, 99)
  header.writeUInt8(info.minZoom, 100)
  header.writeUInt8(info.maxZoom, 101)
  const e7 = (degrees: number) => Math.round(degrees * 1e7)
  header.writeInt32LE(e7(info.bbox.minX), 102)
  header.writeInt32LE(e7(info.bbox.minY), 106)
  header.writeInt32LE(e7(info.bbox.maxX), 110)
  header.writeInt32LE(e7(info.bbox.maxY), 114)
  header.writeUInt8(info.minZoom, 118)
  header.writeInt32LE(e7((info.bbox.minX + info.bbox.maxX) / 2), 119)
  header.writeInt32LE(e7((info.bbox.minY + info.bbox.maxY) / 2), 123)

  const fd = fs.openSync(file, 'w')
  try {
    for (const part of [header, root, metadata, leaves, ...contents]) {
      fs.writeSync(fd, part)
    }
  } finally {
    fs.closeSync(fd)
  }
}

async function waitUntilHealthy(url: string, server: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`tileserver-gl exited with code ${server.exitCode}`)
    }
    try {
      if ((await fetch(url)).ok) return
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('tileserver-gl did not start within 60s')
}

export async function renderRasterPmtiles(options: {
  vectorFile: string
  outputFile: string
  bbox: Bbox
  minZoom: number
  maxZoom: number
  format: RasterFormat
  log: (line: string) => void
}): Promise<void> {
  const { bbox, minZoom, maxZoom, format, log } = options
  const baseUrl = `http://127.0.0.1:${TILESERVER_PORT}`
  const server = spawn(
    'node',
    [
      TILESERVER_ENTRY,
      '--file', options.vectorFile,
      '--port', String(TILESERVER_PORT),
      '--public_url', `${baseUrl}/`,
      '--silent'
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
  server.stderr?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line.trim()) log(line)
    }
  })

  try {
    await waitUntilHealthy(`${baseUrl}/health`, server)

    const jobs: { z: number; x: number; y: number }[] = []
    for (const r of tileRanges(bbox, minZoom, maxZoom)) {
      for (let x = r.minX; x <= r.maxX; x++) {
        for (let y = r.minY; y <= r.maxY; y++) jobs.push({ z: r.z, x, y })
      }
    }
    log(`Rendering ${jobs.length} ${format} tiles (z${minZoom}-${maxZoom})`)

    const tiles = new Map<number, Buffer>()
    let next = 0
    const renderNext = async (): Promise<void> => {
      while (next < jobs.length) {
        const { z, x, y } = jobs[next++]
        const response = await fetch(`${baseUrl}/styles/${STYLE_ID}/${z}/${x}/${y}.${format}`)
        if (!response.ok) {
          throw new Error(`Tile ${z}/${x}/${y} failed with status ${response.status}`)
        }
        tiles.set(zxyToTileId(z, x, y), Buffer.from(await response.arrayBuffer()))
        if (tiles.size % 250 === 0) log(`Rendered ${tiles.size}/${jobs.length} tiles`)
      }
    }
    await Promise.all(Array.from({ length: RENDER_CONCURRENCY }, renderNext))

    writeRasterPmtiles(options.outputFile, tiles, { format, minZoom, maxZoom, bbox })
    log(`Raster archive written: ${tiles.size} tiles, ${fs.statSync(options.outputFile).size} bytes`)
  } finally {
    server.kill()
  }
}
