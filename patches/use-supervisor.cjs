// Points the Playwright MCP server entry in ~/.claude.json at mcp-supervisor.cjs and adds the
// popups-as-tabs.js init script (idempotent, atomic write, backup on change).
//   node patches/use-supervisor.cjs [--server <name>]      (name defaults to PW_MCP_SERVER_NAME or "brave")
// Open chats keep their old server command until /mcp or a new chat.
const fs = require('fs');
const os = require('os');
const path = require('path');
const serverName = (process.argv.includes('--server') ? process.argv[process.argv.indexOf('--server') + 1] : null) || process.env.PW_MCP_SERVER_NAME || 'brave';
const p = path.join(os.homedir(), '.claude.json');
const supervisor = path.join(__dirname, '..', 'mcp-supervisor.cjs');
const initScript = path.join(__dirname, '..', 'popups-as-tabs.js');
const c = JSON.parse(fs.readFileSync(p, 'utf8'));
const b = c.mcpServers[serverName];
if (!b) throw new Error(`no mcpServers.${serverName} entry in ${p}`);
if (!b.args.some((a) => a.endsWith('cli.js')) || !b.args.includes('--extension')) throw new Error(`${serverName} entry is not the extension config (expected args containing cli.js and --extension)`);
let changed = false;
if (b.args[0] !== supervisor) {
  if (b.args[0].endsWith('mcp-supervisor.cjs')) b.args.shift();
  b.args.unshift(supervisor);
  changed = true;
}
// Sign-in/share popups open as tabs instead of new browser windows (see popups-as-tabs.js).
const i = b.args.indexOf('--init-script');
if (i < 0) {
  b.args.push('--init-script', initScript);
  changed = true;
} else if (b.args[i + 1] !== initScript) {
  b.args[i + 1] = initScript;
  changed = true;
}
if (changed) {
  fs.copyFileSync(p, p + '.bak-use-supervisor');
  const tmp = p + '.tmp-supervisor';
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
  fs.renameSync(tmp, p);
  console.log('updated');
} else console.log('already up to date');
console.log(JSON.parse(fs.readFileSync(p, 'utf8')).mcpServers[serverName].args);
