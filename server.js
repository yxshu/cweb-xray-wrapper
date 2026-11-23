/**
 * cWeb Xray wrapper — runs an Xray VLESS+WebSocket node as a cWeb backend app.
 *
 * How it works:
 *   - Node listens on 0.0.0.0:$PORT (cWeb's platform proxy forwards traffic).
 *   - GET /health answers 200 (the readiness path configured in cWeb Settings).
 *   - On startup it writes an Xray config from the UUID env var and spawns the
 *     bundled Xray binary, which listens on 127.0.0.1:10000.
 *   - The binary ships gzipped as xray.gz (GitHub's web upload rejects files
 *     over 25 MB); if no runnable ./xray is present, server.js gunzips it
 *     with Node's built-in zlib into the writable location and uses that.
 *   - WebSocket upgrade requests on /vless are relayed byte-for-byte to the
 *     local Xray instance over a raw TCP socket (Node http + net built-ins only).
 *
 * The UUID is NEVER hardcoded and NEVER logged. Set it as an env var in cWeb.
 * Use a fresh UUID for each deployment.
 */

'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const XRAY_PORT = 10000;
const XRAY_HOST = '127.0.0.1';
let XRAY_BIN = null; // resolved at startup by resolveXrayBinary() below
const MAX_RESTARTS = 5;
const RESTART_DELAY_MS = 2000;

const UUID = process.env.UUID;
if (!UUID) {
  console.error('[wrapper] FATAL: UUID env var is not set. Set a fresh UUID as an env var in cWeb and restart.');
  process.exit(1);
}

// The UUID must never appear in any log line, including Xray's own output.
function scrub(line) {
  return String(line).split(UUID).join('[redacted-uuid]');
}
function log(...args) {
  console.log('[wrapper]', ...args.map((a) => scrub(a)));
}
function logErr(...args) {
  console.error('[wrapper]', ...args.map((a) => scrub(a)));
}

// Config location: cWeb allows persistent writes only under CWEB_STORAGE_PATH
// (usually /app/media). Elsewhere (local dev) use a writable temp directory.
const configDir = process.env.CWEB_STORAGE_PATH
  ? path.join(process.env.CWEB_STORAGE_PATH, 'xray')
  : path.join(os.tmpdir(), 'cweb-xray-wrapper');
fs.mkdirSync(configDir, { recursive: true });
const configPath = path.join(configDir, 'config.json');

// ---------------------------------------------------------------------------
// Xray binary resolution. GitHub's web upload rejects files over 25 MB, so
// the repo ships the binary gzipped as xray.gz (~13 MB). On startup:
//   (a) prefer a bundled ./xray binary next to server.js if it exists and is
//       executable (local dev / ZIP deploy with the raw binary);
//   (b) otherwise gunzip xray.gz (Node built-in zlib, no new dependency)
//       into the writable location and chmod it 0o755;
//   (c) if neither is available, exit with a FATAL log line.
// The decompressed binary lives under CWEB_STORAGE_PATH/xray when that env
// var is set (the only persistently writable location on cWeb), else a
// temp directory (same location as the config file).
// ---------------------------------------------------------------------------
function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch (_) {
    return false;
  }
}

function resolveXrayBinary() {
  const bundled = path.join(__dirname, 'xray');
  if (isExecutable(bundled)) {
    log(`using bundled xray binary at ${bundled}`);
    return bundled;
  }
  const gz = path.join(__dirname, 'xray.gz');
  if (fs.existsSync(gz)) {
    const outPath = path.join(configDir, 'xray');
    log(`bundled xray binary not found; decompressing xray.gz to ${outPath}`);
    const data = zlib.gunzipSync(fs.readFileSync(gz));
    fs.writeFileSync(outPath, data);
    fs.chmodSync(outPath, 0o755);
    log(`decompressed xray binary (${data.length} bytes) to ${outPath}`);
    return outPath;
  }
  console.error('[wrapper] FATAL: no runnable Xray binary found. Expected ./xray or ./xray.gz next to server.js.');
  process.exit(1);
}

XRAY_BIN = resolveXrayBinary();

const xrayConfig = {
  log: { loglevel: 'warning' },
  inbounds: [
    {
      port: XRAY_PORT,
      listen: XRAY_HOST,
      protocol: 'vless',
      settings: {
        clients: [{ id: UUID, flow: '' }],
        decryption: 'none',
      },
      streamSettings: {
        network: 'ws',
        wsSettings: { path: '/vless' },
      },
    },
  ],
  outbounds: [{ protocol: 'freedom', tag: 'direct' }],
};

fs.writeFileSync(configPath, JSON.stringify(xrayConfig, null, 2));
log(`wrote Xray config to ${configPath}`);

// ---------------------------------------------------------------------------
// Xray process management (start, log, restart a few times on crash)
// ---------------------------------------------------------------------------
let xray = null;
let restarts = 0;
let shuttingDown = false;

function startXray() {
  if (shuttingDown) return;
  log(`starting xray (attempt ${restarts + 1})`);
  xray = spawn(XRAY_BIN, ['run', '-c', configPath], { stdio: ['ignore', 'pipe', 'pipe'] });

  xray.stdout.on('data', (d) => {
    for (const line of String(d).split('\n')) {
      if (line.trim()) log('[xray]', line.trim());
    }
  });
  xray.stderr.on('data', (d) => {
    for (const line of String(d).split('\n')) {
      if (line.trim()) logErr('[xray]', line.trim());
    }
  });
  xray.on('error', (err) => {
    logErr(`xray failed to start: ${err.message}`);
  });
  xray.on('exit', (code, signal) => {
    xray = null;
    if (shuttingDown) return;
    logErr(`xray exited (code=${code} signal=${signal})`);
    if (restarts < MAX_RESTARTS) {
      restarts += 1;
      log(`restarting xray in ${RESTART_DELAY_MS}ms (${restarts}/${MAX_RESTARTS})`);
      setTimeout(startXray, RESTART_DELAY_MS);
    } else {
      logErr('xray restart limit reached; wrapper keeps serving /health with xray=down');
    }
  });
}

startXray();

// ---------------------------------------------------------------------------
// HTTP server: /health for the platform readiness check, 404 for the rest.
// WebSocket upgrades on /vless are relayed raw to the local Xray instance.
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', xray: xray ? 'running' : 'down' }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.on('upgrade', (req, socket, head) => {
  const urlPath = (req.url || '').split('?')[0];
  if (urlPath !== '/vless') {
    socket.destroy();
    return;
  }
  if (!xray) {
    logErr('upgrade on /vless but xray is not running; dropping connection');
    socket.destroy();
    return;
  }

  // Reconstruct the exact HTTP upgrade request (request line + raw headers)
  // and forward it together with any bytes already read (head) to Xray.
  const requestLine = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
  let headerBlock = '';
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    headerBlock += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
  }
  const prefix = Buffer.concat([
    Buffer.from(requestLine + headerBlock + '\r\n', 'utf8'),
    head,
  ]);

  const upstream = net.connect(XRAY_PORT, XRAY_HOST, () => {
    upstream.write(prefix);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });

  const destroyBoth = (err) => {
    if (err) logErr(`relay error: ${err.message}`);
    try { socket.destroy(); } catch (_) { /* already closed */ }
    try { upstream.destroy(); } catch (_) { /* already closed */ }
  };
  upstream.on('error', destroyBoth);
  socket.on('error', destroyBoth);
  upstream.on('close', () => { try { socket.destroy(); } catch (_) {} });
  socket.on('close', () => { try { upstream.destroy(); } catch (_) {} });
});

server.on('error', (err) => {
  logErr(`http server error: ${err.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  log(`listening on ${HOST}:${PORT} (health: /health, ws: /vless -> ${XRAY_HOST}:${XRAY_PORT})`);
});

function shutdown(signal) {
  shuttingDown = true;
  log(`received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  if (xray) xray.kill('SIGTERM');
  setTimeout(() => process.exit(0), 5000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
