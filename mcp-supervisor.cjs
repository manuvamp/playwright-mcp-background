// Supervisor for the Playwright MCP server (stdio). Claude Code launches this instead of cli.js:
//   node mcp-supervisor.cjs <cli.js> <cli args...>
// It runs the real Playwright MCP server as a child and proxies newline-delimited JSON-RPC both ways.
// If the child dies, or its code is patched (coreBundle.js changes) while idle, it starts a fresh
// child and replays the MCP handshake, so open chats never need /mcp. Calls in flight when a child
// dies get an error asking the agent to retry; nothing is re-sent automatically (it could repeat an
// action such as a form submit).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const [childScript, ...childArgs] = process.argv.slice(2);
const BUNDLE = path.join(__dirname, 'node_modules', 'playwright-core', 'lib', 'coreBundle.js');
const LOG = path.join(__dirname, 'supervisor.log');
const log = (m) => { try { fs.appendFileSync(LOG, `${new Date().toISOString()} [${process.pid}] ${m}\n`); } catch {} };

let child = null;
let childBuf = '';
let initRequest = null;        // the client's initialize request (replayed to new children)
let initializedNote = null;    // the client's notifications/initialized
let replayInitId = null;       // id of a replayed initialize whose response must be swallowed
let ready = false;             // child finished the handshake
const queue = [];              // client messages waiting for a ready child
const pending = new Map();     // client request id -> method (in flight on the child)
let restarts = [];
let bundleMtime = fileMtime(BUNDLE);
let restartWhenIdle = false;
let exiting = false;

function fileMtime(f) { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }
const toClient = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const toChild = (msg) => child?.stdin.write(JSON.stringify(msg) + '\n');

function startChild() {
  ready = !initRequest; // before the client's first initialize, pass everything straight through
  // PW_MCP_PARENT_PID: the Claude Code process, so the child can name its tab group (patches/apply.cjs GROUP_NAME).
  child = spawn(process.execPath, [childScript, ...childArgs], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true, env: { ...process.env, PW_MCP_PARENT_PID: String(process.ppid) } });
  childBuf = '';
  const me = child;
  child.stdout.on('data', (d) => {
    childBuf += d;
    let i;
    while ((i = childBuf.indexOf('\n')) >= 0) {
      const line = childBuf.slice(0, i); childBuf = childBuf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { process.stdout.write(line + '\n'); continue; }
      if (replayInitId !== null && msg.id === replayInitId && !msg.method) {
        // Handshake replayed on a fresh child: swallow its initialize response, finish the handshake.
        replayInitId = null;
        if (initializedNote) toChild(initializedNote);
        ready = true;
        log('child ready after restart');
        toClient({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
        while (queue.length) sendToChild(queue.shift());
        continue;
      }
      if (msg.id !== undefined && !msg.method) {
        pending.delete(msg.id);
        maybeRestartForUpdate();
      }
      toClient(msg);
    }
  });
  child.on('exit', (code, signal) => {
    if (me !== child) return;
    log(`child exited code=${code} signal=${signal} pending=${pending.size}`);
    for (const [id] of pending)
      toClient({ jsonrpc: '2.0', id, error: { code: -32603, message: 'The browser server restarted (crash, update or stop) while this call was running. It is back now: check the page with browser_snapshot, then retry if needed.' } });
    pending.clear();
    child = null;
    if (exiting) return;
    const now = Date.now();
    restarts = restarts.filter((t) => now - t < 60000);
    restarts.push(now);
    const delay = restarts.length > 5 ? 15000 : 300; // back off if it keeps crashing
    setTimeout(() => { if (!exiting) restartChild(); }, delay);
  });
}

function restartChild() {
  startChild();
  if (initRequest) {
    ready = false;
    replayInitId = `supervisor-init-${Date.now()}`;
    toChild({ ...initRequest, id: replayInitId });
  }
}

function sendToChild(msg) {
  if (msg.id !== undefined && msg.method) pending.set(msg.id, msg.method);
  toChild(msg);
}

function maybeRestartForUpdate() {
  if (!restartWhenIdle || pending.size || !child) return;
  restartWhenIdle = false;
  log('code changed, restarting idle child');
  child.kill();
}

// Client -> child
let inBuf = '';
process.stdin.on('data', (d) => {
  inBuf += d;
  let i;
  while ((i = inBuf.indexOf('\n')) >= 0) {
    const line = inBuf.slice(0, i); inBuf = inBuf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { child?.stdin.write(line + '\n'); continue; }
    if (msg.method === 'initialize') initRequest = msg;
    if (msg.method === 'notifications/initialized') initializedNote = msg;
    if (!child || !ready) {
      queue.push(msg);
      continue;
    }
    sendToChild(msg);
  }
});
process.stdin.on('end', () => { exiting = true; child?.kill(); process.exit(0); });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { exiting = true; child?.kill(); process.exit(0); });

// Pick up patched code: restart the child once it is idle.
setInterval(() => {
  const m = fileMtime(BUNDLE);
  if (m && m !== bundleMtime) {
    bundleMtime = m;
    restartWhenIdle = true;
    log('coreBundle.js changed');
    maybeRestartForUpdate();
  }
}, 5000).unref();

log(`supervisor start: ${childScript}`);
startChild();
