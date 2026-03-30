import express, { type Request, type Response } from 'express';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

const PORT = Number(process.env.PORT || 8080);
const PLANETILER_JAR = process.env.PLANETILER_JAR || path.join(__dirname, 'planetiler.jar');
const JAVA_XMX = process.env.JAVA_XMX || '4G';
const INPUT_FILE = process.env.INPUT_FILE || '/data/input/input.osm.pbf';
const OUTPUT_DIR = process.env.OUTPUT_DIR || '/data/output';
const GENERATE_RATE_LIMIT_MS = Number(process.env.GENERATE_RATE_LIMIT_MS || 10000);
const MAIN_OSM_URL =
  process.env.MAIN_OSM_URL ||
  'https://download.geofabrik.de/europe/germany/baden-wuerttemberg-latest.osm.pbf';

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(path.dirname(INPUT_FILE), { recursive: true });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/output', express.static(OUTPUT_DIR));

const clients = new Set<Response>();
const lastGenerateRequestByIp = new Map<string, number>();
let currentProcess: ReturnType<typeof spawn> | null = null;
let generationInProgress = false;
let downloadInProgress = false;

function broadcast(payload: unknown): void {
  const message = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    client.write(message);
  }
}

app.get('/events', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  clients.add(res);
  res.write(`data: ${JSON.stringify({ type: 'status', message: 'connected' })}\n\n`);

  const keepAlive = setInterval(() => {
    res.write(`data: ${JSON.stringify({ type: 'ping', ts: Date.now() })}\n\n`);
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    clients.delete(res);
  });
});

app.post('/generate', (req: Request, res: Response) => {
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const lastRequest = lastGenerateRequestByIp.get(clientIp) || 0;

  if (now - lastRequest < GENERATE_RATE_LIMIT_MS) {
    return res.status(429).json({ error: 'Too many requests, please wait before retrying' });
  }
  lastGenerateRequestByIp.set(clientIp, now);

  if (generationInProgress) {
    return res.status(409).json({ error: 'A generation process is already running' });
  }
  if (!fs.existsSync(INPUT_FILE)) {
    return res.status(400).json({ error: 'Input file is missing. Download it first.' });
  }

  const minX = Number(req.body?.minX);
  const minY = Number(req.body?.minY);
  const maxX = Number(req.body?.maxX);
  const maxY = Number(req.body?.maxY);

  if (![minX, minY, maxX, maxY].every(Number.isFinite) || minX >= maxX || minY >= maxY) {
    return res.status(400).json({ error: 'Invalid bbox coordinates' });
  }

  const bbox = `${minX},${minY},${maxX},${maxY}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const filename = `export_${timestamp}.pmtiles`;
  const outputFile = path.join(OUTPUT_DIR, filename);

  generationInProgress = true;

  const args = [
    `-Xmx${JAVA_XMX}`,
    '-jar',
    PLANETILER_JAR,
    `--osm_path=${INPUT_FILE}`,
    `--output=${outputFile}`,
    `--bbox=${bbox}`
  ];

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn('java', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    generationInProgress = false;
    return res.status(500).json({ error: (error as Error).message });
  }
  if (!child.stdout || !child.stderr) {
    generationInProgress = false;
    return res.status(500).json({ error: 'Failed to capture Planetiler process streams' });
  }
  currentProcess = child;

  broadcast({ type: 'status', message: 'generation_started', filename });
  broadcast({ type: 'log', stream: 'system', line: `Started: java ${args.join(' ')}` });

  child.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) {
        broadcast({ type: 'log', stream: 'stdout', line });
      }
    }
  });

  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) {
        broadcast({ type: 'log', stream: 'stderr', line });
      }
    }
  });

  child.on('error', (error: Error) => {
    broadcast({ type: 'error', message: error.message });
    currentProcess = null;
    generationInProgress = false;
  });

  child.on('close', (code: number | null) => {
    if (code === 0) {
      broadcast({
        type: 'done',
        message: 'generation_finished',
        filename,
        downloadUrl: `/output/${filename}`
      });
    } else {
      broadcast({ type: 'error', message: `Planetiler exited with code ${code}` });
    }
    currentProcess = null;
    generationInProgress = false;
  });

  return res.status(202).json({ started: true, filename, bbox });
});

app.get('/input-status', (_req: Request, res: Response) => {
  if (!fs.existsSync(INPUT_FILE)) {
    return res.json({ exists: false, downloading: downloadInProgress, inputFile: INPUT_FILE, sourceUrl: MAIN_OSM_URL });
  }
  const stats = fs.statSync(INPUT_FILE);
  return res.json({
    exists: true,
    downloading: downloadInProgress,
    inputFile: INPUT_FILE,
    sourceUrl: MAIN_OSM_URL,
    sizeBytes: stats.size
  });
});

app.post('/download-main-osm', (req: Request, res: Response) => {
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const lastRequest = lastGenerateRequestByIp.get(clientIp) || 0;

  if (now - lastRequest < GENERATE_RATE_LIMIT_MS) {
    return res.status(429).json({ error: 'Too many requests, please wait before retrying' });
  }
  lastGenerateRequestByIp.set(clientIp, now);

  if (downloadInProgress) {
    return res.status(409).json({ error: 'Input download already in progress' });
  }

  downloadInProgress = true;
  const tempInputFile = `${INPUT_FILE}.part`;
  broadcast({ type: 'status', message: 'input_download_started' });
  broadcast({ type: 'log', stream: 'system', line: `Downloading input from ${MAIN_OSM_URL}` });

  void (async () => {
    try {
      const response = await fetch(MAIN_OSM_URL);
      if (!response.ok || !response.body) {
        throw new Error(`Download failed with status ${response.status}`);
      }
      await pipeline(Readable.fromWeb(response.body as never), fs.createWriteStream(tempInputFile));
      fs.renameSync(tempInputFile, INPUT_FILE);
      const stats = fs.statSync(INPUT_FILE);
      broadcast({ type: 'status', message: 'input_download_finished' });
      broadcast({
        type: 'log',
        stream: 'system',
        line: `Input ready at ${INPUT_FILE} (${stats.size} bytes)`
      });
    } catch (error) {
      fs.rmSync(tempInputFile, { force: true });
      broadcast({ type: 'error', message: `Input download failed: ${(error as Error).message}` });
    } finally {
      downloadInProgress = false;
    }
  })();

  return res.status(202).json({ started: true, sourceUrl: MAIN_OSM_URL, inputFile: INPUT_FILE });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Planetiler GUI backend listening on http://localhost:${PORT}`);
});
