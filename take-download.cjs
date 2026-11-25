#!/usr/bin/env node
// Moves a file an agent just downloaded in the browser out of Downloads into "Downloads/AI Downloads".
// A browser set to save without asking (Chromium policy PromptForDownloadLocation=0) puts every download
// straight into Downloads and can't tell agent downloads from yours, so the agent runs this right after its download:
//
//   node take-download.cjs [--match <text|*.ext>] [--to <subfolder>]
//        [--since <seconds|ISO time|epoch ms>] [--wait <seconds>] [--all] [--list]
//
//   --match  part of the file name, or a glob like "*.pdf" / "invoice*.csv" (case-insensitive). Use it
//            whenever you know the name or type, so a download of yours in the same minute isn't taken.
//   --to     subfolder inside AI Downloads (e.g. the job name); created if missing.
//   --since  only files finished after this; a plain number = that many seconds ago (default 120).
//   --wait   how long to wait for the download to finish (default 60 s).
//   --all    move every matching file, not only the newest.
//   --list   show what would be moved, move nothing.
// Prints JSON { moved: [{ from, to, bytes }] } and exits 1 when nothing matched in time.

const fs = require('fs');
const path = require('path');

// PW_MCP_DOWNLOADS overrides the folder the browser saves to (default: <home>/Downloads).
const DOWNLOADS = process.env.PW_MCP_DOWNLOADS || path.join(require('os').homedir(), 'Downloads');
const AI_DIR = path.join(DOWNLOADS, 'AI Downloads');
const PARTIAL = /\.(tmp|crdownload|part|partial|download)$/i;

function args() {
  const a = process.argv.slice(2), o = { since: '120', wait: '60', all: false, list: false };
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    if (k === '--all') o.all = true;
    else if (k === '--list') o.list = true;
    else if (k === '--help' || k === '-h') { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 17).join('\n')); process.exit(0); }
    else if (k.startsWith('--')) o[k.slice(2)] = a[++i];
    else { console.error(`unknown argument: ${k}`); process.exit(2); }
  }
  return o;
}

function sinceMs(v) {
  if (/^\d+(\.\d+)?$/.test(v)) { const n = Number(v); return n > 1e11 ? n : Date.now() - n * 1000; }
  const t = Date.parse(v);
  if (Number.isNaN(t)) { console.error(`bad --since: ${v}`); process.exit(2); }
  return t;
}

function matcher(m) {
  if (!m) return () => true;
  const s = m.toLowerCase();
  if (!/[*?]/.test(s)) return n => n.toLowerCase().includes(s);
  const re = new RegExp('^' + s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
  return n => re.test(n);
}

function candidates(since, match) {
  return fs.readdirSync(DOWNLOADS, { withFileTypes: true })
    .filter(d => d.isFile() && !PARTIAL.test(d.name) && match(d.name))
    .map(d => { const p = path.join(DOWNLOADS, d.name); const s = fs.statSync(p); return { name: d.name, p, size: s.size, t: Math.max(s.mtimeMs, s.birthtimeMs) }; })
    .filter(f => f.t >= since - 1000)
    .sort((a, b) => b.t - a.t);
}

function freeName(dir, name) {
  const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
  let n = 0, p = path.join(dir, name);
  while (fs.existsSync(p)) p = path.join(dir, `${base} (${++n})${ext}`);
  return p;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const o = args();
  const since = sinceMs(o.since), match = matcher(o.match);
  const deadline = Date.now() + Number(o.wait) * 1000;
  let found = [];
  for (;;) {
    found = candidates(since, match);
    if (found.length) {
      await sleep(800); // size must be stable (file fully written)
      found = found.filter(f => { try { return fs.statSync(f.p).size === f.size; } catch { return false; } });
      if (found.length) break;
    }
    if (Date.now() > deadline) break;
    await sleep(500);
  }
  if (!found.length) {
    console.log(JSON.stringify({ moved: [], error: `no finished download in ${DOWNLOADS} since ${new Date(since).toISOString()}${o.match ? ` matching "${o.match}"` : ''}` }));
    process.exit(1);
  }
  const pick = o.all ? found : [found[0]];
  const dir = o.to ? path.join(AI_DIR, o.to.replace(/[<>:"|?*]/g, '_')) : AI_DIR;
  if (o.list) { console.log(JSON.stringify({ wouldMove: pick.map(f => ({ from: f.p, bytes: f.size })), to: dir }, null, 1)); return; }
  fs.mkdirSync(dir, { recursive: true });
  const moved = pick.map(f => { const to = freeName(dir, f.name); fs.renameSync(f.p, to); return { from: f.p, to, bytes: f.size }; });
  console.log(JSON.stringify({ moved }, null, 1));
})();
