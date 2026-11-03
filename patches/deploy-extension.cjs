// Puts the staged extension build (extension-next/, from `build-extension.cjs --out ...extension-next`)
// into extension-bg/ (the copy the browser loads) and has the browser reload it through the broker.
//   node patches/deploy-extension.cjs          wait for a quiet moment
//   node patches/deploy-extension.cjs --now    reload right away
//   node patches/deploy-extension.cjs --status how long since any chat used the browser
// A reload drops every chat's browser connection. These builds keep the tabs (15 min after a
// reload) and hand them back when each chat reconnects, but a call running at that moment still fails,
// so by default this waits until no Claude chat has made a browser call for QUIET_MIN minutes (checked
// every minute, for up to 8 hours). Before swapping, sim-tabs must pass on extension-next. The previous
// build is kept in extension-prev/ (rollback: copy it back over extension-bg/, then
// `curl -X POST 127.0.0.1:8770/reload`, or your PW_MCP_BROKER_PORT). Log: deploy.log in the repo root.
// Env: QUIET_MIN (default 10), PW_MCP_BROKER_PORT (default 8770), PW_MCP_SERVER_NAME (default "brave"; the MCP
// tool prefix mcp__<name>__ that counts as a browser call), PW_LANE_DIR (default <repo>/lane-ids).
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NEXT = path.join(ROOT, 'extension-next');
const LIVE = path.join(ROOT, 'extension-bg');
const PREV = path.join(ROOT, 'extension-prev');
const LOG = path.join(ROOT, 'deploy.log');
const PORT = Number(process.env.PW_MCP_BROKER_PORT) || 8770;
const SERVER = process.env.PW_MCP_SERVER_NAME || 'brave';
const LANE_DIR = process.env.PW_LANE_DIR || path.join(ROOT, 'lane-ids');
const QUIET_MIN = +(process.env.QUIET_MIN || 10);
const MAX_WAIT_MIN = 8 * 60;
const now = process.argv.includes('--now');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => { const line = `${new Date().toISOString()} ${m}`; console.log(line); fs.appendFileSync(LOG, line + '\n'); };

// Last browser call of any Claude chat (main sessions and subagents write their transcripts live).
function lastBrowserCall() {
  let last = 0;
  const cutoff = Date.now() - (QUIET_MIN + 5) * 60e3;
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        let st; try { st = fs.statSync(p); } catch { continue; }
        if (st.mtimeMs < cutoff) continue;
        const size = Math.min(st.size, 2 * 1024 * 1024);
        const fd = fs.openSync(p, 'r');
        const buf = Buffer.alloc(size);
        try { fs.readSync(fd, buf, 0, size, st.size - size); } finally { fs.closeSync(fd); }
        for (const line of buf.toString('utf8').split('\n')) {
          // A real call, not a tool list or a mention: {"type":"tool_use","id":"toolu_..","name":"mcp__<server>__..
          if (!line.includes(`"name":"mcp__${SERVER}__`) || !/"type":"tool_use","id":"[^"]*","name":"mcp__/.test(line)) continue;
          const ts = Date.parse(line.match(/"timestamp":"([^"]+)"/)?.[1] || '');
          if (ts > last) last = ts;
        }
      }
    }
  };
  walk(path.join(os.homedir(), '.claude', 'projects'), 0);
  // Calls through the browser-lanes hook.
  try {
    for (const f of fs.readdirSync(LANE_DIR)) {
      const m = fs.statSync(path.join(LANE_DIR, f)).mtimeMs;
      if (m > last) last = m;
    }
  } catch {}
  return last;
}

const status = async () => { try { return await (await fetch(`http://127.0.0.1:${PORT}/status`, { signal: AbortSignal.timeout(3000) })).json(); } catch { return null; } };

(async () => {
  if (process.argv.includes('--status')) {
    const last = lastBrowserCall();
    console.log(last ? `last browser call ${((Date.now() - last) / 60e3).toFixed(1)} min ago (${new Date(last).toISOString()})` : `no browser call in the last ${QUIET_MIN + 5} min`);
    return;
  }
  if (!fs.existsSync(path.join(NEXT, 'manifest.json'))) throw new Error('no staged build in ' + NEXT);
  execFileSync(process.execPath, ['--check', path.join(NEXT, 'lib', 'background.mjs')], { stdio: 'inherit' });
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'sim-tabs.cjs')], { env: { ...process.env, SIM_EXT_DIR: NEXT }, stdio: 'pipe', timeout: 300e3 });
  } catch (e) {
    log('ABORT: sim-tabs fails on extension-next:\n' + String(e.stdout || e.message).split('\n').filter((l) => /FAIL|passed/.test(l)).join('\n'));
    process.exit(1);
  }
  log(`sim-tabs passed on extension-next; ${now ? 'deploying now' : `waiting until no browser call for ${QUIET_MIN} min`}`);
  const started = Date.now();
  while (!now) {
    const idleMin = (Date.now() - lastBrowserCall()) / 60e3;
    if (idleMin >= QUIET_MIN) break;
    if (Date.now() - started > MAX_WAIT_MIN * 60e3) { log(`gave up: never quiet for ${QUIET_MIN} min in ${MAX_WAIT_MIN / 60} h`); process.exit(2); }
    await sleep(60e3);
  }
  const before = await status();
  if (!before?.extension) { log('ABORT: extension not connected to the broker; nothing changed'); process.exit(3); }
  fs.rmSync(PREV, { recursive: true, force: true });
  fs.cpSync(LIVE, PREV, { recursive: true });
  fs.cpSync(NEXT, LIVE, { recursive: true, force: true });
  log('extension-bg updated (previous build in extension-prev); reloading');
  try { await fetch(`http://127.0.0.1:${PORT}/reload`, { method: 'POST', signal: AbortSignal.timeout(5000) }); } catch (e) { log('reload request failed: ' + e.message); }
  let back = false;
  for (let i = 0; i < 30 && !back; i++) {
    await sleep(2000);
    back = !!(await status())?.extension && i >= 2;
  }
  if (!back) {
    log('WARNING: extension did not reconnect within 60 s. Open the browser extensions page -> Playwright Extension -> Errors / reload; rollback = copy extension-prev over extension-bg and reload.');
    process.exit(4);
  }
  // Proof the new build runs: a short live check (background tabs) must see tab groups answered.
  let check = '';
  try { check = execFileSync(process.execPath, [path.join(__dirname, 'live-lanes.mjs')], { encoding: 'utf8', timeout: 240e3 }); } catch (e) { check = String(e.stdout || e.message); }
  const ok = /answers tab groups: yes/.test(check) && !/FAIL/.test(check);
  log(`${ok ? 'deployed and verified' : 'WARNING: reloaded, but the live check did not confirm the new build'}:\n${check.trim()}`);
  process.exit(ok ? 0 : 5);
})().catch((e) => { log('ERROR: ' + (e.stack || e)); process.exit(1); });
