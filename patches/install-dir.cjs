// The patched MCP install new chats run: the newest <repo>/runtime, runtime-2, runtime-3 ... if any exist
// (~/.claude.json points at it). A bundle that running chats use is never patched in place (their
// supervisors would restart and close their tabs), so a server update goes into the next runtime-N
// folder and ~/.claude.json moves to it; chats already open keep the folder they started with.
// Falls back to the repo itself (its own node_modules), which is all a plain `npm install` gives you.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function installs() {
  return fs.readdirSync(ROOT)
    .map((name) => ({ name, n: name === 'runtime' ? 1 : +(name.match(/^runtime-(\d+)$/)?.[1] ?? NaN) }))
    .filter((d) => d.n > 0 && fs.existsSync(path.join(ROOT, d.name, 'node_modules')))
    .sort((a, b) => b.n - a.n)
    .map((d) => path.join(ROOT, d.name));
}

function currentInstall() {
  return installs()[0] ?? ROOT;
}

function nextInstall() {
  const latest = installs()[0];
  const n = latest ? (path.basename(latest) === 'runtime' ? 1 : +path.basename(latest).split('-')[1]) : 0;
  return path.join(ROOT, n ? `runtime-${n + 1}` : 'runtime');
}

module.exports = { ROOT, installs, currentInstall, nextInstall };
if (require.main === module) console.log(process.argv[2] === '--next' ? nextInstall() : currentInstall());
