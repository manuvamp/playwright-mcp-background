// WARNING: this one drives your REAL, logged-in browser (Brave by default), through the installed extension.
// Live smoke tests of the Playwright MCP server the way Codex drives it: calls carry
// _meta["x-codex-turn-metadata"] (thread_id; parent_thread_id for sub-agents), each bridge job is its own
// server with its own session, and the job ends by stdin close or a hard kill of the supervisor.
// Runs in the user's real browser (background tabs in collapsed "codex smoke ..." groups, closed at the end).
//   node patches/codex-smoke.mjs <test> [install-dir]   (server entry from PW_MCP_SERVER_NAME, default "brave")
// Needs a password manager that injects an in-field frame (LastPass) for the "type" test to mean anything;
// PW_MCP_BROWSER_USER_DATA (default: Brave's user data dir on Windows) and PW_MCP_PROFILE locate the extension's log.
//   tests: type (typing twice through LastPass) | lanes (3 sub-agents in one job) | jobs (3 jobs at once)
//          | keep (kept tab outlives a crashed job, ~4 min) | done (job end settles tabs at once, both ways)
//          | ref (old "ref" argument name; mid-call LastPass cut) | all (type, lanes, jobs, keep)
// Known: "ref" can fail when LastPass strikes again ~3 s after a recovery while a fill waits (page hangs).
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.join(import.meta.dirname, '..');
const TEST = process.argv[2] || 'all';
const INSTALL = process.argv[3] || (await import('node:module')).createRequire(import.meta.url)('./install-dir.cjs').currentInstall();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const ts = () => ((Date.now() - T0) / 1000).toFixed(1).padStart(6) + 's';
const results = [];
const check = (name, ok, detail = '') => { const line = `${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : '\n        ' + String(detail).slice(0, 700)}`; results.push(line); console.log(line); };

const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')).mcpServers[process.env.PW_MCP_SERVER_NAME || 'brave'];
const cliIdx = cfg.args.findIndex((a) => a.endsWith('cli.js'));
const serverArgs = [path.join(ROOT, 'mcp-supervisor.cjs'), path.join(INSTALL, 'node_modules', '@playwright', 'mcp', 'cli.js'), ...cfg.args.slice(cliIdx + 1)];
const uuid = () => crypto.randomUUID();

async function startServer(label) {
  const sup = spawn(process.execPath, serverArgs, { env: { ...process.env, ...cfg.env, PLAYWRIGHT_MCP_GROUP_NAME: 'codex smoke ' + label, CLAUDE_CODE_SESSION_ID: 'codex-smoke-' + label + '-' + uuid() }, stdio: ['pipe', 'pipe', process.env.SERVER_LOG ? fs.openSync(process.env.SERVER_LOG, 'a') : 'ignore'], windowsHide: true });
  let buf = '', nextId = 1;
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
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex-mcp-client', version: '0.1' } });
  sup.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const root = uuid();
  const server = {
    root,
    // thread: undefined = the job's own (top-level) thread; otherwise a sub-agent thread id.
    async call(thread, name, a = {}) {
      const meta = { 'x-codex-turn-metadata': thread ? { thread_id: thread, parent_thread_id: root, agent_role: 'worker' } : { thread_id: root } };
      const t0 = Date.now();
      const r = await rpc('tools/call', { name, arguments: a, _meta: meta });
      const text = r.timeout ? 'TIMEOUT' : (r.result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      console.log(ts(), `[${label}${thread ? ':' + thread.slice(-4) : ''}] ${name} ${JSON.stringify(a).slice(0, 70)} -> ${Date.now() - t0}ms${r.result?.isError || r.timeout ? ' ERROR' : ''}`);
      return { text, ms: Date.now() - t0, isError: !!(r.timeout || r.result?.isError) };
    },
    // Like Codex at the end of a job: the server process is killed, no shutdown handshake.
    kill() { try { execFileSync('taskkill', ['/PID', String(sup.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} },
    killSupervisorOnly() { try { execFileSync('taskkill', ['/PID', String(sup.pid), '/F'], { stdio: 'ignore' }); } catch {} },
    end() { sup.stdin.end(); },
    pid: sup.pid,
  };
  return server;
}
const tabsOf = (t) => (t.match(/^- \d+:.*$/gm) || []);
const snapRef = (text, label) => {
  let s = text;
  const file = text.match(/\]\(([^)]+\.yml)\)/)?.[1];
  if (file) try { s = fs.readFileSync(path.resolve(file), 'utf8'); } catch {}
  return s.match(new RegExp('textbox "' + label + ':?"[^\\n]*\\[ref=(\\w+)\\]'))?.[1];
};
function closeLog() {
  const userData = process.env.PW_MCP_BROWSER_USER_DATA || path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware', 'Brave-Browser', 'User Data');
  const dir = path.join(userData, process.env.PW_MCP_PROFILE || 'Default', 'Local Extension Settings', 'mmlmfjhmonkocbjadbfplnigmagldckm');
  let out = '';
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.log'))) out += fs.readFileSync(path.join(dir, f), 'latin1');
  return out;
}

async function testType() {
  const s = await startServer('type');
  const nav = await s.call(undefined, 'browser_tabs', { action: 'new', url: 'https://httpbin.org/forms/post' });
  check('job: first call opens its tab', /httpbin/.test(nav.text) && !nav.isError, nav.text.slice(0, 300));
  const r1 = await s.call(undefined, 'browser_type', { element: 'Customer name', target: snapRef(nav.text, 'Customer name'), text: 'Codex Worker' });
  await sleep(5000);
  const snap = await s.call(undefined, 'browser_snapshot', {});
  const r2 = await s.call(undefined, 'browser_type', { element: 'Telephone', target: snapRef(snap.text, 'Telephone'), text: '5550199' });
  await sleep(5000);
  const list = await s.call(undefined, 'browser_tabs', { action: 'list' });
  const ev = await s.call(undefined, 'browser_evaluate', { function: '() => [document.querySelector("input[name=custname]").value, document.querySelector("input[name=custtel]").value].join("|")' });
  check('typing twice (LastPass): no error, tab still there, both values kept', !r1.isError && !r2.isError && tabsOf(list.text).length === 1 && /Codex Worker\|5550199/.test(ev.text), `${r1.text.slice(0, 200)} | ${r2.text.slice(0, 200)} | ${list.text.slice(0, 200)} | ${ev.text.slice(0, 200)}`);
  await s.call(undefined, 'browser_close', {});
  s.kill();
}

async function testLanes() {
  const s = await startServer('lanes');
  const threads = [uuid(), uuid(), uuid()];
  const t0 = Date.now();
  const runs = await Promise.all(threads.map(async (th, n) => {
    const a = await s.call(th, 'browser_tabs', { action: 'new', url: `https://example.com/?worker=${n}` });
    const e1 = await s.call(th, 'browser_evaluate', { function: '() => location.search' });
    await s.call(th, 'browser_wait_for', { time: 2 });
    const e2 = await s.call(th, 'browser_evaluate', { function: '() => location.search' });
    const l = await s.call(th, 'browser_tabs', { action: 'list' });
    return { n, a, e1, e2, l };
  }));
  check('3 sub-agent lanes in one job run side by side', Date.now() - t0 < 25000, `${Date.now() - t0} ms`);
  for (const r of runs) check(`sub-agent ${r.n}: own tab, own page, sees only its tab`, r.e1.text.includes(`worker=${r.n}`) && r.e2.text.includes(`worker=${r.n}`) && tabsOf(r.l.text).length === 1, `${r.e1.text.slice(0, 120)} | ${r.e2.text.slice(0, 120)} | ${r.l.text.slice(0, 300)}`);
  const all = await s.call(undefined, 'browser_tabs', { action: 'list', all: true });
  check('job thread sees the 3 sub-agent tabs with all: true', tabsOf(all.text).length === 3, all.text.slice(0, 500));
  await Promise.all(threads.map((th) => s.call(th, 'browser_tabs', { action: 'close' })));
  const after = await s.call(undefined, 'browser_tabs', { action: 'list', all: true });
  check('sub-agents closed their tabs: none left', tabsOf(after.text).length === 0, after.text.slice(0, 300));
  s.kill();
}

async function testJobs() {
  const t0 = Date.now();
  const runs = await Promise.all([0, 1, 2].map(async (n) => {
    const s = await startServer('job' + n);
    const a = await s.call(undefined, 'browser_tabs', { action: 'new', url: `https://example.org/?job=${n}` });
    const e = await s.call(undefined, 'browser_evaluate', { function: '() => location.search' });
    const l = await s.call(undefined, 'browser_tabs', { action: 'list' });
    await s.call(undefined, 'browser_close', {});
    s.kill();
    return { n, a, e, l };
  }));
  check('3 bridge jobs (3 servers) at once', Date.now() - t0 < 40000, `${Date.now() - t0} ms`);
  for (const r of runs) check(`job ${r.n}: first call ${r.a.ms} ms, own page, one tab (no connect page left)`, r.e.text.includes(`job=${r.n}`) && tabsOf(r.l.text).length === 1, `${r.e.text.slice(0, 120)} | ${r.l.text.slice(0, 300)}`);
}

async function testKeep() {
  const tag = 'keep' + Date.now().toString(36);
  const s = await startServer('keep');
  await s.call(undefined, 'browser_tabs', { action: 'new', url: `https://example.org/?${tag}=kept` });
  const k = await s.call(undefined, 'browser_tabs', { action: 'keep' });
  await s.call(undefined, 'browser_tabs', { action: 'new', url: `https://example.org/?${tag}=forgotten` });
  const l = await s.call(undefined, 'browser_tabs', { action: 'list' });
  check('keep marks the tab', /kept for the user/.test(l.text), `${k.text.slice(0, 200)} | ${l.text.slice(0, 300)}`);
  s.kill();
  console.log(ts(), 'server killed like a finished Codex job; watching the two tabs for 4 min');
  // Fate of both tabs, from the extension's close log and from a fresh session's view of the user's tabs.
  for (let i = 0; i < 26; i++) {
    await sleep(10000);
    const log = closeLog();
    const kept = log.includes(`${tag}=kept`) ? (log.match(new RegExp(`[^{]*${tag}=kept[^}]*`, 'g')) || []).pop() : '';
    const forgot = log.includes(`${tag}=forgotten`) ? (log.match(new RegExp(`[^{]*${tag}=forgotten[^}]*`, 'g')) || []).pop() : '';
    if (forgot && kept) break;
    if (i % 3 === 0) console.log(ts(), 'kept:', kept ? kept.slice(0, 160) : '(no log entry yet)', '| forgotten:', forgot ? forgot.slice(0, 160) : '(no log entry yet)');
  }
  const log = closeLog();
  const keptEntry = (log.match(new RegExp(`\\{[^{}]*${tag}=kept[^{}]*\\}`, 'g')) || []).pop() || '';
  const forgotEntry = (log.match(new RegExp(`\\{[^{}]*${tag}=forgotten[^{}]*\\}`, 'g')) || []).pop() || '';
  check('a tab the job forgot to close is cleaned up after the job ends', /"closed"/.test(forgotEntry), forgotEntry || 'no entry');
  check('a tab kept for the user survives the end of the job', !/"action":"closed"/.test(keptEntry), keptEntry || 'no entry');
  const probe = await startServer('probe');
  const ex = await probe.call(undefined, 'browser_tabs', { action: 'existing' });
  console.log(ts(), 'user-side view after the job:', (ex.text.match(new RegExp(`.*${tag}.*`, 'g')) || ['(no tab with the tag)']).join(' / '));
  await probe.call(undefined, 'browser_close', {});
  probe.kill();
  return tag;
}

async function testRefAlias() {
  const s = await startServer('ref');
  const nav = await s.call(undefined, 'browser_tabs', { action: 'new', url: 'https://httpbin.org/forms/post' });
  const t = await s.call(undefined, 'browser_type', { element: 'Customer name', ref: snapRef(nav.text, 'Customer name'), text: 'Old Style' });
  check('browser_type with ref (old argument name) works', !t.isError, t.text.slice(0, 300));
  await sleep(+(process.env.GAP||3000));
  const snap = await s.call(undefined, 'browser_snapshot', {});
  let f = await s.call(undefined, 'browser_fill_form', { fields: [{ name: 'Telephone', type: 'textbox', ref: snapRef(snap.text, 'Telephone'), value: '5550142' }] });
  if (f.isError) {
    console.log(ts(), 'fill failed mid-call; hint present:', /Your tab is back/.test(f.text));
    const again = await s.call(undefined, 'browser_snapshot', {});
    f = await s.call(undefined, 'browser_fill_form', { fields: [{ name: 'Telephone', type: 'textbox', ref: snapRef(again.text, 'Telephone'), value: '5550142' }] });
  }
  check('browser_fill_form with ref inside fields works (at most one retry)', !f.isError, f.text.slice(0, 1200));
  await sleep(3000);
  const tabsNow = await s.call(undefined, 'browser_tabs', { action: 'list' });
  check('still exactly one tab (no blank tab opened in the gap)', tabsOf(tabsNow.text).length === 1, tabsNow.text.slice(0, 300));
  const ev = await s.call(undefined, 'browser_evaluate', { function: '() => [document.querySelector("input[name=custname]").value, document.querySelector("input[name=custtel]").value].join("|")' });
  check("both values typed through ref", /Old Style\|5550142/.test(ev.text), ev.text.slice(0, 800));
  const bad = await s.call(undefined, 'browser_type', { element: 'x', text: 'y' });
  check('a call with neither ref nor target still gets a clear error', bad.isError && /target/.test(bad.text), bad.text.slice(0, 200));
  await s.call(undefined, 'browser_close', {});
  s.kill();
}

async function testSessionDone(how) {
  const tag = 'done' + how + Date.now().toString(36);
  const s = await startServer('done-' + how);
  await s.call(undefined, 'browser_tabs', { action: 'new', url: `https://example.org/?${tag}=kept` });
  await s.call(undefined, 'browser_tabs', { action: 'keep' });
  await s.call(undefined, 'browser_tabs', { action: 'new', url: `https://example.org/?${tag}=forgotten` });
  const endedAt = Date.now();
  if (how === 'stdin') s.end(); else s.killSupervisorOnly();
  console.log(ts(), `job ended (${how}); watching both tabs for 30 s`);
  let kept = '', forgot = '';
  for (let i = 0; i < 15 && !(kept && forgot); i++) {
    await sleep(2000);
    const log = closeLog();
    kept = (log.match(new RegExp(`\\{[^{}]*${tag}=kept[^{}]*\\}`, 'g')) || []).pop() || '';
    forgot = (log.match(new RegExp(`\\{[^{}]*${tag}=forgotten[^{}]*\\}`, 'g')) || []).pop() || '';
  }
  const secs = ((Date.now() - endedAt) / 1000).toFixed(0);
  check(`${how}: forgotten tab closed within 30 s of the job ending (${secs} s)`, /"action":"closed"/.test(forgot) && /session ended/.test(forgot), forgot || 'no entry');
  check(`${how}: kept tab left open for the user`, /left open for the user/.test(kept), kept || 'no entry');
  return tag;
}

async function testArgAliases() {
  const s = await startServer('args');
  await s.call(undefined, 'browser_tabs', { action: 'new', url: 'https://example.com/?args=1' });
  const e1 = await s.call(undefined, 'browser_evaluate', { script: '() => location.search' });
  check('browser_evaluate with script (instead of function)', !e1.isError && /args=1/.test(e1.text), e1.text.slice(0, 300));
  const e2 = await s.call(undefined, 'browser_evaluate', { function: '() => "fn wins"', script: '() => "script loses"' });
  check('function is kept when both are given', /fn wins/.test(e2.text), e2.text.slice(0, 300));
  const r = await s.call(undefined, 'browser_run_code_unsafe', { script: 'async (page) => page.url()' });
  check('browser_run_code_unsafe with script (instead of code)', !r.isError && /args=1/.test(r.text), r.text.slice(0, 300));
  await s.call(undefined, 'browser_close', {});
  s.kill();
}

try {
  if (TEST === 'args') await testArgAliases();
  if (TEST === 'done') { await testSessionDone('stdin'); await testSessionDone('kill'); }
  if (TEST === 'donekill') await testSessionDone('kill');
  if (TEST === 'ref') await testRefAlias();
  if (TEST === 'type' || TEST === 'all') await testType();
  if (TEST === 'lanes' || TEST === 'all') await testLanes();
  if (TEST === 'jobs' || TEST === 'all') await testJobs();
  if (TEST === 'keep' || TEST === 'all') await testKeep();
} catch (e) {
  check('harness', false, e.stack);
}
console.log('\n' + results.join('\n'));
console.log(`${results.filter((r) => r.startsWith('ok')).length}/${results.length} passed`);
setTimeout(() => process.exit(0), 1000);
