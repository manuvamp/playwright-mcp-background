// Small HTTP bridge used by patches/smoke.mjs: runs the configured Playwright MCP server entry from
// ~/.claude.json (mcpServers.<PW_MCP_SERVER_NAME>, default "brave") and lets you drive the real browser
// with plain HTTP. POST {name, arguments} to http://127.0.0.1:$BRIDGE_PORT (default 8765) → MCP tools/call
// result (images are written to ./output/).
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const OUT = path.join(import.meta.dirname, 'output');
mkdirSync(OUT, { recursive: true });
const cfg = JSON.parse(readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')).mcpServers[process.env.PW_MCP_SERVER_NAME || 'brave'];
const child = spawn(cfg.command, cfg.args, { env: { ...process.env, ...cfg.env }, stdio: ['pipe', 'pipe', 'inherit'] });
let nextId = 1, buf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
const rpc = (method, params) => new Promise((res) => { const id = nextId++; pending.set(id, res); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bridge', version: '1' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

let shot = 0;
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    let request;
    try { request = JSON.parse(body || '{}'); } catch (e) { res.end('ERROR bad JSON: ' + e.message); return; }
    const { name, arguments: args = {} } = request;
    const msg = await rpc('tools/call', { name, arguments: args });
    const out = [];
    for (const part of msg.result?.content ?? []) {
      if (part.type === 'text') out.push(part.text);
      else if (part.type === 'image') {
        const file = path.join(OUT, `bridge-${++shot}.png`);
        writeFileSync(file, Buffer.from(part.data, 'base64'));
        out.push(`[image] ${file}`);
      }
    }
    if (msg.error) out.push('ERROR ' + JSON.stringify(msg.error));
    res.end(out.join('\n'));
  });
}).listen(+(process.env.BRIDGE_PORT || 8765), '127.0.0.1', () => console.log('bridge ready'));
