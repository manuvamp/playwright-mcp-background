# playwright-mcp-background

Patches that make [Playwright MCP](https://github.com/microsoft/playwright-mcp) (`@playwright/mcp`, `--extension` mode) drive your **real, logged-in Chromium browser entirely in the background**: agent tabs open as background tabs in a collapsed tab group, and the browser window never comes to the front.

Not affiliated with Microsoft. See [NOTICE](NOTICE).

## Why

Playwright MCP's extension mode lets an agent use your own browser profile (your logins, cookies, extensions). Upstream is designed around the agent visibly driving the browser: connecting activates a tab and focuses the window, and background-tab operation was declined in [microsoft/playwright-mcp#1343](https://github.com/microsoft/playwright-mcp/issues/1343). In practice that means every agent run yanks the browser over whatever you are doing. File uploads in extension mode also fail with `DOM.setFileInputFiles: Not allowed` ([#1481](https://github.com/microsoft/playwright-mcp/issues/1481)).

This repo is a set of string-replacement patches for the installed `playwright-core`, a build script that produces a patched local copy of the Playwright Extension, and a small broker plus supervisor process that tie them together.

## Features

- Agent tabs open as background tabs (never active) in a collapsed tab group titled after the session. No windows are created and nothing calls `bringToFront`, focus or new-window APIs. `Page.bringToFront` / `Target.activateTarget` from agent code are answered as silent no-ops.
- A broker (default port 8770) lets the MCP server connect through the already-running extension instead of launching the browser executable, which always raises the browser.
- Hidden tabs are kept unfrozen (the browser freezes background tabs and stops their timers and network callbacks).
- In hidden tabs, mouse moves/hover, clicks, double/right clicks, wheel and HTML5 drag-and-drop are performed as DOM events, and animation-frame / in-page-timer waits that the browser throttles are skipped.
- Popup handling: links that open a new tab are opened as background tabs; `window.open` and popup windows are adopted as agent tabs and your own tab/window is given back.
- Idle agent tabs are closed automatically (default 10 minutes with no command), skipping tabs with unsaved work (filled fields, ticked boxes, picked files, password fields, editor text, large cross-origin embeds) and tabs you are looking at.
- Hung-tab self-heal: after a slow or failed call the tab is pinged; if it does not answer, its JS is terminated, a fresh tab is opened and the dead one closed. This also avoids the browser's "Page unresponsive" prompt.
- Tool-call time caps: every call is capped (default 120 s) and the page read-back after a call is capped at 30 s, so an agent is never stuck on a silent hang.
- The MCP connection survives the last agent tab closing; the next call just opens a new tab.
- `mcp-supervisor.cjs` runs the real MCP server as a child process, restarts it transparently when it dies or when `coreBundle.js` is re-patched, and replays the MCP handshake, so open chats do not need to reconnect.
- File upload fixes: the file is read in Node and injected via `DataTransfer`. Works for single/multiple files, hidden inputs, iframes, shadow DOM, unicode names and folders (`webkitdirectory`).
- New tool `browser_set_input_files`: sets files on an `<input type=file>` directly (snapshot ref or selector), no click or file chooser needed.
- Optional: the tab group title can be the title of the T3 Code thread running the agent (see "Group name" below).

## Requirements

- Node.js 22.5 or newer (the optional T3 Code title lookup uses `node:sqlite`; everything else works on older versions).
- A Chromium-based browser with the [Playwright Extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm) (id `mmlmfjhmonkocbjadbfplnigmagldckm`) installed from the store once, so the build script has a copy to start from.
- `@playwright/mcp` 0.0.83 (pinned in `package.json`).
- Tested on Windows 11 with Brave only. The scripts use `tasklist`, PowerShell and a `.vbs` launcher in places; other platforms are untested.

## Install

1. Install dependencies:

   ```
   npm install
   ```

2. Patch `playwright-core`:

   ```
   node patches/apply.cjs
   ```

   Each patch is applied once (marker comment) and fails loudly if its anchor text is not found. A backup of the original is saved as `coreBundle.js.bak-original`.

3. Build the patched extension. You need the extension's auth token: connect the store extension once and copy the token from its connect page, or from your existing MCP config.

   ```
   export PLAYWRIGHT_MCP_EXTENSION_TOKEN=<token>      # PowerShell: $env:PLAYWRIGHT_MCP_EXTENSION_TOKEN = "<token>"
   node patches/build-extension.cjs
   ```

   The output goes to `./extension-bg` (gitignored; it contains your token, never commit or share it). Options: `--out <dir>`, a positional source directory, `--server <name>`. The script saves a pristine copy of the store extension to `./extension-src` on the first run, because the store copy is removed once the local one is installed.

4. Load the unpacked extension: open the browser's extensions page, enable Developer mode, remove the store copy of the Playwright Extension, then "Load unpacked" and pick `extension-bg`. The extension id stays the same.

5. Start the broker:

   ```
   node broker.cjs
   ```

   Check it: `curl 127.0.0.1:8770/status` should return `{"extension":true,...}`. On Windows, copy `scripts/playwright-broker.vbs` to your Startup folder (after editing the broker path in it, or setting `PW_MCP_BROKER`) to start the broker hidden at logon. The patched MCP server also starts the broker on demand.

6. Configure your MCP client. Example for Claude Code (`~/.claude.json`, or use `claude mcp add`); use absolute paths:

   ```json
   {
     "mcpServers": {
       "brave": {
         "command": "node",
         "args": [
           "/path/to/playwright-mcp-background/mcp-supervisor.cjs",
           "/path/to/playwright-mcp-background/node_modules/@playwright/mcp/cli.js",
           "--extension",
           "--executable-path", "/path/to/your/browser/executable",
           "--profile-dir-name", "Default",
           "--caps", "vision,pdf,devtools,storage",
           "--output-dir", "/path/to/playwright-mcp-background/output"
         ],
         "env": { "PLAYWRIGHT_MCP_EXTENSION_TOKEN": "<token>" },
         "timeout": 150000
       }
     }
   }
   ```

   Keep `--extension` and the token. If you already have an entry with the `cli.js` args, `node patches/use-supervisor.cjs [--server <name>]` inserts the supervisor in front of it (idempotent).

## Re-apply after Playwright updates

After any `npm install` / update of `@playwright/mcp`, run `node patches/apply.cjs` again, then reconnect the MCP server. The supervisor notices the patched `coreBundle.js` and restarts its child on its own once idle. After a Playwright Extension update, rerun `node patches/build-extension.cjs`, then `curl -X POST 127.0.0.1:8770/reload` to make the extension reload itself. If the browser shows "Service worker registration failed" or `chrome.X` is undefined, remove the extension and load it unpacked again (a plain reload keeps stale settings).

## Environment variables

| Variable | Used by | Default | Purpose |
|---|---|---|---|
| `PLAYWRIGHT_MCP_EXTENSION_TOKEN` | MCP server, `build-extension.cjs` | none | Extension auth token. `build-extension.cjs` falls back to `~/.claude.json` `mcpServers.<name>.env`. |
| `PW_MCP_SERVER_NAME` | `use-supervisor`, `build-extension`, `test-supervisor`, `bridge`, `smoke` | `brave` | Name of the MCP server entry in `~/.claude.json`. |
| `PW_MCP_BROKER_PORT` | broker, patched server, extension build, smoke | `8770` | Broker port. Rebuild the extension if you change it. |
| `PW_MCP_BROWSER_PROCESS` | broker, patched server, smoke | `brave.exe` | Browser process image name, used to tell whether the browser is running (Windows `tasklist`). |
| `PW_MCP_BROKER_LAUNCHER` | patched server | `Startup\playwright-broker.vbs` if present, else `node broker.cjs` | Script that starts the broker detached. |
| `PW_MCP_BROWSER_USER_DATA` | `build-extension` | Brave's `User Data` dir under `%LOCALAPPDATA%` | Browser user data dir to find the store copy of the extension. |
| `PW_MCP_PROFILE` | `build-extension` | `Default` | Browser profile directory name. |
| `PW_MCP_EXTENSION_OUT` | `build-extension` | `./extension-bg` | Output directory (same as `--out`). |
| `PW_MCP_TOOL_CAP_MS` | patched server | `120000` | Per-tool-call time cap. |
| `PLAYWRIGHT_MCP_GROUP_NAME` | patched server | thread title or project folder | Overrides the tab group title for this connection. |
| `PW_MCP_NODE`, `PW_MCP_BROKER` | `scripts/playwright-broker.vbs` | `C:\Program Files\nodejs\node.exe`, placeholder path | Paths used by the launcher. |
| `BRIDGE_PORT` | `bridge.mjs` | `8765` | Port of the test bridge. |

The idle-tab timeout can be changed with `chrome.storage.local` keys `idleTabCloseMs` (and `idleTabCloseGroup` to limit it to one group title), set from an extension page.

### Group name

The tab group is titled after what the session is working on. Order: `PLAYWRIGHT_MCP_GROUP_NAME`; the T3 Code thread title (found through Claude Code's `~/.claude/sessions/<pid>.json` and T3 Code's `state.sqlite`, read-only); the project folder name (worktrees map back to their repo); the MCP client name. The T3 Code lookup is optional: when those files do not exist, or anything in it fails, it is skipped silently.

## Safeguards

| Situation | What the setup does |
|---|---|
| Any tool call runs long | Capped at 120 s (`PW_MCP_TOOL_CAP_MS`); page read-back capped at 30 s. The agent gets an error and should take a snapshot and continue. |
| Page stuck in an endless script / hung renderer | After any slow (over 4 s) or failed call the tab is pinged; if it does not answer in 3 s its JS is terminated, a fresh tab is opened and the dead tab closed. |
| Browser freezes the background tab | Hidden agent tabs are kept unfrozen every 2 s. |
| `alert` / `confirm` / `prompt` | The call returns at once with "Modal state"; self-heal skips tabs with an open dialog. Use `browser_handle_dialog`. |
| Site opens a popup (`target=_blank`, `window.open`, popup window) | Links: default cancelled, URL opened as a background tab. `window.open`: the extension switches your tab/window back. |
| You close the agent's tabs | The connection stays open; the next call opens a new tab. |
| Agent tab left open after its work is done | Closed after 10 minutes without a command, if it is not on screen and has no unsaved work. |
| Extension reloaded / browser restarted | The next call reconnects through the broker. |
| Broker dead | The next connect restarts it (detached). |
| Extension not connected while the browser runs | Clear error; the browser executable is never launched while the browser is running. |
| MCP server child dies or `coreBundle.js` is re-patched | `mcp-supervisor.cjs` starts a fresh child and replays the handshake. A call that was in flight gets an error asking to retry; nothing is re-sent automatically. |
| Dead host / bad URL | Normal navigation error in under a second. |

Stalls are appended to `stalls.log`, broker events to `broker.log`, supervisor events to `supervisor.log` (all gitignored).

Behaviour to know about: in agent tabs `document.visibilityState` is normally `"hidden"`. Mouse input in hidden tabs becomes untrusted DOM events (`isTrusted: false`), CSS `:hover` styles do not apply, and coordinate clicks do not reach into iframes (use frame locators). Never wait inside the page with `setTimeout` or polling loops: the browser throttles timers in background tabs. Use `browser_wait_for` or Playwright waits instead.

## Testing

- `node patches/smoke.mjs [--only name1,name2] [--skip-disruptive]`: 13 end-to-end scenarios against the real browser in background tabs (connect, uploads, input events, dialogs, popups, hung page, reload, broker restart). It samples the foreground window every 250 ms and fails if a browser window takes focus. It uses `bridge.mjs` and your configured MCP server entry. The "disruptive" cases briefly disconnect every agent session on the machine, so use `--skip-disruptive` when others are using the browser.
- `node patches/test-supervisor.cjs [--server <name>]`: exercises `mcp-supervisor.cjs` (handshake, child killed idle, child killed mid-call, code update while idle, clean exit).
- `node patches/smoke-extension.mjs`: loads the built `extension-bg/lib/background.mjs` against a mocked `chrome` API to catch startup errors without touching the browser.

Run them after any patch, Playwright update or extension rebuild.

## Caveats

- The patches are exact string replacements against `@playwright/mcp` 0.0.83 / its bundled `playwright-core`, and `build-extension.cjs` replaces exact text in the extension source. A different version can change those anchors; the scripts then stop with an error naming the patch that no longer matches, and you have to adapt it by hand.
- Only tested on Windows with Brave. Other Chromium browsers and operating systems may need changes (process detection, paths, launcher).
- Events in hidden tabs are synthetic; a few widgets that insist on trusted input or a visible tab will not respond. Sites that use `window.showOpenFilePicker` (no `<input>`) cannot be automated for uploads.
- `accept=` on file inputs is not enforced by the upload fallback; pick the right file type.
- The extension auth token grants control of your browser through the extension. Keep it out of git, logs and screenshots.

## License

Apache-2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE).
