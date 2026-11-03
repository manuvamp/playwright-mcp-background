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
- Popup handling: links that open a new tab are opened as background tabs; `window.open` tabs and popup windows from agent pages are adopted as agent tabs, your own tab is given back and popup windows are minimized (the extension never focuses a browser window).
- Your tabs stay yours: a tab you open from an agent tab you're looking at (link, middle-click, Ctrl+T) isn't adopted, grouped or handed to the agent, and you aren't bounced to another tab. The extension tells the two apart by the opener: agents only work in background tabs, so a tab opened from the tab on your screen is yours.
- Lanes: the main agent and every subagent of a Claude Code session each get their own tabs, tab indexes and current tab on the one shared MCP server, and their calls run side by side instead of queueing or steering each other's tabs. Needs the small `claude-code-hooks/browser-lanes` hook (see "Lanes: parallel agents" below). Without the hook everything runs in one lane, as before.
- Named tab groups: `browser_tabs` takes a `group` name, and each lane can put tabs in its own collapsed sub-group (`🤖 <session> · <name>`) next to the session's main group.
- Your own open tabs: `browser_tabs existing` lists the tabs you have open, `take` works in one as it is (logged in, half filled, no reload), and `browser_navigate` to a page you already have open uses that tab. A tab you drag into an agent group is handed to that agent. Your tabs are never closed: when the agent is done they are given back (out of the group, debugger detached, page untouched).
- Tabs clean up after themselves: a subagent's tabs close when it finishes (except ones it marked `keep` because you must act on them), a group closes when its agent has closed or navigated away all its tabs, and a session that drops keeps its tabs for a grace period (3 minutes, 15 after an extension reload or browser start) so it can reconnect and get them back, otherwise they close. The tab on your screen is never closed, only ungrouped.
- The "connected" page the extension opens for each connection is reused as the first agent tab, or closed once the session has real pages.
- Popups open as background tabs: an init script (`popups-as-tabs.js`) makes `window.open` from a hidden agent tab open nothing and report the URL, and the extension opens it as a background tab in the agent's group. Sign-in popups lose `window.opener`: prefer same-tab redirects or magic links.
- Quiet-window deploys: `patches/deploy-extension.cjs` swaps in a new extension build only when no Claude chat has used the browser for a few minutes (see "Deploying a new extension build").
- Hung-tab self-heal: after a slow or failed call the tab is pinged; if it does not answer, its JS is terminated, a fresh tab is opened and the dead one closed. This also avoids the browser's "Page unresponsive" prompt.
- Tool-call time caps: every call is capped (default 120 s) and the page read-back after a call is capped at 30 s, so an agent is never stuck on a silent hang.
- The MCP connection survives the last agent tab closing; the next call just opens a new tab.
- `mcp-supervisor.cjs` runs the real MCP server as a child process, restarts it transparently when it dies or when `coreBundle.js` is re-patched, and replays the MCP handshake, so open chats do not need to reconnect.
- File upload fixes: the file is read in Node and injected via `DataTransfer`. Works for single/multiple files, hidden inputs, iframes, shadow DOM, unicode names and folders (`webkitdirectory`).
- New tool `browser_set_input_files`: sets files on an `<input type=file>` directly (snapshot ref or selector), no click or file chooser needed.
- No "Playwright Extension started debugging this browser" bar, when the browser runs with `--silent-debugger-extension-api` (see "Hide the debugging bar" below). The MCP adds the flag itself when it has to launch the browser.
- Optional: the tab group title can be the title of the T3 Code thread running the agent (see "Group name" below).

## Requirements

- Node.js 22.5 or newer (the optional T3 Code title lookup uses `node:sqlite`; everything else works on older versions).
- A Chromium-based browser with the [Playwright Extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm) (id `mmlmfjhmonkocbjadbfplnigmagldckm`) installed from the store once, so the build script has a copy to start from.
- `@playwright/mcp` 0.0.83 (pinned in `package.json`).
- For `patches/test-lanes.mjs`: a headless Chromium (`npx playwright install chromium-headless-shell`, or set `PW_TEST_CHROME`).
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

   Keep `--extension` and the token. If you already have an entry with the `cli.js` args, `node patches/use-supervisor.cjs [--server <name>]` inserts the supervisor in front of it and adds `--init-script /path/to/playwright-mcp-background/popups-as-tabs.js` (idempotent; a backup of the config is kept as `<config>.bak-use-supervisor`). If you write the entry by hand, add that `--init-script` argument yourself to get popups as background tabs.

7. Optional, for lanes: register the browser-lanes hook, see "Lanes: parallel agents".

## Lanes: parallel agents

A Claude Code session's main agent and all its subagents share one MCP server. Without lanes that server has one current tab, so parallel subagents steer each other's tabs. With the patches in `apply.cjs` every agent is a lane with its own tabs, tab indexes and current tab, and calls from different lanes run at the same time.

How the server knows who is calling: Claude Code sends each tool call's `tool_use_id` to the server as `_meta["claudecode/toolUseId"]`, but not the agent. A PreToolUse hook (`claude-code-hooks/browser-lanes/hook.js`) writes `<lane dir>/<tool_use_id>.json` with the agent id, and the server reads and deletes it. A SubagentStop hook writes `<lane dir>/done-<agent_id>.json`, and the server closes that subagent's tabs (except `keep` tabs). The hook never blocks anything and prints nothing.

Register it in your Claude Code settings (`hooks` in `~/.claude/settings.json` or the project's `.claude/settings.json`); use the absolute path of the hook and your MCP server name in the matcher:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "mcp__brave__.*",
        "hooks": [{ "type": "command", "command": "node \"/path/to/playwright-mcp-background/claude-code-hooks/browser-lanes/hook.js\"", "timeout": 5 }]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [{ "type": "command", "command": "node \"/path/to/playwright-mcp-background/claude-code-hooks/browser-lanes/hook.js\"", "timeout": 5 }]
      }
    ]
  }
}
```

The lane dir is `PW_LANE_DIR` if set, otherwise `<repo>/lane-ids` for both the hook (it resolves the path from its own location, so it must stay inside the repo) and the patched server. If you copy the hook elsewhere or run the server from another folder, set `PW_LANE_DIR` for both: in the hook's environment, and in the MCP server entry's `env`. Set `PW_MCP_SERVER_NAME` for the hook if you want it to ignore tools of other MCP servers (the matcher already does this). Offline test: `node claude-code-hooks/browser-lanes/test/run-tests.js`.

Other MCP clients that do not send a tool-use id and have no hook simply run everything in the `main` lane.

## Install layout and versioned installs

By default everything runs from the repo: `node_modules/` is the install that `apply.cjs` patches and `mcp-supervisor.cjs` watches. Patching a `coreBundle.js` that a running supervisor watches makes it restart its idle MCP child, which closes that chat's tabs. To update the server without disturbing open chats, keep versioned installs next to the repo root:

```
node patches/install-dir.cjs --next     # prints <repo>/runtime, then runtime-2, runtime-3 ...
```

Create that folder with a copy of `package.json` and `package-lock.json`, run `npm ci` in it, then `node patches/apply.cjs <that folder>` and point your MCP server entry at `<folder>/node_modules/@playwright/mcp/cli.js`. Chats that are already open keep the install they started with; new chats use the new one. `apply.cjs` without an argument patches the newest `runtime[-N]` if one exists, else the repo's own `node_modules`. Logs, the broker and `lane-ids/` always stay in the repo root, whichever install runs. `runtime*/` is gitignored.

## Deploying a new extension build

A reload of the extension drops every chat's browser connection (builds from this repo keep the tabs for a while and hand them back when each chat reconnects, but a call running at that moment still fails). To rebuild without disturbing anyone:

1. Build into a staging folder: `node patches/build-extension.cjs --out extension-next`.
2. `node patches/sim-tabs.cjs extension-next` (or let step 3 run it).
3. `node patches/deploy-extension.cjs` runs `sim-tabs` on `extension-next`, waits until no Claude chat has made a call to your MCP server for `QUIET_MIN` minutes (default 10; it looks at the Claude Code transcripts under `~/.claude/projects` and at `lane-ids/`), copies the previous `extension-bg/` to `extension-prev/`, copies `extension-next/` over `extension-bg/`, asks the broker to reload the extension, waits for it to reconnect and runs `live-lanes.mjs` as a check. `--now` skips the waiting, `--status` shows how long ago the last browser call was. Rollback: copy `extension-prev/` back over `extension-bg/` and `curl -X POST 127.0.0.1:8770/reload`. Log: `deploy.log`.

`deploy-extension.cjs` and `live-lanes.mjs` use your real browser and the extension it has loaded; the broker must be running.

## Hide the debugging bar

Chromium shows a "Playwright Extension" started debugging this browser bar on every window while an extension uses the `chrome.debugger` API. No extension can hide it; the browser has to be started with `--silent-debugger-extension-api`. The patched MCP passes it when it launches the browser, but usually you start the browser yourself, so add it to the places that do:

- Shortcuts (taskbar pin, Start Menu, desktop): add `--silent-debugger-extension-api` to the shortcut's arguments. The shared Start Menu and Public Desktop shortcuts need admin rights.
- Links opened from other apps when the browser is closed (Windows, Brave shown; use `ChromeHTML` for Chrome). A per-user override, no admin needed:

  ```powershell
  $k = 'HKCU:\Software\Classes\BraveHTML\shell\open\command'
  New-Item -Path $k -Force | Out-Null
  Set-ItemProperty -Path $k -Name '(default)' -Value '"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe" --silent-debugger-extension-api --single-argument %1'
  ```

Then fully quit the browser (menu → Exit) and start it again. Trade-off: the flag silences this warning for every extension, not only Playwright, so only use it with extensions you trust. Browser updates can rewrite shortcuts; if the bar comes back, check the running browser's command line for the flag.

## Re-apply after Playwright updates

After any `npm install` / update of `@playwright/mcp`, run `node patches/apply.cjs` again, then reconnect the MCP server. The supervisor notices the patched `coreBundle.js` and restarts its child on its own once idle. After a Playwright Extension update, rerun `node patches/build-extension.cjs`, then `curl -X POST 127.0.0.1:8770/reload` to make the extension reload itself. If the browser shows "Service worker registration failed" or `chrome.X` is undefined, remove the extension and load it unpacked again (a plain reload keeps stale settings).

## Environment variables

| Variable | Used by | Default | Purpose |
|---|---|---|---|
| `PLAYWRIGHT_MCP_EXTENSION_TOKEN` | MCP server, `build-extension.cjs` | none | Extension auth token. `build-extension.cjs` falls back to `~/.claude.json` `mcpServers.<name>.env`. |
| `PW_MCP_SERVER_NAME` | `use-supervisor`, `build-extension`, `test-supervisor`, `live-lanes`, `deploy-extension`, `bridge`, `smoke`, the lanes hook (optional) | `brave` | Name of the MCP server entry in `~/.claude.json` (also the `mcp__<name>__` tool prefix). |
| `PW_MCP_BROKER_PORT` | broker, patched server, extension build, smoke | `8770` | Broker port. Rebuild the extension if you change it. |
| `PW_MCP_BROWSER_PROCESS` | broker, patched server, smoke | `brave.exe` | Browser process image name, used to tell whether the browser is running (Windows `tasklist`). |
| `PW_MCP_BROKER_LAUNCHER` | patched server | `Startup\playwright-broker.vbs` if present, else `node broker.cjs` | Script that starts the broker detached. |
| `PW_MCP_BROWSER_USER_DATA` | `build-extension` | Brave's `User Data` dir under `%LOCALAPPDATA%` | Browser user data dir to find the store copy of the extension. |
| `PW_MCP_PROFILE` | `build-extension` | `Default` | Browser profile directory name. |
| `PW_MCP_EXTENSION_OUT` | `build-extension` | `./extension-bg` | Output directory (same as `--out`). |
| `PW_MCP_TOOL_CAP_MS` | patched server | `120000` | Per-tool-call time cap. |
| `PW_LANE_DIR` | patched server, `claude-code-hooks/browser-lanes/hook.js`, `deploy-extension`, `test-lanes`, `live-lanes` | `<repo>/lane-ids` | Folder where the hook writes per-call lane files and subagent-done notices. Must be the same for the hook and the server. |
| `QUIET_MIN` | `deploy-extension` | `10` | Minutes without a browser call before a deploy goes ahead. |
| `SIM_EXT_DIR` | `sim-tabs` | `./extension-bg` | Extension build directory to test (or pass it as the first argument). |
| `PW_TEST_CHROME`, `PLAYWRIGHT_BROWSERS_PATH` | `test-lanes` | newest `ms-playwright` chrome-headless-shell | Headless browser for the offline lanes test. |
| `PLAYWRIGHT_MCP_GROUP_NAME` | patched server | thread title or project folder | Overrides the tab group title for this connection. |
| `PW_MCP_NODE`, `PW_MCP_BROKER` | `scripts/playwright-broker.vbs` | `C:\Program Files\nodejs\node.exe`, placeholder path | Paths used by the launcher. |
| `BRIDGE_PORT` | `bridge.mjs` | `8765` | Port of the test bridge. |

### Group name

The tab group is titled after what the session is working on (with lanes, a lane's named sub-group is titled `<that title> · <group name>`). Order: `PLAYWRIGHT_MCP_GROUP_NAME`; the T3 Code thread title (found through Claude Code's `~/.claude/sessions/<pid>.json` and T3 Code's `state.sqlite`, read-only); the project folder name (worktrees map back to their repo); the MCP client name. The T3 Code lookup is optional: when those files do not exist, or anything in it fails, it is skipped silently.

## Safeguards

| Situation | What the setup does |
|---|---|
| Any tool call runs long | Capped at 120 s (`PW_MCP_TOOL_CAP_MS`); page read-back capped at 30 s. The agent gets an error and should take a snapshot and continue. |
| Page stuck in an endless script / hung renderer | After any slow (over 4 s) or failed call the tab is pinged; if it does not answer in 3 s its JS is terminated, a fresh tab is opened and the dead tab closed. |
| Browser freezes the background tab | Hidden agent tabs are kept unfrozen every 2 s. |
| `alert` / `confirm` / `prompt` | The call returns at once with "Modal state"; self-heal skips tabs with an open dialog. Use `browser_handle_dialog`. |
| Site opens a popup (`target=_blank`, `window.open`, popup window) | Links: default cancelled, URL opened as a background tab. `window.open`: the extension switches your tab back; a popup window is minimized. |
| You open a link or new tab from an agent tab you're viewing | It's yours: not adopted, grouped or shown to the agent, and you stay on it. |
| You close the agent's tabs | The connection stays open; the next call opens a new tab. |
| Agent finishes with tabs open | Only blank/connect tabs left: the group closes. A subagent's tabs close when it finishes (hook), except `keep` tabs. A session that disconnects: tabs kept 3 minutes (15 after an extension reload / browser start) for a reconnect, then closed; the tab on your screen is only ungrouped. |
| You drag one of your tabs into an agent group | It is handed to that agent as it is (not reloaded) and never closed: it is given back when the agent is done. |
| Extension reloaded / browser restarted | The next call reconnects through the broker. |
| Broker dead | The next connect restarts it (detached). |
| Extension not connected while the browser runs | Clear error; the browser executable is never launched while the browser is running. |
| MCP server child dies or `coreBundle.js` is re-patched | `mcp-supervisor.cjs` starts a fresh child and replays the handshake. A call that was in flight gets an error asking to retry; nothing is re-sent automatically. |
| Dead host / bad URL | Normal navigation error in under a second. |

Stalls are appended to `stalls.log`, broker events to `broker.log`, supervisor events to `supervisor.log` (all gitignored).

Behaviour to know about: in agent tabs `document.visibilityState` is normally `"hidden"`. Mouse input in hidden tabs becomes untrusted DOM events (`isTrusted: false`), CSS `:hover` styles do not apply, and coordinate clicks do not reach into iframes (use frame locators). Never wait inside the page with `setTimeout` or polling loops: the browser throttles timers in background tabs. Use `browser_wait_for` or Playwright waits instead.

## Testing

- `node patches/smoke.mjs [--only name1,name2] [--skip-disruptive]`: 13 end-to-end scenarios against the real browser in background tabs (connect, uploads, input events, dialogs, popups, hung page, reload, broker restart). It samples the foreground window every 250 ms and fails if a browser window takes focus (any browser window, if the browser wasn't in front when the run started). The popups scenario opens a real popup window, which the browser shows in front as it is created, so don't run it while you're using the machine. It uses `bridge.mjs` and your configured MCP server entry. The "disruptive" cases briefly disconnect every agent session on the machine, so use `--skip-disruptive` when others are using the browser.
- `node patches/test-supervisor.cjs [--server <name>]`: exercises `mcp-supervisor.cjs` (handshake, child killed idle, child killed mid-call, code update while idle, clean exit).
- `node patches/sim-tabs.cjs [extension-dir]`: replays tab scenarios (you vs. agent opening tabs, popups, popup windows, agents closing the tab you're viewing, lane sub-groups, orphaned sessions, handing your tabs over) against the built extension in a simulated Chromium, with nothing on screen. Fails if the extension ever focuses a window. `SIM_DISABLE_FIX=1` restores the old "every tab opened from an agent tab is the agent's" behaviour, so you can see the scenarios catch it.
- `node patches/test-lanes.mjs [install-dir]`: offline test of the lanes patches against a headless Chromium on a throwaway profile (two agents navigating at the same time, per-agent tab lists, popups, `keep`, subagent-finished cleanup, errors without the extension). Never touches your real browser.
- `node claude-code-hooks/browser-lanes/test/run-tests.js`: offline tests of the lanes hook.
- `node patches/live-lanes.mjs [install-dir]`: the same ideas against your real browser through the loaded extension (background tabs only, no extension reload). `deploy-extension.cjs` runs it after a reload.
- `node patches/smoke-extension.mjs`: loads the built `extension-bg/lib/background.mjs` against a mocked `chrome` API to catch startup errors without touching the browser.

Run them after any patch, Playwright update or extension rebuild.

## Caveats

- The patches are exact string replacements against `@playwright/mcp` 0.0.83 / its bundled `playwright-core`, and `build-extension.cjs` replaces exact text in the extension source. A different version can change those anchors; the scripts then stop with an error naming the patch that no longer matches, and you have to adapt it by hand.
- Only tested on Windows with Brave. Other Chromium browsers and operating systems may need changes (process detection, paths, launcher).
- Events in hidden tabs are synthetic; a few widgets that insist on trusted input or a visible tab will not respond. Sites that use `window.showOpenFilePicker` (no `<input>`) cannot be automated for uploads.
- `accept=` on file inputs is not enforced by the upload fallback; pick the right file type.
- A popup window an agent's click opens (`window.open` with window features, e.g. "Sign in with Google") is created as a real window, and the browser shows it in front for a moment before the extension minimizes it. Popups that open as tabs don't do this.
- When you open a tab from an agent tab you're viewing, the tab is yours, so the agent won't see a popup it triggered while you were looking at that tab.
- The extension auth token grants control of your browser through the extension. Keep it out of git, logs and screenshots.

## License

Apache-2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE).
