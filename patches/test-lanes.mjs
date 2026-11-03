// Offline test of the lanes patches (apply.cjs LANES_*): every agent of a session gets its own tabs and
// current tab, and agents' calls run side by side. Drives the patched MCP server (newest runtime*/) over stdio,
// the way Claude Code does (each call tagged with _meta["claudecode/toolUseId"], lane file written like
// claude-code-hooks/browser-lanes does), against a private headless Chromium on a throwaway profile.
// Nothing touches your real browser or the screen.
//   node patches/test-lanes.mjs [install-dir]
// PW_TEST_CHROME overrides the headless browser (default: newest ms-playwright chrome-headless-shell;
// install one with `npx playwright install chromium-headless-shell`). PW_LANE_DIR overrides the lane dir.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL = path.resolve(process.argv[2] || createRequire(import.meta.url)('./install-dir.cjs').currentInstall());
const CLI = path.join(INSTALL, 'node_modules', '@playwright', 'mcp', 'cli.js');
const LANE_DIR = process.env.PW_LANE_DIR || path.join(ROOT, 'lane-ids');
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-lanes-test-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  if (process.env.PW_TEST_CHROME) return process.env.PW_TEST_CHROME;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.cache'), 'ms-playwright');
  const dirs = (fs.existsSync(base) ? fs.readdirSync(base) : []).filter((d) => d.startsWith('chromium_headless_shell-')).sort((a, b) => +b.split('-')[1] - +a.split('-')[1]);
  for (const d of dirs) {
    const exe = path.join(base, d, process.platform === 'win32' ? 'chrome-headless-shell-win64' : 'chrome-headless-shell-linux64', process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell');
    if (fs.existsSync(exe)) return exe;
  }
  throw new Error('no chrome-headless-shell found; set PW_TEST_CHROME');
}

// Test site: /a /b /c, /slow (answers after 2.5 s), /opener (has a window.open button).
const site = http.createServer((req, res) => {
  const page = (title, body = '') => `<!doctype html><title>${title}</title><h1>${title}</h1>${body}`;
  const u = new URL(req.url, 'http://x');
  res.setHeader('content-type', 'text/html');
  if (u.pathname === '/slow') return setTimeout(() => res.end(page('Slow page')), 2500);
  if (u.pathname === '/opener') return res.end(page('Opener', `<button id="pop" onclick="window.open('/b?popup=1')">pop</button>`));
  res.end(page('Page ' + u.pathname.slice(1).toUpperCase() + (u.search ? ' ' + u.search : '')));
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${site.address().port}`;

const profile = path.join(SCRATCH, 'profile');
const chrome = spawn(findChrome(), ['--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore', windowsHide: true });
let port;
for (let i = 0; i < 100 && !port; i++) {
  await sleep(100);
  try { port = +fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch {}
}
if (!port) throw new Error('headless browser did not start');

// PW_TEST_DEBUG=1: server debug log, printed when a scenario fails.
const server = spawn(process.execPath, [CLI, '--cdp-endpoint', `http://127.0.0.1:${port}`, '--output-dir', path.join(SCRATCH, 'out')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...(process.env.PW_TEST_DEBUG ? { DEBUG: 'pw:mcp:*,pw:tools:*,pw:protocol' } : {}) } });
let stderr = '';
server.stderr.on('data', (d) => { stderr += d; });
let buf = '';
let nextId = 1;
const waiting = new Map();
server.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
  }
});
const rpc = (method, params) => new Promise((resolve) => { const id = nextId++; waiting.set(id, resolve); server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
let callNo = 0;
// lane: agent id (as the hook writes it), 'main', or null for a call without the hook (no lane file).
async function call(lane, name, args = {}) {
  const toolUseId = `toolu_lanetest_${process.pid}_${++callNo}`;
  if (lane !== null) {
    fs.mkdirSync(LANE_DIR, { recursive: true });
    fs.writeFileSync(path.join(LANE_DIR, toolUseId + '.json'), JSON.stringify({ agent: lane, type: lane === 'main' ? '' : 'general-purpose' }));
  }
  const t0 = Date.now();
  const r = await rpc('tools/call', { name, arguments: args, _meta: { 'claudecode/toolUseId': toolUseId } });
  const text = (r.result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (process.env.PW_TEST_DEBUG) console.log(`    [${lane}] ${name} ${Date.now() - t0}ms ${JSON.stringify(args).slice(0, 80)}`);
  return { text, isError: !!r.result?.isError || !!r.error, raw: r };
}
const pageUrl = (text) => text.match(/- Page URL: (\S+)/)?.[1];
const tabLines = (text) => text.split('\n').filter((l) => /^- \d+:/.test(l));

const results = [];
async function scenario(name, fn) {
  const failures = [];
  const expect = (cond, msg) => { if (!cond) failures.push(msg); };
  try { await fn(expect); } catch (e) { failures.push('threw: ' + (e.stack || e)); }
  results.push({ name, failures });
  console.log(`${failures.length ? 'FAIL' : 'ok  '}  ${name}${failures.map((f) => '\n        - ' + f).join('')}`);
}

try {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'lanes-test', version: '1' } });
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const A = 'a1111111111111111', B = 'b2222222222222222';

  await scenario('browser_tabs has the new actions and parameters', async (expect) => {
    const list = await rpc('tools/list', {});
    const tabs = list.result.tools.find((t) => t.name === 'browser_tabs');
    expect(tabs, 'browser_tabs missing');
    expect(tabs?.inputSchema?.properties?.action?.enum?.includes('group'), 'no group action');
    expect(tabs?.inputSchema?.properties?.group && tabs?.inputSchema?.properties?.all, 'no group/all params');
    expect(['keep', 'existing', 'take'].every((a) => tabs?.inputSchema?.properties?.action?.enum?.includes(a)) && tabs?.inputSchema?.properties?.tabId, 'no keep/existing/take actions or tabId param');
  });

  await scenario('two agents navigate at the same time: each lands on its own tab', async (expect) => {
    const [ra, rb] = await Promise.all([call(A, 'browser_navigate', { url: SITE + '/a' }), call(B, 'browser_navigate', { url: SITE + '/b' })]);
    expect(pageUrl(ra.text) === SITE + '/a', `A on ${pageUrl(ra.text)}: ${ra.text.slice(0, 300)}`);
    expect(pageUrl(rb.text) === SITE + '/b', `B on ${pageUrl(rb.text)}: ${rb.text.slice(0, 300)}`);
    const [sa, sb] = await Promise.all([call(A, 'browser_snapshot'), call(B, 'browser_snapshot')]);
    expect(/Page A/.test(sa.text) && !/Page B/.test(sa.text), 'A snapshot is not page A');
    expect(/Page B/.test(sb.text) && !/Page A/.test(sb.text), 'B snapshot is not page B');
  });

  await scenario('main agent (and a call without the hook) get their own lane too', async (expect) => {
    const rm = await call('main', 'browser_navigate', { url: SITE + '/c' });
    expect(pageUrl(rm.text) === SITE + '/c', `main on ${pageUrl(rm.text)}`);
    const rn = await call(null, 'browser_snapshot');
    expect(/Page C/.test(rn.text), 'call without lane file did not run in the main lane');
    const ra = await call(A, 'browser_snapshot');
    expect(/Page A/.test(ra.text), 'A lost its tab after main navigated');
  });

  await scenario('calls from different agents run side by side (no queueing)', async (expect) => {
    const t0 = Date.now();
    await Promise.all([call(A, 'browser_wait_for', { time: 2 }), call(B, 'browser_wait_for', { time: 2 }), call('main', 'browser_wait_for', { time: 2 })]);
    const both = Date.now() - t0;
    expect(both < 3800, `three 2 s waits took ${both} ms (serialized?)`);
    // A slow navigation in A must not hold up B.
    const slow = call(A, 'browser_navigate', { url: SITE + '/slow' });
    await sleep(200);
    const t1 = Date.now();
    const quick = await call(B, 'browser_evaluate', { function: '() => location.pathname' });
    const quickMs = Date.now() - t1;
    expect(/\/b/.test(quick.text), `B evaluated on the wrong page: ${quick.text.slice(0, 200)}`);
    expect(quickMs < 1500, `B waited ${quickMs} ms behind A's slow navigation`);
    const rs = await slow;
    expect(pageUrl(rs.text) === SITE + '/slow', `A on ${pageUrl(rs.text)}`);
  });

  await scenario('tab lists, indexes and new/close are per agent', async (expect) => {
    const rn = await call(A, 'browser_tabs', { action: 'new', url: SITE + '/a2' });
    expect(!rn.isError, rn.text.slice(0, 300));
    const la = await call(A, 'browser_tabs', { action: 'list' });
    const lb = await call(B, 'browser_tabs', { action: 'list' });
    expect(tabLines(la.text).length === 2, `A sees ${tabLines(la.text).length} tabs:\n${la.text}`);
    expect(tabLines(lb.text).length === 1 && /\/b\)/.test(lb.text), `B sees:\n${lb.text}`);
    expect(/more tabs? belong to other agents/.test(lb.text), 'B not told about other agents\' tabs');
    expect(/\(current\)[^\n]*\/a2\)/.test(la.text), `A's new tab is not its current one:\n${la.text}`);
    const all = await call(B, 'browser_tabs', { action: 'list', all: true });
    expect(tabLines(all.text).length === 4, `all-list has ${tabLines(all.text).length} tabs:\n${all.text}`);
    expect(/yours/.test(all.text) && /main agent/.test(all.text) && /subagent a1111111/.test(all.text), `owners missing:\n${all.text}`);
    // A closes its current tab: its other tab becomes current, B is untouched.
    await call(A, 'browser_tabs', { action: 'close' });
    const sa = await call(A, 'browser_snapshot');
    expect(/Slow page/.test(sa.text), `A's current after close: ${pageUrl(sa.text)}`);
    const sb = await call(B, 'browser_snapshot');
    expect(/Page B/.test(sb.text), 'B lost its page when A closed a tab');
    // Index 0 means each agent's own first tab.
    const sel = await call(B, 'browser_tabs', { action: 'select', index: 0 });
    expect(!sel.isError && /\/b\)/.test(sel.text), `B select 0:\n${sel.text}`);
    const bad = await call(B, 'browser_tabs', { action: 'select', index: 1 });
    expect(bad.isError, 'B could select a tab index it does not have');
  });

  await scenario('a popup belongs to the agent whose page opened it', async (expect) => {
    await call(B, 'browser_navigate', { url: SITE + '/opener' });
    const click = await call(B, 'browser_click', { target: '#pop', element: 'pop button' });
    expect(!click.isError, click.text.slice(0, 300));
    await sleep(800);
    const lb = await call(B, 'browser_tabs', { action: 'list' });
    const la = await call(A, 'browser_tabs', { action: 'list' });
    expect(/popup=1/.test(lb.text), `B does not have its popup:\n${lb.text}`);
    expect(!/popup=1/.test(la.text), `A got B's popup:\n${la.text}`);
    expect(/\(current\)[^\n]*\/opener\)/.test(lb.text), `B's current tab moved to the popup:\n${lb.text}`);
  });

  await scenario('select with all: takes another agent\'s tab over', async (expect) => {
    const all = await call('main', 'browser_tabs', { action: 'list', all: true });
    const line = tabLines(all.text).find((l) => /popup=1/.test(l));
    const index = +line?.match(/^- (\d+):/)?.[1];
    expect(Number.isInteger(index), `popup not in all-list:\n${all.text}`);
    const sel = await call('main', 'browser_tabs', { action: 'select', index, all: true });
    expect(!sel.isError, sel.text.slice(0, 300));
    const sm = await call('main', 'browser_snapshot');
    expect(/popup=1/.test(pageUrl(sm.text) || ''), `main is on ${pageUrl(sm.text)}`);
    const lb = await call(B, 'browser_tabs', { action: 'list' });
    expect(!/popup=1/.test(lb.text), `B still lists the tab main took over:\n${lb.text}`);
  });

  await scenario('run_code and evaluate act on the calling agent\'s page', async (expect) => {
    const [ra, rb] = await Promise.all([
      call(A, 'browser_run_code_unsafe', { code: 'async (page) => page.url()' }),
      call(B, 'browser_evaluate', { function: '() => location.href' }),
    ]);
    expect(/\/slow/.test(ra.text), `A run_code saw ${ra.text.slice(0, 200)}`);
    expect(/\/opener/.test(rb.text), `B evaluate saw ${rb.text.slice(0, 200)}`);
  });

  await scenario('tab groups without the extension: clear error', async (expect) => {
    const r = await call(A, 'browser_tabs', { action: 'group', group: 'Research' });
    expect(r.isError && /browser extension/.test(r.text), `unexpected: ${r.text.slice(0, 300)}`);
  });

  await scenario('The user\'s tabs without the extension: clear errors, navigate unaffected', async (expect) => {
    const e = await call(A, 'browser_tabs', { action: 'existing' });
    expect(e.isError && /browser extension connection/.test(e.text), `existing: ${e.text.slice(0, 300)}`);
    const t = await call(A, 'browser_tabs', { action: 'take', tabId: 1 });
    expect(t.isError && /browser extension connection/.test(t.text), `take: ${t.text.slice(0, 300)}`);
    const n = await call(A, 'browser_tabs', { action: 'take' });
    expect(n.isError && /tabId is required/.test(n.text), `take without tabId: ${n.text.slice(0, 300)}`);
  });

  await scenario('a new agent\'s first call opens a fresh tab of its own', async (expect) => {
    const C = 'c3333333333333333';
    const before = tabLines((await call('main', 'browser_tabs', { action: 'list', all: true })).text).length;
    const rc = await call(C, 'browser_navigate', { url: SITE + '/c' });
    expect(pageUrl(rc.text) === SITE + '/c', `C on ${pageUrl(rc.text)}`);
    const after = tabLines((await call('main', 'browser_tabs', { action: 'list', all: true })).text).length;
    expect(after === before + 1, `tab count ${before} -> ${after}`);
    const sa = await call(A, 'browser_snapshot');
    expect(/Slow page/.test(sa.text), 'A was moved by C');
  });

  await scenario('browser_close by one agent closes only its own tabs', async (expect) => {
    const r = await call('c3333333333333333', 'browser_close');
    expect(!r.isError && /only|Closed your tabs/.test(r.text), r.text.slice(0, 300));
    const all = await call('main', 'browser_tabs', { action: 'list', all: true });
    expect(!/subagent c3333333/.test(all.text), `C's tab still open:\n${all.text}`);
    const sa = await call(A, 'browser_snapshot');
    expect(/Slow page/.test(sa.text), `A lost its tab: ${sa.text.slice(0, 200)}`);
  });

  const D = 'd4444444444444444';
  await scenario('keep: the tab is marked for the user in the agent\'s list', async (expect) => {
    await call(D, 'browser_navigate', { url: SITE + '/a' });
    await call(D, 'browser_tabs', { action: 'new', url: SITE + '/b' });
    const r = await call(D, 'browser_tabs', { action: 'keep', index: 0 });
    expect(!r.isError && /stays open for the user/.test(r.text), r.text.slice(0, 300));
    expect(/- 0: \(kept for the user\)[^\n]*\/a\)/.test(r.text) && !/- 1:[^\n]*kept/.test(r.text), `list:\n${r.text}`);
  });

  await scenario('a finished subagent\'s tabs close; its kept tab goes to main without moving main', async (expect) => {
    const before = pageUrl((await call('main', 'browser_snapshot')).text);
    const done = path.join(LANE_DIR, `done-${D}.json`);
    fs.writeFileSync(done, JSON.stringify({ agent: D, at: Date.now() })); // what the hook writes on SubagentStop
    for (let i = 0; i < 40 && fs.existsSync(done); i++) await sleep(250);
    expect(!fs.existsSync(done), 'done notice not handled within 10 s');
    const all = await call('main', 'browser_tabs', { action: 'list', all: true });
    expect(!/subagent d4444444/.test(all.text), `the finished agent still has tabs:\n${all.text}`);
    expect(!tabLines(all.text).some((l) => /\/b\)/.test(l) && !/subagent b2222222/.test(l)), `its unkept tab is still open:\n${all.text}`);
    const mine = await call('main', 'browser_tabs', { action: 'list' });
    expect(/\(kept for the user\)[^\n]*\/a\)/.test(mine.text), `kept tab not in main's list:\n${mine.text}`);
    const after = pageUrl((await call('main', 'browser_snapshot')).text);
    expect(after === before, `main's current tab moved from ${before} to ${after}`);
    const sb = await call(B, 'browser_snapshot');
    expect(/\/opener/.test(pageUrl(sb.text) || ''), `B was touched: ${pageUrl(sb.text)}`);
  });

  await scenario('a done notice for an agent this session never had is left for its own session', async (expect) => {
    const done = path.join(LANE_DIR, 'done-e5555555555555555.json');
    fs.writeFileSync(done, JSON.stringify({ agent: 'e5555555555555555', at: Date.now() }));
    await sleep(4000);
    expect(fs.existsSync(done), 'another session\'s done notice was consumed');
    fs.rmSync(done, { force: true });
  });

  // Lanes rely on Playwright internals: the in-process server page behind a client page (its CDP
  // target id keys lanes across reconnects; its guid matches hidden-tab link opens to their tab).
  await scenario('internals the lanes rely on still exist', async (expect) => {
    const r = await call(A, 'browser_run_code_unsafe', { code: 'async (page) => { const impl = page._connection.toImpl(page); return JSON.stringify({ target: typeof impl.delegate._targetId, guid: impl.guid === page._guid }); }' });
    expect(/\\?"target\\?":\\?"string\\?"/.test(r.text) && /\\?"guid\\?":true/.test(r.text), `internals changed: ${r.text.slice(0, 300)}`);
  });

  await scenario('lane files are consumed', async (expect) => {
    const left = fs.existsSync(LANE_DIR) ? fs.readdirSync(LANE_DIR).filter((f) => f.includes(`lanetest_${process.pid}_`)) : [];
    expect(!left.length, `${left.length} lane files left`);
  });
} finally {
  server.kill();
  chrome.kill();
  site.close();
  await sleep(500);
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {}
  for (const f of fs.existsSync(LANE_DIR) ? fs.readdirSync(LANE_DIR) : []) if (f.includes(`lanetest_${process.pid}_`) || /^done-[de]{1}[45]{16}\.json$/.test(f)) fs.rmSync(path.join(LANE_DIR, f), { force: true });
}
const failed = results.filter((r) => r.failures.length);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length && stderr.trim()) {
  if (process.env.PW_TEST_DEBUG) fs.writeFileSync(process.env.PW_TEST_DEBUG_LOG || path.join(os.tmpdir(), 'pw-lanes-test-server.log'), stderr);
  console.log('server stderr (tail):\n' + stderr.trim().split('\n').slice(-15).join('\n'));
}
process.exit(failed.length ? 1 : 0);
