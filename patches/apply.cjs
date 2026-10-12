// Local patches to playwright-core for driving the user's Brave (or another Chromium browser) through the Playwright Extension.
// Re-apply after any `npm install` / Playwright update, then reconnect the MCP server (e.g. /mcp in Claude Code):
//   node patches/apply.cjs
// Runtime env read by the patched code: PW_MCP_BROKER_PORT (default 8770), PW_MCP_BROKER_LAUNCHER (script that
// starts broker.cjs detached; default is Startup\playwright-broker.vbs if present, else node broker.cjs),
// PW_MCP_BROWSER_PROCESS (browser image name for the "is it running" check, default brave.exe),
// PLAYWRIGHT_MCP_GROUP_NAME, PW_MCP_TOOL_CAP_MS.
// Each patch is applied once (marker comment) and fails loudly if its anchor moved.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'node_modules', 'playwright-core', 'lib', 'coreBundle.js');
let src = fs.readFileSync(file, 'utf8');
const original = src;

const patches = [
  {
    // Extension mode (chrome.debugger) rejects DOM.setFileInputFiles with "Not allowed": read the
    // files in Node and inject them via DataTransfer (Playwright's buffer path) instead.
    marker: '/*UPLOAD_FALLBACK*/',
    needle: '          await this._page.delegate.setInputFilePaths(progress2, retargeted, localPathsOrDirectory);\n',
    replacement: `          /*UPLOAD_FALLBACK*/ try {
            // Folders: through the extension DOM.setFileInputFiles neither works nor fails (then the
            // input-event wait below hangs forever), so always use the DataTransfer path for them.
            if (localDirectory)
              throw new Error("Not allowed: folder uploads use the DataTransfer path");
            await this._page.delegate.setInputFilePaths(progress2, retargeted, localPathsOrDirectory);
          } catch (e) {
            if (!/Not allowed/i.test(String(e && e.message)))
              throw e;
            const fsp = import_fs14.default.promises, P = import_path14.default;
            // Folder uploads (<input webkitdirectory>): every file below the folder, with the
            // "folder/sub/file" webkitRelativePath that folder-upload pages read.
            const entries = localDirectory ? (await fsp.readdir(localDirectory, { withFileTypes: true, recursive: true })).filter((f) => f.isFile()).map((f) => {
              const full = P.join(f.parentPath ?? f.path, f.name);
              return { full, relativePath: [P.basename(localDirectory), ...P.relative(localDirectory, full).split(P.sep)].join("/") };
            }) : localPaths.map((full) => ({ full, relativePath: "" }));
            const payloads = await Promise.all(entries.map(async ({ full, relativePath }) => ({
              name: P.basename(full),
              relativePath,
              mimeType: mime5.getType(full) || "application/octet-stream",
              buffer: (await fsp.readFile(full)).toString("base64"),
              lastModifiedMs: (await fsp.stat(full)).mtimeMs
            })));
            // Main world, so the webkitRelativePath overrides are what page scripts see.
            const mainContext = await progress2.race(this._frame.mainContext());
            const mainHandle = retargeted._context === mainContext ? retargeted : await progress2.race(this._page.delegate.adoptElementHandle(retargeted, mainContext));
            try {
              await progress2.race(mainHandle.evaluate((node, files) => {
                const dt = new DataTransfer();
                for (const f of files) {
                  const bytes = Uint8Array.from(atob(f.buffer), (c) => c.charCodeAt(0));
                  dt.items.add(new File([bytes], f.name, { type: f.mimeType, lastModified: f.lastModifiedMs }));
                }
                node.files = dt.files;
                files.forEach((f, i) => {
                  if (f.relativePath)
                    Object.defineProperty(node.files[i], "webkitRelativePath", { value: f.relativePath, configurable: true });
                });
                node.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
                node.dispatchEvent(new Event("change", { bubbles: true }));
              }, payloads));
            } finally {
              if (mainHandle !== retargeted)
                mainHandle.dispose();
            }
          }
`,
  },
  {
    // browser_set_input_files tool: fill <input type=file> without clicking or a file chooser.
    marker: '/*SET_INPUT_FILES_TOOL*/',
    needle: '    files_default = [\n      uploadFile,\n      drop\n    ];\n',
    replacement: `    /*SET_INPUT_FILES_TOOL*/ const setInputFiles = defineTabTool({
      capability: "core",
      schema: {
        name: "browser_set_input_files",
        title: "Set files on a file input",
        description: 'Put files straight into an <input type="file"> without clicking it or opening a file chooser. Target a snapshot ref or a selector such as "input[type=file]" (hidden inputs work). Works in background tabs. Prefer this over browser_click + browser_file_upload.',
        inputSchema: elementSchema.extend({
          paths: z3.array(z3.string()).describe("Absolute paths of the files to set. An empty array clears the input.")
        }),
        type: "action"
      },
      handle: async (tab2, params2, response2) => {
        response2.setIncludeSnapshot();
        const { locator: locator2, resolved } = await tab2.targetLocator(params2);
        const paths = await Promise.all(params2.paths.map((p) => response2.resolveClientFilename(p)));
        await tab2.waitForCompletion(async () => {
          await locator2.setInputFiles(paths, tab2.actionTimeoutOptions);
        });
        response2.addCode(\`await page.\${resolved}.setInputFiles(\${JSON.stringify(paths)});\`);
      }
    });
    files_default = [
      uploadFile,
      drop,
      setInputFiles
    ];
`,
  },
  {
    // Background tabs pause requestAnimationFrame (and throttle timers to 1s-1min), so the "stable"
    // actionability check (click, hover, check...) waited forever. A hidden page can't animate, so
    // treat a connected element as stable at once while the page is hidden.
    // (Injected-script source lives in a string literal, hence the plain one-line replacement.)
    marker: '/*HIDDEN_TAB_STABLE*/',
    needle: 'this.utils.builtins.requestAnimationFrame(raf);',
    count: 2,
    replacement: '/*HIDDEN_TAB_STABLE*/(document.visibilityState === "hidden" ? fulfill(this.retarget(node, "no-follow-label") ? true : "error:notconnected") : this.utils.builtins.requestAnimationFrame(raf));',
  },
  {
    // A background tab that has never been on screen has no rendered frame, so Brave drops trusted
    // mouse presses/wheel there (moves still arrive): clicks silently did nothing and wheel hung.
    // While the page is hidden, synthesize the press/release/click (or wheel + scroll) as DOM events
    // on the element at that point instead. Untrusted, but link/checkbox/label/submit activation and
    // framework handlers all work. Visible tabs keep real input.
    marker: '/*HIDDEN_TAB_INPUT*/',
    needle: `      async down(progress2, x, y, button, buttons, modifiers, clickCount) {
        if (this._dragManager.isDragging())
          return;
`,
    replacement: `      /*HIDDEN_TAB_INPUT*/ async _syntheticIfHidden(progress2, kind, x, y, button, modifiers, clickCount, deltaX, deltaY) {
        const page = (opts) => {
          if (document.visibilityState !== "hidden")
            return false;
          const { kind, x, y, button, clickCount, modifiers, deltaX, deltaY } = opts;
          let target = document.elementFromPoint(x, y);
          while (target && target.shadowRoot) {
            const inner = target.shadowRoot.elementFromPoint(x, y);
            if (!inner || inner === target)
              break;
            target = inner;
          }
          target = target || document.body;
          const btn = { left: 0, middle: 1, right: 2 }[button] ?? 0;
          const state = window.__pwHiddenMouse || (window.__pwHiddenMouse = {});
          const init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y, button: kind === "move" ? 0 : btn, buttons: kind === "down" || (kind === "move" && state.down) ? 1 << btn : 0, detail: clickCount || 1, altKey: modifiers.includes("Alt"), ctrlKey: modifiers.includes("Control"), metaKey: modifiers.includes("Meta"), shiftKey: modifiers.includes("Shift"), pointerId: 1, pointerType: "mouse", isPrimary: true };
          if (kind === "move") {
            const prev = state.hover && state.hover.isConnected ? state.hover : null;
            if (prev !== target) {
              const chain = (el) => { const list = []; for (let n = el; n; n = n.parentNode || n.host) if (n.nodeType === 1) list.push(n); return list; };
              const prevChain = prev ? chain(prev) : [], nextChain = chain(target);
              if (prev) {
                prev.dispatchEvent(new PointerEvent("pointerout", { ...init, relatedTarget: target }));
                prev.dispatchEvent(new MouseEvent("mouseout", { ...init, relatedTarget: target }));
                for (const el of prevChain.filter((n) => !nextChain.includes(n))) {
                  el.dispatchEvent(new PointerEvent("pointerleave", { ...init, bubbles: false, relatedTarget: target }));
                  el.dispatchEvent(new MouseEvent("mouseleave", { ...init, bubbles: false, relatedTarget: target }));
                }
              }
              target.dispatchEvent(new PointerEvent("pointerover", { ...init, relatedTarget: prev }));
              target.dispatchEvent(new MouseEvent("mouseover", { ...init, relatedTarget: prev }));
              for (const el of nextChain.filter((n) => !prevChain.includes(n)).reverse()) {
                el.dispatchEvent(new PointerEvent("pointerenter", { ...init, bubbles: false, relatedTarget: prev }));
                el.dispatchEvent(new MouseEvent("mouseenter", { ...init, bubbles: false, relatedTarget: prev }));
              }
              state.hover = target;
            }
            target.dispatchEvent(new PointerEvent("pointermove", init));
            target.dispatchEvent(new MouseEvent("mousemove", init));
            return true;
          }
          if (kind === "down") {
            target.dispatchEvent(new PointerEvent("pointerdown", init));
            if (target.dispatchEvent(new MouseEvent("mousedown", init))) {
              const focusable = target.closest("input, textarea, select, button, a[href], [tabindex], [contenteditable]");
              if (focusable)
                focusable.focus();
              else if (document.activeElement && document.activeElement !== document.body)
                document.activeElement.blur();
            }
            state.down = target;
          } else if (kind === "up") {
            target.dispatchEvent(new PointerEvent("pointerup", init));
            target.dispatchEvent(new MouseEvent("mouseup", init));
            const down = state.down;
            state.down = null;
            if (down && (down === target || down.contains(target) || target.contains(down))) {
              if (btn === 0) {
                // A link that opens a new tab/window would open as the user's active tab. Let the site's
                // own click handlers run, then (if none cancelled it) cancel the default and have the
                // server open the URL as a background tab instead.
                const link = target.closest("a[href]");
                const opensNew = link && link.target && !["_self", "_top", "_parent"].includes(link.target.toLowerCase());
                let openUrl = null;
                const takeOver = (e) => {
                  if (!e.defaultPrevented) {
                    e.preventDefault();
                    openUrl = link.href;
                  }
                };
                if (opensNew)
                  window.addEventListener("click", takeOver, { once: true });
                target.dispatchEvent(new PointerEvent("click", init));
                if (opensNew)
                  window.removeEventListener("click", takeOver);
                if (openUrl)
                  return { openUrl };
                if (clickCount === 2)
                  target.dispatchEvent(new MouseEvent("dblclick", init));
              } else {
                target.dispatchEvent(new PointerEvent("auxclick", init));
                if (btn === 2)
                  target.dispatchEvent(new PointerEvent("contextmenu", init));
              }
            } else if (down && btn === 0) {
              // Released over another element: HTML5 drag-and-drop from the nearest draggable.
              let source = down;
              while (source && !source.draggable)
                source = source.parentElement;
              if (source) {
                const dataTransfer = new DataTransfer();
                const drag = (el, type) => el.dispatchEvent(new DragEvent(type, { ...init, buttons: type === "dragend" ? 0 : 1, dataTransfer }));
                if (drag(source, "dragstart")) {
                  drag(source, "drag");
                  drag(target, "dragenter");
                  if (!drag(target, "dragover"))
                    drag(target, "drop");
                  else
                    drag(target, "dragleave");
                }
                drag(source, "dragend");
              }
            }
          } else if (kind === "wheel") {
            if (target.dispatchEvent(new WheelEvent("wheel", { ...init, deltaX, deltaY, deltaMode: 0 }))) {
              for (let el = target; el && el !== document.documentElement && el !== document.body; el = el.parentElement) {
                const style = getComputedStyle(el);
                if (/(auto|scroll)/.test(style.overflowY + style.overflowX) && (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth)) {
                  el.scrollBy(deltaX, deltaY);
                  return true;
                }
              }
              window.scrollBy(deltaX, deltaY);
            }
          }
          return true;
        };
        const args = { kind, x, y, button, clickCount, modifiers: [...modifiers], deltaX, deltaY };
        const res = await progress2.race(this._client.send("Runtime.evaluate", { expression: \`(\${page})(\${JSON.stringify(args)})\`, returnByValue: true, userGesture: true })).catch(() => null);
        const value = res?.result?.value;
        if (value && typeof value === "object" && value.openUrl) {
          try {
            const newPage = await progress2.race(this._page.browserContext.newPage(progress2));
            await newPage.delegate._mainFrameSession._client.send("Page.navigate", { url: value.openUrl });
          } catch {
          }
          return true;
        }
        return value === true;
      }
      async down(progress2, x, y, button, buttons, modifiers, clickCount) {
        if (this._dragManager.isDragging())
          return;
        if (await this._syntheticIfHidden(progress2, "down", x, y, button, modifiers, clickCount))
          return;
`,
  },
  {
    marker: '/*HIDDEN_TAB_INPUT_MOVE*/',
    needle: `      async move(progress2, x, y, button, buttons, modifiers, forClick) {
        const actualMove = async (progress3) => {
          await progress3.race(this._client.send("Input.dispatchMouseEvent", {
            type: "mouseMoved",`,
    replacement: `      async move(progress2, x, y, button, buttons, modifiers, forClick) {
        /*HIDDEN_TAB_INPUT_MOVE*/ if (!this._dragManager.isDragging() && await this._syntheticIfHidden(progress2, "move", x, y, button, modifiers, 0))
          return;
        const actualMove = async (progress3) => {
          await progress3.race(this._client.send("Input.dispatchMouseEvent", {
            type: "mouseMoved",`,
  },
  {
    marker: '/*HIDDEN_TAB_INPUT_UP*/',
    needle: `          await this._dragManager.drop(progress2, x, y, modifiers);
          return;
        }
        await progress2.race(this._client.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",`,
    replacement: `          await this._dragManager.drop(progress2, x, y, modifiers);
          return;
        }
        /*HIDDEN_TAB_INPUT_UP*/ if (await this._syntheticIfHidden(progress2, "up", x, y, button, modifiers, clickCount))
          return;
        await progress2.race(this._client.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",`,
  },
  {
    marker: '/*HIDDEN_TAB_INPUT_WHEEL*/',
    needle: `      async wheel(progress2, x, y, buttons, modifiers, deltaX, deltaY) {
        await progress2.race(this._client.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",`,
    replacement: `      async wheel(progress2, x, y, buttons, modifiers, deltaX, deltaY) {
        /*HIDDEN_TAB_INPUT_WHEEL*/ if (await this._syntheticIfHidden(progress2, "wheel", x, y, "none", modifiers, 0, deltaX, deltaY))
          return;
        await progress2.race(this._client.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",`,
  },
  {
    // Native-drag detection waits on an in-page setTimeout (throttled in background tabs, so
    // dragTo hung). Hidden tabs get the synthetic HTML5 drag from HIDDEN_TAB_INPUT instead.
    marker: '/*HIDDEN_TAB_NO_DRAG_INTERCEPT*/',
    needle: `        if (button !== "left")
          return moveCallback(progress2);
        const client = this._crPage._mainFrameSession._client;`,
    replacement: `        if (button !== "left")
          return moveCallback(progress2);
        /*HIDDEN_TAB_NO_DRAG_INTERCEPT*/ const visibility = await this._crPage._mainFrameSession._client.send("Runtime.evaluate", { expression: "document.visibilityState", returnByValue: true }).catch(() => null);
        if (visibility?.result?.value === "hidden")
          return moveCallback(progress2);
        const client = this._crPage._mainFrameSession._client;`,
  },
  {
    // After every action the MCP "settles" with an in-page setTimeout; Brave throttles timers in
    // background tabs (1s, then 1 min), so each tool call hung 60-100s. Wait in Node instead.
    marker: '/*NODE_SETTLE_TIMER*/',
    needle: `      async waitForTimeout(time) {
        if (this._javaScriptBlocked()) {`,
    replacement: `      async waitForTimeout(time) {
        /*NODE_SETTLE_TIMER*/ if (true) {`,
  },
  {
    // Brave freezes background tabs (measured 2026-10-10: FREEZE 2s after setup, then no timers,
    // no network callbacks), so a site's own JS stalls after e.g. clicking SEND. While the main
    // frame is hidden, keep its lifecycle "active" (unfreezes it) every 2s.
    marker: '/*KEEP_UNFROZEN*/',
    needle: `          lifecycleEventsEnabled = this._client.send("Page.setLifecycleEventsEnabled", { enabled: true }),`,
    replacement: `          lifecycleEventsEnabled = this._client.send("Page.setLifecycleEventsEnabled", { enabled: true }),
          /*KEEP_UNFROZEN*/ (() => {
            if (!this._isMainFrame())
              return Promise.resolve();
            const keepActive = () => this._client.send("Page.setWebLifecycleState", { state: "active" }).catch(() => {});
            const timer = setInterval(() => {
              this._client.send("Runtime.evaluate", { expression: "document.visibilityState", returnByValue: true }).then((r) => {
                if (r?.result?.value === "hidden")
                  return keepActive();
              }).catch(() => {});
            }, 2e3);
            timer.unref?.();
            this._keepUnfrozenTimer = timer;
            (globalThis.__pwMainFrameSessions ??= new Set()).add(this);
            return Promise.resolve();
          })(),`,
  },
  {
    marker: '/*KEEP_UNFROZEN_DISPOSE*/',
    needle: `      dispose() {
        this._firstNonInitialNavigationCommittedReject(new TargetClosedError(this._page.closeReason()));`,
    replacement: `      dispose() {
        /*KEEP_UNFROZEN_DISPOSE*/ clearInterval(this._keepUnfrozenTimer);
        globalThis.__pwMainFrameSessions?.delete(this);
        this._firstNonInitialNavigationCommittedReject(new TargetClosedError(this._page.closeReason()));`,
  },
  {
    // No tool call may hang: on 2026-10-10 one browser_run_code_unsafe (click SEND, wait, evaluate)
    // sat for 25+ minutes in a background tab. Cap every call at 120s and hand control back.
    marker: '/*TOOL_CALL_CAP*/',
    needle: `        try {
          await handle(parsedArguments, response2);
          for (const reason of context.drainPendingUnhandledRejections())`,
    replacement: `        try {
          /*TOOL_CALL_CAP*/ const capMs = +(process.env.PW_MCP_TOOL_CAP_MS || 120000);
          const startedAt = Date.now();
          const logStall = (what) => {
            try {
              require("fs").appendFileSync(require("path").join(__dirname, "..", "..", "..", "stalls.log"), \`\${new Date().toISOString()} \${name} \${what} \${JSON.stringify(parsedArguments).slice(0, 300)}\n\`);
            } catch {
            }
          };
          // Self-heal: if the current tab no longer answers (hung renderer, endless page script),
          // open a fresh background tab first (so the connection keeps a tab) and close the dead one,
          // before Brave can show its "Page unresponsive" prompt. Skipped while a dialog is open
          // (a dialog legitimately blocks page scripts).
          const healTab = async () => {
            try {
              const tab = context.currentTab();
              if (!tab || tab.page.isClosed() || tab.modalStates().length)
                return "";
              // Only a timeout means hung; an error (browser error page, navigation in flight) is alive.
              const alive = await Promise.race([tab.page.evaluate(() => 1).then(() => true, () => true), new Promise((r) => setTimeout(() => r(false), 3e3))]);
              if (alive)
                return "";
              const url = tab.page.url();
              for (const session of globalThis.__pwMainFrameSessions ?? []) {
                try {
                  if (session._page.mainFrame().url() === url)
                    session._client.send("Runtime.terminateExecution").catch(() => {});
                } catch {
                }
              }
              await Promise.race([context.newTab().catch(() => {}), new Promise((r) => setTimeout(r, 8e3))]);
              await Promise.race([tab.page.close({ runBeforeUnload: false }).catch(() => {}), new Promise((r) => setTimeout(r, 5e3))]);
              logStall("tab unresponsive, closed " + url);
              return \` The tab (\${url}) stopped responding (endless page script or hung renderer), so it was closed and a fresh blank tab opened: navigate back and continue.\`;
            } catch {
              return "";
            }
          };
          let capTimer, callError;
          try {
            await Promise.race([
              handle(parsedArguments, response2),
              new Promise((_, reject) => capTimer = setTimeout(() => reject(Object.assign(new Error("cap"), { isCap: true })), capMs))
            ]);
          } catch (e) {
            callError = e;
          } finally {
            clearTimeout(capTimer);
          }
          const recovery = callError || Date.now() - startedAt > 4e3 ? await healTab() : "";
          if (callError?.isCap) {
            logStall(\`capped after \${capMs}ms\`);
            throw new Error(\`Tool "\${name}" gave up after \${capMs / 1000}s: the page is stuck or still busy (a background tab can be frozen by Brave, or a dialog/navigation is pending).\${recovery} Do not repeat the same call. Take browser_snapshot to see the page state, then continue; in run_code/evaluate never wait inside the page.\`);
          }
          if (callError) {
            if (recovery)
              callError.message += recovery;
            throw callError;
          }
          if (recovery)
            response2.addError(recovery.trim());
          for (const reason of context.drainPendingUnhandledRejections())`,
  },
  {
    // The response snapshot after each tool also touches the page; bound it so a stuck page can't
    // hang the call after the capped part finished.
    marker: '/*SERIALIZE_CAP*/',
    needle: `          responseObject = await response2.serialize();
          this._sessionLog?.logResponse(name, parsedArguments, responseObject);`,
    replacement: `          /*SERIALIZE_CAP*/ let serializeTimer;
          responseObject = await Promise.race([
            response2.serialize(),
            new Promise((r) => serializeTimer = setTimeout(() => r({ content: [{ type: "text", text: \`### Error
Tool "\${name}" ran, but reading the page afterwards timed out (the page is stuck). Take browser_snapshot or open a new tab.\` }], isError: true }), 30e3))
          ]).finally(() => clearTimeout(serializeTimer));
          this._sessionLog?.logResponse(name, parsedArguments, responseObject);`,
  },
  {
    // Switching tabs must not raise the browser over the user's work (Page.bringToFront focuses the window).
    marker: '/*NO_BRING_TO_FRONT*/',
    needle: '        await tab2.page.bringToFront();\n        await tab2.updateWebMCPTools();\n',
    replacement: '        /*NO_BRING_TO_FRONT*/\n        await tab2.updateWebMCPTools();\n',
  },
  {
    // New tabs open in the background instead of switching the user's current tab.
    marker: '/*BACKGROUND_TABS*/',
    needle: '        const tab2 = await this._sendToExtension("chrome.tabs.create", [{ url: url3 }]);\n',
    replacement: '        /*BACKGROUND_TABS*/ const tab2 = await this._sendToExtension("chrome.tabs.create", [{ url: url3, active: false }]);\n',
  },
  {
    // The extension names each agent's tab group after the MCP client ("claude-code"), so every
    // session looked the same. Send what the session is working on instead:
    // the T3 Code thread title (optional: used only when T3 Code's state.sqlite and Claude Code's session files exist), found via ~/.claude/sessions/<claude pid>.json (sessionId) and T3's
    // state.sqlite (each thread stores the Claude session it resumes), read-only. Falls back to the
    // project folder (worktrees map back to their repo), then the client name for home/system dirs.
    // PLAYWRIGHT_MCP_GROUP_NAME overrides everything. PW_MCP_PARENT_PID comes from mcp-supervisor.cjs.
    marker: '/*GROUP_NAME*/',
    needle: '        const client = {\n          name: clientName,\n',
    replacement: `        /*GROUP_NAME*/ const projectName = (() => {
          if (process.env.PLAYWRIGHT_MCP_GROUP_NAME)
            return process.env.PLAYWRIGHT_MCP_GROUP_NAME;
          const P = require("path"), fs = require("fs"), os = require("os");
          try {
            const sessionOf = (pid) => {
              try {
                return JSON.parse(fs.readFileSync(P.join(os.homedir(), ".claude", "sessions", pid + ".json"), "utf8")).sessionId;
              } catch {
                return null;
              }
            };
            // Supervisors started before PW_MCP_PARENT_PID existed: ask Windows for the grandparent.
            const grandparent = () => {
              try {
                return require("child_process").execFileSync("powershell.exe", ["-NoProfile", "-Command", "(Get-CimInstance Win32_Process -Filter 'ProcessId=" + process.ppid + "').ParentProcessId"], { windowsHide: true, encoding: "utf8", timeout: 8e3 }).trim();
              } catch {
                return null;
              }
            };
            const sessionId = process.env.CLAUDE_CODE_SESSION_ID || (process.env.PW_MCP_PARENT_PID && sessionOf(process.env.PW_MCP_PARENT_PID)) || sessionOf(process.ppid) || sessionOf(grandparent());
            const dbPath = P.join(os.homedir(), ".t3", "userdata", "state.sqlite");
            if (sessionId && fs.existsSync(dbPath)) {
              const db = new (require("node:sqlite").DatabaseSync)(dbPath, { readOnly: true });
              try {
                const row = db.prepare("select t.title from provider_session_runtime r join projection_threads t on t.thread_id = r.thread_id where json_extract(r.resume_cursor_json, '$.resume') = ? and t.deleted_at is null order by r.last_seen_at desc limit 1").get(sessionId);
                const title = row?.title?.trim();
                if (title && !/^new thread$/i.test(title))
                  return title.length > 40 ? title.slice(0, 39) + "\\u2026" : title;
              } finally {
                db.close();
              }
            }
          } catch {
          }
          const dir = P.resolve(process.cwd());
          const parts = dir.split(/[\\\\/]+/).filter(Boolean);
          const wt = parts.findIndex((s, i) => s.toLowerCase() === "worktrees" && /^\\.(claude|t3)$/i.test(parts[i - 1] || ""));
          if (wt > 0)
            return parts[wt - 1].toLowerCase() === ".claude" ? parts[wt - 2] : parts[wt + 1];
          const generic = [require("os").homedir(), process.env.SystemRoot || "C:\\\\Windows"].map((d) => P.resolve(d).toLowerCase());
          if (parts.length < 2 || generic.some((g) => dir.toLowerCase() === g || (g.endsWith("windows") && dir.toLowerCase().startsWith(g))))
            return null;
          return parts[parts.length - 1];
        })();
        const client = {
          name: projectName || clientName,
`,
  },
  {
    // Launching brave.exe with the connect URL always brings Brave to the front. Ask broker.cjs to
    // have the (local build of the) extension open it in a minimized window instead; start the
    // broker if it isn't running; fall back to launching Brave only if that fails.
    marker: '/*BROKER_OPEN*/',
    needle: '        const href = url3.toString();\n',
    replacement: `        const href = url3.toString();
        /*BROKER_OPEN*/ const brokerPort = process.env.PW_MCP_BROKER_PORT || 8770;
        const openViaBroker = async () => {
          const post = () => fetch("http://127.0.0.1:" + brokerPort + "/open", { method: "POST", body: href, signal: AbortSignal.timeout(45e3) });
          let res;
          try {
            res = await post();
          } catch (e) {
            if (e?.cause?.code !== "ECONNREFUSED")
              return false;
            const brokerPath = require("path").join(__dirname, "..", "..", "..", "broker.cjs");
            if (!require("fs").existsSync(brokerPath))
              return false;
            // Start it through its hidden launcher (wscript exits at once), so the broker is not a child
            // of this MCP server and survives when the server's process tree is killed.
            const launcher = process.env.PW_MCP_BROKER_LAUNCHER || require("path").join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "playwright-broker.vbs");
            if (launcher && require("fs").existsSync(launcher))
              require("child_process").spawn("wscript.exe", [launcher], { detached: true, windowsHide: true, stdio: "ignore" }).unref();
            else
              require("child_process").spawn(process.execPath, [brokerPath], { detached: true, windowsHide: true, stdio: "ignore" }).unref();
            await new Promise((r) => setTimeout(r, 1500));
            res = await post().catch(() => null);
          }
          return !!res?.ok;
        };
        if (await openViaBroker())
          return;
        // Launching the browser exe while the browser is already running pulls it over the user's work, so only do
        // that when the browser is closed; otherwise fail loudly so the agent reports the real problem.
        const browserExe = process.env.PW_MCP_BROWSER_PROCESS || "brave.exe";
        let browserRunning = false;
        try {
          browserRunning = require("child_process").execFileSync("tasklist", ["/FI", "IMAGENAME eq " + browserExe, "/NH"], { windowsHide: true, encoding: "utf8" }).toLowerCase().includes(browserExe.toLowerCase());
        } catch {
        }
        if (browserRunning)
          throw new Error("The browser is running but the background Playwright extension is not connected to broker.cjs (http://127.0.0.1:" + brokerPort + "/status). Not launching " + browserExe + " because that would take over the user's screen. Ask the user to check the Playwright Extension card in the browser's extensions page (enabled, no errors, reload).");
`,
  },
];

for (const p of patches) {
  if (src.includes(p.marker)) continue;
  const found = src.split(p.needle).length - 1;
  if (found !== (p.count ?? 1)) {
    console.error(`${p.marker}: anchor found ${found}x, expected ${p.count ?? 1}; Playwright changed, patch by hand`);
    process.exit(1);
  }
  src = src.split(p.needle).join(p.replacement);
  console.log('applied', p.marker);
}

if (src === original) {
  console.log('already patched:', file);
} else {
  if (!fs.existsSync(file + '.bak-original')) fs.writeFileSync(file + '.bak-original', original);
  fs.writeFileSync(file, src);
  console.log('patched:', file);
}
