#!/usr/bin/env node
'use strict';
// Claude Code hook for the lanes feature of playwright-mcp-background (see README, "Lanes").
// PreToolUse for your Playwright MCP server's tools: records which agent made each browser call, so the
// patched MCP server gives every agent (the main session and each subagent) its own tabs and lets them
// work at the same time. Claude Code sends the call's tool_use_id to the server as
// _meta["claudecode/toolUseId"]; the server reads <lane dir>/<tool_use_id>.json and deletes it.
// SubagentStop: writes <lane dir>/done-<agent_id>.json, so the server closes that subagent's tabs
// (except ones it kept for the user with browser_tabs keep).
// Never blocks or changes anything, prints nothing; any error exits silently.
//
// Lane dir: PW_LANE_DIR, else <repo>/lane-ids (this file lives in <repo>/claude-code-hooks/browser-lanes/),
// which is where the patched server looks by default. If you copy the hook elsewhere, set PW_LANE_DIR for
// both the hook and the MCP server (the env of the server entry in your Claude Code MCP config).
// Tool prefix: mcp__<PW_MCP_SERVER_NAME>__ if that env var is set for the hook, else any mcp__ tool
// (the hook matcher in the Claude Code settings already limits it to your browser server).
const fs = require('fs');
const path = require('path');

const DIR = process.env.PW_LANE_DIR || path.join(__dirname, '..', '..', 'lane-ids');
const PREFIX = process.env.PW_MCP_SERVER_NAME ? `mcp__${process.env.PW_MCP_SERVER_NAME}__` : 'mcp__';

let raw = '';
process.stdin.on('data', (c) => { raw += c; }).on('end', () => {
  try {
    const event = JSON.parse(raw);
    if (event.hook_event_name === 'SubagentStop') {
      if (!/^[\w-]{1,128}$/.test(event.agent_id || '')) return;
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(path.join(DIR, 'done-' + event.agent_id + '.json'), JSON.stringify({ agent: event.agent_id, session: event.session_id || '', at: Date.now() }));
      return;
    }
    if (!String(event.tool_name || '').startsWith(PREFIX) || !/^[\w-]{1,128}$/.test(event.tool_use_id || '')) return;
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(path.join(DIR, event.tool_use_id + '.json'), JSON.stringify({
      agent: event.agent_id || 'main',
      type: event.agent_type || '',
      session: event.session_id || '',
      at: Date.now(),
    }));
    // Files of calls that never reached the server (denied by another hook or the user).
    if (Math.random() < 0.02) prune();
  } catch {}
});

function prune() {
  const cutoff = Date.now() - 3600e3;
  for (const f of fs.readdirSync(DIR)) {
    const p = path.join(DIR, f);
    try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch {}
  }
}
