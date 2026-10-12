// Builds extension-bg/: a local copy of the Playwright Extension that never pulls the browser to the front.
//   node patches/build-extension.cjs [path-to-store-extension-version-dir] [--out <dir>] [--server <name>]
// Source defaults to the newest store copy in the browser's profile (Brave's Default profile on Windows;
// override with PW_MCP_BROWSER_USER_DATA and PW_MCP_PROFILE), or extension-src/ (a pristine
// copy saved by the first build, because the store copy is removed when the local one is installed).
// Output dir: --out <dir> or PW_MCP_EXTENSION_OUT, default ./extension-bg next to this repo's package.json.
// Token: PLAYWRIGHT_MCP_EXTENSION_TOKEN env var first, else ~/.claude.json mcpServers.<name>.env
// (<name> from --server or PW_MCP_SERVER_NAME, default "brave"). The token is baked into the output dir only,
// which is gitignored: never commit it.
// Broker port baked into the extension: PW_MCP_BROKER_PORT (default 8770; must match broker.cjs).
// Changes vs. the store build:
//  - connecting no longer activates the tab or focuses the browser window;
//  - connect pages arrive from broker.cjs (no brave.exe launch) and open as background tabs;
//  - every agent tab is a background tab (never active) in a collapsed "🤖 <thread title>" tab group, and
//    the tabs an MCP server created are closed when it disconnects. No windows are ever created:
//    on Windows, creating a browser window (even minimized) activates the browser and steals focus;
//  - broker.cjs can send {type:"reload"} so a rebuilt copy is picked up without touching brave://extensions;
//  - the auth token is seeded with PLAYWRIGHT_MCP_EXTENSION_TOKEN (see above), so the config
//    keeps working after the store copy (and its storage) is removed.
// Keeps the manifest "key", so the extension ID (mmlmfjhmonkocbjadbfplnigmagldckm) is unchanged.
const fs = require('fs');
const path = require('path');

const os = require('os');

const ID = 'mmlmfjhmonkocbjadbfplnigmagldckm';
const root = path.join(__dirname, '..');
// CLI: optional positional source dir, --out <dir>, --server <name>.
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const outArg = flag('--out') || process.env.PW_MCP_EXTENSION_OUT;
const serverName = flag('--server') || process.env.PW_MCP_SERVER_NAME || 'brave';
const BROKER_PORT = Number(process.env.PW_MCP_BROKER_PORT) || 8770;
const dest = outArg ? path.resolve(outArg) : path.join(root, 'extension-bg');
const pristine = path.join(root, 'extension-src');
const userData = process.env.PW_MCP_BROWSER_USER_DATA || path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware', 'Brave-Browser', 'User Data');
const storeDir = path.join(userData, process.env.PW_MCP_PROFILE || 'Default', 'Extensions', ID);

let src = argv[0];
if (!src && fs.existsSync(storeDir)) {
  const versions = fs.readdirSync(storeDir).filter((v) => fs.existsSync(path.join(storeDir, v, 'manifest.json'))).sort();
  if (versions.length) src = path.join(storeDir, versions[versions.length - 1]);
}
if (!src) src = pristine;
if (!fs.existsSync(path.join(src, 'manifest.json'))) throw new Error('No extension source found at ' + src);
if (path.resolve(src) !== path.resolve(pristine)) {
  fs.rmSync(pristine, { recursive: true, force: true });
  fs.cpSync(src, pristine, { recursive: true, filter: (p) => !p.includes(`${path.sep}_metadata`) });
}

let token = process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
if (!token) {
  try {
    token = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')).mcpServers[serverName].env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
  } catch {}
}
if (!token) throw new Error(`PLAYWRIGHT_MCP_EXTENSION_TOKEN is not set and was not found in ~/.claude.json mcpServers.${serverName}.env`);

fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(pristine, dest, { recursive: true });

function patch(rel, edits) {
  const file = path.join(dest, rel);
  let text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  for (const [needle, replacement] of edits) {
    if (text.split(needle).length !== 2) throw new Error(`${rel}: anchor not found exactly once (extension changed, update this script):\n${needle}`);
    text = text.replace(needle, replacement);
  }
  fs.writeFileSync(file, text);
}

// manifest: no store updates (they would overwrite this build), extra permissions for the broker.
const manifestPath = path.join(dest, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
delete manifest.update_url;
manifest.permissions = [...new Set([...manifest.permissions, 'storage', 'alarms'])];
manifest.version_name = `${manifest.version}-background`;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

patch('lib/ui/authToken.js', [[
  '\t\ttoken = generateAuthToken();\n',
  `\t\ttoken = ${JSON.stringify(token)} || generateAuthToken();\n`,
]]);

patch('lib/background.mjs', [
  // 1) Connecting must not activate the tab or focus the window.
  [
    '\t\t\tawait Promise.all([chrome.tabs.update(tab.id, { active: true }), chrome.windows.update(tab.windowId, { focused: true })]).catch(() => {});\n',
    '\t\t\t// local build: no tab activation / window focus on connect (runs in the background)\n',
  ],
  // 2) Tabs the MCP opens are background tabs next to its other tabs; remember them for cleanup.
  [
    '\t\tconst result = await invokeChromeMethod(message.method, args);\n',
    '\t\tif (message.method === "chrome.tabs.create") args[0] = await backgroundTabOptions(args[0] ?? {}, this._attachedTabs);\n\t\tconst result = await invokeChromeMethod(message.method, args);\n\t\tif (message.method === "chrome.tabs.create" && result?.id !== void 0) await rememberAgentTab(result.id);\n',
  ],
  // 3) Close the tabs we created for this connection when the MCP server disconnects.
  [
    '\t\tif (groupTabs.length) ungroupTabs(groupTabs);\n',
    '\t\tif (groupTabs.length) ungroupTabs(groupTabs);\n\t\tcloseAgentTabs(groupTabs);\n',
  ],
  // 4) Keep the Playwright tab group collapsed so it is just a small chip in the tab strip.
  [
    '\t\t\t\t\tawait chrome.tabGroups.update(this._groupId, this.groupStyle);\n',
    '\t\t\t\t\tawait chrome.tabGroups.update(this._groupId, { ...this.groupStyle, collapsed: true });\n',
  ],
  // 4c) Group title = "🤖 <project>" (apply.cjs sends the project folder as the client name) instead
  //     of "Playwright · claude-code", which truncated to the same chip for every session. Groups
  //     left over from the old title are still cleaned up on startup.
  [
    'var PLAYWRIGHT_GROUP_TITLE = "Playwright";\nvar PLAYWRIGHT_GROUP_TITLE_PREFIX = `${PLAYWRIGHT_GROUP_TITLE} · `;\n',
    'var PLAYWRIGHT_GROUP_TITLE = "🤖";\nvar PLAYWRIGHT_GROUP_TITLE_PREFIX = `${PLAYWRIGHT_GROUP_TITLE} `;\nvar LEGACY_GROUP_TITLE = "Playwright";\n',
  ],
  [
    'g.title === PLAYWRIGHT_GROUP_TITLE || g.title?.startsWith(PLAYWRIGHT_GROUP_TITLE_PREFIX));\n',
    'g.title === PLAYWRIGHT_GROUP_TITLE || g.title?.startsWith(PLAYWRIGHT_GROUP_TITLE_PREFIX) || g.title?.startsWith(LEGACY_GROUP_TITLE));\n',
  ],
  // 4d) Brave deletes a group when its last tab closes; the store build kept adding new tabs to the
  //     dead group id, failed, and left them as loose ungrouped tabs. Start a new group instead.
  [
    '\t\t\t\tif (this._groupId === null) {\n',
    '\t\t\t\tif (this._groupId !== null && !await chrome.tabGroups.get(this._groupId).catch(() => null)) this._groupId = null;\n\t\t\t\tif (this._groupId === null) {\n',
  ],
  // 4a) Keep the connection when the last agent tab closes (the user closed it, or a hung tab was
  //     closed by the MCP self-heal). Closing it left the MCP session dead until /mcp; open
  //     sessions now just create a new tab on the next call. The MCP process exit still closes it.
  [
    '\t\tif (this._hasEverAttached && this._attachedTabs.size === 0 && this._pendingReattach.size === 0) this.close("All controlled tabs detached");\n',
    '\t\t// local build: keep the connection open with zero tabs (see build-extension.cjs 4a)\n',
  ],
  // 4e) A tab the user opened from an agent tab (link, middle-click, Ctrl+T while viewing it) is theirs,
  //     not the agent's: don't announce it to the MCP (it auto-attached it, pulled it into the collapsed
  //     group and could make it the agent's current tab), and push it out of the 🤖 group the browser
  //     put it in. See isUserOpenedTab in the broker region.
  [
    '\t\t\tcase "chrome.tabs.onCreated": return args[0].openerTabId;\n',
    '\t\t\tcase "chrome.tabs.onCreated": return isUserOpenedTab(args[0]) ? void 0 : args[0].openerTabId;\n',
  ],
  [
    '\t\t\tif (this._isTabReserved(tabId)) {\n',
    '\t\t\tif (this._isTabReserved(tabId) || userOpenedTabs.has(tabId)) {\n',
  ],
  // 4b) Never let Memory Saver discard a tab an agent is attached to.
  [
    '\t_onTabAttached(tabId) {\n\t\tthis._updateBadge(tabId, CONNECTED_BADGE);\n',
    '\t_onTabAttached(tabId) {\n\t\tthis._updateBadge(tabId, CONNECTED_BADGE);\n\t\tchrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});\n',
  ],
  // 5) Broker client.
  [
    'new PlaywrightExtension();\n',
    `new PlaywrightExtension();
//#region local build: background broker (see broker.cjs)
var BROKER_URL = "ws://127.0.0.1:${BROKER_PORT}/ext";
var AGENT_TABS_KEY = "agentTabIds";
var brokerSocket = null;
function connectBroker() {
	if (brokerSocket && brokerSocket.readyState <= WebSocket.OPEN) return;
	let ws;
	try {
		ws = new WebSocket(BROKER_URL);
	} catch {
		return;
	}
	brokerSocket = ws;
	ws.onmessage = async (event) => {
		let msg;
		try {
			msg = JSON.parse(event.data);
		} catch {
			return;
		}
		if (msg.type === "reload") {
			chrome.runtime.reload();
			return;
		}
		if (msg.type !== "open") return;
		try {
			const tab = await openConnectPage(msg.url);
			ws.send(JSON.stringify({ id: msg.id, ok: true, tabId: tab.id }));
		} catch (error) {
			ws.send(JSON.stringify({ id: msg.id, ok: false, error: String(error?.message ?? error) }));
		}
	};
	ws.onerror = () => {};
	ws.onclose = () => {
		if (brokerSocket === ws) brokerSocket = null;
	};
}
// The browser may not activate permissions added to an unpacked copy of a store extension (on 2026-10-10 it
// kept the store manifest's set, so chrome.alarms/chrome.storage were undefined and the worker crashed
// at startup). Use them only when present; fall back to memory and to browser events for reconnects.
var agentTabMemory = /* @__PURE__ */ new Set();
async function agentTabIds() {
	if (!chrome.storage?.session) return new Set(agentTabMemory);
	const { [AGENT_TABS_KEY]: ids } = await chrome.storage.session.get(AGENT_TABS_KEY).catch(() => ({}));
	return new Set([...(ids ?? []), ...agentTabMemory]);
}
async function saveAgentTabIds(ids) {
	agentTabMemory = new Set(ids);
	await chrome.storage?.session?.set({ [AGENT_TABS_KEY]: [...ids] }).catch(() => {});
}
async function rememberAgentTab(tabId) {
	const ids = await agentTabIds();
	ids.add(tabId);
	await saveAgentTabIds(ids);
	// Memory Saver must not discard a tab an agent is working in (it would reload mid-task).
	await chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
}
async function openConnectPage(url) {
	if (!url.startsWith(chrome.runtime.getURL("connect.html") + "?")) throw new Error("Refusing to open a non-connect URL");
	const tab = await chrome.tabs.create({ url, active: false });
	await rememberAgentTab(tab.id);
	return tab;
}
async function backgroundTabOptions(options, attachedTabIds) {
	let windowId = options.windowId;
	for (const tabId of attachedTabIds) {
		if (windowId !== void 0) break;
		windowId = await chrome.tabs.get(tabId).then((t) => t.windowId, () => void 0);
	}
	return { ...options, ...(windowId !== void 0 ? { windowId } : {}), active: false };
}
async function closeAgentTabs(tabIds) {
	const ours = await agentTabIds();
	const ids = tabIds.filter((id) => ours.has(id));
	if (!ids.length) return;
	for (const id of ids) {
		ours.delete(id);
		tabCloseReasons.set(id, "session disconnected");
	}
	await saveAgentTabIds(ours);
	await chrome.tabs.remove(ids).catch(() => {});
}
if (chrome.alarms) {
	chrome.alarms.create("playwright-broker", { periodInMinutes: .5 });
	chrome.alarms.onAlarm.addListener((alarm) => {
		if (alarm.name === "playwright-broker") connectBroker();
	});
}
// Popups opened by agent pages (target=_blank, window.open) must not switch the user's tab or window.
// Remember the user's last active tab per window; when a tab whose opener is an agent tab appears,
// adopt it as an agent tab and give the user's tab back.
var lastUserTab = /* @__PURE__ */ new Map();
async function isAgentTab(tabId) {
	if (tabId === void 0) return false;
	if (userOpenedTabs.has(tabId)) return false;
	if ((await agentTabIds()).has(tabId)) return true;
	const tab = await chrome.tabs.get(tabId).catch(() => null);
	if (!tab || tab.groupId === void 0 || tab.groupId < 0) return false;
	const group = await chrome.tabGroups.get(tab.groupId).catch(() => null);
	return !!group?.title?.startsWith(PLAYWRIGHT_GROUP_TITLE);
}
// Who opened a new tab: the user or an agent? Agents only work in background tabs, so a tab whose
// opener is the tab on screen (the active tab of the last focused browser window) was opened by the
// user, even if that tab is an agent's (they were reviewing it). Before 2026-10-12 every tab opened from
// an agent tab was adopted: the user got bounced to an old tab and the agent took the new one over.
// Decided once per tab, synchronously (the relay's onCreated forwarder asks too, and must get the same answer).
var activeTabByWindow = /* @__PURE__ */ new Map();
var previousActiveTabByWindow = /* @__PURE__ */ new Map();
var activatedAtByWindow = /* @__PURE__ */ new Map();
var lastFocusedWindow = null;
var userOpenedTabs = /* @__PURE__ */ new Set();
var classifiedTabs = /* @__PURE__ */ new Set();
function isUserOpenedTab(tab) {
	if (tab?.id === void 0 || tab.openerTabId === void 0) return false;
	if (!classifiedTabs.has(tab.id)) {
		classifiedTabs.add(tab.id);
		if (lastFocusedWindow !== null && activeTabByWindow.get(lastFocusedWindow) === tab.openerTabId) userOpenedTabs.add(tab.id);
	}
	return userOpenedTabs.has(tab.id);
}
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
	previousActiveTabByWindow.set(windowId, activeTabByWindow.get(windowId));
	activeTabByWindow.set(windowId, tabId);
	activatedAtByWindow.set(windowId, Date.now());
});
chrome.windows.onFocusChanged.addListener((windowId) => {
	if (windowId !== chrome.windows.WINDOW_ID_NONE) lastFocusedWindow = windowId;
});
chrome.tabs.onRemoved.addListener((tabId) => {
	classifiedTabs.delete(tabId);
	userOpenedTabs.delete(tabId);
});
chrome.windows.getLastFocused().then((w) => {
	if (lastFocusedWindow === null && w?.id !== void 0) lastFocusedWindow = w.id;
}).catch(() => {});
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
	const tab = await chrome.tabs.get(tabId).catch(() => null);
	if (!tab || await isAgentTab(tabId) || (!userOpenedTabs.has(tabId) && await isAgentTab(tab.openerTabId))) return;
	lastUserTab.set(windowId, tabId);
});
chrome.tabs.query({ active: true }).then(async (tabs) => {
	for (const t of tabs) {
		if (!activeTabByWindow.has(t.windowId)) activeTabByWindow.set(t.windowId, t.id);
		if (!lastUserTab.has(t.windowId) && !await isAgentTab(t.id) && !await isAgentTab(t.openerTabId)) lastUserTab.set(t.windowId, t.id);
	}
}).catch(() => {});
chrome.tabs.onCreated.addListener(async (tab) => {
	if (isUserOpenedTab(tab)) {
		// The user's tab: leave it active and get it out of the collapsed agent group the browser put it in.
		if (tab.groupId !== void 0 && tab.groupId >= 0) {
			const group = await chrome.tabGroups.get(tab.groupId).catch(() => null);
			if (group?.title?.startsWith(PLAYWRIGHT_GROUP_TITLE)) await ungroupTabs([tab.id]);
		}
		return;
	}
	// Fast path first (no awaits) so a popup that grabbed the active tab is reverted within ms.
	const knownAgentOpener = tab.openerTabId !== void 0 && agentTabMemory.has(tab.openerTabId);
	if (knownAgentOpener && tab.active && lastUserTab.has(tab.windowId)) chrome.tabs.update(lastUserTab.get(tab.windowId), { active: true }).catch(() => {});
	if (!knownAgentOpener && !await isAgentTab(tab.openerTabId)) return;
	await rememberAgentTab(tab.id);
	const opener = await chrome.tabs.get(tab.openerTabId).catch(() => null);
	if (opener && tab.windowId !== opener.windowId) {
		// A popup window: minimize it so the OS hands focus back to whatever the user was using. Never
		// focus a browser window here: when they were in another app that raised the browser over it (2026-10-12).
		const win = await chrome.windows.get(tab.windowId).catch(() => null);
		if (win?.focused) await chrome.windows.update(tab.windowId, { state: "minimized" }).catch(() => {});
		return;
	}
	if (tab.active) {
		const previous = lastUserTab.get(tab.windowId);
		if (previous !== void 0) await chrome.tabs.update(previous, { active: true }).catch(() => {});
	}
});
chrome.runtime.onStartup.addListener(connectBroker);
chrome.tabs.onActivated.addListener(connectBroker);
chrome.tabs.onUpdated.addListener(connectBroker);
chrome.windows.onFocusChanged.addListener(connectBroker);
// While the worker is alive, retry every 5s until connected (the broker's pings then keep it alive).
setInterval(connectBroker, 5e3);
connectBroker();
//#endregion
`,
  ],
  // 6) Close finished agent tabs so they don't sit in RAM until the session ends .
  //    A tab is closed when its agent hasn't sent it a command for IDLE_TAB_CLOSE_MS, the user isn't
  //    looking at it, and it holds no unsaved work: no filled field, ticked box, picked file, password
  //    field, editor text or large cross-origin embed (a form filled and left for approval is kept).
  //    The MCP connection stays open (4a), so the agent's next call just opens a new tab.
  // 7) Never let an agent raise a tab: page.bringToFront() in browser_run_code_unsafe (an agent used it
  //    on 2026-10-10 to make radios/dropdowns work) switched the user's tab and raised the browser. Answer it as a
  //    no-op success so the agent's code carries on in the background.
  [
    '\t\tif (message.method === "chrome.tabs.create") args[0] = await backgroundTabOptions(',
    '\t\tif (message.method === "chrome.debugger.sendCommand" && /^(Page\\.bringToFront|Target\\.activateTarget)$/.test(args[1] || "")) return {};\n\t\tif (message.method === "chrome.tabs.create") args[0] = await backgroundTabOptions(',
  ],
  //    Called before the command runs: tabs.onRemoved fires before chrome.tabs.remove resolves.
  [
    '\t\tif (message.method === "chrome.tabs.create") args[0] = await backgroundTabOptions(',
    '\t\tmarkAgentTabUse(message.method, args);\n\t\tif (message.method === "chrome.tabs.create") args[0] = await backgroundTabOptions(',
  ],
  [
    'setInterval(connectBroker, 5e3);\nconnectBroker();\n//#endregion\n',
    `setInterval(connectBroker, 5e3);
connectBroker();
//#endregion
//#region local build: close idle, finished agent tabs (build-extension.cjs 6)
var IDLE_TAB_CLOSE_MS = 10 * 60e3;
// Traffic that isn't the agent working in the tab: patches/apply.cjs keep-unfrozen pings (a
// document.visibilityState evaluate every 2 s, then setWebLifecycleState), frame bootstrapping, and
// browser-wide commands that the relay routes through whichever tab is attached.
var IDLE_IGNORED_CDP = /^(Page\\.setWebLifecycleState|Runtime\\.runIfWaitingForDebugger|(Browser|Target|Storage|SystemInfo)\\.)/;
var IDLE_IGNORED_EVAL = "document.visibilityState";
var agentTabLastUse = /* @__PURE__ */ new Map();
// Why each agent tab closed, kept in chrome.storage.local "tabCloseLog" (last 100), so a vanished tab
// can be explained: idle timer, session disconnected, closed by the MCP, or by the user/browser.
var tabCloseReasons = /* @__PURE__ */ new Map();
var agentTabUrls = /* @__PURE__ */ new Map();
async function logTabEvent(entry) {
	const { tabCloseLog = [] } = await chrome.storage.local.get("tabCloseLog").catch(() => ({}));
	tabCloseLog.push({ time: new Date().toISOString(), ...entry });
	await chrome.storage.local.set({ tabCloseLog: tabCloseLog.slice(-100) }).catch(() => {});
}
function markAgentTabUse(method, args) {
	const target = args[0];
	if (method === "chrome.tabs.remove") for (const id of [target].flat()) tabCloseReasons.set(id, "closed by the MCP (agent or self-heal)");
	if (target?.tabId === void 0 || target.sessionId) return;
	if (method === "chrome.debugger.sendCommand" && args[1] === "Page.close") tabCloseReasons.set(target.tabId, "closed by the MCP (agent or self-heal)");
	if (method === "chrome.debugger.sendCommand" && (IDLE_IGNORED_CDP.test(args[1] || "") || args[2]?.expression === IDLE_IGNORED_EVAL)) return;
	if (method === "chrome.debugger.attach" || method === "chrome.debugger.sendCommand") agentTabLastUse.set(target.tabId, Date.now());
}
var UNSAVED_WORK_CHECK = \`(() => {
	const fromUrl = new Set([...new URLSearchParams(location.search).values()]);
	const ignoredEmbed = /youtube|vimeo|doubleclick|googlesyndication|google\\\\.com\\\\/maps|recaptcha|hcaptcha|challenges\\\\.cloudflare/i;
	const check = (doc) => {
		if (doc.querySelector("input[type=password]")) return "password field";
		for (const el of doc.querySelectorAll("input, textarea, select")) {
			if (el.disabled) continue;
			const type = (el.type || "").toLowerCase();
			if (["hidden", "submit", "button", "reset", "image", "range", "color", "search"].includes(type)) continue;
			if (type === "checkbox" || type === "radio") { if (el.checked) return "ticked " + type; continue; }
			if (type === "file") { if (el.files && el.files.length) return "picked file"; continue; }
			if (el.tagName === "SELECT") { if ([...el.options].some((o) => o.selected !== o.defaultSelected)) return "changed select"; continue; }
			if (el.value && el.value.trim() && !fromUrl.has(el.value)) return "filled field";
		}
		for (const el of doc.querySelectorAll("[contenteditable]")) if (el.isContentEditable && el.textContent.trim()) return "editor text";
		for (const frame of doc.querySelectorAll("iframe")) {
			let inner = null;
			try { inner = frame.contentDocument; } catch {}
			if (inner) { const found = check(inner); if (found) return found; continue; }
			const box = frame.getBoundingClientRect();
			if (box.width >= 300 && box.height >= 200 && !ignoredEmbed.test(frame.src)) return "embedded frame";
		}
		return "";
	};
	return check(document);
})()\`;
async function closeIdleAgentTabs() {
	const now = Date.now();
	// Overrides, set with chrome.storage.local.set() from an extension page: idleTabCloseMs (0/unset =
	// default) and idleTabCloseGroup (only that group title; for tests, so other sessions' tabs are safe).
	const settings = await chrome.storage.local.get(["idleTabCloseMs", "idleTabCloseGroup"]).catch(() => ({}));
	const idleMs = settings.idleTabCloseMs || IDLE_TAB_CLOSE_MS;
	const targets = await chrome.debugger.getTargets().catch(() => []);
	for (const target of targets) {
		const tabId = target.tabId;
		if (!target.attached || tabId === void 0 || target.type !== "page") continue;
		const last = agentTabLastUse.get(tabId);
		if (last === void 0) {
			agentTabLastUse.set(tabId, now);
			continue;
		}
		if (now - last < idleMs || !await isAgentTab(tabId)) continue;
		const tab = await chrome.tabs.get(tabId).catch(() => null);
		if (!tab || tab.active) continue;
		if (settings.idleTabCloseGroup && (await chrome.tabGroups.get(tab.groupId).catch(() => null))?.title !== settings.idleTabCloseGroup) continue;
		const unsaved = await Promise.race([
			chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: UNSAVED_WORK_CHECK, returnByValue: true }).then((r) => r?.exceptionDetails ? "check failed" : r?.result?.value ?? "check failed", () => "check failed"),
			new Promise((resolve) => setTimeout(() => resolve("check timed out"), 3e3))
		]);
		const idleMin = Math.round((now - last) / 6e4);
		if (unsaved) {
			// Look again after another idle period.
			agentTabLastUse.set(tabId, now);
			logTabEvent({ tabId, url: tab.url, action: "kept", reason: \`idle \${idleMin} min, \${unsaved}\` });
			continue;
		}
		const ours = await agentTabIds();
		if (ours.delete(tabId)) await saveAgentTabIds(ours);
		tabCloseReasons.set(tabId, \`idle \${idleMin} min, no unsaved work\`);
		agentTabUrls.set(tabId, tab.url);
		await chrome.tabs.remove(tabId).catch(() => {});
	}
}
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
	if (changeInfo.url && agentTabLastUse.has(tabId)) agentTabUrls.set(tabId, changeInfo.url);
});
// When an agent closes the tab the user is looking at, the browser activates a neighbour, often another agent's
// tab: send them back to their own last tab instead (lastUserTab, from the popup handling above).
var lastAgentTabRemovedAt = 0;
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => setTimeout(async () => {
	if (Math.abs(Date.now() - lastAgentTabRemovedAt) > 1500 || !await isAgentTab(tabId)) return;
	const back = lastUserTab.get(windowId);
	if (back !== void 0 && back !== tabId) chrome.tabs.update(back, { active: true }).catch(() => {});
}, 300));
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
	if (!agentTabLastUse.has(tabId) && !tabCloseReasons.has(tabId)) return;
	// Only when the closed tab was on screen (the browser may report the neighbour's activation first):
	// another session closing a background tab while the user opens an agent tab must not move them.
	const windowId = removeInfo?.windowId;
	if (activeTabByWindow.get(windowId) === tabId || previousActiveTabByWindow.get(windowId) === tabId && Date.now() - (activatedAtByWindow.get(windowId) ?? 0) < 1500) lastAgentTabRemovedAt = Date.now();
	logTabEvent({ tabId, url: agentTabUrls.get(tabId), action: "closed", reason: tabCloseReasons.get(tabId) || "closed by the user or browser" });
	agentTabLastUse.delete(tabId);
	agentTabUrls.delete(tabId);
	tabCloseReasons.delete(tabId);
});
// The user opening an agent tab counts as use.
chrome.tabs.onActivated.addListener(({ tabId }) => {
	if (agentTabLastUse.has(tabId)) agentTabLastUse.set(tabId, Date.now());
});
if (chrome.alarms) {
	chrome.alarms.create("playwright-idle-tabs", { periodInMinutes: 1 });
	chrome.alarms.onAlarm.addListener((alarm) => {
		if (alarm.name === "playwright-idle-tabs") closeIdleAgentTabs();
	});
}
//#endregion
`,
  ],
]);

console.log(`built ${dest} from ${src} (extension ${manifest.version_name})`);
