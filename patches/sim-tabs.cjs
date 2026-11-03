// Offline test of extension-bg/lib/background.mjs tab handling against a simulated Chromium browser (no real
// browser, nothing on screen). Covers who owns a new tab (the user vs agent), bounces, group membership,
// what the agent's MCP gets told, the "agent closed the tab the user was viewing" rule, lane sub-groups
// (playwright.groupTab) and orphaned sessions (grace period + re-adoption on reconnect).
//   node patches/sim-tabs.cjs [extension-dir]   (SIM_DISABLE_FIX=1: expect failures)
// extension-dir defaults to SIM_EXT_DIR, then PW_MCP_EXTENSION_OUT, then ./extension-bg (run patches/build-extension.cjs first).
// Chrome behaviour modelled: events are dispatched one at a time, in order (onCreated before the new
// tab's onActivated); a tab opened by a link from a grouped tab joins that group.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const EXT_DIR = path.resolve(process.argv[2] || process.env.SIM_EXT_DIR || process.env.PW_MCP_EXTENSION_OUT || path.join(__dirname, '..', 'extension-bg'));
const CODE = fs.readFileSync(path.join(EXT_DIR, 'lib', 'background.mjs'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeBrowser() {
  const queue = [];
  let pumping = false;
  const pump = () => {
    if (pumping) return;
    pumping = true;
    setTimeout(function next() {
      const item = queue.shift();
      if (!item) { pumping = false; return; }
      for (const l of [...item.ev.listeners]) { try { l(...item.args); } catch (e) { console.error('listener threw', e); } }
      setTimeout(next, 0);
    }, 0);
  };
  const Ev = () => {
    const ev = { listeners: [], addListener: (f) => ev.listeners.push(f), removeListener: (f) => { ev.listeners = ev.listeners.filter((x) => x !== f); }, hasListener: (f) => ev.listeners.includes(f) };
    ev.emit = (...args) => { queue.push({ ev, args }); pump(); };
    return ev;
  };
  const windows = new Map();
  const tabs = [];
  const groups = new Map();
  let nextTab = 100, nextGroup = 1, focusedWindow = 1;
  const attached = new Set();
  const focusCalls = [];
  const crossWindowMoves = [];
  const store = { session: {}, local: {} };
  const ev = { created: Ev(), activated: Ev(), updated: Ev(), removed: Ev(), focus: Ev(), winCreated: Ev() };
  const snap = (t) => ({ ...t, index: tabs.filter((x) => x.windowId === t.windowId).indexOf(t) });
  const tab = (id) => tabs.find((t) => t.id === id);
  const need = (id) => { const t = tab(id); if (!t) throw new Error('No tab with id: ' + id); return t; };
  function activate(id) {
    const t = need(id);
    if (t.active) return;
    for (const o of tabs) if (o.windowId === t.windowId) o.active = false;
    t.active = true;
    if (t.groupId >= 0) groups.get(t.groupId).collapsed = false;
    ev.activated.emit({ tabId: id, windowId: t.windowId });
  }
  function setGroup(id, groupId) {
    const t = need(id);
    if (t.groupId === groupId) return;
    const old = t.groupId;
    t.groupId = groupId;
    ev.updated.emit(id, { groupId }, snap(t));
    if (old >= 0 && !tabs.some((x) => x.groupId === old)) groups.delete(old);
  }
  function addTab({ windowId, url = 'https://example.com/', active = true, openerTabId, groupId = -1 }) {
    const t = { id: nextTab++, windowId, url, active: false, openerTabId, groupId, status: 'complete' };
    const at = openerTabId !== undefined && tab(openerTabId)?.windowId === windowId ? tabs.indexOf(tab(openerTabId)) + 1 : tabs.length;
    tabs.splice(at, 0, t);
    ev.created.emit({ ...snap(t), active });
    if (active) activate(t.id);
    return t.id;
  }
  function removeTab(id, { activationFirst = true } = {}) {
    const t = need(id);
    const siblings = tabs.filter((x) => x.windowId === t.windowId && x !== t);
    const next = t.active ? siblings[Math.min(tabs.filter((x) => x.windowId === t.windowId).indexOf(t), siblings.length - 1)] : null;
    const doRemove = () => {
      tabs.splice(tabs.indexOf(t), 1);
      attached.delete(id);
      ev.removed.emit(id, { windowId: t.windowId, isWindowClosing: false });
      if (t.groupId >= 0 && !tabs.some((x) => x.groupId === t.groupId)) groups.delete(t.groupId);
    };
    if (next && activationFirst) { t.active = false; activate(next.id); doRemove(); }
    else { doRemove(); if (next) activate(next.id); }
  }
  function focusWindow(id) { focusedWindow = id; for (const w of windows.values()) w.focused = w.id === id; ev.focus.emit(id); }
  const ok = (v) => Promise.resolve(v);
  const chrome = {
    tabs: {
      onCreated: ev.created, onActivated: ev.activated, onUpdated: ev.updated, onRemoved: ev.removed,
      get: async (id) => snap(need(id)),
      query: async (q = {}) => tabs.filter((t) => (q.active === undefined || t.active === q.active) && (q.windowId === undefined || t.windowId === q.windowId) && (q.groupId === undefined || t.groupId === q.groupId)).map(snap),
      update: async (id, props = {}) => { need(id); if (props.active) activate(id); return snap(need(id)); },
      create: async (opts = {}) => {
        const windowId = opts.windowId ?? focusedWindow;
        if (windows.get(windowId)?.type !== 'normal') throw new Error('Tabs can only be created in normal windows.');
        return snap(need(addTab({ windowId, url: opts.url, active: opts.active ?? true, openerTabId: opts.openerTabId, groupId: opts.openerTabId !== undefined ? tab(opts.openerTabId)?.groupId ?? -1 : -1 })));
      },
      remove: async (ids) => { for (const id of [ids].flat()) if (tab(id)) removeTab(id); },
      group: async ({ tabIds, groupId }) => {
        if (groupId === undefined) { groupId = nextGroup++; groups.set(groupId, { id: groupId, title: '', collapsed: false, color: 'grey', windowId: need([tabIds].flat()[0]).windowId }); }
        else if (!groups.has(groupId)) throw new Error('No group with id: ' + groupId);
        for (const id of [tabIds].flat()) {
          // Chrome moves a tab into the group's window (and it stops being that window's active tab).
          const t = need(id);
          if (t.windowId !== groups.get(groupId).windowId) { crossWindowMoves.push(id); t.windowId = groups.get(groupId).windowId; t.active = false; }
          setGroup(id, groupId);
        }
        return groupId;
      },
      ungroup: async (ids) => { for (const id of [ids].flat()) if (tab(id)) setGroup(id, -1); },
      // Chrome only moves tabs between normal windows and closes the window a move empties.
      move: async (id, { windowId }) => {
        const t = need(id);
        if (windows.get(t.windowId)?.type !== 'normal' || windows.get(windowId)?.type !== 'normal') throw new Error('Tabs can only be moved to and from normal windows.');
        const from = t.windowId;
        t.windowId = windowId; t.active = false;
        tabs.splice(tabs.indexOf(t), 1); tabs.push(t);
        if (!tabs.some((x) => x.windowId === from)) windows.delete(from);
        return snap(t);
      },
    },
    tabGroups: {
      get: async (id) => { if (!groups.has(id)) throw new Error('No group with id: ' + id); return { ...groups.get(id) }; },
      query: async () => [...groups.values()].map((g) => ({ ...g })),
      update: async (id, props) => {
        const g = groups.get(id);
        if (!g) throw new Error('No group');
        Object.assign(g, props);
        // Collapsing a group that holds the active tab moves Brave to a tab outside it.
        const act = tabs.find((t) => t.windowId === g.windowId && t.active);
        if (props.collapsed && act?.groupId === id) { const out = tabs.find((t) => t.windowId === g.windowId && t.groupId !== id); if (out) activate(out.id); }
        return { ...g };
      },
    },
    windows: {
      WINDOW_ID_NONE: -1, onFocusChanged: ev.focus, onCreated: ev.winCreated, onRemoved: Ev(),
      get: async (id) => { if (!windows.has(id)) throw new Error('No window with id: ' + id); return { ...windows.get(id) }; },
      getAll: async ({ windowTypes } = {}) => [...windows.values()].filter((w) => !windowTypes || windowTypes.includes(w.type)).map((w) => ({ ...w })),
      create: async ({ url, focused = true, state = 'normal' } = {}) => {
        const id = Math.max(0, ...windows.keys()) + 1;
        windows.set(id, { id, type: 'normal', focused, state });
        ev.winCreated.emit({ ...windows.get(id) });
        if (focused) { focusCalls.push(id); focusWindow(id); }
        return { ...windows.get(id), tabs: [snap(need(addTab({ windowId: id, url })))] };
      },
      getLastFocused: async () => ({ ...windows.get(focusedWindow) }),
      update: async (id, props) => { if (props.focused) focusCalls.push(id); const w = windows.get(id); Object.assign(w, props); if (props.state === 'minimized') { w.focused = false; } if (props.focused) focusWindow(id); return { ...w }; },
    },
    debugger: {
      onEvent: Ev(), onDetach: Ev(),
      attach: async ({ tabId }) => { need(tabId); attached.add(tabId); },
      detach: async ({ tabId }) => { attached.delete(tabId); },
      sendCommand: async () => ({}),
      getTargets: async () => [...attached].filter(tab).map((tabId) => ({ tabId, attached: true, type: 'page' })),
    },
    storage: Object.fromEntries(['session', 'local'].map((area) => [area, {
      get: async (k) => (typeof k === 'string' ? { [k]: store[area][k] } : Object.fromEntries([k].flat().map((x) => [x, store[area][x]]))),
      set: async (o) => { Object.assign(store[area], JSON.parse(JSON.stringify(o))); },
    }])),
    alarms: { create() {}, clear() {}, onAlarm: Ev() },
    runtime: { onMessage: Ev(), onStartup: Ev(), getURL: (p) => 'chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/' + p, reload() {} },
    action: { onClicked: Ev(), setBadgeText: ok, setTitle: ok, setBadgeBackgroundColor: ok },
  };
  return { chrome, windows, tabs, groups, attached, focusCalls, crossWindowMoves, tab, addTab, removeTab, activate, focusWindow, store };
}

// The MCP server end of a relay connection: answers commands, records the tabs it is told about
// (chrome.tabs.onCreated) and auto-attaches to them like the real server.
function makeMcp() {
  const sess = { told: new Set(), created: new Map(), detached: [], pending: new Map(), nextId: 1, ws: null };
  sess.onSend = (raw) => {
    const m = JSON.parse(raw);
    if (m.id !== undefined && sess.pending.has(m.id)) { sess.pending.get(m.id)(m); sess.pending.delete(m.id); return; }
    if (m.method === 'chrome.tabs.onCreated') { sess.told.add(m.params[0].id); sess.created.set(m.params[0].id, m.params[0]); sess.mcp('chrome.debugger.attach', [{ tabId: m.params[0].id }, '1.3']); }
    if (m.method === 'chrome.debugger.onDetach') sess.detached.push(m.params[0]?.tabId);
  };
  sess.mcp = (method, params) => new Promise((resolve) => { const id = sess.nextId++; sess.pending.set(id, resolve); sess.ws.onmessage({ data: JSON.stringify({ id, method, params }) }); });
  return sess;
}

async function setup({ session = true } = {}) {
  const b = makeBrowser();
  b.windows.set(1, { id: 1, type: 'normal', focused: true, state: 'normal' });
  const U1 = b.addTab({ windowId: 1, url: 'https://mail.example/' });
  const U2 = b.addTab({ windowId: 1, url: 'https://news.example/', active: false });
  // ws://sim/<n> sockets are relay connections to a simulated MCP server (s.connect); every other URL
  // (the broker) never opens.
  const simRelays = new Map();
  class FakeWS {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 3;
    constructor(url) {
      this.readyState = 0;
      const sess = simRelays.get(url);
      if (!sess) return;
      sess.ws = this;
      this.send = (raw) => sess.onSend(raw);
      setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0);
    }
    send() {} close() { this.readyState = 3; }
  }
  const ctx = vm.createContext({ chrome: b.chrome, console: { log() {}, error: console.error, warn() {} }, setTimeout, clearTimeout, setInterval: () => 0, WebSocket: FakeWS, URL, URLSearchParams, Promise, Date, JSON, Math, Map, Set, Error, String });
  vm.runInContext(CODE, ctx, { filename: 'background.mjs' });
  // SIM_DISABLE_FIX=1: treat every tab opened from an agent tab as the agent's (the old behaviour),
  // to check the scenarios still catch the original bug.
  if (process.env.SIM_DISABLE_FIX) ctx.isUserOpenedTab = () => false;
  await sleep(30);
  const isAgent = async (id) => (await ctx.agentTabIds()).has(id);
  const active = () => b.tabs.find((t) => t.windowId === 1 && t.active)?.id;
  // A session that connects the way the connect page does (connectionRequested, then connectToTab with
  // ?client={"name","sessionKey"} in the page URL), through PlaywrightExtension._onMessage.
  let relays = 0;
  const connect = async ({ clientName = 'sim', sessionKey } = {}) => {
    const sess = makeMcp();
    const relayUrl = 'ws://sim/' + ++relays;
    simRelays.set(relayUrl, sess);
    const client = JSON.stringify({ name: clientName, ...(sessionKey ? { sessionKey } : {}) });
    const page = await ctx.openConnectPage(b.chrome.runtime.getURL('connect.html') + '?mcpRelayUrl=' + encodeURIComponent(relayUrl) + '&client=' + encodeURIComponent(client));
    const ext = ctx.playwrightExtension;
    await new Promise((r) => ext._onMessage({ type: 'connectionRequested', mcpRelayUrl: relayUrl }, { tab: page, url: page.url }, r));
    const tab = await b.chrome.tabs.get(page.id);
    const res = await new Promise((r) => ext._onMessage({ type: 'connectToTab', clientName }, { tab, url: tab.url }, r));
    if (!res?.success) throw new Error('connect failed: ' + res?.error);
    await sleep(80);
    sess.page = page.id;
    sess.group = [...ext._connections.values()].pop();
    sess.drop = () => sess.ws.onclose(); // the socket closes (MCP child restart, extension reload, network)
    return sess;
  };
  if (!session) return { b, ctx, U1, U2, isAgent, active, connect };
  // An agent session: connect page in the background, a relay connection, the MCP auto-attaching.
  const sess = makeMcp();
  const { told, mcp } = sess;
  const ws = { readyState: 1, close() {}, send: (raw) => sess.onSend(raw) };
  sess.ws = ws;
  const connectTab = await ctx.openConnectPage(b.chrome.runtime.getURL('connect.html') + '?mcpRelayUrl=x');
  const conn = new ctx.RelayConnection(ws);
  new ctx.ConnectedTabGroup(conn, connectTab, 'sim', { title: '🤖 sim', color: 'green' }, () => false);
  await sleep(60);
  const A1 = connectTab.id;
  const A2 = (await mcp('chrome.tabs.create', [{ url: 'https://agent2.example/' }])).result.id;
  await mcp('chrome.debugger.attach', [{ tabId: A2 }, '1.3']);
  await sleep(60);
  return { b, ctx, U1, U2, A1, A2, told, mcp, isAgent, active, conn, connect };
}

const results = [];
async function scenario(name, fn, opts) {
  const failures = [];
  const expect = (cond, msg) => { if (!cond) failures.push(msg); };
  try {
    const s = await setup(opts);
    await fn(s, expect);
    // The extension must never focus a Brave window: on Windows that raises Brave over the user's app.
    expect(!s.b.focusCalls.length, `extension focused window(s) ${s.b.focusCalls}`);
  } catch (e) { failures.push('threw: ' + e.stack); }
  results.push({ name, failures });
  console.log(`${failures.length ? 'FAIL' : 'ok  '}  ${name}${failures.map((f) => '\n        - ' + f).join('')}`);
}

const keepAlive = setInterval(() => {}, 1000);
(async () => {
  await scenario('setup: agent tabs are background, grouped, collapsed; the user stays on their tab', async (s, expect) => {
    expect(s.active() === s.U1, `active is ${s.active()}, expected the user's tab ${s.U1}`);
    const g = s.b.tab(s.A1).groupId;
    expect(g >= 0 && s.b.tab(s.A2).groupId === g, 'agent tabs not in one group');
    expect(s.b.groups.get(g)?.collapsed && s.b.groups.get(g)?.title === '🤖 sim', 'group not collapsed/titled');
  });

  const userOpensFromAgentTab = async (s, { active, grouped = true }) => {
    s.b.activate(s.A1); // The user opens the agent tab to review it (group expands)
    await sleep(80);
    const n = s.b.addTab({ windowId: 1, openerTabId: s.A1, active, groupId: grouped ? s.b.tab(s.A1).groupId : -1, url: 'https://terms.example/' });
    await sleep(400);
    return n;
  };
  const expectUserOwns = async (s, expect, n) => {
    expect(!(await s.isAgent(n)), 'new tab was adopted as an agent tab');
    expect(!s.told.has(n), 'agent MCP was told about the new tab');
    expect(!s.b.attached.has(n), 'debugger attached to the new tab');
    expect(s.b.tab(n)?.groupId === -1, `new tab still in group ${s.b.tab(n)?.groupId}`);
  };

  await scenario('The user clicks a target=_blank link in an agent tab they are viewing: they land on it, agent never sees it', async (s, expect) => {
    const n = await userOpensFromAgentTab(s, { active: true });
    expect(s.active() === n, `bounced: active is ${s.active()}, expected new tab ${n}`);
    await expectUserOwns(s, expect, n);
    expect(s.ctx.lastUserTab.get(1) === n, 'new tab not remembered as the user\'s last tab');
  });

  await scenario('The user middle-clicks a link in an agent tab: background tab is theirs, they stay put', async (s, expect) => {
    const n = await userOpensFromAgentTab(s, { active: false });
    expect(s.active() === s.A1, `active changed to ${s.active()}`);
    await expectUserOwns(s, expect, n);
  });

  await scenario('The user presses Ctrl+T while viewing an agent tab: new tab is their', async (s, expect) => {
    const n = await userOpensFromAgentTab(s, { active: true, grouped: false });
    expect(s.active() === n, `bounced to ${s.active()}`);
    await expectUserOwns(s, expect, n);
  });

  await scenario('a link opened from that tab is also their (no spreading)', async (s, expect) => {
    const n = await userOpensFromAgentTab(s, { active: true });
    const m = s.b.addTab({ windowId: 1, openerTabId: n, active: true });
    await sleep(400);
    expect(s.active() === m, `bounced to ${s.active()}`);
    await expectUserOwns(s, expect, m);
  });

  await scenario('The user clicks a target=_blank link in their own tab: nothing interferes', async (s, expect) => {
    const n = s.b.addTab({ windowId: 1, openerTabId: s.U1, active: true });
    await sleep(400);
    expect(s.active() === n, `bounced to ${s.active()}`);
    await expectUserOwns(s, expect, n);
  });

  await scenario('agent page pops a foreground tab (window.open from hidden tab): The user is put back, agent owns it', async (s, expect) => {
    const n = s.b.addTab({ windowId: 1, openerTabId: s.A2, active: true, groupId: s.b.tab(s.A2).groupId });
    await sleep(400);
    expect(s.active() === s.U1, `The user left on ${s.active()}, expected ${s.U1}`);
    expect(await s.isAgent(n), 'popup not adopted');
    expect(s.told.has(n) && s.b.attached.has(n), 'agent MCP did not get the popup');
    expect(s.b.tab(n).groupId === s.b.tab(s.A2).groupId, 'popup not in agent group');
  });

  await scenario('agent page pops a background tab: nothing moves, agent owns it', async (s, expect) => {
    const n = s.b.addTab({ windowId: 1, openerTabId: s.A2, active: false, groupId: s.b.tab(s.A2).groupId });
    await sleep(400);
    expect(s.active() === s.U1, `active changed to ${s.active()}`);
    expect(await s.isAgent(n) && s.told.has(n), 'popup not adopted/told');
  });

  for (const userInBrave of [true, false]) {
    await scenario(`agent page opens a popup window while the user is ${userInBrave ? 'in Brave' : 'in another app'}: minimized, no window focused`, async (s, expect) => {
      if (!userInBrave) { s.b.windows.get(1).focused = false; s.b.chrome.windows.onFocusChanged.emit(-1); await sleep(50); }
      s.b.windows.set(2, { id: 2, type: 'popup', focused: false, state: 'normal' });
      const n = s.b.addTab({ windowId: 2, openerTabId: s.A2, active: true });
      if (userInBrave) s.b.focusWindow(2);
      await sleep(400);
      expect(s.b.windows.get(2).state === 'minimized', 'popup window not minimized');
      expect(s.active() === s.U1, `The user's tab changed to ${s.active()}`);
      expect(await s.isAgent(n) && s.told.has(n), 'popup not adopted/told');
    });
  }

  // Real Brave (measured): window.open from a hidden agent tab sends Page.windowOpen from
  // that tab first, then creates the tab with openerTabId = the user's active tab, active, next to their tab.
  const agentWindowOpen = (s, from, url) => s.b.chrome.debugger.onEvent.emit({ tabId: from }, 'Page.windowOpen', { url, windowName: 'oauth', userGesture: true });

  await scenario('agent window.open whose new tab claims the user\'s tab as opener: The user put back, agent owns it', async (s, expect) => {
    agentWindowOpen(s, s.A2, 'https://accounts.example/o/oauth2');
    const n = s.b.addTab({ windowId: 1, openerTabId: s.U1, active: true, url: 'https://accounts.example/o/oauth2' });
    await sleep(400);
    expect(s.active() === s.U1, `The user left on ${s.active()}, expected ${s.U1}`);
    expect(await s.isAgent(n), 'tab not adopted');
    expect(s.told.has(n) && s.b.attached.has(n), 'agent MCP did not get the tab');
    expect(s.b.tab(n).groupId === s.b.tab(s.A2).groupId, `tab not in agent group (group ${s.b.tab(n).groupId})`);
  });

  await scenario('The user clicks a target=_blank link in an agent tab they are viewing (Page.windowOpen from it): still their', async (s, expect) => {
    s.b.activate(s.A1);
    await sleep(80);
    agentWindowOpen(s, s.A1, 'https://terms.example/');
    const n = s.b.addTab({ windowId: 1, openerTabId: s.A1, active: true, url: 'https://terms.example/' });
    await sleep(400);
    expect(s.active() === n, `bounced: active is ${s.active()}, expected new tab ${n}`);
    await expectUserOwns(s, expect, n);
  });

  await scenario('agent window.open popup window claiming the user\'s tab, the user in another app: minimized and adopted', async (s, expect) => {
    s.b.windows.get(1).focused = false; s.b.chrome.windows.onFocusChanged.emit(-1); await sleep(50);
    s.b.windows.set(2, { id: 2, type: 'popup', focused: false, state: 'normal' });
    agentWindowOpen(s, s.A2, 'https://appleid.example/auth');
    const n = s.b.addTab({ windowId: 2, openerTabId: s.U1, active: true, url: 'https://appleid.example/auth' });
    await sleep(400);
    expect(s.b.windows.get(2)?.state === 'minimized', 'popup window not minimized');
    expect(await s.isAgent(n) && s.told.has(n), 'popup not adopted/told');
  });

  await scenario('agent page opens a normal window: its tab joins the agent group, the window goes away', async (s, expect) => {
    s.b.windows.set(2, { id: 2, type: 'normal', focused: false, state: 'normal' });
    agentWindowOpen(s, s.A2, 'https://share.example/');
    const n = s.b.addTab({ windowId: 2, openerTabId: s.U1, active: true, url: 'https://share.example/' });
    await sleep(400);
    expect(!s.b.windows.has(2), 'new window still open');
    expect(s.b.tab(n)?.windowId === 1, `tab is in window ${s.b.tab(n)?.windowId}`);
    expect(s.b.tab(n)?.groupId === s.b.tab(s.A2).groupId, 'tab not in agent group');
    expect(s.active() === s.U1, `The user's tab changed to ${s.active()}`);
  });

  // popups-as-tabs.js: a hidden agent page's window.open logs the URL instead of opening anything.
  const MARKER = '[agent] window.open blocked; opened in a background tab instead (see browser_tabs):';
  const agentLogsOpen = (s, from, url) => s.b.chrome.debugger.onEvent.emit({ tabId: from }, 'Runtime.consoleAPICalled', { type: 'debug', args: [{ type: 'string', value: MARKER }, { type: 'string', value: url }] });

  await scenario('hidden agent page calls window.open: background tab in the agent group, nothing in front', async (s, expect) => {
    const before = s.b.tabs.length;
    const activations = [];
    s.b.chrome.tabs.onActivated.addListener(({ tabId }) => activations.push(tabId));
    agentLogsOpen(s, s.A2, 'https://accounts.example/signin');
    await sleep(400);
    const n = s.b.tabs.find((t) => t.url === 'https://accounts.example/signin')?.id;
    expect(n !== undefined && s.b.tabs.length === before + 1, 'background tab not opened');
    expect(!activations.length, `tabs were activated: ${activations}`);
    expect(s.active() === s.U1, `The user's tab changed to ${s.active()}`);
    expect(await s.isAgent(n) && s.told.has(n) && s.b.attached.has(n), 'agent MCP did not get the tab');
    expect(s.b.tab(n)?.groupId === s.b.tab(s.A2).groupId, 'tab not in agent group');
  });

  await scenario('marker from a non-http URL or another console message: nothing opens', async (s, expect) => {
    const before = s.b.tabs.length;
    agentLogsOpen(s, s.A2, 'javascript:alert(1)');
    s.b.chrome.debugger.onEvent.emit({ tabId: s.A2 }, 'Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: MARKER }, { type: 'string', value: 'https://x.example/' }] });
    await sleep(300);
    expect(s.b.tabs.length === before, 'a tab was opened');
  });

  await scenario('agent tab in a minimized sign-in popup calls window.open: tab goes to the normal window, agent gets it', async (s, expect) => {
    s.b.windows.set(2, { id: 2, type: 'popup', focused: false, state: 'minimized' });
    const p = s.b.addTab({ windowId: 2, openerTabId: s.A2, active: true });
    await sleep(300);
    agentLogsOpen(s, p, 'https://next.example/');
    await sleep(400);
    const n = s.b.tabs.find((t) => t.url === 'https://next.example/')?.id;
    expect(s.b.tab(n)?.windowId === 1, `tab in window ${s.b.tab(n)?.windowId}`);
    expect(s.told.has(n), 'agent MCP did not get the tab');
    expect(s.active() === s.U1, `The user's tab changed to ${s.active()}`);
  });

  await scenario('agent tab in a sign-in popup, agent opens a new tab: it goes to the user\'s normal window', async (s, expect) => {
    s.b.windows.set(2, { id: 2, type: 'popup', focused: false, state: 'minimized' });
    const p = s.b.addTab({ windowId: 2, openerTabId: s.A2, active: true });
    await sleep(300);
    // Only the popup tab stays attached (the others closed), so it decides the window.
    s.conn._attachedTabs = new Set([p]);
    const r = await s.mcp('chrome.tabs.create', [{ url: 'https://agent4.example/' }]);
    expect(!r.error, `create failed: ${r.error}`);
    expect(s.b.tab(r.result?.id)?.windowId === 1, `new tab in window ${s.b.tab(r.result?.id)?.windowId}`);
  });

  for (const activationFirst of [true, false]) {
    await scenario(`agent closes the tab the user is viewing (${activationFirst ? 'activation' : 'removal'} event first): they go back to their own tab`, async (s, expect) => {
      s.b.activate(s.U2);
      await sleep(80);
      s.b.activate(s.A2);
      await sleep(80);
      await s.mcp('chrome.tabs.remove', [s.A2]).catch(() => {});
      await sleep(600);
      expect(s.active() === s.U2, `active is ${s.active()}, expected the user's last tab ${s.U2}`);
    });
  }

  await scenario('another agent closes a background tab while the user opens an agent tab: they stay on it', async (s, expect) => {
    s.b.activate(s.A1);
    s.b.removeTab(s.A2); // background agent tab closed by its session at the same moment
    await sleep(600);
    expect(s.active() === s.A1, `moved to ${s.active()}`);
  });

  // 10) Groups close when the agent is done (events only, DONE_CHECK_MS shortened to 50 ms for the sim).
  const groupTabs = (s) => s.b.tabs.filter((t) => t.groupId >= 0 && t.groupId === s.b.tab(s.A1)?.groupId).map((t) => t.id);

  await scenario('agent closes its work tab, only the connect page is left: the whole group closes', async (s, expect) => {
    s.ctx.DONE_CHECK_MS = 50;
    await s.mcp('chrome.tabs.remove', [s.A2]);
    await sleep(300);
    expect(!s.b.tab(s.A1), 'connect page still open');
    expect(s.active() === s.U1, `The user's tab changed to ${s.active()}`);
    expect(s.b.tab(s.U1) && s.b.tab(s.U2), 'The user\'s tabs were closed');
  });

  await scenario('agent navigates its last real tab to about:blank: the group closes', async (s, expect) => {
    s.ctx.DONE_CHECK_MS = 50;
    await s.mcp('chrome.tabs.remove', [s.A1]);
    await sleep(100);
    const t = s.b.tab(s.A2); t.url = 'about:blank';
    s.b.chrome.tabs.onUpdated.emit(s.A2, { url: 'about:blank' }, { ...t });
    await sleep(300);
    expect(!s.b.tab(s.A2), 'blank agent tab still open');
  });

  await scenario('a group with a real page left stays open (agent may still need it)', async (s, expect) => {
    s.ctx.DONE_CHECK_MS = 50;
    await s.mcp('chrome.tabs.remove', [s.A1]);
    await sleep(300);
    expect(!!s.b.tab(s.A2), 'agent\'s real page was closed');
  });

  await scenario('agent still working (command within the window): the group is not closed', async (s, expect) => {
    s.ctx.DONE_CHECK_MS = 300;
    s.b.tab(s.A2).url = 'about:blank';
    await s.mcp('chrome.tabs.remove', [s.A1]);
    await s.mcp('chrome.debugger.sendCommand', [{ tabId: s.A2 }, 'Runtime.evaluate', { expression: '1' }]);
    await sleep(150);
    await s.mcp('chrome.debugger.sendCommand', [{ tabId: s.A2 }, 'Page.navigate', { url: 'https://work.example/' }]);
    const t = s.b.tab(s.A2); t.url = 'https://work.example/';
    s.b.chrome.tabs.onUpdated.emit(s.A2, { url: t.url }, { ...t });
    await sleep(1000);
    expect(!!s.b.tab(s.A2), 'tab closed while the agent was using it');
  });

  await scenario('agent goes to about:blank, the MCP reads the page back right after: group still closes once quiet', async (s, expect) => {
    s.ctx.DONE_CHECK_MS = 200;
    await s.mcp('chrome.tabs.remove', [s.A1]);
    const t = s.b.tab(s.A2); t.url = 'about:blank';
    s.b.chrome.tabs.onUpdated.emit(s.A2, { url: 'about:blank' }, { ...t });
    for (let i = 0; i < 3; i++) { await sleep(100); await s.mcp('chrome.debugger.sendCommand', [{ tabId: s.A2 }, 'Accessibility.getFullAXTree', {}]); }
    await sleep(150);
    expect(!!s.b.tab(s.A2), 'closed while the MCP was still reading the page');
    await sleep(700);
    expect(!s.b.tab(s.A2), 'blank group never closed after the agent went quiet');
  });

  // 13) A connect page nobody uses closes once the session has a real page (CONNECT_PAGE_IDLE_MS shortened).
  const navigate = (s, id, url) => { const t = s.b.tab(id); t.url = url; s.b.chrome.tabs.onUpdated.emit(id, { url }, { ...t }); };

  await scenario('connect page left idle while the agent works in another tab: it closes, the work tab stays', async (s, expect) => {
    s.ctx.CONNECT_PAGE_IDLE_MS = 50;
    s.ctx.DONE_CHECK_MS = 50;
    navigate(s, s.A2, 'https://work.example/');
    await sleep(400);
    expect(!s.b.tab(s.A1), 'connect page still open');
    expect(!!s.b.tab(s.A2), 'work tab was closed');
    expect(s.active() === s.U1, `The user's tab changed to ${s.active()}`);
  });

  await scenario('connect page on the user\'s screen: stays while they look, closes once they leave it', async (s, expect) => {
    s.ctx.CONNECT_PAGE_IDLE_MS = 50;
    s.ctx.DONE_CHECK_MS = 1e5;
    s.b.activate(s.A1);
    await sleep(80);
    navigate(s, s.A2, 'https://work.example/');
    await sleep(400);
    expect(!!s.b.tab(s.A1), 'connect page closed under the user');
    s.b.activate(s.U1);
    await sleep(400);
    expect(!s.b.tab(s.A1), 'connect page still open after the user left it');
    expect(!!s.b.tab(s.A2), 'work tab was closed');
  });

  await scenario('connect page with no real page in the session yet: stays', async (s, expect) => {
    s.ctx.CONNECT_PAGE_IDLE_MS = 50;
    s.ctx.DONE_CHECK_MS = 1e5;
    navigate(s, s.A2, 'about:blank');
    const r = await s.mcp('chrome.tabs.create', [{ url: 'about:blank' }]);
    await s.mcp('chrome.debugger.attach', [{ tabId: r.result.id }, '1.3']);
    await sleep(400);
    expect(!!s.b.tab(s.A1), 'connect page closed although the agent has no real page');
  });

  await scenario('connect page the agent still sends commands to: waits, closes once quiet', async (s, expect) => {
    s.ctx.CONNECT_PAGE_IDLE_MS = 200;
    s.ctx.DONE_CHECK_MS = 1e5;
    navigate(s, s.A2, 'https://work.example/');
    for (let i = 0; i < 4; i++) { await sleep(100); await s.mcp('chrome.debugger.sendCommand', [{ tabId: s.A1 }, 'Runtime.evaluate', { expression: '1' }]); }
    expect(!!s.b.tab(s.A1), 'closed while the agent was using it');
    await sleep(900);
    expect(!s.b.tab(s.A1), 'never closed after the agent went quiet');
  });

  await scenario('agent navigates the connect page itself to its work: nothing closes', async (s, expect) => {
    s.ctx.CONNECT_PAGE_IDLE_MS = 50;
    s.ctx.DONE_CHECK_MS = 50;
    navigate(s, s.A1, 'https://work.example/');
    await sleep(400);
    expect(!!s.b.tab(s.A1) && !!s.b.tab(s.A2), 'a work tab was closed');
  });

  // 12) A dropped session's tabs stay grouped and collapsed for ORPHAN_GRACE_MS (shortened for the sim),
  //     then close like a disconnect did before (12).
  await scenario('session disconnects: its tabs stay grouped during the grace period, then every tab in its group closes, including adopted popups', async (s, expect) => {
    s.ctx.ORPHAN_GRACE_MS = s.ctx.STARTUP_ORPHAN_GRACE_MS = 400;
    agentWindowOpen(s, s.A2, 'https://popup.example/');
    const n = s.b.addTab({ windowId: 1, openerTabId: s.U1, active: true, url: 'https://popup.example/' });
    await sleep(300);
    s.ctx.agentTabMemory.delete(n); // e.g. adopted before an extension reload: not in the remembered set
    await s.ctx.saveAgentTabIds([...s.ctx.agentTabMemory].filter((id) => id !== n));
    const g = s.b.tab(s.A1).groupId;
    s.conn.close('test');
    await sleep(150);
    expect([s.A1, s.A2, n].every((id) => s.b.tab(id)?.groupId === g), `not all still in the group during grace: ${[s.A1, s.A2, n].map((id) => s.b.tab(id)?.groupId)}`);
    expect(s.b.groups.get(g)?.collapsed, 'group expanded during grace');
    await sleep(500);
    expect(!s.b.tab(s.A1) && !s.b.tab(s.A2) && !s.b.tab(n), `group tabs left after grace: ${[s.A1, s.A2, n].filter((id) => s.b.tab(id))}`);
    expect(s.b.tab(s.U1) && s.b.tab(s.U2), 'The user\'s tabs were closed');
  });

  await scenario('session disconnects while the user is looking at one of its tabs: after the grace period that tab stays, ungrouped', async (s, expect) => {
    s.ctx.ORPHAN_GRACE_MS = s.ctx.STARTUP_ORPHAN_GRACE_MS = 200;
    s.b.activate(s.A2);
    await sleep(80);
    s.conn.close('test');
    await sleep(500);
    expect(!s.b.tab(s.A1), 'other group tab not closed');
    expect(s.b.tab(s.A2)?.groupId === -1, `tab the user is viewing: ${s.b.tab(s.A2) ? 'group ' + s.b.tab(s.A2).groupId : 'closed'}`);
    expect(s.active() === s.A2, `The user moved to ${s.active()}`);
  });

  await scenario('extension start: left-over 🤖 groups wait out the grace period, then close (active tab kept, ungrouped)', async (s, expect) => {
    s.ctx.ORPHAN_GRACE_MS = s.ctx.STARTUP_ORPHAN_GRACE_MS = 300;
    const o1 = s.b.addTab({ windowId: 1, url: 'https://old1.example/', active: false });
    const o2 = s.b.addTab({ windowId: 1, url: 'https://old2.example/', active: false });
    const g = await s.b.chrome.tabs.group({ tabIds: [o1, o2] });
    await s.b.chrome.tabGroups.update(g, { title: '🤖 old session' });
    s.b.activate(o2); // The user happens to be on one of them
    await sleep(80);
    await s.ctx.cleanupStalePlaywrightGroups();
    await sleep(100);
    expect(s.b.tab(o1)?.groupId === g && s.b.tab(o2)?.groupId === g, 'left-over tabs closed/ungrouped before the grace period ended');
    await sleep(400);
    expect(!s.b.tab(o1), 'left-over tab not closed');
    expect(s.b.tab(o2)?.groupId === -1, `active left-over tab: ${s.b.tab(o2) ? 'group ' + s.b.tab(o2).groupId : 'closed'}`);
    expect(s.b.tab(s.U1) && s.b.tab(s.U2), 'The user\'s tabs were closed');
  });

  // 11) Lanes: named sub-groups per connection (playwright.groupTab). Every lane scenario also checks that
  //     no tab was activated (the user's tab never changes) besides what the test itself did as the user.
  const gOf = (s, id) => s.b.tab(id)?.groupId;
  const gInfo = (s, id) => s.b.groups.get(gOf(s, id));
  const newLaneTab = async (s, mcp = s.mcp, url = 'https://lane.example/') => {
    const r = await mcp('chrome.tabs.create', [{ url }]);
    await mcp('chrome.debugger.attach', [{ tabId: r.result.id }, '1.3']);
    await sleep(60);
    return r.result.id;
  };
  const laneScenario = (name, fn, opts) => scenario(name, async (s, expect) => {
    const acts = [];
    s.expectActive = s.U1;
    s.userViews = async (id) => { s.b.activate(id); await sleep(80); s.expectActive = id; acts.length = 0; };
    s.b.chrome.tabs.onActivated.addListener(({ tabId }) => acts.push(tabId));
    await fn(s, expect);
    await sleep(50);
    expect(!acts.length, `tabs were activated: ${acts}`);
    expect(s.active() === s.expectActive, `The user's tab changed to ${s.active()}, expected ${s.expectActive}`);
  }, opts);
  const notOurs = (id) => `Tab ${id} is not one of this session's tabs`;

  await laneScenario('lanes 1: groupTab puts a tab in a new collapsed sub-group "🤖 sim · Research" with its own color; still attached', async (s, expect) => {
    const r = await s.mcp('playwright.groupTab', [{ tabId: s.A2, name: '  Research ' }]);
    await sleep(100);
    const g = gInfo(s, s.A2), main = gInfo(s, s.A1);
    expect(!r.error, `groupTab failed: ${r.error}`);
    expect(r.result?.title === '🤖 sim · Research' && r.result?.groupId === g?.id, `result ${JSON.stringify(r.result)}`);
    expect(g?.title === '🤖 sim · Research' && g.id !== main?.id, `tab in group "${g?.title}"`);
    expect(g?.collapsed, 'sub-group not collapsed');
    expect(g?.color !== main?.color, `sub-group color ${g?.color} = main color`);
    expect(main?.title === '🤖 sim' && main.collapsed, 'main group changed');
    expect(s.conn.attachedTabs.has(s.A2) && s.b.attached.has(s.A2), 'tab no longer attached');
    expect(await s.ctx.isAgentTab(s.A2), 'not an agent tab any more');
    const b1 = await newLaneTab(s);
    const r2 = await s.mcp('playwright.groupTab', [{ tabId: b1, name: 'Mail' }]);
    await sleep(100);
    expect(r2.result?.title === '🤖 sim · Mail' && gInfo(s, b1)?.title === '🤖 sim · Mail', `second sub-group: ${gInfo(s, b1)?.title}`);
    expect(![main?.color, g?.color].includes(gInfo(s, b1)?.color), `second sub-group color ${gInfo(s, b1)?.color} not distinct`);
    const long = 'x'.repeat(60);
    const r3 = await s.mcp('playwright.groupTab', [{ tabId: b1, name: long }]);
    expect(r3.result?.title === '🤖 sim · ' + 'x'.repeat(39) + '…', `long name title ${r3.result?.title}`);
  });

  await laneScenario('lanes 2: groupTab "" (or no name) moves the tab back to the main group', async (s, expect) => {
    await s.mcp('playwright.groupTab', [{ tabId: s.A2, name: 'Research' }]);
    const r = await s.mcp('playwright.groupTab', [{ tabId: s.A2, name: '' }]);
    await sleep(100);
    expect(!r.error && r.result?.title === '🤖 sim', `result ${JSON.stringify(r)}`);
    expect(gOf(s, s.A2) === gOf(s, s.A1) && r.result?.groupId === gOf(s, s.A1), `tab in group ${gInfo(s, s.A2)?.title}`);
    expect(![...s.b.groups.values()].some((g) => g.title === '🤖 sim · Research'), 'emptied sub-group still there');
    expect(gInfo(s, s.A1)?.collapsed, 'main group expanded');
    expect(s.b.attached.has(s.A2), 'tab detached');
    await s.mcp('playwright.groupTab', [{ tabId: s.A2, name: 'Research' }]);
    const r2 = await s.mcp('playwright.groupTab', [{ tabId: s.A2 }]);
    await sleep(100);
    expect(r2.result?.title === '🤖 sim' && gOf(s, s.A2) === gOf(s, s.A1), 'missing name did not mean the main group');
  });

  await laneScenario('lanes 3: groupTab on a tab that is not this session\'s: error, nothing changes', async (s, expect) => {
    const state = () => JSON.stringify([[...s.b.groups.values()], s.b.tabs.map((t) => [t.id, t.groupId])]);
    const before = state();
    const r = await s.mcp('playwright.groupTab', [{ tabId: s.U2, name: 'Research' }]);
    const r2 = await s.mcp('playwright.groupTab', [{ tabId: 99999, name: 'Research' }]);
    await sleep(100);
    expect(r.error === notOurs(s.U2), `error: ${r.error}`);
    expect(r2.error === notOurs(99999), `error: ${r2.error}`);
    expect(state() === before, 'groups or tabs changed');
  });

  await laneScenario('lanes 4: race: tabs.create, then groupTab before/with/after the attach: the tab ends in the sub-group', async (s, expect) => {
    const create = async (url) => (await s.mcp('chrome.tabs.create', [{ url }])).result.id;
    const a = await create('https://lane-a.example/'); // groupTab done before the MCP attaches
    const ra = await s.mcp('playwright.groupTab', [{ tabId: a, name: 'Research' }]);
    await sleep(50);
    await s.mcp('chrome.debugger.attach', [{ tabId: a }, '1.3']);
    const b = await create('https://lane-b.example/'); // groupTab and attach sent together
    await Promise.all([s.mcp('playwright.groupTab', [{ tabId: b, name: 'Research' }]), s.mcp('chrome.debugger.attach', [{ tabId: b }, '1.3'])]);
    const c = await create('https://lane-c.example/'); // attach first, groupTab right behind it
    await Promise.all([s.mcp('chrome.debugger.attach', [{ tabId: c }, '1.3']), s.mcp('playwright.groupTab', [{ tabId: c, name: 'Research' }])]);
    await sleep(300);
    expect(!ra.error, `groupTab before attach failed: ${ra.error}`);
    for (const [label, id] of [['before', a], ['together', b], ['after', c]]) {
      expect(gInfo(s, id)?.title === '🤖 sim · Research', `${label}: tab in group "${gInfo(s, id)?.title}"`);
      expect(s.b.attached.has(id) && s.conn.attachedTabs.has(id), `${label}: tab not attached`);
    }
    expect(gOf(s, a) === gOf(s, b) && gOf(s, b) === gOf(s, c), 'more than one Research group');
  });

  await laneScenario('lanes 5: a popup opened from a sub-group tab joins that sub-group', async (s, expect) => {
    await s.mcp('playwright.groupTab', [{ tabId: s.A2, name: 'Research' }]);
    await sleep(50);
    // Brave puts a link popup in its opener's group
    const n1 = s.b.addTab({ windowId: 1, openerTabId: s.A2, active: false, groupId: gOf(s, s.A2), url: 'https://p1.example/' });
    await sleep(200);
    // window.open from the hidden tab: Brave names the user's tab as opener and groups nothing
    agentWindowOpen(s, s.A2, 'https://p2.example/');
    const n2 = s.b.addTab({ windowId: 1, openerTabId: s.U1, active: false, url: 'https://p2.example/' });
    await sleep(200);
    // popups-as-tabs.js marker: the extension opens it next to its opener
    agentLogsOpen(s, s.A2, 'https://p3.example/');
    await sleep(400);
    const n3 = s.b.tabs.find((t) => t.url === 'https://p3.example/')?.id;
    for (const [label, n] of [['link', n1], ['window.open', n2], ['marker', n3]]) {
      expect(n !== undefined && s.told.has(n) && s.b.attached.has(n), `${label}: popup not told/attached`);
      expect(gOf(s, n) === gOf(s, s.A2), `${label}: popup in group "${gInfo(s, n)?.title}"`);
    }
  });

  await laneScenario('lanes 6: a sub-group Brave deleted after its last tab closed is recreated with the same title', async (s, expect) => {
    s.ctx.DONE_CHECK_MS = 1e5;
    const b1 = await newLaneTab(s);
    const r1 = await s.mcp('playwright.groupTab', [{ tabId: b1, name: 'Research' }]);
    await s.mcp('chrome.tabs.remove', [b1]);
    await sleep(100);
    expect(!s.b.groups.has(r1.result?.groupId), 'emptied sub-group not deleted by the sim');
    const r2 = await s.mcp('playwright.groupTab', [{ tabId: s.A2, name: 'Research' }]);
    await sleep(100);
    const g = gInfo(s, s.A2);
    expect(!r2.error && r2.result?.groupId !== r1.result?.groupId && r2.result?.groupId === g?.id, `result ${JSON.stringify(r2)}`);
    expect(g?.title === '🤖 sim · Research' && g.collapsed, `recreated group "${g?.title}" collapsed=${g?.collapsed}`);
  });

  await laneScenario('lanes 7a: done-check across main + sub-group: only placeholders left -> every tab closes', async (s, expect) => {
    s.ctx.DONE_CHECK_MS = 50;
    const b1 = await newLaneTab(s);
    await s.mcp('playwright.groupTab', [{ tabId: b1, name: 'Research' }]);
    navigate(s, b1, 'about:blank');
    await s.mcp('chrome.tabs.remove', [s.A2]);
    await sleep(400);
    expect(!s.b.tab(s.A1) && !s.b.tab(b1), `tabs left: ${[s.A1, b1].filter((id) => s.b.tab(id))}`);
    expect(s.b.tab(s.U1) && s.b.tab(s.U2), 'The user\'s tabs were closed');
  });

  await laneScenario('lanes 7b: done-check across main + sub-group: one real page in the sub-group -> nothing closes', async (s, expect) => {
    s.ctx.DONE_CHECK_MS = 50;
    const b1 = await newLaneTab(s);
    await s.mcp('playwright.groupTab', [{ tabId: b1, name: 'Research' }]);
    await s.mcp('chrome.tabs.remove', [s.A2]);
    await sleep(400);
    expect(s.b.tab(s.A1) && s.b.tab(b1), `closed: ${[s.A1, b1].filter((id) => !s.b.tab(id))}`);
  });

  await laneScenario('lanes 8a: disconnect: main + sub-group stay grouped and collapsed during the grace period, all close after it', async (s, expect) => {
    s.ctx.ORPHAN_GRACE_MS = s.ctx.STARTUP_ORPHAN_GRACE_MS = 400;
    s.ctx.DONE_CHECK_MS = 1e5;
    await s.mcp('playwright.groupTab', [{ tabId: s.A2, name: 'Research' }]);
    await sleep(50);
    const gm = gOf(s, s.A1), gs = gOf(s, s.A2);
    s.conn.close('test');
    await sleep(150);
    expect(gOf(s, s.A1) === gm && gOf(s, s.A2) === gs, 'tabs regrouped/closed during grace');
    expect(s.b.groups.get(gm)?.collapsed && s.b.groups.get(gs)?.collapsed, 'a group was expanded during grace');
    await sleep(500);
    expect(!s.b.tab(s.A1) && !s.b.tab(s.A2), `tabs left after grace: ${[s.A1, s.A2].filter((id) => s.b.tab(id))}`);
  });

  await laneScenario('lanes 8b: disconnect while the user views a sub-group tab: after the grace period it stays, ungrouped; the rest closes', async (s, expect) => {
    s.ctx.ORPHAN_GRACE_MS = s.ctx.STARTUP_ORPHAN_GRACE_MS = 300;
    s.ctx.DONE_CHECK_MS = 1e5;
    await s.mcp('playwright.groupTab', [{ tabId: s.A2, name: 'Research' }]);
    await sleep(50);
    const gs = gOf(s, s.A2);
    await s.userViews(s.A2);
    s.conn.close('test');
    await sleep(100);
    expect(gOf(s, s.A2) === gs, 'ungrouped during grace');
    await sleep(400);
    expect(!s.b.tab(s.A1), 'main group tab not closed');
    expect(gOf(s, s.A2) === -1, `tab the user is viewing: ${s.b.tab(s.A2) ? 'group ' + gOf(s, s.A2) : 'closed'}`);
  });

  await laneScenario('lanes 9: disconnect + reconnect with the same sessionKey within grace: tabs adopted, main + sub groups reused, nothing closes', async (s, expect) => {
    s.ctx.ORPHAN_GRACE_MS = s.ctx.STARTUP_ORPHAN_GRACE_MS = 500;
    s.ctx.DONE_CHECK_MS = 1e5;
    const one = await s.connect({ clientName: 'sim', sessionKey: 'K1' });
    const w1 = await newLaneTab(s, one.mcp, 'https://work1.example/');
    const w2 = await newLaneTab(s, one.mcp, 'https://work2.example/');
    await one.mcp('playwright.groupTab', [{ tabId: w2, name: 'Research' }]);
    await sleep(50);
    const gm = gOf(s, one.page), gs = gOf(s, w2);
    expect(s.b.groups.get(gm)?.title === '🤖 sim' && gOf(s, w1) === gm && s.b.groups.get(gs)?.title === '🤖 sim · Research', 'first session groups wrong');
    one.drop();
    await sleep(150);
    const two = await s.connect({ clientName: 'sim', sessionKey: 'K1' });
    await sleep(150);
    for (const id of [one.page, w1, w2]) expect(two.told.has(id) && two.group._connection.attachedTabs.has(id) && s.b.attached.has(id), `tab ${id} not handed to the new session`);
    expect(gOf(s, one.page) === gm && gOf(s, w1) === gm && gOf(s, two.page) === gm, `main group not reused: ${[one.page, w1, two.page].map((id) => gOf(s, id))} vs ${gm}`);
    expect(gOf(s, w2) === gs, 'sub-group not reused');
    expect(s.b.groups.get(gm)?.title === '🤖 sim' && s.b.groups.get(gm)?.collapsed && s.b.groups.get(gs)?.collapsed, 'groups retitled/expanded');
    const r = await two.mcp('playwright.groupTab', [{ tabId: w1, name: 'Research' }]);
    expect(r.result?.groupId === gs, `adopted sub-group not reused by groupTab: ${JSON.stringify(r)}`);
    await sleep(600);
    expect([one.page, w1, w2, two.page].every((id) => s.b.tab(id)), `closed after the grace time: ${[one.page, w1, w2, two.page].filter((id) => !s.b.tab(id))}`);
  }, { session: false });

  await laneScenario('lanes 10: different sessionKey, same title: no adoption, new group "🤖 sim (2)", the orphan closes at expiry', async (s, expect) => {
    s.ctx.ORPHAN_GRACE_MS = s.ctx.STARTUP_ORPHAN_GRACE_MS = 400;
    s.ctx.DONE_CHECK_MS = 1e5;
    const one = await s.connect({ clientName: 'sim', sessionKey: 'K1' });
    const w1 = await newLaneTab(s, one.mcp, 'https://work1.example/');
    const gm = gOf(s, one.page);
    one.drop();
    await sleep(100);
    const two = await s.connect({ clientName: 'sim', sessionKey: 'K2' });
    await sleep(100);
    expect(!two.told.has(w1) && !two.told.has(one.page), 'other session told about the orphan\'s tabs');
    expect(gInfo(s, two.page)?.title === '🤖 sim (2)', `new group "${gInfo(s, two.page)?.title}"`);
    expect(gOf(s, two.page) !== gm && gOf(s, w1) === gm, 'orphan group reused by another session');
    await sleep(500);
    expect(!s.b.tab(w1) && !s.b.tab(one.page), 'orphan not closed at expiry');
    expect(s.b.tab(two.page) && gInfo(s, two.page)?.title === '🤖 sim (2)', 'new session\'s tab closed/ungrouped');
  }, { session: false });

  await laneScenario('lanes 11: old server without sessionKey reconnects with the same title: adopts', async (s, expect) => {
    s.ctx.ORPHAN_GRACE_MS = s.ctx.STARTUP_ORPHAN_GRACE_MS = 400;
    s.ctx.DONE_CHECK_MS = 1e5;
    const one = await s.connect({ clientName: 'sim' });
    const w1 = await newLaneTab(s, one.mcp, 'https://work1.example/');
    const gm = gOf(s, one.page);
    one.drop();
    await sleep(100);
    const two = await s.connect({ clientName: 'sim' });
    await sleep(150);
    expect(two.told.has(w1) && two.told.has(one.page) && s.b.attached.has(w1), 'orphan tabs not handed over');
    expect(gOf(s, w1) === gm && gOf(s, two.page) === gm && s.b.groups.get(gm)?.title === '🤖 sim', 'main group not reused');
    await sleep(500);
    expect([one.page, w1, two.page].every((id) => s.b.tab(id)), 'adopted tabs closed at expiry');
  }, { session: false });

  await laneScenario('lanes 12: extension start: main + " · sub" left-overs become one orphan that a matching connection adopts; an unmatched one closes after grace; a legacy group closes at once', async (s, expect) => {
    s.ctx.ORPHAN_GRACE_MS = s.ctx.STARTUP_ORPHAN_GRACE_MS = 400;
    s.ctx.DONE_CHECK_MS = 1e5;
    const leftOver = async (url, title, color) => {
      const id = s.b.addTab({ windowId: 1, url, active: false });
      const g = await s.b.chrome.tabs.group({ tabIds: [id] });
      await s.b.chrome.tabGroups.update(g, { title, color, collapsed: true });
      return [id, g];
    };
    const [o1, g1] = await leftOver('https://old-main.example/', '🤖 sim', 'blue');
    const [o2, g2] = await leftOver('https://old-research.example/', '🤖 sim · Research', 'red');
    const [o3] = await leftOver('https://other.example/', '🤖 other', 'purple');
    const [o4] = await leftOver('https://legacy.example/', 'Playwright · claude-code', 'grey');
    s.b.store.local.agentGroupOwners = { [g1]: { sessionKey: 'K1', title: '🤖 sim', name: '' }, [g2]: { sessionKey: 'K1', title: '🤖 sim', name: 'Research' } };
    await sleep(50);
    await s.ctx.cleanupStalePlaywrightGroups();
    await sleep(100);
    expect(!s.b.tab(o4), 'legacy group tab not closed at once');
    expect(s.b.tab(o1) && s.b.tab(o2) && s.b.tab(o3), 'a 🤖 left-over closed before the grace period ended');
    const sim = s.ctx.orphanSessions.find((o) => o.title === '🤖 sim');
    expect(sim?.groups.length === 2 && sim.sessionKey === 'K1' && s.ctx.orphanSessions.length === 2, `orphans: ${JSON.stringify(s.ctx.orphanSessions.map((o) => ({ title: o.title, key: o.sessionKey, groups: o.groups })))}`);
    const two = await s.connect({ clientName: 'sim', sessionKey: 'K1' });
    await sleep(150);
    expect(two.told.has(o1) && two.told.has(o2) && s.b.attached.has(o1) && s.b.attached.has(o2), 'left-over tabs not handed to the session');
    expect(gOf(s, o1) === g1 && gOf(s, two.page) === g1 && gOf(s, o2) === g2, `groups not reused: ${[o1, two.page, o2].map((id) => gOf(s, id))}`);
    expect(s.b.groups.get(g1)?.title === '🤖 sim' && s.b.groups.get(g1)?.color === two.group.groupStyle.color, 'main group not restyled to the new session');
    expect(s.b.groups.get(g2)?.title === '🤖 sim · Research' && s.b.groups.get(g2)?.color !== s.b.groups.get(g1)?.color, 'sub-group title/color wrong');
    expect(s.b.groups.get(g1)?.collapsed && s.b.groups.get(g2)?.collapsed, 'collapsed state changed');
    await sleep(500);
    expect(s.b.tab(o1) && s.b.tab(o2), 'adopted left-overs closed at expiry');
    expect(!s.b.tab(o3), 'unmatched left-over not closed after the grace period');
  }, { session: false });

  // 14) The user's tabs: handed over by moving them into a 🤖 group, or taken over by an agent; never closed
  //     for them (HAND_OVER_MIN_AGE_MS shortened for the sim). s.handOver = the user drags a tab into a group.
  const userScenario = (name, fn) => scenario(name, async (s, expect) => {
    s.ctx.HAND_OVER_MIN_AGE_MS = 50;
    s.a = await s.connect();
    s.g = s.b.tab(s.a.page).groupId;
    s.expectActive = s.U1;
    const acts = [];
    s.b.chrome.tabs.onActivated.addListener(({ tabId }) => acts.push(tabId));
    // A tab the agent opens (the MCP attaches to each tab it creates).
    s.agentTab = async (url = 'https://agent.example/') => { const id = (await s.a.mcp('chrome.tabs.create', [{ url }])).result.id; await s.a.mcp('chrome.debugger.attach', [{ tabId: id }, '1.3']); return id; };
    s.handOver = async (id, groupId = s.g) => { await s.b.chrome.tabs.group({ groupId, tabIds: [id] }); await sleep(150); };
    await sleep(60);
    acts.length = 0;
    await fn(s, expect, acts);
    await sleep(50);
    expect(s.active() === s.expectActive, `The user's tab changed to ${s.active()}, expected ${s.expectActive}`);
    expect(!s.b.crossWindowMoves.length, `tabs moved to another window: ${s.b.crossWindowMoves}`);
  }, { session: false });
  const isUserTab = async (s, id) => (await s.ctx.userTabIds()).has(id);

  await userScenario('The user drags their tab into an agent group: handed to that chat (attached, marked theirs), not thrown out', async (s, expect) => {
    await s.handOver(s.U2);
    expect(s.b.tab(s.U2).groupId === s.g, `tab left the group (group ${s.b.tab(s.U2).groupId})`);
    expect(s.b.attached.has(s.U2), 'not attached');
    expect(s.a.created.get(s.U2)?.pwUser?.handedTo === '', `server not told it is the user's: ${JSON.stringify(s.a.created.get(s.U2))}`);
    expect(await isUserTab(s, s.U2) && s.b.store.local.userTabs?.[s.U2], 'not remembered as the user\'s (chrome.storage.local)');
  });

  await userScenario('a tab the user opened from an agent tab, moved into the group later: handed over too', async (s, expect) => {
    s.b.activate(s.a.page);
    await sleep(80);
    const n = s.b.addTab({ windowId: 1, openerTabId: s.a.page, active: false, groupId: s.g, url: 'https://terms.example/' });
    await sleep(300);
    expect(s.b.tab(n).groupId === -1 && !s.b.attached.has(n), 'precondition: their new tab was put out of the group');
    s.b.activate(s.U1);
    await sleep(100);
    await s.handOver(n);
    expect(s.b.tab(n).groupId === s.g, 'thrown out of the group again');
    expect(s.b.attached.has(n) && s.a.created.get(n)?.pwUser, 'not handed to the chat');
  });

  await userScenario('a tab that joins the group as it opens (agent page popup) stays the agent\'s, not the user\'s', async (s, expect) => {
    const n = s.b.addTab({ windowId: 1, openerTabId: s.a.page, active: false, url: 'https://popup.example/' });
    await s.b.chrome.tabs.group({ groupId: s.g, tabIds: [n] });
    await sleep(150);
    expect(s.b.tab(n)?.groupId === s.g, 'popup thrown out of the group');
    expect(!(await isUserTab(s, n)) && !s.a.created.get(n)?.pwUser, 'a just-opened tab was taken for the user\'s');
  });

  await userScenario('closing the user\'s tab (agent done, helper finished) gives it back: open, out of the group, detached', async (s, expect) => {
    await s.handOver(s.U2);
    const r = await s.a.mcp('chrome.tabs.remove', [s.U2]);
    await sleep(150);
    expect(!r.error, `remove failed: ${r.error}`);
    expect(!!s.b.tab(s.U2), 'The user\'s tab was closed');
    expect(s.b.tab(s.U2)?.groupId === -1, 'still in the agent group');
    expect(!s.b.attached.has(s.U2) && s.a.detached.includes(s.U2), 'not detached / MCP not told');
    expect(!(await isUserTab(s, s.U2)), 'still marked as handed over');
    await s.handOver(s.U2);
    await s.a.mcp('chrome.debugger.sendCommand', [{ tabId: s.U2 }, 'Page.close', {}]);
    await sleep(150);
    expect(!!s.b.tab(s.U2) && s.b.tab(s.U2).groupId === -1, 'Page.close closed the user\'s tab');
  });

  await userScenario('the session drops with the user\'s tab in its group: after the grace period its tabs close, theirs stays (ungrouped)', async (s, expect) => {
    s.ctx.ORPHAN_GRACE_MS = 200;
    await s.handOver(s.U2);
    const w = await s.agentTab();
    await sleep(150);
    s.a.drop();
    await sleep(600);
    expect(!s.b.tab(w) && !s.b.tab(s.a.page), 'agent tabs not closed');
    expect(!!s.b.tab(s.U2) && s.b.tab(s.U2).groupId === -1, 'The user\'s tab closed or left in the group');
  });

  await userScenario('The user drags their tab into a group whose session dropped: at expiry it is theirs, not closed', async (s, expect) => {
    s.ctx.ORPHAN_GRACE_MS = 300;
    s.a.drop();
    await sleep(50);
    await s.b.chrome.tabs.group({ groupId: s.g, tabIds: [s.U2] });
    await sleep(600);
    expect(!s.b.tab(s.a.page), 'connect page not closed');
    expect(!!s.b.tab(s.U2) && s.b.tab(s.U2).groupId === -1, 'The user\'s tab closed or left in the group');
  });

  await userScenario('playwright.listTabs: The user\'s web tabs only, the one on screen marked', async (s, expect) => {
    const w = await s.agentTab();
    const settings = s.b.addTab({ windowId: 1, url: 'chrome://settings/', active: false });
    await sleep(150);
    const r = await s.a.mcp('playwright.listTabs', [{}]);
    const list = r.result?.tabs ?? [];
    const ids = list.map((t) => t.tabId);
    expect(ids.includes(s.U1) && ids.includes(s.U2), `The user's tabs missing: ${JSON.stringify(r)}`);
    expect(![w, s.a.page, settings].some((id) => ids.includes(id)), `agent or browser tabs listed: ${ids}`);
    expect(list.find((t) => t.tabId === s.U1)?.onScreen === true && list.find((t) => t.tabId === s.U2)?.onScreen === false, `onScreen wrong: ${JSON.stringify(list)}`);
  });

  await userScenario('playwright.takeTab of a background tab: joins the agent group, attached, marked theirs; nothing activated', async (s, expect, acts) => {
    const r = await s.a.mcp('playwright.takeTab', [{ tabId: s.U2, name: '' }]);
    await sleep(150);
    expect(!r.error && r.result?.tabId === s.U2, `take failed: ${JSON.stringify(r)}`);
    expect(s.b.tab(s.U2).groupId === s.g, 'not in the agent group');
    expect(s.b.attached.has(s.U2) && s.a.created.get(s.U2)?.pwUser?.takenFor === '', `not attached as the user's: ${JSON.stringify(s.a.created.get(s.U2))}`);
    expect(!acts.length, `tabs were activated: ${acts}`);
  });

  await userScenario('playwright.takeTab of the tab on the user\'s screen: the group opens so they stay on it', async (s, expect, acts) => {
    expect(s.b.groups.get(s.g)?.collapsed, 'precondition: agent group collapsed');
    const r = await s.a.mcp('playwright.takeTab', [{ tabId: s.U1 }]);
    await sleep(150);
    expect(!r.error, `take failed: ${r.error}`);
    expect(s.b.tab(s.U1).groupId === s.g && !s.b.groups.get(s.g).collapsed, 'not in an open agent group');
    expect(!acts.length, `tabs were activated: ${acts}`);
  });

  await userScenario('playwright.takeTab of another session\'s tab, a browser page or an unknown id: error, nothing changes', async (s, expect) => {
    const other = await s.connect({ clientName: 'other' });
    const w = await s.agentTab();
    const settings = s.b.addTab({ windowId: 1, url: 'chrome://settings/', active: false });
    await sleep(150);
    const r1 = await other.mcp('playwright.takeTab', [{ tabId: w }]);
    const r2 = await s.a.mcp('playwright.takeTab', [{ tabId: settings }]);
    const r3 = await s.a.mcp('playwright.takeTab', [{ tabId: 99999 }]);
    expect(/in use by an agent/.test(r1.error || ''), `other session's tab: ${JSON.stringify(r1)}`);
    expect(/browser page/.test(r2.error || ''), `browser page: ${JSON.stringify(r2)}`);
    expect(/No open tab/.test(r3.error || ''), `unknown id: ${JSON.stringify(r3)}`);
    expect(s.b.tab(w).groupId === s.g && !other.created.has(w), 'agent tab moved to the other session');
  });

  await userScenario('playwright.takeTab of a tab in another window or in one of their own groups: attached where it is, given back there', async (s, expect) => {
    s.b.windows.set(2, { id: 2, type: 'normal', focused: false, state: 'normal' });
    const w2 = s.b.addTab({ windowId: 2, url: 'https://other-window.example/', active: true });
    const work = await s.b.chrome.tabs.group({ tabIds: [s.U2] });
    s.b.groups.get(work).title = 'Work';
    await sleep(100);
    const r1 = await s.a.mcp('playwright.takeTab', [{ tabId: w2 }]);
    const r2 = await s.a.mcp('playwright.takeTab', [{ tabId: s.U2 }]);
    await sleep(150);
    expect(!r1.error && !r2.error, `take failed: ${r1.error} ${r2.error}`);
    expect(s.b.tab(w2).windowId === 2 && s.b.tab(w2).groupId === -1 && s.b.tab(w2).active, 'the tab in window 2 was moved');
    expect(s.b.tab(s.U2).groupId === work, 'taken out of their own group');
    expect(s.b.attached.has(w2) && s.b.attached.has(s.U2), 'not attached');
    await s.a.mcp('chrome.tabs.remove', [s.U2]);
    await sleep(100);
    expect(s.b.tab(s.U2)?.groupId === work && !s.b.attached.has(s.U2), 'given back out of their own group, or still attached');
  });

  await userScenario('The user drags a handed tab back out: detached, theirs again', async (s, expect) => {
    await s.handOver(s.U2);
    await s.b.chrome.tabs.ungroup([s.U2]);
    await sleep(150);
    expect(!s.b.attached.has(s.U2) && s.a.detached.includes(s.U2), 'still attached');
    expect(!(await isUserTab(s, s.U2)), 'still marked as handed over');
  });

  await userScenario('a tab dropped into a helper\'s sub-group goes to that sub-group', async (s, expect) => {
    const w = await s.agentTab();
    await sleep(100);
    const r = await s.a.mcp('playwright.groupTab', [{ tabId: w, name: 'Research' }]);
    await sleep(100);
    await s.handOver(s.U2, r.result.groupId);
    expect(s.a.created.get(s.U2)?.pwUser?.handedTo === 'Research', `handed to ${JSON.stringify(s.a.created.get(s.U2)?.pwUser)}`);
  });

  await scenario('the agent\'s own new tabs stay in the background and get grouped', async (s, expect) => {
    const r = await s.mcp('chrome.tabs.create', [{ url: 'https://agent3.example/' }]);
    await s.mcp('chrome.debugger.attach', [{ tabId: r.result.id }, '1.3']);
    await sleep(200);
    expect(s.active() === s.U1, `active changed to ${s.active()}`);
    expect(await s.isAgent(r.result.id), 'not an agent tab');
    expect(s.b.tab(r.result.id).groupId === s.b.tab(s.A1).groupId, 'not grouped');
  });

  const failed = results.filter((r) => r.failures.length);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  clearInterval(keepAlive);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
