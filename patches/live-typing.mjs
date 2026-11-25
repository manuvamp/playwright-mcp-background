// WARNING: this one drives your REAL, logged-in browser (Brave by default), through the installed extension.
// Live check: typing into a form in a background agent tab must not lose the tab. LastPass's
// in-field iframe used to force-detach the debugger (build-extension.cjs 16). Uses httpbin.org/forms/post.
//   SECOND=1 node patches/live-typing.mjs [install-dir] [type|fill|click|none] [lane] [watchSeconds]   (server entry from PW_MCP_SERVER_NAME, default "brave")
// Expect '- 0: (current, yours)' on every poll and both typed values at the end. Run from a scratch dir (writes server-stderr-*.log).
// It types into a form in a background agent tab, then watches whether the tab survives.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const INSTALL = process.argv[2] || (await import('node:module')).createRequire(import.meta.url)('./install-dir.cjs').currentInstall();
const TOOL = process.argv[3] || 'type';
const LANE = process.argv[4] || 'typingcheck000000';
const WATCH = +(process.argv[5] || 12);
const LANE_DIR = process.env.PW_LANE_DIR || path.join(ROOT, 'lane-ids');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')).mcpServers[process.env.PW_MCP_SERVER_NAME || 'brave'];
const cliIdx = cfg.args.findIndex((a) => a.endsWith('cli.js'));
const args = [path.join(ROOT, 'mcp-supervisor.cjs'), path.join(INSTALL, 'node_modules', '@playwright', 'mcp', 'cli.js'), ...cfg.args.slice(cliIdx + 1)];
const sup = spawn(process.execPath, args, { env: { ...process.env, ...cfg.env, PLAYWRIGHT_MCP_GROUP_NAME: 'tab close repro' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
sup.stderr.pipe(fs.createWriteStream(`server-stderr-${TOOL}.log`));
let buf = '', nextId = 1, n = 0;
const waiting = new Map();
const T0 = Date.now();
const ts = () => ((Date.now() - T0) / 1000).toFixed(1).padStart(6) + 's';
sup.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    else if (msg.method) console.log(ts(), 'notification', msg.method);
  }
});
const rpc = (method, params, timeoutMs = 150000) => new Promise((resolve) => {
  const id = nextId++;
  const t = setTimeout(() => { waiting.delete(id); resolve({ timeout: true }); }, timeoutMs);
  waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
  sup.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
async function call(name, a = {}) {
  const id = `toolu_repro_${process.pid}_${++n}`;
  fs.mkdirSync(LANE_DIR, { recursive: true });
  fs.writeFileSync(path.join(LANE_DIR, id + '.json'), JSON.stringify({ agent: LANE, type: LANE === 'main' ? '' : 'worker' }));
  const t0 = Date.now();
  const r = await rpc('tools/call', { name, arguments: a, _meta: { 'claudecode/toolUseId': id } });
  const text = r.timeout ? 'TIMEOUT' : (r.result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  console.log(ts(), `${name} ${JSON.stringify(a).slice(0, 100)} -> ${Date.now() - t0}ms${r.result?.isError ? ' ERROR' : ''}`);
  return text;
}
const snapRefs = (text) => {
  let s = text;
  const file = text.match(/\]\(([^)]+\.yml)\)/)?.[1];
  if (file) try { s = fs.readFileSync(path.resolve(file), 'utf8'); } catch {}
  const get = (label) => s.match(new RegExp('textbox "' + label + ':?"[^\\n]*\\[ref=(\\w+)\\]'))?.[1];
  return { name: get('Customer name'), tel: get('Telephone') };
};

try {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '1' } });
  sup.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const nav = await call('browser_navigate', { url: 'https://httpbin.org/forms/post' });
  const refs = snapRefs(nav);
  console.log(ts(), 'refs', JSON.stringify(refs));
  let out = '';
  if (process.env.LPIGNORE) console.log((await call('browser_evaluate', { function: '() => { for (const el of document.querySelectorAll("input, textarea, select, form")) { el.setAttribute("data-lpignore", "true"); } return document.querySelectorAll("[data-lpignore]").length; }' })).split('\n').slice(0, 2).join(' '));
  if (process.env.OBSERVE) console.log((await call('browser_evaluate', { function: `() => {
    const kill = (n) => { if (n.nodeType === 1) { const list = n.tagName === 'IFRAME' ? [n] : [...n.querySelectorAll('iframe')]; for (const f of list) { const src = f.getAttribute('src') || ''; window.__seen = (window.__seen || []).concat(src); if (/^chrome-extension:/.test(src)) f.remove(); } } };
    new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) kill(n); }).observe(document.documentElement, { childList: true, subtree: true });
    return 'observer on';
  }` })).split('\n').slice(0, 2).join(' '));
  if (TOOL === 'type') out = await call('browser_type', { element: 'Customer name', target: refs.name, text: 'Repro Test' });
  else if (TOOL === 'fill') out = await call('browser_fill_form', { fields: [{ name: 'Customer name', type: 'textbox', target: refs.name, value: 'Repro Test' }, { name: 'Telephone', type: 'textbox', target: refs.tel, value: '12345' }] });
  else if (TOOL === 'click') out = await call('browser_click', { element: 'Customer name', target: refs.name });
  else out = await call('browser_wait_for', { time: 1 });
  console.log(out.slice(0, 1500));
  for (let i = 0; i < WATCH; i++) {
    await sleep(1000);
    const list = await call('browser_tabs', { action: 'list', all: true });
    console.log('        ', list.split('\n').filter((l) => /^- \d+:/.test(l)).join(' | ') || list.slice(0, 200));
  }
  if (process.env.SECOND) {
    // Second field soon after the first recovery (inside the upstream 3 s re-attach cooldown).
    const snap = await call('browser_snapshot', {});
    const r2 = snapRefs(snap);
    console.log(ts(), 'refs after recovery', JSON.stringify(r2));
    await call('browser_type', { element: 'Telephone', target: r2.tel, text: '5550100' });
    for (let i = 0; i < WATCH; i++) {
      await sleep(1000);
      const list = await call('browser_tabs', { action: 'list', all: true });
      console.log('        ', list.split('\n').filter((l) => /^- \d+:/.test(l)).join(' | ') || list.slice(0, 200));
    }
  }
  const ev = await call('browser_evaluate', { function: '() => [document.querySelector("input[name=custname]")?.value, document.querySelector("input[name=custtel]")?.value, !!document.querySelector("[data-lastpass-root]")]' });
  console.log(ev.split('\n').slice(0, 4).join(' / '));
} finally {
  await call('browser_close', {}).catch(() => {});
  sup.stdin.end();
  setTimeout(() => process.exit(0), 1500);
}
