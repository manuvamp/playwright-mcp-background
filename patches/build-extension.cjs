// Builds extension-bg/: a local copy of the Playwright Extension that never pulls the browser to the front.
//   node patches/build-extension.cjs [path-to-store-extension-version-dir] [--out <dir>] [--server <name>]
// Source defaults to the newest store copy in the browser's profile (Brave's Default profile on Windows;
// override with PW_MCP_BROWSER_USER_DATA and PW_MCP_PROFILE), or extension-src/ (a pristine
// copy saved by the first build, because the store copy is removed when the local one is installed).
// Output dir: --out <dir> or PW_MCP_EXTENSION_OUT, default ./extension-bg next to this repo's package.json.
// --out lets you build somewhere else (e.g. extension-next/) so a build can be tested offline with
// sim-tabs.cjs (SIM_EXT_DIR=<dir>) while the browser keeps running extension-bg/.
// Token: PLAYWRIGHT_MCP_EXTENSION_TOKEN env var first, else ~/.claude.json mcpServers.<name>.env
// (<name> from --server or PW_MCP_SERVER_NAME, default "brave"). The token is baked into the output dir only,
// which is gitignored: never commit it.
// Broker port baked into the extension: PW_MCP_BROKER_PORT (default 8770; must match broker.cjs).
// Changes vs. the store build:
//  - connecting no longer activates the tab or focuses the Brave window;
//  - connect pages arrive from broker.cjs (no brave.exe launch) and open as background tabs;
//  - every agent tab is a background tab (never active) in a collapsed "🤖 <thread title>" tab group (lanes
//    can put tabs in named sub-groups "🤖 <thread title> · <name>", 11), and a session's tabs are closed
//    3 min after it disconnects unless it reconnects and adopts them (12). No windows are ever created:
//    on Windows, creating a Brave window (even minimized) activates Brave and steals focus;
//  - windows an agent page opens (sign-in/share popups) are folded into the agent's tab group or
//    minimized, tabs it opens are handed to that agent (8), and every new window is logged ("windowLog");
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
const flag = (name) => {
  const eq = argv.findIndex((a) => a.startsWith(name + '='));
  if (eq >= 0) return argv.splice(eq, 1)[0].slice(name.length + 1);
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (!v) throw new Error(name + ' needs a value');
  argv.splice(i, 2);
  return v;
};
const outArg = flag('--out') || process.env.PW_MCP_EXTENSION_OUT;
const serverName = flag('--server') || process.env.PW_MCP_SERVER_NAME || 'brave';
const BROKER_PORT = Number(process.env.PW_MCP_BROKER_PORT) || 8770;
const dest = outArg ? path.resolve(outArg) : path.join(root, 'extension-bg');
const pristine = path.join(root, 'extension-src');
const userData = process.env.PW_MCP_BROWSER_USER_DATA || path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware', 'Brave-Browser', 'User Data');
const storeDir = path.join(userData, process.env.PW_MCP_PROFILE || 'Default', 'Extensions', ID);

let src = argv[0];
// dest is wiped before the build: never let it be the pristine copy, the source or a parent of them.
for (const keep of [pristine, root, src].filter(Boolean)) {
  const rel = path.relative(path.resolve(dest), path.resolve(keep));
  if (!rel || !rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error(`--out ${dest} would delete ${keep}`);
}
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

// The popup guard the extension installs in every agent tab (9); the same file is the MCP --init-script.
const popupGuardSource = fs.readFileSync(path.join(root, 'popups-as-tabs.js'), 'utf8');

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
    // _createdTabs : a tab this connection created is its own before the MCP attaches to it,
    // so playwright.groupTab sent right after chrome.tabs.create is accepted (11).
    '\t\tif (message.method === "chrome.tabs.create") args[0] = await backgroundTabOptions(args[0] ?? {}, this._attachedTabs);\n\t\tconst result = await invokeChromeMethod(message.method, args);\n\t\tif (message.method === "chrome.tabs.create" && result?.id !== void 0) {\n\t\t\tthis._createdTabs.add(result.id);\n\t\t\tawait rememberAgentTab(result.id);\n\t\t}\n',
  ],
  [
    '\t_recentReattach = /* @__PURE__ */ new Set();\n',
    '\t_recentReattach = /* @__PURE__ */ new Set();\n\t_createdTabs = /* @__PURE__ */ new Set();\n\tongrouptab;\n',
  ],
  // 3) A session that disconnects no longer takes its group with it at once : the MCP child
  //    restarting, an extension reload or a dropped socket killed agents' tabs (unsaved forms, pages left
  //    open for the user's review). The tabs stay grouped and collapsed as an orphan for ORPHAN_GRACE_MS; a
  //    reconnect of the same session adopts them (12), otherwise they close like before (tab on the user's
  //    screen kept, ungrouped).
  [
    '\t\tif (groupTabs.length) ungroupTabs(groupTabs);\n',
    '\t\tclearTimeout(this._doneTimer);\n\t\tthis._closed = true;\n\t\tif (groupTabs.length) registerOrphan({\n\t\t\ttitle: this.groupStyle.title,\n\t\t\tcolor: this.groupStyle.color,\n\t\t\tsessionKey: this.sessionKey,\n\t\t\ttabIds: groupTabs,\n\t\t\tgroups: this._groupList(),\n\t\t\tdesired: this._desiredGroup,\n\t\t\treason: "session disconnected (did not reconnect within 3 min)"\n\t\t});\n',
  ],
  // 4) Keep the Playwright tab group collapsed so it is just a small chip in the tab strip: now in
  //    _styleNewGroup (11), which also skips the collapse when the group holds a window's active tab.
  // 4c) Group title = "🤖 <project>" (apply.cjs sends the project folder as the client name) instead
  //     of "Playwright · claude-code", which truncated to the same chip for every session. Groups
  //     left over from the old title are still cleaned up on startup.
  [
    'var PLAYWRIGHT_GROUP_TITLE = "Playwright";\nvar PLAYWRIGHT_GROUP_TITLE_PREFIX = `${PLAYWRIGHT_GROUP_TITLE} · `;\n',
    'var PLAYWRIGHT_GROUP_TITLE = "🤖";\nvar PLAYWRIGHT_GROUP_TITLE_PREFIX = `${PLAYWRIGHT_GROUP_TITLE} `;\nvar LEGACY_GROUP_TITLE = "Playwright";\n',
  ],
  // 4d) Brave deletes a group when its last tab closes; the store build kept adding new tabs to the
  //     dead group id, failed, and left them as loose ungrouped tabs. Start a new group instead: now in
  //     _placeTab (11), for the main group and every sub-group.
  // 4a) Keep the connection when the last agent tab closes (the user closed it, or a hung tab was
  //     closed by the MCP self-heal). Closing it left the MCP session dead until /mcp; open
  //     sessions now just create a new tab on the next call. The MCP process exit still closes it.
  [
    '\t\tif (this._hasEverAttached && this._attachedTabs.size === 0 && this._pendingReattach.size === 0) this.close("All controlled tabs detached");\n',
    '\t\t// local build: keep the connection open with zero tabs (see build-extension.cjs 4a)\n',
  ],
  // 4e) A tab the user opened from an agent tab (link, middle-click, Ctrl+T while viewing it) is theirs, not
  //     the agent's: don't announce it to the MCP (it auto-attached it, pulled it into the collapsed
  //     group and could make it the agent's current tab), and push it out of the 🤖 group Brave put
  //     it in. See isUserOpenedTab in the broker region.
  //     A tab an agent page opened with window.open reports the user's active tab as its opener, so it is
  //     announced to the agent that really opened it (agentOpenerOf, see 8).
  [
    '\t\t\tcase "chrome.tabs.onCreated": return args[0].openerTabId;\n',
    '\t\t\tcase "chrome.tabs.onCreated": return isUserOpenedTab(args[0]) ? void 0 : agentOpenerOf(args[0]) ?? args[0].openerTabId;\n',
  ],
  [
    '\t\t\tif (this._isTabReserved(tabId)) {\n',
    '\t\t\tif (this._isTabReserved(tabId) || userOpenedTabs.has(tabId)) {\n',
  ],
  // 4b) Never let Memory Saver discard a tab an agent is attached to.
  //     Also install the popup guard (9) in every agent tab, so sessions started without the init script
  //     (from before the popup guard existed, until reconnected) never open a window or a tab in front either.
  [
    '\t_onTabAttached(tabId) {\n\t\tthis._updateBadge(tabId, CONNECTED_BADGE);\n',
    '\t_onTabAttached(tabId) {\n\t\tthis._updateBadge(tabId, CONNECTED_BADGE);\n\t\tchrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});\n\t\tinstallPopupGuard(tabId);\n',
  ],
  // 10) Close the whole group when the agent is done with it, on events only: no idle
  //     timer (tabs must not vanish while an agent might still need
  //     them). "Done" = the agent closed its tabs or navigated them away until only blank/connect pages
  //     are left, and it sent nothing for DONE_CHECK_MS. The connection stays open: its next call opens a
  //     fresh tab (and group).
  [
    '\t_onTabRemoved(tabId) {\n\t\tthis._groupTabIds.delete(tabId);\n\t}\n',
    `\t_onTabRemoved(tabId) {
		this._desiredGroup.delete(tabId);
		this._connection._createdTabs.delete(tabId);
		if (this._groupTabIds.delete(tabId)) this._scheduleDoneCheck();
	}
	_scheduleDoneCheck() {
		clearTimeout(this._doneTimer);
		this._doneTimer = setTimeout(() => void this._closeIfDone(), DONE_CHECK_MS);
	}
	async _closeIfDone() {
		const ids = [...this._groupTabIds];
		if (!ids.length) return;
		const tabs = (await Promise.all(ids.map((id) => chrome.tabs.get(id).catch(() => null)))).filter(Boolean);
		if (!tabs.every((t) => isPlaceholderUrl(t.pendingUrl || t.url))) return;
		// The MCP reads the page back after each call: wait for it to go quiet, re-checking while only
		// placeholders are left (a real page ends the wait).
		if (ids.some((id) => Date.now() - (agentTabLastUse.get(id) ?? 0) < DONE_CHECK_MS)) return this._scheduleDoneCheck();
		await closeAgentTabs(tabs.map((t) => t.id), "agent done (only blank/connect tabs left)");
	}
`,
  ],
  [
    '\t\tif (changeInfo.url === void 0) return;\n',
    '\t\tif (changeInfo.url === void 0) return;\n\t\tif (this._groupTabIds.has(tabId) && isPlaceholderUrl(changeInfo.url)) this._scheduleDoneCheck();\n',
  ],
  // 10b) On extension start (reload, Brave restart, worker restart) every 🤖 group is left over from a
  //      connection that no longer exists. The store build ungrouped them, leaving their tabs loose in
  //      The user's tab strip; they were closed at once instead, except a tab active in its window (ungrouped).
  //      Since (12) a 🤖 group becomes an orphan with the same grace as a disconnect, so the
  //      sessions reconnecting after an extension reload get their tabs back; "X · name" sub-groups fold
  //      into the orphan of "X". Legacy "Playwright…" groups (no session can come back for them) are
  //      still closed at once.
  [
    '\t\tconst stale = (await chrome.tabGroups.query({})).filter((g) => g.title === PLAYWRIGHT_GROUP_TITLE || g.title?.startsWith(PLAYWRIGHT_GROUP_TITLE_PREFIX));\n\t\tconst tabIds = (await Promise.all(stale.map((g) => chrome.tabs.query({ groupId: g.id })))).flat().map((t) => t.id).filter((id) => id !== void 0);\n\t\tif (tabIds.length) await ungroupTabs(tabIds);\n',
    `\t\tconst all = await chrome.tabGroups.query({});
		const legacyTabs = (await Promise.all(all.filter((g) => g.title?.startsWith(LEGACY_GROUP_TITLE)).map((g) => chrome.tabs.query({ groupId: g.id })))).flat().filter((t) => t.id !== void 0);
		const keep = legacyTabs.filter((t) => t.active).map((t) => t.id);
		if (keep.length) await ungroupTabs(keep);
		await Promise.all(legacyTabs.filter((t) => !t.active).map((t) => {
			tabCloseReasons.set(t.id, "left over from an earlier session (extension start)");
			return chrome.tabs.remove(t.id).catch(() => {});
		}));
		// One orphan per main title (titles are unique among live sessions, so one title = one session);
		// its session key comes from agentGroupOwners when the stored title still matches the group
		// (group ids are reused after a Brave restart).
		const owners = await groupOwners();
		const sessions = /* @__PURE__ */ new Map();
		for (const g of all.filter((g) => g.title === PLAYWRIGHT_GROUP_TITLE || g.title?.startsWith(PLAYWRIGHT_GROUP_TITLE_PREFIX))) {
			const sep = g.title.indexOf(SUB_GROUP_SEPARATOR);
			const title = sep < 0 ? g.title : g.title.slice(0, sep);
			const owner = owners[g.id]?.title === title ? owners[g.id] : void 0;
			const name = sep < 0 ? "" : owner?.name || g.title.slice(sep + SUB_GROUP_SEPARATOR.length);
			if (!sessions.has(title)) sessions.set(title, {
				title,
				color: void 0,
				sessionKey: void 0,
				tabIds: [],
				groups: []
			});
			const session = sessions.get(title);
			session.sessionKey ||= owner?.sessionKey || void 0;
			if (!name) session.color = g.color;
			session.groups.push({
				name,
				groupId: g.id
			});
			for (const t of await chrome.tabs.query({ groupId: g.id }).catch(() => [])) if (t.id !== void 0) session.tabIds.push(t.id);
		}
		for (const session of sessions.values()) if (session.tabIds.length) registerOrphan({
			...session,
			grace: STARTUP_ORPHAN_GRACE_MS,
			reason: "left over from an earlier session (not reclaimed within 15 min of extension start)"
		});
`,
  ],
  // 12) Orphans: tabs of a session whose connection closed (or that were left over at extension start),
  //     kept grouped for ORPHAN_GRACE_MS so the session can reconnect and get them back.
  [
    'var ConnectedTabGroup = class {\n',
    `//#region local build: orphaned sessions (build-extension.cjs 12)
var ORPHAN_GRACE_MS = 18e4;
// Groups found at extension start (reload, Brave restart): every session lost its connection at once,
// and one that is waiting on the user may only call again much later, so they get longer to come back.
var STARTUP_ORPHAN_GRACE_MS = 9e5;
var SUB_GROUP_SEPARATOR = " · ";
var GROUP_OWNERS_KEY = "agentGroupOwners";
var orphanSessions = [];
// New MCP servers put a stable per-session key in the connect page URL (?client={"name":..,"sessionKey":..});
// old servers don't, and their sessions are matched by title only.
function sessionKeyFromUrl(url) {
	try {
		const client = JSON.parse(new URL(url).searchParams.get("client") || "null");
		return typeof client?.sessionKey === "string" && client.sessionKey ? client.sessionKey : void 0;
	} catch {
		return void 0;
	}
}
function baseGroupTitle(title) {
	return String(title ?? "").replace(/ \\(\\d+\\)$/, "");
}
// groupId -> { sessionKey, title (main title), name (sub-group name, "" = main) } in chrome.storage.local, so
// orphans made at extension start know their session. Writes are serialized (read-modify-write) and
// drop groups that no longer exist. chrome.storage may be missing (see the broker region).
var groupOwnersWrite = Promise.resolve();
function updateGroupOwners(change) {
	if (!chrome.storage?.local) return Promise.resolve();
	groupOwnersWrite = groupOwnersWrite.then(async () => {
		const { [GROUP_OWNERS_KEY]: owners = {} } = await chrome.storage.local.get(GROUP_OWNERS_KEY).catch(() => ({}));
		const live = new Set((await chrome.tabGroups.query({}).catch(() => [])).map((g) => String(g.id)));
		for (const id of Object.keys(owners)) if (!live.has(id)) delete owners[id];
		change(owners);
		await chrome.storage.local.set({ [GROUP_OWNERS_KEY]: owners }).catch(() => {});
	}).catch(() => {});
	return groupOwnersWrite;
}
function rememberGroupOwner(groupId, sessionKey, title, name) {
	return updateGroupOwners((owners) => {
		owners[groupId] = {
			sessionKey: sessionKey ?? null,
			title,
			name: name || ""
		};
	});
}
async function groupOwners() {
	await groupOwnersWrite;
	if (!chrome.storage?.local) return {};
	const { [GROUP_OWNERS_KEY]: owners } = await chrome.storage.local.get(GROUP_OWNERS_KEY).catch(() => ({}));
	return owners ?? {};
}
function registerOrphan({ title, color, sessionKey, tabIds, groups, desired, reason, grace = ORPHAN_GRACE_MS }) {
	const orphan = {
		title,
		color,
		sessionKey: sessionKey || void 0,
		tabIds: [...tabIds],
		groups: [...groups],
		desired: new Map(desired ?? []),
		reason,
		grace,
		at: Date.now()
	};
	orphan.timer = setTimeout(() => void expireOrphan(orphan), grace);
	orphanSessions.push(orphan);
	return orphan;
}
// Which orphans a new connection takes over: every orphan with its session key; when either side has
// no key (old MCP server, group left over without a stored owner), the most recent orphan with the same
// title (ignoring " (n)"). A different key never adopts. Taken synchronously, so two connections that
// arrive together can't both get the same orphan.
function takeOrphansFor(group) {
	let picked = group.sessionKey ? orphanSessions.filter((o) => o.sessionKey === group.sessionKey) : [];
	if (!picked.length) {
		const title = baseGroupTitle(PLAYWRIGHT_GROUP_TITLE_PREFIX + (group.clientName || "unknown"));
		picked = orphanSessions.filter((o) => (!o.sessionKey || !group.sessionKey) && baseGroupTitle(o.title) === title).sort((a, b) => b.at - a.at).slice(0, 1);
	}
	for (const o of picked) {
		clearTimeout(o.timer);
		orphanSessions.splice(orphanSessions.indexOf(o), 1);
	}
	return picked.sort((a, b) => b.at - a.at);
}
// Grace over and nobody came back: close the orphan's groups like a disconnect did before (12).
// Tabs the user dragged out of the groups meanwhile are theirs; tabs the orphan's pages opened into them go too.
// The tab on their screen (or active in any window) stays, ungrouped.
async function expireOrphan(orphan) {
	const i = orphanSessions.indexOf(orphan);
	if (i < 0) return;
	orphanSessions.splice(i, 1);
	clearTimeout(orphan.timer);
	const groupIds = new Set(orphan.groups.map((g) => g.groupId));
	const ids = new Set(orphan.tabIds);
	for (const groupId of groupIds) for (const t of await chrome.tabs.query({ groupId }).catch(() => [])) ids.add(t.id);
	const tabs = (await Promise.all([...ids].map((id) => chrome.tabs.get(id).catch(() => null)))).filter((t) => t && groupIds.has(t.groupId));
	const keep = tabs.filter((t) => t.active || t.id === tabOnScreen()).map((t) => t.id);
	if (keep.length) await ungroupTabs(keep);
	await closeAgentTabs(tabs.filter((t) => !keep.includes(t.id)).map((t) => t.id), orphan.reason);
}
// Backup for the timers: an alarm wakes a sleeping service worker, a setTimeout doesn't.
function sweepOrphans() {
	const now = Date.now();
	for (const o of [...orphanSessions]) if (now - o.at >= o.grace) void expireOrphan(o);
}
if (chrome.alarms) {
	chrome.alarms.create("playwright-orphans", { periodInMinutes: .5 });
	chrome.alarms.onAlarm.addListener((alarm) => {
		if (alarm.name === "playwright-orphans") sweepOrphans();
	});
}
//#endregion
var ConnectedTabGroup = class {
`,
  ],
  // 11) Named sub-groups per connection: the MCP server runs several agents (lanes) per
  //     session and puts a lane's tabs in "🤖 <title> · <name>" with playwright.groupTab [{ tabId, name }]
  //     -> { groupId, title } ("" or no name = the main group). Every group change of a session runs
  //     through one queue, and the group asked for is remembered per tab, so the attach-time grouping
  //     never pulls a tab back into the main group after (or while) a groupTab moved it.
  [
    '\t"chrome.tabs.remove"\n]);\n',
    '\t"chrome.tabs.remove",\n\t"playwright.groupTab"\n]);\n',
  ],
  [
    '\t\tconst args = message.params ?? [];\n',
    `\t\tconst args = message.params ?? [];
		// Not a chrome API (11): the session's ConnectedTabGroup handles it.
		if (message.method === "playwright.groupTab") {
			if (!this.ongrouptab) throw new Error("This session has no tab group yet");
			const { tabId, name } = args[0] ?? {};
			return await this.ongrouptab(tabId, name);
		}
`,
  ],
  [
    '\tconstructor(connection, selectedTab, clientName, groupStyle, isTabReserved) {\n\t\tthis.clientName = clientName;\n',
    `\tconstructor(connection, selectedTab, clientName, groupStyle, isTabReserved, sessionKey) {
		this.clientName = clientName;
		this.sessionKey = sessionKey || void 0;
		this._subGroups = /* @__PURE__ */ new Map();
		this._subGroupColors = /* @__PURE__ */ new Map();
		this._desiredGroup = /* @__PURE__ */ new Map();
		this._movingTabs = /* @__PURE__ */ new Set();
		this._groupQueue = Promise.resolve();
		this._closed = false;
`,
  ],
  [
    '\t\tthis._connection.ontabdetached = (tabId) => this._onTabDetached(tabId);\n',
    '\t\tthis._connection.ontabdetached = (tabId) => this._onTabDetached(tabId);\n\t\tthis._connection.ongrouptab = (tabId, name) => this.groupTab(tabId, name);\n',
  ],
  // "Ours" = the main group or any sub-group. A tab we are moving between our groups is skipped: Brave
  // may report the new group before tabs.group resolves with its id.
  [
    '\t\tconst inOurGroup = this._groupId !== null && tab.groupId === this._groupId;\n',
    '\t\tif (this._movingTabs.has(tabId)) return;\n\t\tconst inOurGroup = this._ownsGroup(tab.groupId);\n',
  ],
  [
    '\tasync _addTabToGroup(tabId) {\n\t\tif (this._groupTabIds.has(tabId)) return;\n\t\ttry {\n\t\t\tawait retryOnDrag(async () => {\n\t\t\t\tif (this._groupId === null) {\n\t\t\t\t\tthis._groupId = await chrome.tabs.group({ tabIds: [tabId] });\n\t\t\t\t\tawait chrome.tabGroups.update(this._groupId, this.groupStyle);\n\t\t\t\t} else await chrome.tabs.group({\n\t\t\t\t\tgroupId: this._groupId,\n\t\t\t\t\ttabIds: [tabId]\n\t\t\t\t});\n\t\t\t});\n\t\t\tthis._groupTabIds.add(tabId);\n\t\t} catch (error) {\n\t\t\tdebugLog("Error adding tab to group:", error);\n\t\t}\n\t}\n',
    `\tasync _addTabToGroup(tabId) {
		if (this._groupTabIds.has(tabId)) return;
		// Attach-time grouping (11): the group a playwright.groupTab asked for, else the group of the agent
		// tab that opened it (a lane's popups stay with the lane), else the main group.
		await this._enqueue(async () => {
			if (this._closed || this._groupTabIds.has(tabId)) return;
			await this._placeTab(tabId, await this._groupNameFor(tabId));
		}).catch((error) => debugLog("Error adding tab to group:", error));
	}
	async groupTab(tabId, name) {
		if (this._closed) throw new Error("This session is closed");
		if (typeof tabId !== "number" || !(this._groupTabIds.has(tabId) || this._connection.attachedTabs.has(tabId) || this._connection._createdTabs.has(tabId))) throw new Error(\`Tab \${tabId} is not one of this session's tabs\`);
		name = String(name ?? "").trim();
		this._desiredGroup.set(tabId, name);
		const groupId = await this._enqueue(() => this._placeTab(tabId, name));
		return {
			groupId,
			title: this._groupTitle(name)
		};
	}
	_enqueue(fn) {
		const run = this._groupQueue.then(() => fn());
		this._groupQueue = run.catch(() => {});
		return run;
	}
	async _groupNameFor(tabId) {
		if (this._desiredGroup.has(tabId)) return this._desiredGroup.get(tabId);
		const tab = await chrome.tabs.get(tabId).catch(() => null);
		let name = this._nameOfGroup(tab?.groupId);
		const openerId = agentOpenerByTab.get(tabId) ?? tab?.openerTabId;
		if (name === void 0 && openerId !== void 0 && this._groupTabIds.has(openerId)) name = this._nameOfGroup((await chrome.tabs.get(openerId).catch(() => null))?.groupId) ?? this._desiredGroup.get(openerId);
		name ??= "";
		this._desiredGroup.set(tabId, name);
		return name;
	}
	// Runs inside the queue. Moving a tab into an existing group never changes its collapsed state.
	async _placeTab(tabId, name) {
		const tab = await chrome.tabs.get(tabId);
		let groupId = name ? this._subGroups.get(name) ?? null : this._groupId;
		// 4d) Brave deletes a group when its last tab closes: start a new one with the same title.
		if (groupId !== null && !await chrome.tabGroups.get(groupId).catch(() => null)) groupId = null;
		let created = false;
		this._movingTabs.add(tabId);
		try {
			await retryOnDrag(async () => {
				if (groupId === null) {
					groupId = await chrome.tabs.group({
						tabIds: [tabId],
						createProperties: { windowId: tab.windowId }
					});
					created = true;
					if (name) this._subGroups.set(name, groupId);
					else this._groupId = groupId;
				} else if (tab.groupId !== groupId) await chrome.tabs.group({
					groupId,
					tabIds: [tabId]
				});
			});
			this._groupTabIds.add(tabId);
		} finally {
			this._movingTabs.delete(tabId);
		}
		if (created) {
			await this._styleNewGroup(groupId, name);
			void rememberGroupOwner(groupId, this.sessionKey, this.groupStyle.title, name);
		}
		return groupId;
	}
	// 4) Collapsed, so a group is just a small chip in the tab strip, except when it holds the active tab
	//    of its window: collapsing it makes Brave switch that window to another tab.
	async _styleNewGroup(groupId, name) {
		const style = name ? {
			title: this._groupTitle(name),
			color: this._subGroupColor(name)
		} : this.groupStyle;
		const holdsActive = (await chrome.tabs.query({ groupId }).catch(() => [])).some((t) => t.active);
		await retryOnDrag(() => chrome.tabGroups.update(groupId, {
			...style,
			...holdsActive ? {} : { collapsed: true }
		}));
	}
	_groupTitle(name) {
		if (!name) return this.groupStyle.title;
		return this.groupStyle.title + SUB_GROUP_SEPARATOR + (name.length > 40 ? name.slice(0, 39) + "…" : name);
	}
	// Different from the main group's color and, while colors last, from the other sub-groups'.
	_subGroupColor(name) {
		const kept = this._subGroupColors.get(name);
		if (kept && kept !== this.groupStyle.color) return kept;
		const used = new Set([this.groupStyle.color, ...[...this._subGroupColors].filter(([n]) => n !== name && this._subGroups.has(n)).map(([, c]) => c)]);
		const color = PLAYWRIGHT_GROUP_COLORS.find((c) => !used.has(c)) ?? PLAYWRIGHT_GROUP_COLORS.find((c) => c !== this.groupStyle.color);
		this._subGroupColors.set(name, color);
		return color;
	}
	_ownsGroup(groupId) {
		return this._nameOfGroup(groupId) !== void 0;
	}
	_nameOfGroup(groupId) {
		if (groupId === void 0 || groupId === null || groupId < 0) return void 0;
		if (groupId === this._groupId) return "";
		for (const [name, id] of this._subGroups) if (id === groupId) return name;
		return void 0;
	}
	_groupList() {
		return [...this._groupId !== null ? [{
			name: "",
			groupId: this._groupId
		}] : [], ...[...this._subGroups].map(([name, groupId]) => ({
			name,
			groupId
		}))];
	}
	// 12) Take over the tabs of orphaned sessions (see takeOrphansFor). Queued right after the constructor,
	//     before any attach-time grouping, so the connect page lands in the adopted main group.
	adoptOrphans() {
		const orphans = takeOrphansFor(this);
		if (!orphans.length) return Promise.resolve();
		return this._enqueue(async () => {
			for (const o of orphans) {
				for (const { name, groupId } of o.groups) {
					if (name ? this._subGroups.has(name) : this._groupId !== null) continue;
					const g = await chrome.tabGroups.get(groupId).catch(() => null);
					if (!g) continue;
					if (name) {
						this._subGroups.set(name, groupId);
						this._subGroupColors.set(name, g.color);
					} else this._groupId = groupId;
					// New title/color only; the collapsed state stays as it is.
					const style = name ? {
						title: this._groupTitle(name),
						color: this._subGroupColor(name)
					} : {
						title: this.groupStyle.title,
						color: this.groupStyle.color
					};
					if (g.title !== style.title || g.color !== style.color) await retryOnDrag(() => chrome.tabGroups.update(groupId, style)).catch(() => {});
					void rememberGroupOwner(groupId, this.sessionKey, this.groupStyle.title, name);
				}
			}
			for (const o of orphans) {
				const ids = new Set(o.tabIds);
				for (const { groupId } of o.groups) for (const t of await chrome.tabs.query({ groupId }).catch(() => [])) ids.add(t.id);
				for (const id of ids) {
					const tab = await chrome.tabs.get(id).catch(() => null);
					// Gone, or the user dragged it out of the group meanwhile (theirs now).
					const name = o.groups.find((g) => g.groupId === tab?.groupId)?.name;
					if (!tab || name === void 0 || this._groupTabIds.has(id)) continue;
					this._desiredGroup.set(id, name);
					const target = name ? this._subGroups.get(name) : this._groupId;
					if (target === tab.groupId) this._groupTabIds.add(id);
					else await this._placeTab(id, name).catch((error) => debugLog("Error adopting tab:", error));
					// Tell the MCP server (chrome.tabs.onCreated), which attaches to it.
					this._connection.attachTab(tab);
				}
			}
		}).catch((error) => debugLog("Error adopting orphaned tabs:", error));
	}
`,
  ],
  // 12) sessionKey from the connect page URL; a new connection adopts its orphans. A live orphan of
  //     another session (different key) keeps its title, so the new connection becomes "… (2)".
  [
    'this._connectTab(sender.tab.id, selectedTab, message.clientName)',
    'this._connectTab(sender.tab.id, selectedTab, message.clientName, sessionKeyFromUrl(sender.url || sender.tab?.url || ""))',
  ],
  [
    '\tasync _connectTab(selectorTabId, tab, clientName) {\n',
    '\tasync _connectTab(selectorTabId, tab, clientName, sessionKey) {\n',
  ],
  [
    '\t\t\tconst group = new ConnectedTabGroup(connection, tab, clientName, uniqueGroupStyle(clientName, [...this._connections.values()].map((group) => group.groupStyle)), (tabId) => this._pendingConnections.has(tabId));\n\t\t\tgroup.onclose = () => this._connections.delete(id);\n\t\t\tthis._connections.set(id, group);\n',
    `\t\t\tconst taken = [...this._connections.values()].map((group) => group.groupStyle).concat(orphanSessions.filter((o) => o.sessionKey && sessionKey && o.sessionKey !== sessionKey).map((o) => ({
				title: o.title,
				color: o.color
			})));
			const group = new ConnectedTabGroup(connection, tab, clientName, uniqueGroupStyle(clientName, taken), (tabId) => this._pendingConnections.has(tabId), sessionKey);
			group.onclose = () => this._connections.delete(id);
			this._connections.set(id, group);
			group.adoptOrphans();
`,
  ],
  // 5) Broker client.
  [
    'new PlaywrightExtension();\n',
    `// Named so sim-tabs.cjs can drive connectToTab like the connect page does.
var playwrightExtension = new PlaywrightExtension();
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
// Brave may not activate permissions added to an unpacked copy of a store extension (it
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
// The normal window agent tabs go into: the preferred one if it is a normal window (an agent's tab can
// sit in a minimized sign-in popup, and tabs can't be created there), else the user's last focused one.
// Never left to Brave: without a usable windowId it may open a new window, which steals focus.
async function agentWindowId(preferred) {
	if (preferred !== void 0 && (await chrome.windows.get(preferred).catch(() => null))?.type === "normal") return preferred;
	const wins = (await chrome.windows.getAll({ windowTypes: ["normal"] }).catch(() => [])).filter((w) => !w.incognito);
	return (wins.find((w) => w.id === lastFocusedWindow) ?? wins.find((w) => w.focused) ?? wins[0])?.id;
}
async function openConnectPage(url) {
	if (!url.startsWith(chrome.runtime.getURL("connect.html") + "?")) throw new Error("Refusing to open a non-connect URL");
	const windowId = await agentWindowId();
	// Brave running with no window at all: the only case where a window must be made; keep it minimized.
	const tab = windowId !== void 0 ? await chrome.tabs.create({ url, active: false, windowId }) : (await chrome.windows.create({ url, focused: false, state: "minimized" })).tabs[0];
	await rememberAgentTab(tab.id);
	return tab;
}
async function backgroundTabOptions(options, attachedTabIds) {
	let windowId = options.windowId;
	for (const tabId of attachedTabIds) {
		if (windowId !== void 0) break;
		windowId = await chrome.tabs.get(tabId).then((t) => t.windowId, () => void 0);
	}
	windowId = await agentWindowId(windowId);
	return { ...options, ...(windowId !== void 0 ? { windowId } : {}), active: false };
}
// The tab the user is looking at right now (active tab of the last focused window). Group cleanups never
// close it: it is ungrouped and left to them.
function tabOnScreen() {
	return lastFocusedWindow !== null ? activeTabByWindow.get(lastFocusedWindow) : void 0;
}
// A session that disconnects takes its whole group with it, not just the tabs it created: popups it adopted and tabs from before an extension
// reload were left behind as stale loose tabs. Tabs are closed one by one (one stale id fails a batch).
async function closeAgentTabs(tabIds, reason = "session disconnected") {
	const ours = await agentTabIds();
	const ids = tabIds.filter((id) => id !== tabOnScreen());
	if (!ids.length) return;
	for (const id of ids) {
		ours.delete(id);
		tabCloseReasons.set(id, reason);
	}
	await saveAgentTabIds(ours);
	await Promise.all(ids.map((id) => chrome.tabs.remove(id).catch(() => {})));
}
// Tabs with no agent work in them: a group holding only these is finished.
function isPlaceholderUrl(url) {
	return !url || url === "about:blank" || url.startsWith("chrome://newtab") || url.startsWith(chrome.runtime.getURL("connect.html"));
}
var DONE_CHECK_MS = 3e3;
if (chrome.alarms) {
	chrome.alarms.create("playwright-broker", { periodInMinutes: .5 });
	chrome.alarms.onAlarm.addListener((alarm) => {
		if (alarm.name === "playwright-broker") connectBroker();
	});
}
// Popups opened by agent pages (target=_blank, window.open) must not switch the user's tab or window.
// Remember their last active tab per window and their last focused window; when a tab whose opener is
// an agent tab appears, adopt it as an agent tab and give the user's tab back.
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
// Who opened a new tab: The user or an agent? Agents only work in background tabs, so a tab whose opener
// is the tab on screen (the active tab of the last focused Brave window) was opened by the user, even if
// that tab is an agent's (they were reviewing it). Earlier builds adopted every tab opened from an agent tab
// was adopted: The user got bounced to an old tab and the agent took the new one over. Decided once per
// tab, synchronously (the relay's onCreated forwarder asks too, and must get the same answer).
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
		if (agentOpenerOf(tab) === void 0 && lastFocusedWindow !== null && activeTabByWindow.get(lastFocusedWindow) === tab.openerTabId) userOpenedTabs.add(tab.id);
	}
	return userOpenedTabs.has(tab.id);
}
// Which agent tab really opened this tab. A tab or popup an agent page opens with window.open (or a
// target=_blank link/form) reports the user's active tab as its openerTabId (measured), so it
// looked like theirs: it stayed in front, the agent never got it, and it was left behind. Chrome sends
// Page.windowOpen from the opening tab ~20 ms before tabs.onCreated; match the new tab to it. Opens
// from the agent tab the user is viewing are their (4e). Decided once per tab, like isUserOpenedTab.
var agentWindowOpens = [];
var agentOpenerByTab = /* @__PURE__ */ new Map();
var lastAgentWindowOpenAt = 0;
function sameUrl(a, b) {
	try {
		return new URL(a).href === new URL(b).href;
	} catch {
		return a === b;
	}
}
chrome.debugger.onEvent.addListener((source, method, params) => {
	if (method !== "Page.windowOpen" || source?.tabId === void 0) return;
	if (lastFocusedWindow !== null && activeTabByWindow.get(lastFocusedWindow) === source.tabId) return;
	const now = Date.now();
	lastAgentWindowOpenAt = now;
	agentWindowOpens = agentWindowOpens.filter((o) => now - o.at < 5e3);
	agentWindowOpens.push({ tabId: source.tabId, url: params?.url || "", at: now });
});
// 9) Agent pages don't call the real window.open while hidden (popups-as-tabs.js init script): they log
//    the URL with this marker and we open it as a background tab next to the agent's tab, opener set, so
//    the agent's MCP gets it and nothing ever comes to the front.
var AGENT_OPEN_MARKER = "[agent] window.open blocked; opened in a background tab instead (see browser_tabs):";
// The same script, installed by the extension itself in every tab an agent attaches to (current page and
// every later navigation), so sessions without the --init-script are covered too.
var POPUP_GUARD_SOURCE = ${JSON.stringify(popupGuardSource)};
function installPopupGuard(tabId) {
	chrome.debugger.sendCommand({ tabId }, "Page.addScriptToEvaluateOnNewDocument", { source: POPUP_GUARD_SOURCE, runImmediately: true }).catch(() => {});
}
chrome.debugger.onEvent.addListener(async (source, method, params) => {
	if (method !== "Runtime.consoleAPICalled" || params?.type !== "debug" || params.args?.[0]?.value !== AGENT_OPEN_MARKER || source?.tabId === void 0) return;
	const url = String(params.args[1]?.value || "");
	if (!/^https?:/i.test(url)) return;
	const opener = await chrome.tabs.get(source.tabId).catch(() => null);
	if (!opener) return;
	const windowId = await agentWindowId(opener.windowId);
	if (windowId === void 0) return;
	// So the relay announces the tab to this agent even when no openerTabId is possible (its tab is in a
	// popup window): agentOpenerOf matches it like a Page.windowOpen.
	agentWindowOpens.push({ tabId: opener.id, url, at: Date.now() });
	const tab = await chrome.tabs.create({ url, active: false, windowId, ...(windowId === opener.windowId ? { openerTabId: opener.id } : {}) }).catch(() => null);
	if (tab) await rememberAgentTab(tab.id);
});
function agentOpenerOf(tab) {
	if (tab?.id === void 0) return void 0;
	if (agentOpenerByTab.has(tab.id)) return agentOpenerByTab.get(tab.id);
	const url = tab.pendingUrl || tab.url || "";
	const now = Date.now();
	const i = agentWindowOpens.findIndex((o) => o.tabId !== tab.id && now - o.at < 3e3 && (!url || !o.url || url === "about:blank" || sameUrl(url, o.url)));
	const opener = i < 0 ? void 0 : agentWindowOpens.splice(i, 1)[0].tabId;
	agentOpenerByTab.set(tab.id, opener);
	return opener;
}
// The tab to give back to the user when an agent's new tab grabbed their window. tabs.onCreated fires before
// tabs.onActivated, so the tab on record is still the one they were looking at (even an agent's tab).
function userTabFor(windowId, newTabId) {
	const active = activeTabByWindow.get(windowId);
	return active !== void 0 && active !== newTabId ? active : lastUserTab.get(windowId) ?? previousActiveTabByWindow.get(windowId);
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
		// The user's tab: leave it active and get it out of the collapsed agent group Brave put it in.
		if (tab.groupId !== void 0 && tab.groupId >= 0) {
			const group = await chrome.tabGroups.get(tab.groupId).catch(() => null);
			if (group?.title?.startsWith(PLAYWRIGHT_GROUP_TITLE)) await ungroupTabs([tab.id]);
		}
		return;
	}
	// Fast path first (no awaits) so a popup that grabbed the active tab is reverted within ms.
	const agentOpener = agentOpenerOf(tab);
	const openerId = agentOpener ?? tab.openerTabId;
	const knownAgentOpener = agentOpener !== void 0 || openerId !== void 0 && agentTabMemory.has(openerId);
	const back = tab.active ? userTabFor(tab.windowId, tab.id) : void 0;
	if (knownAgentOpener && back !== void 0) chrome.tabs.update(back, { active: true }).catch(() => {});
	if (!knownAgentOpener && !await isAgentTab(openerId)) return;
	await rememberAgentTab(tab.id);
	const opener = await chrome.tabs.get(openerId).catch(() => null);
	if (opener && tab.windowId !== opener.windowId) {
		// The agent page opened a window. Never focus a Brave window here: when the user was in another app
		// that raised Brave over it . A normal window: move the tab next to the agent's tabs
		// (Brave closes the emptied window). A popup (sign-in, share) can't give up its tab: minimize it,
		// focused or not; an unfocused one used to stay on screen.
		const win = await chrome.windows.get(tab.windowId).catch(() => null);
		const moved = win?.type === "normal" && opener.windowId !== void 0 && await chrome.tabs.move(tab.id, { windowId: opener.windowId, index: -1 }).then(() => true, () => false);
		if (!moved && win && win.state !== "minimized") await chrome.windows.update(tab.windowId, { state: "minimized" }).catch(() => {});
		logWindowEvent({ windowId: tab.windowId, type: win?.type, url: tab.pendingUrl || tab.url, openerTab: openerId, action: moved ? "agent window folded into its tab group" : "agent popup minimized" });
		return;
	}
	if (tab.active && !knownAgentOpener && back !== void 0) await chrome.tabs.update(back, { active: true }).catch(() => {});
});
// Every new Brave window, with what probably made it (chrome.storage.local "windowLog", last 50), so a
// window that appears "for no reason" can be traced: an agent page (Page.windowOpen just before), an
// agent command, or the user.
async function logWindowEvent(entry) {
	const { windowLog = [] } = await chrome.storage.local.get("windowLog").catch(() => ({}));
	windowLog.push({ time: new Date().toISOString(), ...entry });
	await chrome.storage.local.set({ windowLog: windowLog.slice(-50) }).catch(() => {});
}
chrome.windows.onCreated.addListener((win) => setTimeout(async () => {
	const tabs = await chrome.tabs.query({ windowId: win.id }).catch(() => []);
	const lastAgentUse = Math.max(0, ...agentTabLastUse.values());
	logWindowEvent({
		windowId: win.id,
		type: win.type,
		state: win.state,
		action: "window created",
		tabs: tabs.map((t) => ({ url: (t.pendingUrl || t.url || "").slice(0, 200), opener: t.openerTabId, agentOpener: agentOpenerByTab.get(t.id) })),
		msSinceAgentWindowOpen: lastAgentWindowOpenAt ? Date.now() - lastAgentWindowOpenAt : null,
		msSinceAgentCommand: lastAgentUse ? Date.now() - lastAgentUse : null
	});
}, 500));
chrome.tabs.onRemoved.addListener((tabId) => agentOpenerByTab.delete(tabId));
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
  // 6) Log why each agent tab closed (chrome.storage.local "tabCloseLog"). The idle-tab auto-close that
  //    used to live here was removed: agents close their own tabs.
  // 7) Never let an agent raise a tab: page.bringToFront() in browser_run_code_unsafe (an agent used it
  //    to make radios/dropdowns work) switched the user's tab and raised Brave. Answer it as a
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
//#region local build: agent tab close log (build-extension.cjs 6)
// Traffic that isn't the agent working in the tab: patches/apply.cjs keep-unfrozen pings (a
// document.visibilityState evaluate every 2 s, then setWebLifecycleState), frame bootstrapping, and
// browser-wide commands that the relay routes through whichever tab is attached.
var IDLE_IGNORED_CDP = /^(Page\\.setWebLifecycleState|Runtime\\.runIfWaitingForDebugger|(Browser|Target|Storage|SystemInfo)\\.)/;
var IDLE_IGNORED_EVAL = "document.visibilityState";
var agentTabLastUse = /* @__PURE__ */ new Map();
// Why each agent tab closed, kept in chrome.storage.local "tabCloseLog" (last 100), so a vanished tab
// can be explained: session disconnected, closed by the MCP, or by the user/Brave.
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
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
	if (changeInfo.url && agentTabLastUse.has(tabId)) agentTabUrls.set(tabId, changeInfo.url);
});
// When an agent closes the tab the user is looking at, Brave activates a neighbour, often another agent's
// tab: send them back to their own last tab instead (lastUserTab, from the popup handling above).
var lastAgentTabRemovedAt = 0;
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => setTimeout(async () => {
	if (Math.abs(Date.now() - lastAgentTabRemovedAt) > 1500 || !await isAgentTab(tabId)) return;
	const back = lastUserTab.get(windowId);
	if (back !== void 0 && back !== tabId) chrome.tabs.update(back, { active: true }).catch(() => {});
}, 300));
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
	if (!agentTabLastUse.has(tabId) && !tabCloseReasons.has(tabId)) return;
	// Only when the closed tab was on screen (Brave may report the neighbour's activation first):
	// another session closing a background tab while the user opens an agent tab must not move them.
	const windowId = removeInfo?.windowId;
	if (activeTabByWindow.get(windowId) === tabId || previousActiveTabByWindow.get(windowId) === tabId && Date.now() - (activatedAtByWindow.get(windowId) ?? 0) < 1500) lastAgentTabRemovedAt = Date.now();
	logTabEvent({ tabId, url: agentTabUrls.get(tabId), action: "closed", reason: tabCloseReasons.get(tabId) || "closed by the user or Brave" });
	agentTabLastUse.delete(tabId);
	agentTabUrls.delete(tabId);
	tabCloseReasons.delete(tabId);
});
// Older builds ran an idle-tab closer on this alarm.
chrome.alarms?.clear("playwright-idle-tabs");
//#endregion
`,
  ],
  // 13) The connect page opened for each connection stayed behind as a stray tab whenever the agent
  //     opened its work in new tabs (browser_tabs new) or reconnected. Once the session has a real page,
  //     a connect page no agent has sent anything to for CONNECT_PAGE_IDLE_MS closes. Never while it is the
  //     tab on the user's screen (checked again later). Current MCP servers reuse or close it themselves.
  [
    '\t\tif (this._groupTabIds.has(tabId) && isPlaceholderUrl(changeInfo.url)) this._scheduleDoneCheck();\n',
    '\t\tif (this._groupTabIds.has(tabId) && isPlaceholderUrl(changeInfo.url)) this._scheduleDoneCheck();\n\t\telse if (this._groupTabIds.has(tabId)) this._scheduleConnectPageCheck();\n',
  ],
  // After a reconnect the session's real pages attach again (no URL change) next to a fresh connect page.
  [
    '\t\tinstallPopupGuard(tabId);\n',
    '\t\tinstallPopupGuard(tabId);\n\t\tthis._scheduleConnectPageCheck();\n',
  ],
  [
    '\t_scheduleDoneCheck() {\n',
    `\t_scheduleConnectPageCheck() {
		if (this._closed) return;
		clearTimeout(this._connectPageTimer);
		this._connectPageTimer = setTimeout(() => void this._closeIdleConnectPages(), CONNECT_PAGE_IDLE_MS);
	}
	async _closeIdleConnectPages() {
		if (this._closed) return;
		const tabs = (await Promise.all([...this._groupTabIds].map((id) => chrome.tabs.get(id).catch(() => null)))).filter(Boolean);
		if (!tabs.some((t) => !isPlaceholderUrl(t.pendingUrl || t.url))) return;
		const connectPage = chrome.runtime.getURL("connect.html");
		let waiting = false;
		for (const t of tabs) {
			if (!(t.pendingUrl || t.url || "").startsWith(connectPage)) continue;
			if (t.id === tabOnScreen() || Date.now() - (agentTabLastUse.get(t.id) ?? 0) < CONNECT_PAGE_IDLE_MS) {
				waiting = true;
				continue;
			}
			await closeAgentTabs([t.id], "connect page no longer needed (the session has other tabs)");
		}
		if (waiting) this._scheduleConnectPageCheck();
	}
	_scheduleDoneCheck() {
`,
  ],
  [
    'var DONE_CHECK_MS = 3e3;\n',
    'var DONE_CHECK_MS = 3e3;\nvar CONNECT_PAGE_IDLE_MS = 15e3;\n',
  ],
  // 14) The user's tabs (the user drags a tab from outside the tab group into it, and agents should use a page the user already has
  //     open, logged in or half filled, instead of starting from scratch). A tab they move into a 🤖 group (drag, or "Add tab to
  //     group" for a collapsed one) is handed to that chat; an agent can list their open tabs and take one over
  //     (playwright.listTabs / playwright.takeTab, for browser_tabs existing/take and browser_navigate).
  //     Such tabs stay theirs: every close (agent, helper finished, session gone, group cleanup) gives them
  //     back instead (out of the 🤖 group, debugger off, page as it is). Before, a tab they had opened from an
  //     agent tab was thrown out of the group, and a dropped tab could be closed with the group.
  [
    '\t"playwright.groupTab"\n]);',
    '\t"playwright.groupTab",\n\t"playwright.listTabs",\n\t"playwright.takeTab"\n]);',
  ],
  [
    '\t\t\tparams: [tab]\n\t\t});',
    '\t\t\tparams: [userTabMemory.has(tab.id) ? {\n\t\t\t\t...tab,\n\t\t\t\tpwUser: userTabInfo.get(tab.id) ?? {}\n\t\t\t} : tab]\n\t\t});',
  ],
  [
    '\t\t\treturn await this.ongrouptab(tabId, name);\n\t\t}\n',
    `\t\t\treturn await this.ongrouptab(tabId, name);
		}
		if (message.method === "playwright.listTabs") return { tabs: await userOpenTabs() };
		if (message.method === "playwright.takeTab") {
			if (!this.ontaketab) throw new Error("This session has no tab group yet");
			const { tabId, name } = args[0] ?? {};
			return await this.ontaketab(tabId, name);
		}
		// Closing one of the user's tabs gives it back to them instead (every server close path ends here).
		if (message.method === "chrome.tabs.remove" || message.method === "chrome.debugger.sendCommand" && args[1] === "Page.close" && !args[0]?.sessionId) {
			const user = await userTabIds();
			const ids = message.method === "chrome.tabs.remove" ? [args[0]].flat() : [args[0]?.tabId];
			const handedBack = ids.filter((id) => user.has(id));
			for (const id of handedBack) await releaseUserTab(id, "the agent is done with it");
			if (handedBack.length) {
				const rest = ids.filter((id) => !user.has(id));
				if (!rest.length) return {};
				args[0] = rest;
			}
		}
`,
  ],
  [
    '\t\tthis._connection.ongrouptab = (tabId, name) => this.groupTab(tabId, name);\n',
    '\t\tthis._connection.ongrouptab = (tabId, name) => this.groupTab(tabId, name);\n\t\tthis._connection.ontaketab = (tabId, name) => this.takeTab(tabId, name);\n',
  ],
  [
    '\t\t\tif (this._isTabReserved(tabId) || userOpenedTabs.has(tabId)) {\n\t\t\t\tungroupTabs([tabId]);\n\t\t\t\treturn;\n\t\t\t}\n\t\t\tthis._groupTabIds.add(tabId);\n\t\t\tif (!isNonDebuggableUrl(tab.url)) this._connection.attachTab(tab);\n',
    `\t\t\t// Brave puts a tab opened from a grouped tab into that group right away: an agent's popup, or a tab
			// The user opened from an agent tab (theirs, 4e: out again). A tab that joins later, the user moved there
			// themselves (drag, "Add tab to group"): they are handing it to this chat (14).
			const handedOver = !agentTabMemory.has(tabId) && !this._connection._createdTabs.has(tabId) && Date.now() - (tabCreatedAt.get(tabId) ?? 0) >= HAND_OVER_MIN_AGE_MS;
			if (this._isTabReserved(tabId) || !handedOver && userOpenedTabs.has(tabId)) {
				ungroupTabs([tabId]);
				return;
			}
			this._groupTabIds.add(tabId);
			if (handedOver) void this._handOver(tabId, tab);
			else if (!isNonDebuggableUrl(tab.url)) this._connection.attachTab(tab);
`,
  ],
  [
    '\t\t\tthis._groupTabIds.delete(tabId);\n\t\t\tif (this._connection.attachedTabs.has(tabId)) this._connection.detachTab(tabId);\n\t\t}\n\t}\n',
    `\t\t\tthis._groupTabIds.delete(tabId);
			if (this._connection.attachedTabs.has(tabId)) this._connection.detachTab(tabId);
			// The user moved their tab back out of the group: theirs again.
			if (userTabMemory.has(tabId)) void forgetUserTab(tabId);
		}
	}
	async _handOver(tabId, tab) {
		const name = this._nameOfGroup(tab.groupId) ?? "";
		this._desiredGroup.set(tabId, name);
		await rememberUserTab(tabId, { handedTo: name });
		if (!isNonDebuggableUrl(tab.url)) this._connection.attachTab(tab);
		logTabEvent({ tabId, url: tab.url, action: "handed to the agent by the user", group: this._groupTitle(name) });
	}
	// An agent takes over one of the user's open tabs (browser_tabs take, or browser_navigate to a page they have
	// open): it works in their page as it is (logged in, half filled), nothing reloads. An ungrouped tab joins
	// the agent's group when that group is in the same window (or the group starts around it); a tab in
	// another window or in one of their own groups stays where it is. Nothing is activated or focused.
	async takeTab(tabId, name) {
		if (this._closed) throw new Error("This session is closed");
		const tab = typeof tabId === "number" ? await chrome.tabs.get(tabId).catch(() => null) : null;
		if (!tab) throw new Error("No open tab with id " + tabId);
		if (this._groupTabIds.has(tabId) || this._connection.attachedTabs.has(tabId)) return { tabId, title: tab.title, url: tab.url };
		if (this._isTabReserved(tabId) || userTabMemory.has(tabId) || await isAgentTab(tabId)) throw new Error("Tab " + tabId + " is in use by an agent, not one of the user's free tabs");
		if (!/^(https?|file):/.test(tab.pendingUrl || tab.url || "")) throw new Error("Tab " + tabId + " is a browser page (" + tab.url + ") agents can't work in");
		name = String(name ?? "").trim();
		this._desiredGroup.set(tabId, name);
		await rememberUserTab(tabId, { takenFor: name });
		const groupId = name ? this._subGroups.get(name) ?? null : this._groupId;
		const group = groupId !== null ? await chrome.tabGroups.get(groupId).catch(() => null) : null;
		if (tab.groupId === -1 && (!group || group.windowId === tab.windowId)) {
			// The active tab of a window can't sit in a collapsed group (Brave would switch away from it).
			if (group?.collapsed && tab.active) await retryOnDrag(() => chrome.tabGroups.update(groupId, { collapsed: false })).catch(() => {});
			await this._enqueue(() => this._placeTab(tabId, name)).catch((error) => debugLog("Error grouping a taken tab:", error));
		} else this._groupTabIds.add(tabId);
		this._connection.attachTab(await chrome.tabs.get(tabId).catch(() => tab));
		logTabEvent({ tabId, url: tab.url, action: "taken over by an agent (the user's tab)" });
		return { tabId, title: tab.title, url: tab.url };
	}
`,
  ],
  [
    'async function closeAgentTabs(tabIds, reason = "session disconnected") {\n',
    `async function closeAgentTabs(tabIds, reason = "session disconnected") {
	// 14) The user's tabs are given back, never closed.
	const user = await userTabIds();
	for (const id of tabIds.filter((id) => user.has(id))) await releaseUserTab(id, reason);
	tabIds = tabIds.filter((id) => !user.has(id));
`,
  ],
  [
    '// Tabs with no agent work in them: a group holding only these is finished.\n',
    `//#region local build: The user's tabs (build-extension.cjs 14)
// Tabs of the user's that an agent works in: ones they moved into a 🤖 group and ones an agent took over. In
// chrome.storage.local, so an extension reload (deploy) keeps them; tab ids start over when Brave starts,
// so the list is cleared then.
var USER_TABS_KEY = "userTabs";
var HAND_OVER_MIN_AGE_MS = 2e3;
var userTabMemory = /* @__PURE__ */ new Set();
var userTabInfo = /* @__PURE__ */ new Map();
var tabCreatedAt = /* @__PURE__ */ new Map();
var userTabsLoaded = Promise.resolve(chrome.storage?.local?.get(USER_TABS_KEY)).then((stored) => {
	for (const [id, info] of Object.entries(stored?.[USER_TABS_KEY] ?? {})) {
		userTabMemory.add(Number(id));
		userTabInfo.set(Number(id), info);
	}
}, () => {});
async function userTabIds() {
	await userTabsLoaded;
	return new Set(userTabMemory);
}
async function saveUserTabs() {
	await chrome.storage?.local?.set({ [USER_TABS_KEY]: Object.fromEntries([...userTabMemory].map((id) => [id, userTabInfo.get(id) ?? {}])) }).catch(() => {});
}
async function rememberUserTab(tabId, info = {}) {
	await userTabsLoaded;
	userTabMemory.add(tabId);
	userTabInfo.set(tabId, info);
	await saveUserTabs();
}
async function forgetUserTab(tabId) {
	await userTabsLoaded;
	if (!userTabMemory.delete(tabId)) return;
	userTabInfo.delete(tabId);
	await saveUserTabs();
}
// Back to the user: out of the 🤖 group, debugger off (the MCP sees the page go), page left as it is.
async function releaseUserTab(tabId, reason) {
	await forgetUserTab(tabId);
	const ours = await agentTabIds();
	if (ours.delete(tabId)) await saveAgentTabIds(ours);
	for (const group of playwrightExtension._connections.values()) group.releaseTab(tabId);
	const tab = await chrome.tabs.get(tabId).catch(() => null);
	if (!tab) return;
	if (tab.groupId >= 0 && (await chrome.tabGroups.get(tab.groupId).catch(() => null))?.title?.startsWith(PLAYWRIGHT_GROUP_TITLE)) await ungroupTabs([tabId]);
	chrome.tabs.update(tabId, { autoDiscardable: true }).catch(() => {});
	logTabEvent({ tabId, url: tab.url, action: "given back to the user (their tab, not closed)", reason });
}
// The user's open tabs an agent may take over: web pages that are no agent's and in no 🤖 group.
async function userOpenTabs() {
	const [tabs, agents, user] = await Promise.all([chrome.tabs.query({}), agentTabIds(), userTabIds()]);
	const agentGroups = new Set((await chrome.tabGroups.query({}).catch(() => [])).filter((g) => g.title?.startsWith(PLAYWRIGHT_GROUP_TITLE)).map((g) => g.id));
	const connected = playwrightExtension._connectedTabIds();
	return tabs.filter((t) => t.id !== void 0 && !t.incognito && !agents.has(t.id) && !user.has(t.id) && !connected.has(t.id) && !agentGroups.has(t.groupId) && /^(https?|file):/.test(t.pendingUrl || t.url || "")).map((t) => ({
		tabId: t.id,
		title: t.title || "",
		url: t.pendingUrl || t.url,
		windowId: t.windowId,
		active: !!t.active,
		onScreen: t.id === tabOnScreen(),
		lastAccessed: t.lastAccessed
	}));
}
chrome.tabs.onCreated.addListener((tab) => {
	if (tab.id !== void 0) tabCreatedAt.set(tab.id, Date.now());
});
chrome.tabs.onRemoved.addListener((tabId) => {
	tabCreatedAt.delete(tabId);
	if (userTabMemory.has(tabId)) void forgetUserTab(tabId);
});
chrome.runtime.onStartup.addListener(() => {
	userTabMemory.clear();
	userTabInfo.clear();
	void saveUserTabs();
});
//#endregion
// Tabs with no agent work in them: a group holding only these is finished.
`,
  ],
  [
    '\tconst keep = tabs.filter((t) => t.active || t.id === tabOnScreen()).map((t) => t.id);\n\tif (keep.length) await ungroupTabs(keep);\n\tawait closeAgentTabs(tabs.filter((t) => !keep.includes(t.id)).map((t) => t.id), orphan.reason);\n',
    `\t// 14) A tab the user moved into the group while the session was gone is theirs: back to them, not closed.
	const agents = await agentTabIds();
	const handedBack = tabs.filter((t) => !orphan.tabIds.includes(t.id) && !agents.has(t.id)).map((t) => t.id);
	if (handedBack.length) await ungroupTabs(handedBack);
	const keep = tabs.filter((t) => !handedBack.includes(t.id) && (t.active || t.id === tabOnScreen())).map((t) => t.id);
	if (keep.length) await ungroupTabs(keep);
	await closeAgentTabs(tabs.filter((t) => !keep.includes(t.id) && !handedBack.includes(t.id)).map((t) => t.id), orphan.reason);
`,
  ],
  [
    '\t\t\t\t\t// Tell the MCP server (chrome.tabs.onCreated), which attaches to it.\n',
    `\t\t\t\t\t// A tab the user moved into the group while it waited is handed to this chat (14).
					if (!o.tabIds.includes(id) && !userTabMemory.has(id) && !(await agentTabIds()).has(id)) await rememberUserTab(id, { handedTo: name });
					// Tell the MCP server (chrome.tabs.onCreated), which attaches to it.
`,
  ],
]);

console.log(`built ${dest} from ${src} (extension ${manifest.version_name})`);
