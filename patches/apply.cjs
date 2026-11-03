// Local patches to playwright-core for driving the user's Brave (or another Chromium browser) through the Playwright Extension.
// Runtime env read by the patched code: PW_MCP_BROKER_PORT (default 8770), PW_MCP_BROKER_LAUNCHER (script that
// starts broker.cjs detached; default is Startupplaywright-broker.vbs if present, else node broker.cjs),
// PW_MCP_BROWSER_PROCESS (browser image name for the "is it running" check, default brave.exe),
// PW_LANE_DIR (where the browser-lanes hook writes lane files, default <repo>/lane-ids),
// PLAYWRIGHT_MCP_GROUP_NAME, PW_MCP_TOOL_CAP_MS.
// Re-apply after any `npm install` / Playwright update, then reconnect the MCP server (e.g. /mcp in Claude Code):
//   node patches/apply.cjs [install-dir]
// install-dir defaults to the newest <repo>/runtime[-N] (see install-dir.cjs), else the repo itself
// (its own node_modules). Patching a bundle a running supervisor watches restarts its idle MCP children,
// which closes their tabs: install a fresh copy into runtime-N+1 (npm install there, then apply.cjs) and
// point the MCP server entry at it instead (see README, "Install layout").
// Each patch is applied once (marker comment) and fails loudly if its anchor moved.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ROOT_JS = JSON.stringify(ROOT); // logs, broker and lane-ids live here, whichever install runs
const installDir = path.resolve(process.argv[2] || require('./install-dir.cjs').currentInstall());
const file = path.join(installDir, 'node_modules', 'playwright-core', 'lib', 'coreBundle.js');
let src = fs.readFileSync(file, 'utf8');
const original = src;

// Lanes: helpers must never wait for each other or work on each other's tabs. A Claude session's
// main agent and all its subagents share one MCP server, which had ONE current tab, so
// parallel helpers steered each other's tabs and sessions ran them one after another. Now every
// agent is a lane with its own tabs, tab indexes and current tab, and calls from different lanes run
// side by side. A call's lane is the Claude agent id that the browser-lanes PreToolUse hook
// (claude-code-hooks/browser-lanes) records per tool call; LANES_SERVER reads it and runs the call
// inside an AsyncLocalStorage store. installLanes and tabsToolSpec are stringified into the bundle,
// so they must stay self-contained (no variables from this file).
function installLanes(Context, Tab) {
  const { AsyncLocalStorage } = require("async_hooks");
  const laneStore = globalThis.__pwLaneStore ??= new AsyncLocalStorage();
  // Kept across reconnects (a new Context after the extension reloads or the connection drops, when
  // the extension hands the session its tabs back): the lane of each tab and each lane's current tab,
  // keyed by CDP target id, which stays the same for a tab's whole life.
  const laneByTarget = globalThis.__pwLaneByTarget ??= new Map();
  const currentTargetByLane = globalThis.__pwCurrentTargetByLane ??= new Map();
  const groupByLane = globalThis.__pwGroupByLane ??= new Map();
  const laneInfo = globalThis.__pwLaneInfo ??= new Map();
  // Tabs an agent marked with browser_tabs keep (left for the user to act on), by CDP target id.
  const keepTargets = globalThis.__pwKeepTargets ??= new Set();
  // The user's tabs (extension build 14): ones they moved into this chat's tab group, ones an agent took over
  // (browser_tabs take, browser_navigate to a page they have open). The extension marks them (pwUser) when it
  // reports the tab, and gives them back instead of closing them. takeHints: chrome tab id -> the lane
  // taking it, until its page appears; laneNotices: per lane, tabs the user handed it since its last call.
  const takeHints = globalThis.__pwTakeHints ??= new Map();
  const laneNotices = globalThis.__pwLaneNotices ??= new Map();
  const relay = () => globalThis.__pwRelayModel;
  const openHints = () => globalThis.__pwOpenHints ??= [];
  const isConnectPage = (tab) => {
    try {
      return /^chrome-extension:\/\/[^/]+\/connect\.html/.test(tab.page.url());
    } catch {
      return false;
    }
  };
  const MARKER = "[agent] window.open blocked; opened in a background tab instead (see browser_tabs):";
  // Only valid inside a tool call. Event handlers (new page, page closed) must not use it: their async
  // context is whatever started the connection, so they look the lane up from the tab instead.
  const laneNow = () => laneStore.getStore()?.lane ?? "main";
  const targetIdOf = (page) => {
    try {
      return page._connection.toImpl(page).delegate._targetId;
    } catch {
      return void 0;
    }
  };
  const chromeTabIdOf = (tab) => relay()?.chromeTabIdForTarget?.(targetIdOf(tab.page));
  const userInfoOf = (tab) => {
    const id = chromeTabIdOf(tab);
    return id === void 0 ? void 0 : relay()?._knownTabs?.get(id)?.pwUser;
  };
  // Same page: same origin, path (without a trailing /) and query; the #hash doesn't count. "" for non-web URLs.
  const pageKey = (url) => {
    try {
      const u = new URL(/^[a-z][\w+.-]*:/i.test(url) ? url : "https://" + url);
      return /^https?:$/.test(u.protocol) ? u.origin + u.pathname.replace(/\/+$/, "") + u.search : "";
    } catch {
      return "";
    }
  };
  const extensionNeeded = (e) => /Unknown method/.test(String(e?.message)) ? new Error("Using the user's open tabs needs the updated Playwright Extension build (run patches/build-extension.cjs, then reload the extension); open a new tab instead") : e;
  const remember = (map, key, value) => {
    if (key === void 0)
      return;
    map.delete(key);
    map.set(key, value);
    if (map.size > 2e3)
      map.delete(map.keys().next().value);
  };
  const proto = Context.prototype;
  proto._lane = function(name) {
    const lanes = this.__lanes ??= new Map();
    let lane = lanes.get(name);
    if (!lane)
      lanes.set(name, lane = { current: void 0 });
    return lane;
  };
  proto._setLaneCurrent = function(name, tab) {
    this._lane(name).current = tab;
    if (tab)
      remember(currentTargetByLane, name, targetIdOf(tab.page));
  };
  // Every read and write of the current tab in the original code now goes to the calling agent's lane.
  Object.defineProperty(proto, "_currentTab", {
    configurable: true,
    get() {
      return this._lane(laneNow()).current;
    },
    set(tab) {
      this._setLaneCurrent(laneNow(), tab);
    }
  });
  proto.laneName = () => laneNow();
  proto.laneLabel = (name) => {
    if (name === void 0)
      return "not assigned yet";
    if (name === "main")
      return "main agent";
    const type = laneInfo.get(name)?.type;
    return "subagent " + String(name).slice(0, 8) + (type ? " (" + type + ")" : "");
  };
  proto.tabs = function() {
    const name = laneNow();
    return this._tabs.filter((t) => t._lane === name);
  };
  proto.allTabs = function() {
    return this._tabs.filter((t) => t._lane !== void 0);
  };
  proto._assignLane = function(tab, name, { current = true } = {}) {
    if (!tab)
      return;
    this._unassigned?.delete(tab);
    tab._resolving = false;
    const old = tab._lane;
    if (old !== void 0 && old !== name) {
      const prev = this._lane(old);
      if (prev.current === tab)
        prev.current = this._tabs.find((t) => t !== tab && t._lane === old);
    }
    tab._lane = name;
    const targetId = targetIdOf(tab.page);
    remember(laneByTarget, targetId, name);
    if (targetId !== void 0 && keepTargets.has(targetId))
      tab._keep = true;
    if (!current)
      return;
    const lane = this._lane(name);
    // A lane's first tab becomes its current tab (as before lanes); after a reconnect, so does the tab
    // the agent was working in.
    if (!lane.current) {
      this._setLaneCurrent(name, tab);
    } else if (targetId !== void 0 && currentTargetByLane.get(name) === targetId && lane.current !== tab) {
      // The extension handed this tab back after a reconnect. The connect page the reconnect opened
      // is not needed then.
      const prev = lane.current;
      lane.current = tab;
      if (/^chrome-extension:\/\/[^/]+\/connect\.html/.test(prev.page.url()))
        prev.page.close().catch(() => {
        });
    }
  };
  proto._resolveLane = function(tab) {
    const user = userInfoOf(tab);
    if (user)
      tab._user = true;
    const known = laneByTarget.get(targetIdOf(tab.page));
    if (known !== void 0)
      return this._assignLane(tab, known);
    const chromeId = chromeTabIdOf(tab);
    const take = chromeId !== void 0 ? takeHints.get(chromeId) : void 0;
    if (take) {
      takeHints.delete(chromeId);
      return this._assignLane(tab, take.lane, { current: false });
    }
    if (user?.handedTo !== void 0)
      return this._handOverTo(tab, user.handedTo);
    if (this._initLane !== void 0)
      return this._assignLane(tab, this._initLane);
    if (this._pendingNewTabs) {
      // An agent is creating a tab (browser_tabs new, first navigate): newTab() claims its page, and
      // any other page that appears meanwhile is resolved once that is done.
      (this._unassigned ??= new Set()).add(tab);
      return;
    }
    // A tab that one of the agents' pages opened. The popup guard (popups-as-tabs.js) logs each
    // window.open URL and the extension opens it; hidden-tab clicks on target=_blank links open it
    // server-side (HIDDEN_TAB_INPUT). Both leave a hint naming the opener. Without a hint ask CDP for
    // the opener; last resort, the agent that called last.
    const now = Date.now();
    const hints = openHints();
    for (let i2 = hints.length - 1; i2 >= 0; i2--) {
      if (now - hints[i2].at > 5e3)
        hints.splice(i2, 1);
    }
    const url = tab.page.url();
    let i = hints.findIndex((h) => h.url && h.url === url);
    if (i < 0 && hints.length)
      i = 0;
    if (i >= 0) {
      const [hint] = hints.splice(i, 1);
      const name = hint.lane ?? this._tabs.find((t) => t.page._guid === hint.openerGuid)?._lane;
      if (name !== void 0)
        return this._assignLane(tab, name);
    }
    (this._unassigned ??= new Set()).add(tab);
    tab._resolving = true;
    const fallback = globalThis.__pwLastLane ?? "main";
    Promise.race([tab.page.opener().catch(() => null), new Promise((r) => setTimeout(() => r(null), 1e3))]).then((opener) => {
      if (!tab._resolving || !this._tabs.includes(tab))
        return;
      const name = opener ? this._tabs.find((t) => t.page === opener)?._lane : void 0;
      this._assignLane(tab, name ?? fallback);
    });
  };
  // The user moved one of their tabs into this chat's tab group (or a helper's sub-group): it goes to the agent
  // of that group (the main agent for the main group), as its current tab when it has no real page yet,
  // and that agent's next result says so (takeNotices).
  proto._handOverTo = function(tab, groupName) {
    let lane = "main";
    for (const [name, group] of groupByLane) {
      if (groupName && group === groupName)
        lane = name;
    }
    const current = this._lane(lane).current;
    const free = !current || isConnectPage(current) || current.page.url() === "about:blank";
    this._assignLane(tab, lane, { current: false });
    if (free)
      this._setLaneCurrent(lane, tab);
    if (!laneNotices.has(lane))
      laneNotices.set(lane, []);
    laneNotices.get(lane).push({ tab, current: free });
  };
  proto.takeNotices = async function(lane) {
    const pending = laneNotices.get(lane);
    if (!pending?.length)
      return "";
    laneNotices.delete(lane);
    const mine = this._tabs.filter((t) => t._lane === lane);
    const lines = [];
    for (const { tab, current } of pending) {
      const index = mine.indexOf(tab);
      if (index < 0)
        continue;
      const title = await Promise.race([tab.page.title().catch(() => ""), new Promise((r) => setTimeout(() => r(""), 2e3))]);
      lines.push("- " + index + ": [" + title + "](" + tab.page.url() + ")" + (current ? " (now your current tab)" : " (switch to it with browser_tabs select)"));
    }
    if (!lines.length)
      return "";
    return "### The user handed you a tab\nThe user moved this tab of theirs into your tab group, so they want you to work in it:\n" + lines.join("\n") + "\nIt is their page as they left it (logged in, maybe half filled): don't reload it or navigate away from their work unless that is the task. browser_tabs close gives it back to them without closing it.";
  };
  // The user's open tabs (not agents'), from the extension: [{ tabId, title, url, active, onScreen, ... }].
  proto.userTabs = async function() {
    await this.ensureBrowserContext();
    if (!relay()?._sendToExtension)
      throw new Error("The user's tabs are only reachable through the browser extension connection");
    const result = await relay()._sendToExtension("playwright.listTabs", [{}]).catch((e) => {
      throw extensionNeeded(e);
    });
    return Array.isArray(result?.tabs) ? result.tabs : [];
  };
  // Work in one of the user's tabs as it is (no reload): it becomes the caller's current tab.
  proto.takeUserTab = async function(chromeTabId) {
    await this.ensureBrowserContext();
    const model = relay();
    if (!model?._sendToExtension)
      throw new Error("The user's tabs are only reachable through the browser extension connection");
    const name = laneNow();
    const find = () => this._tabs.find((t) => chromeTabIdOf(t) === chromeTabId);
    const already = find();
    if (already) {
      if (already._lane !== name)
        this._assignLane(already, name);
      this._setCurrentTab(already);
      return already;
    }
    takeHints.set(chromeTabId, { lane: name });
    try {
      await model._sendToExtension("playwright.takeTab", [{ tabId: chromeTabId, name: groupByLane.get(name) ?? "" }]);
    } catch (e) {
      takeHints.delete(chromeTabId);
      throw extensionNeeded(e);
    }
    for (let i = 0; i < 100; i++) {
      const tab = find();
      if (tab?._lane !== void 0) {
        tab._user = true;
        if (tab._lane !== name)
          this._assignLane(tab, name, { current: false });
        this._setCurrentTab(tab);
        return tab;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    takeHints.delete(chromeTabId);
    throw new Error("The user's tab " + chromeTabId + " did not connect within 10 s; try again");
  };
  // browser_navigate to a page the user already has open: work in their tab instead of loading a fresh copy,
  // which would lose what they typed and a login only that tab has. Otherwise returns
  // their tabs on the same site, so the agent can take one over if that is what they meant.
  proto.userTabFor = async function(url) {
    const target = pageKey(url);
    if (!target || !relay()?._sendToExtension)
      return {};
    if (this._currentTab && pageKey(this._currentTab.page.url()) === target)
      return {};
    let tabs;
    try {
      tabs = await this.userTabs();
    } catch {
      return {};
    }
    const rank = (t) => (t.onScreen ? 2 : 0) + (t.active ? 1 : 0);
    const same = tabs.filter((t) => pageKey(t.url) === target).sort((a, b) => rank(b) - rank(a) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
    for (const t of same) {
      try {
        return { taken: await this.takeUserTab(t.tabId) };
      } catch {
      }
    }
    const origin = new URL(target).origin;
    return { site: tabs.filter((t) => pageKey(t.url).startsWith(origin + "/") || pageKey(t.url) === origin).slice(0, 5) };
  };
  proto._resolveLeftovers = function() {
    for (const tab of [...this._unassigned ?? []]) {
      if (tab._resolving)
        continue;
      this._unassigned.delete(tab);
      this._resolveLane(tab);
    }
  };
  proto._onPageCreated = function(page) {
    const tab = new Tab(this, page, (t) => this._onPageClosed(t));
    this._tabs.push(tab);
    page.on("console", (message) => {
      try {
        if (message.type() === "debug" && message.text().startsWith(MARKER))
          openHints().push({ lane: tab._lane, url: message.text().slice(MARKER.length).trim(), at: Date.now() });
      } catch {
      }
    });
    this._startPageVideo(page).catch(() => {
    });
    this._resolveLane(tab);
  };
  proto._onPageClosed = function(tab) {
    const index = this._tabs.indexOf(tab);
    if (index === -1)
      return;
    this._tabs.splice(index, 1);
    this._unassigned?.delete(tab);
    const name = tab._lane;
    if (name === void 0)
      return;
    const lane = this._lane(name);
    if (lane.current === tab) {
      // The nearest of the same agent's tabs, as before lanes. Not remembered as its choice, so after
      // a reconnect (every page closes, then comes back) it gets the tab it was working in.
      const rest = this._tabs.filter((t) => t._lane === name);
      const before = this._tabs.slice(0, index).filter((t) => t._lane === name).length;
      lane.current = rest[Math.min(before, rest.length - 1)];
    }
  };
  proto.newTab = async function() {
    const name = laneNow();
    const browserContext = await this.ensureBrowserContext();
    // The connect page the extension opened for this connection has no other use: it becomes the first
    // tab an agent needs instead of staying behind as a stray tab. Not while it is
    // another agent's current tab: that agent's call is about to navigate it (the connection's first
    // call, with a second helper starting at the same moment).
    const spare = this._tabs.find((t) => isConnectPage(t) && !t._claimed && !t._keep && !this._isCurrentOfOtherLane(t, name));
    if (spare) {
      spare._claimed = true;
      this._assignLane(spare, name);
      this._setCurrentTab(spare);
      await spare.page.goto("about:blank").catch(() => {
      });
      const spareGroup = groupByLane.get(name);
      if (spareGroup)
        await this.setTabGroup(spare, spareGroup).catch(() => {
        });
      return this._currentTab;
    }
    this._pendingNewTabs = (this._pendingNewTabs || 0) + 1;
    let page;
    try {
      page = await browserContext.newPage();
    } catch (e) {
      if (!--this._pendingNewTabs)
        this._resolveLeftovers();
      throw e;
    }
    this._pendingNewTabs--;
    const tab = this._tabs.find((t) => t.page === page);
    this._assignLane(tab, name);
    this._setCurrentTab(tab);
    if (!this._pendingNewTabs)
      this._resolveLeftovers();
    const group = groupByLane.get(name);
    if (tab && group)
      await this.setTabGroup(tab, group).catch(() => {
      });
    return this._currentTab;
  };
  proto.selectTab = async function(index, all) {
    const tab = (all ? this.allTabs() : this.tabs())[index];
    if (!tab)
      throw new Error("Tab " + index + " not found");
    if (tab._lane !== laneNow())
      this._assignLane(tab, laneNow());
    await tab.updateWebMCPTools();
    this._setCurrentTab(tab);
    return tab;
  };
  proto.closeTab = async function(index, all) {
    const tab = index === void 0 ? this._currentTab : (all ? this.allTabs() : this.tabs())[index];
    if (!tab)
      throw new Error("Tab " + index + " not found");
    const url = tab.page.url();
    await tab.page.close();
    return url;
  };
  // Pages already open when the connection is set up (the connect page, tabs handed back after a
  // reconnect that no lane claims) go to the agent whose call set it up.
  const initializeBrowserContext = proto._initializeBrowserContext;
  proto._initializeBrowserContext = async function() {
    this._initLane = laneNow();
    try {
      return await initializeBrowserContext.call(this);
    } finally {
      this._initLane = void 0;
    }
  };
  const dispose = proto.dispose;
  proto.dispose = async function() {
    try {
      return await dispose.call(this);
    } finally {
      this.__lanes?.clear();
      this._unassigned?.clear();
    }
  };
  proto._isCurrentOfOtherLane = function(tab, name) {
    for (const [other, lane] of this.__lanes ?? [])
      if (other !== name && lane.current === tab)
        return true;
    return false;
  };
  // After every call: a connect page nobody took (a reconnect while the agents already have tabs, an
  // agent that opened its work with browser_tabs new) closes as soon as the session has another tab.
  // A connect page that is still some agent's current tab stays (that agent may be navigating it right
  // now in a parallel call); the extension closes it once no agent has used it for 15 s.
  proto.closeSpareConnectPages = function() {
    if (!this._tabs.some((t) => !isConnectPage(t)))
      return;
    for (const tab of this._tabs.filter((t) => isConnectPage(t) && !t._claimed && !t._keep && !this._isCurrentOfOtherLane(t)))
      tab.page.close().catch(() => {
      });
  };
  proto.keepTab = function(tab) {
    tab._keep = true;
    const targetId = targetIdOf(tab.page);
    if (targetId !== void 0)
      keepTargets.add(targetId);
  };
  // A subagent finished (SubagentStop, via the browser-lanes hook): its tabs close, except the ones it
  // kept for the user; those go to the main agent's list (never as its current tab, so nothing navigates
  // them away). Returns false when this session never had that agent.
  proto.finishLane = async function(name) {
    if (name === "main")
      return false;
    const mine = this._tabs.filter((t) => t._lane === name);
    if (!mine.length && !this.__lanes?.has(name))
      return false;
    for (const tab of mine) {
      if (tab._keep)
        this._assignLane(tab, "main", { current: false });
      else
        await tab.page.close().catch(() => {
        });
    }
    this.__lanes?.delete(name);
    groupByLane.delete(name);
    currentTargetByLane.delete(name);
    laneNotices.delete(name);
    return true;
  };
  proto.setLaneGroup = function(name) {
    if (name)
      groupByLane.set(laneNow(), name);
    else
      groupByLane.delete(laneNow());
  };
  // Named tab groups live in the extension (playwright.groupTab, extension build 11+).
  proto.setTabGroup = async function(tab, name) {
    const model = globalThis.__pwRelayModel;
    const tabId = model?.chromeTabIdForTarget?.(targetIdOf(tab.page));
    if (tabId === void 0)
      throw new Error("Tab groups only work through the browser extension, and this tab is not attached to it.");
    let result;
    try {
      result = await model._sendToExtension("playwright.groupTab", [{ tabId, name }]);
    } catch (e) {
      if (/Unknown method/.test(String(e?.message)))
        throw new Error("Tab groups need the updated Playwright Extension build, which the browser has not loaded yet (run build-extension.cjs and reload the extension, see README). Tabs still work, in this session's main group.");
      throw e;
    }
    tab._groupName = name;
    return result;
  };
}

function tabsToolSpec(z) {
  const titleOf = (tab) => Promise.race([tab.page.title().catch(() => ""), new Promise((r) => setTimeout(() => r(""), 2e3))]);
  return {
    capability: "core-tabs",
    schema: {
      name: "browser_tabs",
      title: "Manage tabs",
      description: "List, create, close, select, group or keep browser tabs, or work in a tab the user already has open. Every agent (the main agent and each subagent) has its own tabs, tab indexes and current tab, so several agents can use the browser at the same time without waiting for each other or touching each other's tabs. New tabs open in this session's tab group; use group to put tabs in a named group of their own. Close each tab as soon as its work is done. When a subagent finishes, all its tabs close automatically except the ones it marked with keep (a form or sign-in left for the user to act on; say so in your reply). existing lists the tabs the user has open (logged in, maybe half filled); take works in one of them as it is, without reloading (browser_navigate to a page they have open does that by itself). A tab the user drags into your group is handed to you. The user's tabs are never closed: close gives them back to them.",
      inputSchema: z.object({
        action: z.enum(["list", "new", "close", "select", "group", "keep", "existing", "take"]).describe("Operation to perform. group: move a tab into the tab group named by `group`. keep: leave a tab open for the user after you finish (only when they must act on it). existing: list the user's own open tabs. take: work in one of them (needs tabId)."),
        index: z.number().optional().describe("Tab index from list, used for close/select/group/keep. If omitted for close, group or keep, the current tab is used."),
        tabId: z.number().optional().describe("Id of one of the user's tabs, from action existing; used for take."),
        url: z.string().optional().describe("URL to navigate to in the new tab, used for new."),
        group: z.string().optional().describe('Tab group name, used for new and group. The group is created if needed, and your later new tabs open in it too. "" = this session\'s main group.'),
        all: z.boolean().optional().describe("list/select/close across every agent of this session instead of only your own tabs; select then takes that tab over as yours.")
      }),
      type: "action"
    },
    handle: async (context, params, response) => {
      const all = !!params.all;
      const me = context.laneName();
      const groupName = params.group === void 0 ? void 0 : params.group.trim();
      switch (params.action) {
        case "list": {
          if (all)
            await context.ensureBrowserContext();
          else
            await context.ensureTab();
          break;
        }
        case "new": {
          if (groupName !== void 0)
            context.setLaneGroup(groupName);
          const tab = await context.newTab();
          if (groupName) {
            const result = await context.setTabGroup(tab, groupName);
            response.addTextResult("New tab is in group " + JSON.stringify(result?.title ?? groupName) + "; your later new tabs open there too.");
          }
          if (params.url) {
            const url = await tab.checkUrlAndNavigate(params.url);
            response.setIncludeSnapshot();
            response.addAction({ name: "navigate", url });
          }
          break;
        }
        case "close": {
          const target = params.index === void 0 ? context.currentTab() : (all ? context.allTabs() : context.tabs())[params.index];
          await context.closeTab(params.index, all);
          if (target?._user)
            response.addTextResult("That was the user's tab: given back to them, still open (out of your tab group).");
          break;
        }
        case "existing": {
          const tabs = await context.userTabs();
          const lines = tabs.map((t) => "- tabId " + t.tabId + ":" + (t.onScreen ? " (on the user's screen)" : t.active ? " (active in its window)" : "") + " [" + t.title + "](" + t.url + ")");
          response.addTextResult(tabs.length ? "Tabs the user has open (not agents'). To work in one as it is, use browser_tabs take with its tabId:\n" + lines.join("\n") : "The user has no other web pages open.");
          return;
        }
        case "take": {
          if (params.tabId === void 0)
            throw new Error("tabId is required: the id from browser_tabs existing");
          await context.takeUserTab(params.tabId);
          response.addTextResult("You now work in the user's tab as they left it (not reloaded: their login and anything they typed are still there). It is theirs: when you are done, browser_tabs close gives it back to them without closing it.");
          response.setIncludeSnapshot();
          break;
        }
        case "select": {
          if (params.index === void 0)
            throw new Error("Tab index is required");
          await context.selectTab(params.index, all);
          break;
        }
        case "group": {
          if (groupName === void 0)
            throw new Error('group is required: the tab group name ("" = this session\'s main group)');
          const tab = params.index === void 0 ? context.currentTabOrDie() : context.tabs()[params.index];
          if (!tab)
            throw new Error("Tab " + params.index + " not found");
          const result = await context.setTabGroup(tab, groupName);
          context.setLaneGroup(groupName);
          response.addTextResult("Tab moved to group " + JSON.stringify(result?.title ?? groupName) + "; your later new tabs open there too.");
          break;
        }
        case "keep": {
          const tab = params.index === void 0 ? context.currentTabOrDie() : context.tabs()[params.index];
          if (!tab)
            throw new Error("Tab " + params.index + " not found");
          context.keepTab(tab);
          response.addTextResult("This tab stays open for the user after you finish; tell them in your reply what they need to do there. Your other tabs close when you finish.");
          break;
        }
      }
      const tabs = all ? context.allTabs() : context.tabs();
      const current = context.currentTab();
      const lines = [];
      for (let i = 0; i < tabs.length; i++) {
        const tab = tabs[i];
        const flags = [tab === current ? "current" : "", all ? tab._lane === me ? "yours" : context.laneLabel(tab._lane) : "", tab._user ? "the user's tab" : "", tab._keep ? "kept for the user" : ""].filter(Boolean);
        lines.push("- " + i + ":" + (flags.length ? " (" + flags.join(", ") + ")" : "") + " [" + await titleOf(tab) + "](" + tab.page.url() + ")" + (tab._groupName ? " {group: " + tab._groupName + "}" : ""));
      }
      if (!tabs.length)
        lines.push(all ? "No open tabs in this session." : "No open tabs. Navigate to a URL to create one.");
      const others = all ? 0 : context.allTabs().length - tabs.length;
      if (others)
        lines.push("(" + others + " more tab" + (others === 1 ? "" : "s") + " belong to other agents of this session; list them with all: true)");
      response.addTextResult(lines.join("\n"));
    }
  };
}

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
          // So the new page goes to the lane (agent) whose tab opened it (LANES_CONTEXT).
          (globalThis.__pwOpenHints ??= []).push({ openerGuid: this._page.guid, url: value.openUrl, at: Date.now() });
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
    // Brave freezes background tabs (measured: FREEZE 2s after setup, then no timers,
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
    // No tool call may hang: one browser_run_code_unsafe (click SEND, wait, evaluate)
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
              require("fs").appendFileSync(require("path").join(${ROOT_JS}, "stalls.log"), \`\${new Date().toISOString()} \${name} \${what} \${JSON.stringify(parsedArguments).slice(0, 300)}\n\`);
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
                  if (session._page.guid === tab.page._guid)
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
    // Switching tabs must not raise Brave over the user's work (Page.bringToFront focuses the window).
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
    // the T3 Code thread title (optional: used only when T3 Code's sqlite state and Claude Code's session files exist), found via ~/.claude/sessions/<claude pid>.json (sessionId) and T3's
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
            // T3 v0.1.0+ keeps threads in statev2.sqlite (state.sqlite stopped updating at that upgrade); older T3 used state.sqlite.
            const lookups = [
              ["statev2.sqlite", "select t.title from orchestration_v2_projection_provider_threads p join orchestration_v2_projection_threads t on t.thread_id = p.thread_id where json_extract(p.payload_json, '$.nativeThreadRef.nativeId') = ? and t.deleted_at is null order by p.updated_at desc limit 1"],
              ["state.sqlite", "select t.title from provider_session_runtime r join projection_threads t on t.thread_id = r.thread_id where json_extract(r.resume_cursor_json, '$.resume') = ? and t.deleted_at is null order by r.last_seen_at desc limit 1"]
            ];
            for (const [dbFile, sql] of sessionId ? lookups : []) {
              const dbPath = P.join(os.homedir(), ".t3", "userdata", dbFile);
              if (!fs.existsSync(dbPath))
                continue;
              let row;
              try {
                const db = new (require("node:sqlite").DatabaseSync)(dbPath, { readOnly: true });
                try {
                  row = db.prepare(sql).get(sessionId);
                } finally {
                  db.close();
                }
              } catch {
                continue;
              }
              const title = row?.title?.trim();
              if (title && !/^new thread$/i.test(title))
                return title.length > 40 ? title.slice(0, 39) + "\\u2026" : title;
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
    // Launching the browser exe with the connect URL always brings the browser to the front. Ask broker.cjs to
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
            const brokerPath = require("path").join(${ROOT_JS}, "broker.cjs");
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
        // that when it is closed; otherwise fail loudly so the agent reports the real problem.
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
  {
    // When Brave is closed and the MCP has to launch it, start it with --silent-debugger-extension-api so the
    // extension's debugger attach doesn't show the "Playwright Extension started debugging this browser" bar
    // (the browser's own shortcuts and link handler need the same flag, see README).
    marker: '/*SILENT_DEBUGGER*/',
    needle: '        args.push(href);\n',
    replacement: `        /*SILENT_DEBUGGER*/ args.push("--silent-debugger-extension-api");
        args.push(href);
`,
  },
  // --- Migrations for bundles patched with earlier versions of this file (the text above already has these) ---
  {
    // Logs and the broker live in playwright-mcp/, not three folders above coreBundle.js (that broke
    // once the server moved to playwright-mcp/runtime/).
    marker: '/*ROOT_PATHS_STALLS*/',
    optional: true,
    needle: 'require("path").join(__dirname, "..", "..", "..", "stalls.log")',
    replacement: `require("path").join(/*ROOT_PATHS_STALLS*/ ${ROOT_JS}, "stalls.log")`,
  },
  {
    marker: '/*ROOT_PATHS_BROKER*/',
    optional: true,
    needle: 'require("path").join(__dirname, "..", "..", "..", "broker.cjs")',
    replacement: `require("path").join(/*ROOT_PATHS_BROKER*/ ${ROOT_JS}, "broker.cjs")`,
  },
  {
    // Self-heal stopped scripts in every tab with the hung tab's URL; with several agents on the same
    // site that hit the other agents' tabs. Only the hung tab now.
    marker: '/*HEAL_EXACT_TAB*/',
    optional: true,
    needle: 'if (session._page.mainFrame().url() === url)',
    replacement: 'if (/*HEAL_EXACT_TAB*/ session._page.guid === tab.page._guid)',
  },
  {
    marker: '/*OPEN_HINT*/',
    optional: true,
    needle: `        if (value && typeof value === "object" && value.openUrl) {
          try {`,
    replacement: `        if (value && typeof value === "object" && value.openUrl) {
          /*OPEN_HINT*/ (globalThis.__pwOpenHints ??= []).push({ openerGuid: this._page.guid, url: value.openUrl, at: Date.now() });
          try {`,
  },
  // --- Lanes: every agent of a session gets its own tabs (see installLanes above) ---
  {
    marker: '/*LANES_CONTEXT*/',
    needle: '          text2 = text2.replaceAll(secretValue, `<secret>${secretName}</secret>`);\n        }\n        return text2;\n      }\n    };\n  }\n});\n',
    replacement: '          text2 = text2.replaceAll(secretValue, `<secret>${secretName}</secret>`);\n        }\n        return text2;\n      }\n    };\n    /*LANES_CONTEXT*/ (' + installLanes.toString() + ')(Context, Tab);\n  }\n});\n',
  },
  {
    marker: '/*LANES_TABS_TOOL*/',
    start: '    browserTabs = defineTool({\n      capability: "core-tabs",\n',
    end: '    tabs_default = [\n      browserTabs\n    ];\n',
    replacement: '    /*LANES_TABS_TOOL*/ browserTabs = defineTool((' + tabsToolSpec.toString() + ')(z25));\n',
  },
  {
    // browser_close ends the whole connection, i.e. every agent's tabs. While other agents still have
    // tabs, it closes only the caller's.
    marker: '/*LANES_CLOSE*/',
    needle: `      handle: async (context, params2, response2) => {
        if (context.config.sharedBrowserContext)
          throw new Error("The browser context is shared between clients and cannot be closed.");
`,
    replacement: `      handle: async (context, params2, response2) => {
        /*LANES_CLOSE*/ if (context.allTabs?.().some((t) => t._lane !== context.laneName())) {
          for (const tab2 of context.tabs())
            await tab2.page.close().catch(() => {
            });
          response2.addTextResult("Closed your tabs. Other agents of this session are still using the browser, so the connection stays open.");
          return;
        }
        if (context.config.sharedBrowserContext)
          throw new Error("The browser context is shared between clients and cannot be closed.");
`,
  },
  {
    // A page the user already has open is used as it is (their tab, not reloaded), see installLanes userTabFor.
    // Otherwise the result names their tabs on the same site, in case they meant one of those.
    marker: '/*NAVIGATE_USER_TAB*/',
    needle: `      handle: async (context, params2, response2) => {
        const tab2 = await context.ensureTab();
        const url3 = await tab2.checkUrlAndNavigate(params2.url);
        response2.setIncludeSnapshot();
        response2.addAction({ name: "navigate", url: url3 });
      }
`,
    replacement: `      handle: async (context, params2, response2) => {
        /*NAVIGATE_USER_TAB*/ const user = await context.userTabFor?.(params2.url) ?? {};
        if (user.taken) {
          response2.addTextResult("The user already had this page open, so you are working in their tab as they left it (not reloaded: their login and anything they typed are still there). It is theirs: when you are done, browser_tabs close gives it back to them without closing it. For a fresh copy instead, use browser_tabs new with the url.");
          response2.setIncludeSnapshot();
          return;
        }
        const tab2 = await context.ensureTab();
        const url3 = await tab2.checkUrlAndNavigate(params2.url);
        response2.setIncludeSnapshot();
        response2.addAction({ name: "navigate", url: url3 });
        if (user.site?.length)
          response2.addTextResult("The user also has this site open: " + user.site.map((t) => "[" + t.title + "](" + t.url + ") (tabId " + t.tabId + (t.onScreen ? ", on their screen" : "") + ")").join(", ") + ". If they were in the middle of something there (a half-filled form, a page only that tab is signed in to), work in their tab instead: browser_tabs take with its tabId.");
      }
`,
  },
  {
    // The extension relay (one per connection) is how Context reaches the extension for tab groups.
    marker: '/*RELAY_MODEL*/',
    needle: '        this._model = new BrowserModel(sendCommand);\n',
    replacement: '        this._model = new BrowserModel(sendCommand);\n        /*RELAY_MODEL*/ globalThis.__pwRelayModel = this._model;\n',
  },
  {
    marker: '/*RELAY_TAB_ID*/',
    needle: '      async _attachTab(tabId) {\n        const existing = this._tabSessions.get(tabId);\n',
    replacement: `      /*RELAY_TAB_ID*/ chromeTabIdForTarget(targetId) {
        if (targetId === void 0)
          return void 0;
        for (const s of this._tabSessions.values()) {
          if (s.targetInfo?.targetId === targetId)
            return s.tabId;
        }
        return void 0;
      }
      async _attachTab(tabId) {
        const existing = this._tabSessions.get(tabId);
`,
  },
  {
    // The extension keeps a disconnected session's tabs for a few minutes and hands them back when the
    // same session reconnects (extension build 12); this key says which session it is.
    marker: '/*SESSION_ID_GLOBAL*/',
    needle: 'const sessionId = process.env.CLAUDE_CODE_SESSION_ID || (process.env.PW_MCP_PARENT_PID && sessionOf(process.env.PW_MCP_PARENT_PID)) || sessionOf(process.ppid) || sessionOf(grandparent());\n',
    replacement: 'const sessionId = process.env.CLAUDE_CODE_SESSION_ID || (process.env.PW_MCP_PARENT_PID && sessionOf(process.env.PW_MCP_PARENT_PID)) || sessionOf(process.ppid) || sessionOf(grandparent());\n            /*SESSION_ID_GLOBAL*/ globalThis.__pwSessionId = sessionId;\n',
  },
  {
    marker: '/*SESSION_KEY*/',
    needle: '        const client = {\n          name: projectName || clientName,\n',
    replacement: '        const client = {\n          name: projectName || clientName,\n          /*SESSION_KEY*/ sessionKey: globalThis.__pwSessionId || (process.env.PW_MCP_PARENT_PID ? "claude-pid:" + process.env.PW_MCP_PARENT_PID : "pid:" + process.ppid),\n',
  },
  {
    // Each call runs in its agent's lane, and a dropped connection is re-established at once while
    // the session had pages open (so the extension hands them back), instead of on the next call.
    marker: '/*LANES_SERVER*/',
    start: '  const onClose = () => backendPromise?.then((b) => b.dispose?.()).catch(serverDebug);\n',
    end: '      const mergedResult = mergeTextParts(toolResult);\n',
    replacement: `  /*LANES_SERVER*/ let serverClosed = false;
  const onClose = () => {
    serverClosed = true;
    return backendPromise?.then((b) => b.dispose?.()).catch(serverDebug);
  };
  addServerListener(server, "close", onClose);
  // Claude Code sends each call's tool_use id as _meta["claudecode/toolUseId"]; the browser-lanes hook
  // wrote lane-ids/<id>.json with the agent that made the call (no file: another client, or a chat
  // started before the hook existed, so everything runs in the "main" lane as before lanes).
  const laneStore = globalThis.__pwLaneStore ??= new (require("async_hooks").AsyncLocalStorage)();
  const laneInfo = globalThis.__pwLaneInfo ??= new Map();
  const laneDir = process.env.PW_LANE_DIR || require("path").join(${ROOT_JS}, "lane-ids");
  const laneForCall = (meta) => {
    const id = meta?.["claudecode/toolUseId"];
    if (typeof id !== "string" || !/^[\\w-]{1,128}$/.test(id))
      return "main";
    const file = require("path").join(laneDir, id + ".json");
    try {
      const entry = JSON.parse(require("fs").readFileSync(file, "utf8"));
      require("fs").unlink(file, () => {
      });
      const lane = entry.agent ? String(entry.agent) : "main";
      if (lane !== "main" && entry.type)
        laneInfo.set(lane, { type: String(entry.type) });
      return lane;
    } catch {
      return "main";
    }
  };
  const isRealPage = (url) => /^(https?|file):/i.test(url || "");
  const ensureBackend = () => {
    if (!backendPromise) {
      const promise = initializeServer(server, factory, transportInitialized).then((backend2) => {
        backend2.on?.("dynamictoolschange", () => {
          if (backendPromise === promise)
            void server.sendToolListChanged().catch(serverDebug);
        });
        backend2.once("disconnected", () => {
          if (backendPromise === promise)
            backendPromise = void 0;
          void backend2.dispose?.().catch(serverDebug);
          if (globalThis.__pwHadRealPages && globalThis.__pwExtensionKeepsTabs && !serverClosed)
            void reconnectSoon();
        });
        // Does the extension in Brave keep a dropped session's tabs and hand them back (build 12+, the
        // one that knows playwright.groupTab)? Only then is reconnecting right away worth it; with an
        // older build it would just leave an empty connect page behind.
        void globalThis.__pwRelayModel?._sendToExtension("playwright.groupTab", [{ tabId: -1, name: "" }]).then(() => true, (e) => !/Unknown method/.test(String(e?.message))).then((keeps) => {
          globalThis.__pwExtensionKeepsTabs = keeps;
        });
        if (runHeartbeat && !heartbeatStarted) {
          heartbeatStarted = true;
          void transportInitialized.then(() => startHeartbeat(server));
        }
        return backend2;
      }).catch((e) => {
        if (backendPromise === promise)
          backendPromise = void 0;
        throw e;
      });
      backendPromise = promise;
    }
    return backendPromise;
  };
  // Only while the extension is connected to the broker: this must never fall through to launching
  // the browser exe (the browser on the user's screen). Gives up after a minute; the next call reconnects as before.
  let reconnecting = false;
  const reconnectSoon = async () => {
    if (reconnecting)
      return;
    reconnecting = true;
    try {
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2e3));
        if (serverClosed || backendPromise || !globalThis.__pwHadRealPages)
          return;
        const up = await fetch("http://127.0.0.1:" + (process.env.PW_MCP_BROKER_PORT || 8770) + "/status", { signal: AbortSignal.timeout(2e3) }).then((r) => r.json()).then((j) => j?.extension === true, () => false);
        if (!up)
          continue;
        await ensureBackend().catch(serverDebug);
        return;
      }
    } finally {
      reconnecting = false;
    }
  };
  // A subagent finished: the browser-lanes hook (SubagentStop) wrote lane-ids/done-<agent id>.json. The
  // session that had that agent closes its tabs (except kept ones); notices no session claims expire.
  const finishLanes = async () => {
    let files;
    try {
      files = require("fs").readdirSync(laneDir).filter((f) => f.startsWith("done-"));
    } catch {
      return;
    }
    if (!files.length)
      return;
    const context = backendPromise ? (await backendPromise.catch(() => null))?._context : void 0;
    for (const f of files) {
      const file = require("path").join(laneDir, f);
      let entry;
      try {
        entry = JSON.parse(require("fs").readFileSync(file, "utf8"));
      } catch {
        continue;
      }
      let done = Date.now() - (entry.at || 0) > 6e5;
      if (!done && context?.finishLane)
        done = await context.finishLane(String(entry.agent)).catch(() => false);
      if (done)
        require("fs").unlink(file, () => {
        });
    }
  };
  setInterval(() => void finishLanes().catch(serverDebug), 3e3).unref?.();
  server.setRequestHandler(CallToolRequestSchema, async (request2, extra) => {
    serverDebug("callTool", request2);
    try {
      const backend = await ensureBackend();
      const lane = laneForCall(request2.params._meta);
      globalThis.__pwLastLane = lane;
      // A browser_close that ends the connection (no other agent has tabs) must not trigger a reconnect.
      if (request2.params.name === "browser_close" && !(backend._context?._tabs ?? []).some((t) => t._lane !== void 0 && t._lane !== lane))
        globalThis.__pwHadRealPages = false;
      const toolResult = await laneStore.run({ lane }, () => backend.callTool(request2.params.name, request2.params.arguments || {}, extra.signal));
      try {
        backend._context?.closeSpareConnectPages?.();
        globalThis.__pwHadRealPages = (backend._context?._tabs ?? []).some((t) => isRealPage(t.page.url()));
      } catch {
      }
      // Tabs the user handed this agent (moved into its tab group) since its last call.
      const handed = await backend._context?.takeNotices?.(lane).catch(() => "");
      if (handed && Array.isArray(toolResult?.content))
        toolResult.content.push({ type: "text", text: handed });
`,
  },
];

for (const p of patches) {
  if (src.includes(p.marker)) continue;
  if (p.start) {
    // Range patch: replace from `start` up to (not including) the next `end`.
    const a = src.indexOf(p.start);
    const b = a < 0 ? -1 : src.indexOf(p.end, a);
    if (a < 0 || b < 0 || src.indexOf(p.start, a + 1) >= 0) {
      console.error(`${p.marker}: range anchors not found exactly once; Playwright changed, patch by hand`);
      process.exit(1);
    }
    src = src.slice(0, a) + p.replacement + src.slice(b);
    console.log('applied', p.marker);
    continue;
  }
  const found = src.split(p.needle).length - 1;
  if (!found && p.optional) continue;
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
