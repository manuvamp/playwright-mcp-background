// WARNING: this one drives your REAL, logged-in browser (Brave by default), through the installed extension.
// Live check of lanes in the user's real browser, through the extension, like a Claude session with two
// subagents: both drive their own background tab at the same time. Then a second chat whose first call
// is browser_tabs new, with a helper that keeps one tab for the user and finishes: no connect page may be
// left behind, and only the kept tab stays. Background tabs only (collapsed "🤖 lanes live check"
// groups, closed at the end); no extension reload, no other chat affected.
//   node patches/live-lanes.mjs [install-dir]   (server entry from PW_MCP_SERVER_NAME, default "brave")
// It is also run by deploy-extension.cjs after a reload. Use test-lanes.mjs for a headless-only check.
// Expects the extension build in the browser to answer tab groups (extension-next); with the older build it
// checks that the server reports that clearly instead.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL = path.resolve(process.argv[2] || createRequire(import.meta.url)('./install-dir.cjs').currentInstall());
const LANE_DIR = process.env.PW_LANE_DIR || path.join(ROOT, 'lane-ids');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const serverName = process.env.PW_MCP_SERVER_NAME || 'brave';
const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')).mcpServers[serverName];
const cliIdx = cfg.args.findIndex((a) => a.endsWith('cli.js'));
const args = [path.join(ROOT, 'mcp-supervisor.cjs'), path.join(INSTALL, 'node_modules', '@playwright', 'mcp', 'cli.js'), ...cfg.args.slice(cliIdx + 1)];
let n = 0;
const servers = [];
// One MCP server (through the supervisor, like a chat): a fresh connection to the extension, with its
// own connect page.
async function startServer() {
  const sup = spawn(process.execPath, args, { env: { ...process.env, ...cfg.env, PLAYWRIGHT_MCP_GROUP_NAME: 'lanes live check' }, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  servers.push(sup);
  let buf = '';
  let nextId = 1;
  const waiting = new Map();
  sup.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    }
  });
  const rpc = (method, params, timeoutMs = 150000) => new Promise((resolve) => {
    const id = nextId++;
    const t = setTimeout(() => { waiting.delete(id); resolve({ timeout: true }); }, timeoutMs);
    waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
    sup.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '1' } });
  sup.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  return async function call(lane, name, a = {}) {
    const id = `toolu_livelanes_${process.pid}_${++n}`;
    fs.mkdirSync(LANE_DIR, { recursive: true });
    fs.writeFileSync(path.join(LANE_DIR, id + '.json'), JSON.stringify({ agent: lane, type: lane === 'main' ? '' : 'general-purpose' }));
    const t0 = Date.now();
    const r = await rpc('tools/call', { name, arguments: a, _meta: { 'claudecode/toolUseId': id } });
    const text = r.timeout ? 'TIMEOUT' : (r.result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    return { text, ms: Date.now() - t0, isError: r.timeout || !!r.result?.isError };
  };
}
const pageUrl = (t) => t.match(/- Page URL: (\S+)/)?.[1] || '';
const tabCount = (t) => (t.match(/^- \d+:/gm) || []).length;
const results = [];
const check = (name, ok, detail = '') => { results.push(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : '\n        ' + String(detail).slice(0, 600)}`); };

const A = 'a1ive0000000000aa', B = 'b1ive0000000000bb', C = 'c1ive0000000000cc';
try {
  const call = await startServer();

  const [ra, rb] = await Promise.all([call(A, 'browser_navigate', { url: 'https://example.com/?lane=a' }), call(B, 'browser_navigate', { url: 'https://example.org/?lane=b' })]);
  check('two agents navigate at once, each on its own tab', pageUrl(ra.text).includes('lane=a') && pageUrl(rb.text).includes('lane=b'), `A: ${pageUrl(ra.text) || ra.text.slice(0, 300)} | B: ${pageUrl(rb.text) || rb.text.slice(0, 300)}`);

  const [ea, eb] = await Promise.all([call(A, 'browser_evaluate', { function: '() => location.search' }), call(B, 'browser_evaluate', { function: '() => location.search' })]);
  check('each agent evaluates in its own page', /lane=a/.test(ea.text) && /lane=b/.test(eb.text), `${ea.text.slice(0, 200)} | ${eb.text.slice(0, 200)}`);

  const t0 = Date.now();
  await Promise.all([call(A, 'browser_wait_for', { time: 2 }), call(B, 'browser_wait_for', { time: 2 })]);
  check('calls run side by side (two 2 s waits)', Date.now() - t0 < 4500, `${Date.now() - t0} ms`);

  const all = await call('main', 'browser_tabs', { action: 'list', all: true });
  check('main agent sees both helpers\' tabs with all: true', /lane=a/.test(all.text) && /lane=b/.test(all.text) && /subagent a1ive000/.test(all.text), all.text);
  check('no connect page left (the first helper navigated it)', !/connect\.html/.test(all.text), all.text);
  const own = await call(B, 'browser_tabs', { action: 'list' });
  check('a helper\'s own list has only its tab', /lane=b/.test(own.text) && !/lane=a/.test(own.text), own.text);

  const g = await call(A, 'browser_tabs', { action: 'group', group: 'Helper A' });
  const grouped = !g.isError && /Helper A/.test(g.text);
  const oldExtension = g.isError && /updated Playwright Extension build/.test(g.text);
  check('tab group: moved (new extension) or clearly reported (old extension)', grouped || oldExtension, g.text);
  results.push(`info  extension build answers tab groups: ${grouped ? 'yes' : 'no (extension-next not loaded yet)'}`);
  if (grouped) {
    const nb = await call(A, 'browser_tabs', { action: 'new', url: 'https://example.com/?lane=a2' });
    check('helper\'s next new tab opens in its group', !nb.isError && /\{group: Helper A\}/.test((await call(A, 'browser_tabs', { action: 'list' })).text), nb.text);
  }

  // Done: close every tab; the extension closes the emptied group by itself.
  // (A list with no tabs left would open a new one, so count first.)
  for (const lane of [A, B]) {
    const count = tabCount((await call(lane, 'browser_tabs', { action: 'list' })).text);
    for (let i = 0; i < count; i++) await call(lane, 'browser_tabs', { action: 'close' });
  }
  const left = await call('main', 'browser_tabs', { action: 'list', all: true });
  check('all tabs closed', /No open tabs in this session/.test(left.text), left.text);

  // A second chat whose first call is browser_tabs new: in earlier builds its "<thread> connected" page
  // stayed behind. Its helper keeps one tab for the user and then finishes (what the SubagentStop hook writes).
  const call2 = await startServer();
  const c1 = await call2(C, 'browser_tabs', { action: 'new', url: 'https://example.com/?lane=c1' });
  const c2 = await call2(C, 'browser_tabs', { action: 'new', url: 'https://example.org/?lane=c2' });
  const all2 = await call2('main', 'browser_tabs', { action: 'list', all: true });
  check('first call "new": the connect page became that tab, nothing else open', !c1.isError && !c2.isError && !/connect\.html/.test(all2.text) && tabCount(all2.text) === 2, all2.text);
  await call2(C, 'browser_tabs', { action: 'keep', index: 0 });
  const done = path.join(LANE_DIR, `done-${C}.json`);
  fs.writeFileSync(done, JSON.stringify({ agent: C, at: Date.now() }));
  for (let i = 0; i < 40 && fs.existsSync(done); i++) await sleep(250);
  const after = await call2('main', 'browser_tabs', { action: 'list', all: true });
  check('helper finished: its other tab closed, the kept one stays for the user', !fs.existsSync(done) && /kept for the user[^\n]*lane=c1/.test(after.text) && !/lane=c2/.test(after.text) && tabCount(after.text) === 1, after.text);
  await call2('main', 'browser_tabs', { action: 'close', index: 0, all: true });
  const left2 = await call2('main', 'browser_tabs', { action: 'list', all: true });
  check('second chat: all tabs closed', /No open tabs in this session/.test(left2.text), left2.text);

  // A third chat and "The user's" tabs (extension build 14): stand-ins opened from the extension's connect page
  // with chrome.tabs.create, like tabs they opened themselves (background, end of their tab strip, removed at the
  // end). The main agent keeps the connect page as its current tab to reach the chrome APIs.
  const call3 = await startServer();
  const ex = await call3('main', 'browser_tabs', { action: 'existing' });
  const userBuild = !ex.isError;
  results.push(`info  extension build knows the user's tabs: ${userBuild ? 'yes' : 'no (extension-next not loaded yet)'}`);
  if (!userBuild) check('The user\'s tabs with the old extension: clearly reported', /updated Playwright Extension build/.test(ex.text), ex.text);
  else {
    const chromeApi = async (fn) => {
      const r = await call3('main', 'browser_evaluate', { function: fn });
      const m = r.text.match(/### Result\n([\s\S]*?)\n(###|$)/);
      return m ? JSON.parse(m[1]) : r.text;
    };
    await call3('main', 'browser_tabs', { action: 'list' });
    // Used every 1.5 s, the connect page is never "idle" or "done" for the extension's cleanups meanwhile.
    const ping = setInterval(() => void call3('main', 'browser_evaluate', { function: '() => 1' }), 1500);
    const user = await chromeApi("async () => { const ids = []; for (const q of ['take', 'nav', 'drag']) ids.push((await chrome.tabs.create({ url: 'https://example.com/?user=' + q, active: false })).id); return ids; }");
    try {
      const [M1, M2, M3] = user;
      await sleep(2500); // older than a tab Brave groups as it opens
      const list = await call3('main', 'browser_tabs', { action: 'existing' });
      check('existing lists the user\'s tabs (not agents\')', user.every((id) => list.text.includes(`tabId ${id}:`)) && !/connect\.html/.test(list.text), list.text);
      const T = 't1ive0000000000tt', N = 'n1ive0000000000nn', H = 'h1ive0000000000hh';
      const take = await call3(T, 'browser_tabs', { action: 'take', tabId: M1 });
      check('take: the agent works in the user\'s tab as it is', !take.isError && /\(current, the user's tab\)[^\n]*user=take/.test(take.text) && /user=take/.test(pageUrl(take.text)), take.text);
      const nav = await call3(N, 'browser_navigate', { url: 'https://example.com/?user=nav' });
      check('navigate to a page the user has open: uses their tab', !nav.isError && /the user already had this page open/.test(nav.text) && /\(current, the user's tab\)[^\n]*user=nav/.test((await call3(N, 'browser_tabs', { action: 'list' })).text), nav.text);
      await call3(H, 'browser_tabs', { action: 'new', url: 'https://example.org/?lane=h', group: 'Helper H' });
      await chromeApi(`async () => { const g = (await chrome.tabGroups.query({})).find((g) => g.title?.endsWith(' · Helper H')); await chrome.tabs.group({ groupId: g.id, tabIds: [${M3}] }); return g.id; }`);
      await sleep(1500);
      const told = await call3(H, 'browser_tabs', { action: 'list' });
      check('a tab the user drags into a helper\'s group: that helper is told and has it', /### The user handed you a tab/.test(told.text) && /\(the user's tab\)[^\n]*user=drag/.test(told.text), told.text);
      // T finishes (SubagentStop), N and H close their tabs: The user's three stay open, out of the agent groups.
      const done = path.join(LANE_DIR, `done-${T}.json`);
      fs.writeFileSync(done, JSON.stringify({ agent: T, at: Date.now() }));
      for (let i = 0; i < 40 && fs.existsSync(done); i++) await sleep(250);
      const closeN = await call3(N, 'browser_tabs', { action: 'close' });
      check('closing the user\'s tab says it was given back', /given back to them/.test(closeN.text), closeN.text);
      for (let i = tabCount((await call3(H, 'browser_tabs', { action: 'list' })).text); i > 0; i--) await call3(H, 'browser_tabs', { action: 'close' });
      await sleep(500);
      const after = await chromeApi(`async () => Promise.all(${JSON.stringify(user)}.map((id) => chrome.tabs.get(id).then((t) => t.groupId, () => 'closed')))`);
      check('helper done / tabs closed: The user\'s tabs stay open, out of the agent groups', Array.isArray(after) && after.every((g) => g === -1), JSON.stringify(after));
    } finally {
      await chromeApi(`async () => { await chrome.tabs.remove(${JSON.stringify(user)}).catch(() => {}); return true; }`).catch(() => {});
      clearInterval(ping);
    }
  }
  const left3 = await call3('main', 'browser_tabs', { action: 'close' });
  check('third chat: closed', !left3.isError, left3.text);
} catch (e) {
  check('threw', false, e.stack);
} finally {
  for (const sup of servers) sup.stdin.end();
  await sleep(2000);
  for (const f of fs.existsSync(LANE_DIR) ? fs.readdirSync(LANE_DIR) : []) if (f.includes(`livelanes_${process.pid}_`) || /^done-[ct]1ive0+(cc|tt)\.json$/.test(f)) fs.rmSync(path.join(LANE_DIR, f), { force: true });
}
console.log(results.join('\n'));
process.exit(results.some((l) => l.startsWith('FAIL')) ? 1 : 0);
