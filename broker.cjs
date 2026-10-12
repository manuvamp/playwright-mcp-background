// Background broker for the local Playwright Extension build (extension-bg/).
// The extension keeps a WebSocket open to ws://127.0.0.1:8770/ext. Playwright MCP servers POST
// their connect-page URL to http://127.0.0.1:8770/open and the extension opens it in a minimized
// agent tab, so connecting never launches the browser exe (which always brings the browser to the front).
// Can be started at logon by scripts/playwright-broker.vbs (Windows); MCP servers also start it on demand.
// Env: PW_MCP_BROKER_PORT (default 8770), PW_MCP_BROWSER_PROCESS (browser image name, default brave.exe).
const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');
const { wsServer: WebSocketServer } = require(path.join(__dirname, 'node_modules', 'playwright-core', 'lib', 'utilsBundle.js'));

const PORT = Number(process.env.PW_MCP_BROKER_PORT) || 8770;
const BROWSER_PROCESS = process.env.PW_MCP_BROWSER_PROCESS || 'brave.exe';
const EXTENSION_ORIGIN = 'chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm';
const LOG = path.join(__dirname, 'broker.log');
const startedAt = Date.now();
let extension = null;
let everConnected = false;
let nextId = 1;
const pending = new Map();
const waiters = new Set();

const log = (...a) => {
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 256 * 1024) fs.renameSync(LOG, LOG + '.old');
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${a.join(' ')}\n`);
  } catch {}
};

function browserRunning() {
  try {
    return execFileSync('tasklist', ['/FI', 'IMAGENAME eq ' + BROWSER_PROCESS, '/NH'], { windowsHide: true, encoding: 'utf8' }).toLowerCase().includes(BROWSER_PROCESS.toLowerCase());
  } catch {
    return false;
  }
}

function waitForExtension(ms) {
  if (extension) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok) => { waiters.delete(done); clearTimeout(timer); resolve(ok); };
    const timer = setTimeout(() => done(false), ms);
    waiters.add(done);
  });
}

const wss = new WebSocketServer({ noServer: true });
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/status') {
    res.end(JSON.stringify({ extension: !!extension, everConnected, uptimeS: Math.round((Date.now() - startedAt) / 1000) }));
    return;
  }
  if (req.method === 'POST' && req.url === '/reload') {
    // Reload the unpacked extension after `node patches/build-extension.cjs`.
    if (!extension) {
      res.statusCode = 503;
      res.end('extension not connected');
      return;
    }
    extension.send(JSON.stringify({ type: 'reload' }));
    log('asked extension to reload');
    res.end('reloading');
    return;
  }
  if (req.method !== 'POST' || req.url !== '/open') {
    res.statusCode = 404;
    res.end();
    return;
  }
  let url = '';
  for await (const chunk of req) url += chunk;
  // Wait for the extension only when it is plausibly about to (re)connect: the browser is running and
  // either this broker just started or the extension was connected before. Otherwise answer at
  // once so the MCP server falls back to launching the browser instead of stalling.
  if (!extension && browserRunning() && (everConnected || Date.now() - startedAt < 60_000))
    await waitForExtension(35_000);
  if (!extension) {
    log('open refused: extension not connected');
    res.statusCode = 503;
    res.end('extension not connected');
    return;
  }
  const id = nextId++;
  try {
    const result = await new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      extension.send(JSON.stringify({ id, type: 'open', url }));
      setTimeout(() => reject(new Error('extension did not answer')), 10_000);
    });
    pending.delete(id);
    log('opened connect page in tab', result.tabId);
    res.end(JSON.stringify(result));
  } catch (e) {
    pending.delete(id);
    log('open failed:', e.message);
    res.statusCode = 502;
    res.end(e.message);
  }
});

server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ext' || req.headers.origin !== EXTENSION_ORIGIN) {
    log('rejected websocket', req.url, 'origin', req.headers.origin);
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    extension?.close();
    extension = ws;
    everConnected = true;
    log('extension connected');
    for (const done of [...waiters]) done(true);
    // Messages every 20s keep the extension's MV3 service worker (and this socket) alive.
    const ping = setInterval(() => ws.send(JSON.stringify({ type: 'ping' })), 20_000);
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      const p = pending.get(msg.id);
      if (!p) return;
      if (msg.ok) p.resolve(msg);
      else p.reject(new Error(msg.error || 'open failed'));
    });
    ws.on('close', () => {
      clearInterval(ping);
      if (extension === ws) extension = null;
      log('extension disconnected');
    });
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') process.exit(0); // another broker is already running
  log('server error:', e.message);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => log('broker listening on', PORT));
