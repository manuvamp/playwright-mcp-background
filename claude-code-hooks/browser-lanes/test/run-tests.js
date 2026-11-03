// Offline tests for the browser-lanes hook: node claude-code-hooks/browser-lanes/test/run-tests.js
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK = path.join(__dirname, '..', 'hook.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-lanes-test-'));
const run = (input, env = {}) => spawnSync(process.execPath, [HOOK], { input: typeof input === 'string' ? input : JSON.stringify(input), env: { ...process.env, PW_LANE_DIR: dir, ...env }, encoding: 'utf8' });
const read = (id) => { try { return JSON.parse(fs.readFileSync(path.join(dir, id + '.json'), 'utf8')); } catch { return null; } };
const results = [];
const check = (name, ok) => results.push(`${ok ? 'ok  ' : 'FAIL'}  ${name}`);
const base = { hook_event_name: 'PreToolUse', session_id: 's1', tool_input: { url: 'https://example.com' } };

let r = run({ ...base, tool_name: 'mcp__brave__browser_navigate', tool_use_id: 'toolu_sub1', agent_id: 'a3b3bed47d970f448', agent_type: 'general-purpose' });
check('subagent call: lane file names the agent', r.status === 0 && !r.stdout && read('toolu_sub1')?.agent === 'a3b3bed47d970f448' && read('toolu_sub1')?.type === 'general-purpose');
r = run({ ...base, tool_name: 'mcp__brave__browser_snapshot', tool_use_id: 'toolu_main1' });
check('main-session call: lane "main"', r.status === 0 && !r.stdout && read('toolu_main1')?.agent === 'main');
r = run({ ...base, tool_name: 'Bash', tool_use_id: 'toolu_bash1', tool_input: { command: 'ls' } });
check('other tools: nothing written', r.status === 0 && !r.stdout && read('toolu_bash1') === null);
r = run({ ...base, tool_name: 'mcp__brave__browser_click', tool_use_id: '../../evil' });
check('odd tool_use_id: nothing written', r.status === 0 && !r.stdout && !fs.readdirSync(dir).some((f) => f.includes('evil')));
r = run({ ...base, tool_name: 'mcp__other__browser_click', tool_use_id: 'toolu_other1' }, { PW_MCP_SERVER_NAME: 'brave' });
check('PW_MCP_SERVER_NAME set: other servers\' tools ignored', r.status === 0 && !r.stdout && read('toolu_other1') === null);
r = run({ ...base, tool_name: 'mcp__pw__browser_click', tool_use_id: 'toolu_named1' }, { PW_MCP_SERVER_NAME: 'pw' });
check('PW_MCP_SERVER_NAME set: its own tools recorded', r.status === 0 && !r.stdout && read('toolu_named1')?.agent === 'main');
r = run({ hook_event_name: 'SubagentStop', session_id: 's1', agent_id: 'a3b3bed47d970f448', agent_type: 'general-purpose', stop_hook_active: false });
check('subagent finished: done notice for the server', r.status === 0 && !r.stdout && read('done-a3b3bed47d970f448')?.agent === 'a3b3bed47d970f448');
const before = fs.readdirSync(dir).length;
r = run({ hook_event_name: 'SubagentStop', session_id: 's1', agent_id: '../x' });
check('subagent finished with an odd id: nothing written', r.status === 0 && fs.readdirSync(dir).length === before);
r = run('not json');
check('bad input: exits quietly', r.status === 0 && !r.stdout);
// Default lane dir (no PW_LANE_DIR) is <repo>/lane-ids, where the patched server looks.
const defDir = path.join(__dirname, '..', '..', '..', 'lane-ids');
const existed = fs.existsSync(defDir);
const env = { ...process.env }; delete env.PW_LANE_DIR;
r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ ...base, tool_name: 'mcp__brave__browser_tabs', tool_use_id: 'toolu_default_dir_test' }), env, encoding: 'utf8' });
const f = path.join(defDir, 'toolu_default_dir_test.json');
check('default lane dir is <repo>/lane-ids', r.status === 0 && fs.existsSync(f));
fs.rmSync(f, { force: true });
if (!existed) fs.rmSync(defDir, { recursive: true, force: true });

fs.rmSync(dir, { recursive: true, force: true });
console.log(results.join('\n'));
process.exit(results.some((l) => l.startsWith('FAIL')) ? 1 : 0);
