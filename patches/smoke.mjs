// End-to-end smoke test for the background browser setup (extension-bg + broker + patches).
//   node patches/smoke.mjs [--only name1,name2] [--skip-disruptive]
// Needs bridge.mjs (repo root) and an MCP server entry in ~/.claude.json (PW_MCP_SERVER_NAME, default "brave").
// Env: PW_MCP_BROKER_PORT (default 8770), PW_MCP_BROWSER_PROCESS (default brave.exe).
// Runs every scenario through a fresh patched MCP server (bridge.mjs on its own port), in background
// tabs of the user's browser. Samples the foreground window every 250 ms and fails if a browser window takes
// focus while the suite runs. Never submits real forms; all test pages are example.com/.org with
// injected HTML. "Disruptive" cases (extension reload, broker restart) briefly disconnect every
// agent session on this machine, so --skip-disruptive skips them when other threads are working.
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const FILES = path.join(ROOT, 'output', 'smoke-files');
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
const skipDisruptive = args.includes('--skip-disruptive');

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BROKER_PORT = Number(process.env.PW_MCP_BROKER_PORT) || 8770;
const BROWSER_PROC = (process.env.PW_MCP_BROWSER_PROCESS || 'brave.exe').replace(/\.exe$/i, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BROWSER_FG = new RegExp(`^${BROWSER_PROC}\\|`, 'i');
const BROWSER_FG_UNTITLED = new RegExp(`^${BROWSER_PROC}\\|\\s*$`, 'i');
const bridges = [];
async function startBridge(port, env = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, 'bridge.mjs')], { env: { ...process.env, BRIDGE_PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  bridges.push(child);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('bridge did not start')), 30000);
    child.stdout.on('data', (d) => { if (String(d).includes('bridge ready')) { clearTimeout(t); resolve(); } });
    child.on('exit', (c) => reject(new Error('bridge exited ' + c)));
  });
  return async (name, a = {}, timeoutMs = 150000) => {
    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', body: JSON.stringify({ name, arguments: a }), signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    const m = text.match(/### Result\n([\s\S]*?)(\n### |$)/);
    return { text, result: m ? m[1].trim() : null, error: /### Error/.test(text) ? text.split('### Error')[1].trim().split('\n').slice(0, 2).join(' ') : null, ms: Date.now() - started };
  };
}
function killTree(child) {
  try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
}
const ps = (script) => execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim();
const FG_PS = `Add-Type -Namespace S -Name W -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);'
while ($true) { $h = [S.W]::GetForegroundWindow(); $sb = New-Object Text.StringBuilder 256; [void][S.W]::GetWindowText($h, $sb, 256); $p = 0; [void][S.W]::GetWindowThreadProcessId($h, [ref]$p); $n = (Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName; [Console]::Out.WriteLine("$n|$sb"); [Console]::Out.Flush(); Start-Sleep -Milliseconds 250 }`;

// ---------- test fixtures ----------
mkdirSync(path.join(FILES, 'folder', 'sub'), { recursive: true });
writeFileSync(path.join(FILES, 'deck.pdf'), '%PDF-1.4\n%smoke\n');
writeFileSync(path.join(FILES, 'pitch déck – v2 (final).txt'), 'unicode name');
writeFileSync(path.join(FILES, 'folder', 'a.txt'), 'a');
writeFileSync(path.join(FILES, 'folder', 'sub', 'b.txt'), 'bb');
const F = (n) => path.join(FILES, n).replaceAll('\\', '/');

const PAGE = `
<input id=one type=file><input id=many type=file multiple><input id=dir type=file webkitdirectory>
<label id=lbl style="display:inline-block;padding:6px;border:1px solid">Upload<input id=hid type=file hidden></label>
<div id=zone style="width:240px;height:50px;border:2px dashed">drop</div>
<div id=src draggable=true style="width:70px;height:26px;background:#ccc">card</div><div id=dst style="width:180px;height:50px;border:1px solid">col</div>
<input id=txt><select id=sel><option>a</option><option>b</option></select><span id=hov>hover</span>
<button id=alert>alert</button><button id=confirm>confirm</button><button id=prompt>prompt</button>
<a id=blank href="https://example.org/?pw-smoke-popup" target=_blank>blank link</a><button id=winopen>window.open</button><button id=popup>popup window</button>
<button id=busy>busy loop</button><button id=slowfetch>slow fetch</button><p id=log></p>`;
const SETUP = `async (page) => {
  await page.evaluate((html) => {
    document.title = 'pw-smoke';
    document.body.innerHTML = html;
    window.L = (m) => document.getElementById('log').textContent += m + ';';
    const files = (i) => [...i.files].map(f => (f.webkitRelativePath || f.name) + '/' + f.size).join(',');
    for (const id of ['one', 'many', 'dir', 'hid']) document.getElementById(id).addEventListener('change', e => L(id + '=' + files(e.target)));
    zone.addEventListener('dragover', e => e.preventDefault()); zone.addEventListener('drop', e => { e.preventDefault(); L('zone=' + [...e.dataTransfer.files].map(f => f.name).join(',')); });
    src.addEventListener('dragstart', e => e.dataTransfer.setData('text/plain', 'card')); dst.addEventListener('dragover', e => e.preventDefault()); dst.addEventListener('drop', e => { e.preventDefault(); L('drag=' + e.dataTransfer.getData('text/plain')); });
    hov.onmouseenter = () => L('hover'); sel.onchange = () => L('select=' + sel.value); txt.oninput = () => L('typed=' + txt.value);
    document.getElementById('alert').onclick = () => alert('smoke alert');
    document.getElementById('confirm').onclick = () => L('confirm=' + confirm('ok?'));
    document.getElementById('prompt').onclick = () => L('prompt=' + prompt('name?'));
    winopen.onclick = () => window.open('https://example.org/?pw-smoke-winopen', '_blank');
    popup.onclick = () => window.open('https://example.org/?pw-smoke-popupwin', 'smoke', 'popup,width=400,height=300');
    busy.onclick = () => { const end = Date.now() + 200000; while (Date.now() < end) {} };
    slowfetch.onclick = () => fetch('https://httpbin.org/delay/8').then(() => L('slowfetch=done'));
  }, ${JSON.stringify(PAGE)});
  return await page.evaluate(() => document.visibilityState);
}`;
const log = async (call) => (await call('browser_evaluate', { function: `() => document.getElementById('log')?.textContent ?? 'NO LOG'` })).result ?? '';
const vis = async (call) => (await call('browser_evaluate', { function: '() => document.visibilityState' })).result;
async function freshPage(call, tag) {
  await call('browser_navigate', { url: `https://example.com/?pw-smoke-${tag}` });
  return (await call('browser_run_code_unsafe', { code: SETUP })).result;
}
const hasModal = (r) => /Modal state|modal state/.test(r.text);

// ---------- scenarios ----------
const results = [];
const scenarios = [];
const test = (name, fn, { disruptive = false } = {}) => scenarios.push({ name, fn, disruptive });
const expect = (cond, detail) => { if (!cond) throw new Error(detail); };

test('connect + background tab', async ({ call }) => {
  const r = await call('browser_navigate', { url: 'https://example.com/?pw-smoke-connect' });
  expect(!r.error, r.error);
  expect((await vis(call)) === '"hidden"', 'agent tab is not hidden (it is in front of the user)');
  const ua = (await call('browser_evaluate', { function: '() => navigator.userAgent' })).result;
  expect(!/Headless/.test(ua), 'headless browser, not the user\'s real browser');
});
test('uploads: file, multi, unicode, folder, label chooser, drop', async ({ call }) => {
  await freshPage(call, 'upload');
  for (const [target, paths] of [['#one', [F('deck.pdf')]], ['#many', [F('deck.pdf'), F('pitch déck – v2 (final).txt')]], ['#dir', [F('folder')]]]) {
    const r = await call('browser_set_input_files', { target, paths });
    expect(!r.error, `${target}: ${r.error}`);
  }
  let r = await call('browser_click', { target: '#lbl', element: 'label' });
  expect(hasModal(r), 'label click did not open an intercepted file chooser');
  r = await call('browser_file_upload', { paths: [F('deck.pdf')] });
  expect(!r.error, r.error);
  r = await call('browser_drop', { target: '#zone', element: 'zone', paths: [F('deck.pdf')] });
  expect(!r.error, r.error);
  const l = await log(call);
  for (const want of ['one=deck.pdf', 'many=deck.pdf', 'pitch déck – v2 (final).txt', 'dir=folder/a.txt/1', 'folder/sub/b.txt/2', 'hid=deck.pdf', 'zone=deck.pdf'])
    expect(l.includes(want), `missing "${want}" in ${l}`);
});
test('input: type, select, hover, drag, click', async ({ call }) => {
  await freshPage(call, 'input');
  for (const [tool, a] of [['browser_type', { target: '#txt', text: 'Tester' }], ['browser_select_option', { target: '#sel', values: ['b'] }], ['browser_hover', { target: '#hov', element: 'hov' }], ['browser_drag', { startTarget: '#src', startElement: 'card', endTarget: '#dst', endElement: 'col' }]]) {
    const r = await call(tool, a);
    expect(!r.error, `${tool}: ${r.error}`);
    expect(r.ms < 15000, `${tool} took ${r.ms} ms`);
  }
  const l = await log(call);
  for (const want of ['typed=Tester', 'select=b', 'hover', 'drag=card']) expect(l.includes(want), `missing ${want} in ${l}`);
});
test('dialogs: alert, confirm, prompt are reported and handled', async ({ call }) => {
  await freshPage(call, 'dialogs');
  for (const [id, accept, text] of [['alert', true], ['confirm', false], ['prompt', true, 'Bob']]) {
    const r = await call('browser_click', { target: '#' + id, element: id });
    expect(r.ms < 20000, `${id} click took ${r.ms} ms`);
    expect(hasModal(r), `${id}: dialog not reported as modal state`);
    const h = await call('browser_handle_dialog', { accept, ...(text ? { promptText: text } : {}) });
    expect(!h.error, `${id} handle: ${h.error}`);
  }
  const l = await log(call);
  expect(l.includes('confirm=false') && l.includes('prompt=Bob'), 'dialog results wrong: ' + l);
});
test('popups: target=_blank, window.open, popup window stay in background', async ({ call, focusSteals }) => {
  await freshPage(call, 'popups');
  for (const id of ['blank', 'winopen', 'popup']) {
    const before = focusSteals();
    const r = await call('browser_click', { target: '#' + id, element: id });
    expect(!r.error || /modal/i.test(r.error), `${id}: ${r.error}`);
    await sleep(1500);
    expect(focusSteals() === before, `${id} brought Brave to the front`);
  }
  const tabs = (await call('browser_tabs', { action: 'list' })).text;
  for (let i = 0; i < 4; i++) {
    const list = (await call('browser_tabs', { action: 'list' })).text;
    const m = [...list.matchAll(/^- (\d+): .*pw-smoke-(popup|winopen|popupwin)/gm)];
    if (!m.length) break;
    await call('browser_tabs', { action: 'close', index: +m[0][1] });
  }
  return tabs.split('\n').filter((l) => /^- \d+:/.test(l)).length + ' tabs seen';
});
test('page busy loop: call gives up within the cap, next call works', async ({ capCall }) => {
  await freshPage(capCall, 'busy');
  const r = await capCall('browser_click', { target: '#busy', element: 'busy' });
  expect(r.ms < 40000, `busy click took ${r.ms} ms (cap is 15 s in this test)`);
  const n = await capCall('browser_navigate', { url: 'https://example.com/?pw-smoke-after-busy' });
  expect(n.ms < 60000, `recovery navigate took ${n.ms} ms`);
  return `click returned after ${r.ms} ms (${r.error ? 'error' : 'ok'}); recovery navigate ${n.error ? 'ERR ' + n.error : 'ok'} in ${n.ms} ms`;
});
test('stuck run_code: capped, next call works', async ({ capCall }) => {
  const r = await capCall('browser_run_code_unsafe', { code: 'async (page) => { await new Promise(() => {}); }' });
  expect(r.ms < 25000 && /gave up/.test(r.error ?? ''), `not capped: ${r.ms} ms ${r.error}`);
  const n = await capCall('browser_evaluate', { function: '() => 1' });
  expect(n.result === '1', 'call after cap failed: ' + n.error);
});
test('in-page work in a frozen-prone background tab', async ({ call }) => {
  await freshPage(call, 'timers');
  await sleep(4000);
  const r = await call('browser_run_code_unsafe', { code: `async (page) => { const s = Date.now(); await page.evaluate(() => new Promise(r => setTimeout(r, 1500))); const t = Date.now() - s; const f = Date.now(); await page.evaluate(() => fetch('/').then(r => r.status)); return { timer1500: t, fetch: Date.now() - f }; }` });
  expect(r.result, r.error);
  const v = JSON.parse(r.result);
  expect(v.timer1500 < 8000, `1.5 s timer took ${v.timer1500} ms (tab frozen/throttled)`);
  expect(v.fetch < 8000, `fetch took ${v.fetch} ms`);
  return r.result;
});
test('slow site request (8 s) does not stall the tool', async ({ call }) => {
  await freshPage(call, 'slow');
  const r = await call('browser_click', { target: '#slowfetch', element: 'slow fetch' });
  expect(r.ms < 15000, `click waited ${r.ms} ms`);
  await call('browser_wait_for', { time: 9 });
  expect((await log(call)).includes('slowfetch=done'), 'slow fetch never completed (tab frozen?)');
  return `click returned in ${r.ms} ms`;
});
test('agent tab closed by the user: next call recovers', async ({ call }) => {
  await call('browser_navigate', { url: 'https://example.com/?pw-smoke-close' });
  await call('browser_run_code_unsafe', { code: 'async (page) => { await page.close(); }' });
  const r = await call('browser_navigate', { url: 'https://example.com/?pw-smoke-after-close' });
  expect(!r.error, 'did not recover: ' + r.error);
});
test('navigation to a dead host returns an error quickly', async ({ call }) => {
  const r = await call('browser_navigate', { url: 'https://pw-smoke-does-not-exist.invalid/' });
  expect(r.ms < 30000, `took ${r.ms} ms`);
  return r.error ? 'error (expected): ' + r.error.slice(0, 80) : 'loaded an error page';
});
test('extension reload: sessions reconnect', async ({ call }) => {
  await call('browser_navigate', { url: 'https://example.com/?pw-smoke-pre-reload' });
  await fetch(`http://127.0.0.1:${BROKER_PORT}/reload`, { method: 'POST' });
  for (let i = 0; i < 30; i++) { await sleep(1000); const s = await (await fetch(`http://127.0.0.1:${BROKER_PORT}/status`)).json(); if (s.extension) break; }
  let r = await call('browser_navigate', { url: 'https://example.com/?pw-smoke-post-reload' });
  if (r.error) r = await call('browser_navigate', { url: 'https://example.com/?pw-smoke-post-reload-2' });
  expect(!r.error, 'no recovery after extension reload: ' + r.error);
  return r.error ? 'recovered on 2nd call' : 'recovered on 1st call';
}, { disruptive: true });
test('broker killed: next connect restarts it', async () => {
  ps(`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ? { $_.CommandLine -match 'broker\\.cjs' } | % { Stop-Process -Id $_.ProcessId -Force }`);
  await sleep(1000);
  const call = await startBridge(8769);
  const r = await call('browser_navigate', { url: 'https://example.com/?pw-smoke-broker' });
  expect(!r.error, 'connect after broker kill failed: ' + r.error);
  const s = await (await fetch(`http://127.0.0.1:${BROKER_PORT}/status`)).json();
  expect(s.extension, 'broker restarted but extension not connected');
}, { disruptive: true });

// ---------- run ----------
const fg = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', FG_PS], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
let fgSamples = [], steals = 0, startFg = null, lastSteal = null; const stealLines = [];
fg.stdout.on('data', (d) => {
  for (const line of String(d).split(/\r?\n/).filter(Boolean)) {
    if (!startFg) startFg = line;
    fgSamples.push(line);
    // Only agent windows count: our test pages ("pw-smoke", "Example Domain") or an untitled browser
    // window (e.g. "Page unresponsive" prompt). The user switching to their own browser tabs is not a steal.
    const agentWindow = BROWSER_FG.test(line) && (/pw-smoke|Example Domain/.test(line) || BROWSER_FG_UNTITLED.test(line));
    if (agentWindow && line !== lastSteal) { steals++; stealLines.push(new Date().toISOString().slice(11, 19) + ' ' + line); }
    lastSteal = agentWindow ? line : null;
  }
});
await sleep(800);
const call = await startBridge(8768);
const capCall = await startBridge(8767, { PW_MCP_TOOL_CAP_MS: '15000' });
for (const s of scenarios) {
  if (only && !only.includes(s.name.split(':')[0]) && !only.some((o) => s.name.startsWith(o))) continue;
  if (s.disruptive && skipDisruptive) { results.push([s.name, 'SKIP', 'disruptive']); continue; }
  const t = Date.now(), stealsBefore = steals;
  try {
    const info = await s.fn({ call, capCall, focusSteals: () => steals });
    const stole = steals > stealsBefore;
    results.push([s.name, stole ? 'FAIL' : 'PASS', (stole ? 'browser took focus: ' + stealLines.slice(stealsBefore).join(' / ') + ' ' : '') + (info ?? '') + ` (${Date.now() - t} ms)`]);
  } catch (e) {
    results.push([s.name, 'FAIL', e.message.slice(0, 300) + ` (${Date.now() - t} ms)`]);
  }
}
for (const b of bridges) killTree(b);
killTree(fg);
rmSync(FILES, { recursive: true, force: true });
const startedInBrave = BROWSER_FG.test(startFg ?? '');
console.log(`foreground at start: ${startFg}${startedInBrave ? '  (the browser was already in front: focus check not meaningful)' : ''}`);
for (const [n, st, d] of results) console.log(`${st.padEnd(4)}  ${n}  ${d}`);
const failed = results.filter((r) => r[1] === 'FAIL').length;
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
