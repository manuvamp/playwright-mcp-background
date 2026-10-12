// Loads extension-bg/lib/background.mjs against a mocked `chrome` API to catch startup errors
// without touching Brave. Usage: node patches/smoke-extension.mjs
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const calls = [];
const event = (name) => ({ addListener: () => calls.push(`listen ${name}`), removeListener() {} });
const handler = (prefix) => new Proxy({}, {
  get(target, prop) {
    if (prop in target) return target[prop];
    if (/^on[A-Z]/.test(prop)) return event(`${prefix}.${String(prop)}`);
    return (...args) => { calls.push(`${prefix}.${String(prop)}(${JSON.stringify(args).slice(0, 80)})`); return Promise.resolve([]); };
  },
});
const missing = new Set((process.env.MISSING || '').split(',').filter(Boolean));
globalThis.chrome = new Proxy({}, { get: (_, ns) => missing.has(String(ns)) ? undefined : handler(String(ns)) });
globalThis.chrome.runtime; // touch
globalThis.WebSocket = class { static OPEN = 1; constructor(url) { calls.push(`WebSocket(${url})`); this.readyState = 0; } send() {} close() {} };
globalThis.WebSocket.OPEN = 1;

const file = path.join(import.meta.dirname, '..', 'extension-bg', 'lib', 'background.mjs');
try {
  await import(pathToFileURL(file).href);
  console.log('loaded OK');
} catch (e) {
  console.log('STARTUP ERROR:', e.stack);
}
console.log(calls.filter((c) => /WebSocket|alarms|broker/i.test(c)).join('\n'));
