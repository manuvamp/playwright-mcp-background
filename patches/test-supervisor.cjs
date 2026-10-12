// Tests mcp-supervisor.cjs like Claude Code would use it: handshake, tool calls, child killed
// mid-session, child killed during a call, and a code update while idle. Uses background tabs only.
//   node patches/test-supervisor.cjs [--server <name>]   (name defaults to PW_MCP_SERVER_NAME or "brave")
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const serverName = (process.argv.includes('--server') ? process.argv[process.argv.indexOf('--server') + 1] : null) || process.env.PW_MCP_SERVER_NAME || 'brave';
const cfg = JSON.parse(fs.readFileSync(path.join(require('os').homedir(), '.claude.json'), 'utf8')).mcpServers[serverName];
const cliIdx = cfg.args.findIndex((a) => a.endsWith('cli.js'));
const sup = spawn(process.execPath, [path.join(ROOT, 'mcp-supervisor.cjs'), ...cfg.args.slice(cliIdx)], { env: { ...process.env, ...cfg.env }, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
let buf = '', nextId = 1;
const waiting = new Map(), notes = [];
sup.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    else if (msg.method) notes.push(msg.method);
  }
});
const rpc = (method, params, timeoutMs = 90000) => new Promise((resolve) => {
  const id = nextId++;
  const t = setTimeout(() => { waiting.delete(id); resolve({ timeout: true }); }, timeoutMs);
  waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
  sup.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const call = (name, args) => rpc('tools/call', { name, arguments: args });
const text = (r) => r.timeout ? 'TIMEOUT' : r.error ? 'RPC ERROR: ' + r.error.message : (r.result?.isError ? 'TOOL ERROR: ' : '') + (r.result?.content?.[0]?.text ?? '').split('\n').slice(0, 2).join(' ');
const childPid = () => {
  const out = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${sup.pid}" | ? { $_.CommandLine -match 'cli.js' }).ProcessId`], { encoding: 'utf8', windowsHide: true }).trim();
  return +out.split(/\s+/)[0];
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);

(async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'supervisor-test', version: '1' } });
  sup.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  check('handshake', !!init.result?.serverInfo, init.result?.serverInfo?.name ?? JSON.stringify(init).slice(0, 100));
  const list = await rpc('tools/list', {});
  check('tools/list', (list.result?.tools?.length ?? 0) > 10, `${list.result?.tools?.length} tools, set_input_files=${!!list.result?.tools?.find((t) => t.name === 'browser_set_input_files')}`);
  let r = await call('browser_navigate', { url: 'https://example.com/?pw-sup-1' });
  check('first call', /example\.com/.test(text(r)) && !/ERROR/.test(text(r)), text(r));

  // 1) child killed while idle
  const pid1 = childPid();
  execFileSync('taskkill', ['/PID', String(pid1), '/F'], { stdio: 'ignore' });
  await sleep(1500);
  r = await call('browser_navigate', { url: 'https://example.com/?pw-sup-2' });
  const pid2 = childPid();
  check('child killed while idle -> next call works, no /mcp', !/ERROR|TIMEOUT/.test(text(r)) && pid2 !== pid1, `${text(r)} (child ${pid1} -> ${pid2})`);

  // 2) child killed during a call
  const slow = call('browser_run_code_unsafe', { code: 'async (page) => { await new Promise(r => setTimeout(r, 20000)); return 1; }' });
  await sleep(2000);
  execFileSync('taskkill', ['/PID', String(childPid()), '/F'], { stdio: 'ignore' });
  r = await slow;
  check('child killed mid-call -> clear error (no hang)', /restarted/.test(text(r)), text(r));
  r = await call('browser_navigate', { url: 'https://example.com/?pw-sup-3' });
  check('  ... and the following call works', !/ERROR|TIMEOUT/.test(text(r)), text(r));

  // 3) code update while idle -> child replaced automatically
  const pid3 = childPid();
  const bundle = path.join(ROOT, 'node_modules', 'playwright-core', 'lib', 'coreBundle.js');
  const now = new Date();
  fs.utimesSync(bundle, now, now);
  await sleep(8000);
  const pid4 = childPid();
  r = await call('browser_navigate', { url: 'https://example.com/?pw-sup-4' });
  check('code update -> fresh child picks it up', pid4 && pid4 !== pid3 && !/ERROR|TIMEOUT/.test(text(r)), `child ${pid3} -> ${pid4}; ${text(r)}`);
  check('client told tools may have changed', notes.includes('notifications/tools/list_changed'), notes.join(','));

  sup.stdin.end();
  await sleep(1500);
  let alive = false;
  try { process.kill(sup.pid, 0); alive = true; } catch {}
  check('supervisor exits when Claude closes it', !alive, alive ? 'still running' : 'exited');
  console.log(results.join('\n'));
  process.exit(results.some((l) => l.startsWith('FAIL')) ? 1 : 0);
})();
