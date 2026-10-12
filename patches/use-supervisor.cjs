// Points the Playwright MCP server entry in ~/.claude.json at mcp-supervisor.cjs (idempotent, atomic write).
//   node patches/use-supervisor.cjs [--server <name>]      (name defaults to PW_MCP_SERVER_NAME or "brave")
const os = require('os');
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
const serverName = (argv.includes('--server') ? argv[argv.indexOf('--server') + 1] : null) || process.env.PW_MCP_SERVER_NAME || 'brave';
const p = path.join(os.homedir(), '.claude.json');
const supervisor = path.join(__dirname, '..', 'mcp-supervisor.cjs');
const c = JSON.parse(fs.readFileSync(p, 'utf8'));
const b = c.mcpServers[serverName];
if (!b) throw new Error(`no mcpServers.${serverName} entry in ${p}`);
if (!b.args.some((a) => a.endsWith('cli.js')) || !b.args.includes('--extension')) throw new Error(`${serverName} entry is not the extension config (expected args containing cli.js and --extension)`);
if (b.args[0] !== supervisor) {
  if (b.args[0].endsWith('mcp-supervisor.cjs')) b.args.shift();
  b.args.unshift(supervisor);
  const tmp = p + '.tmp-supervisor';
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
  fs.renameSync(tmp, p);
  console.log('updated');
} else console.log('already using supervisor');
console.log(JSON.parse(fs.readFileSync(p, 'utf8')).mcpServers[serverName].args.slice(0, 3));
