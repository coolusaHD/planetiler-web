const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const PLANETILER_JAR = process.env.PLANETILER_JAR || path.join(__dirname, 'planetiler.jar');
const JAVA_XMX = process.env.JAVA_XMX || '4G';
const INPUT_FILE = process.env.INPUT_FILE || '/data/input/input.osm.pbf';
const OUTPUT_DIR = process.env.OUTPUT_DIR || '/data/output';

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/output', express.static(OUTPUT_DIR));

const clients = new Set();
let currentProcess = null;
let generationInProgress = false;

function broadcast(payload) {
  const message = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    client.write(message);
  }
}

app.get('/events', (req, res) => {
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

app.post('/generate', (req, res) => {
  if (generationInProgress) {
    return res.status(409).json({ error: 'A generation process is already running' });
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

  let child;
  try {
    child = spawn('java', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    generationInProgress = false;
    return res.status(500).json({ error: error.message });
  }
  currentProcess = child;

  broadcast({ type: 'status', message: 'generation_started', filename });
  broadcast({ type: 'log', stream: 'system', line: `Started: java ${args.join(' ')}` });

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) {
        broadcast({ type: 'log', stream: 'stdout', line });
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) {
        broadcast({ type: 'log', stream: 'stderr', line });
      }
    }
  });

  child.on('error', (error) => {
    broadcast({ type: 'error', message: error.message });
    currentProcess = null;
    generationInProgress = false;
  });

  child.on('close', (code) => {
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

  res.status(202).json({ started: true, filename, bbox });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Planetiler GUI backend listening on http://localhost:${PORT}`);
});
