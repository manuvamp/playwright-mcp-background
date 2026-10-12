// Offline test of extension-bg/lib/background.mjs tab handling against a simulated Chromium browser (no real
// browser, nothing on screen). Covers who owns a new tab (user vs agent), bounces, group membership,
// what the agent's MCP gets told, and the "agent closed the tab the user was viewing" rule.
//   node patches/sim-tabs.cjs [extension-dir]   (SIM_DISABLE_FIX=1: expect failures)
// extension-dir defaults to PW_MCP_EXTENSION_OUT, then ./extension-bg (run patches/build-extension.cjs first).
// Chrome behaviour modelled: events are dispatched one at a time, in order (onCreated before the new
// tab's onActivated); a tab opened by a link from a grouped tab joins that group.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const EXT_DIR = path.resolve(process.argv[2] || process.env.PW_MCP_EXTENSION_OUT || path.join(__dirname, '..', 'extension-bg'));
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
  const store = { session: {}, local: {} };
  const ev = { created: Ev(), activated: Ev(), updated: Ev(), removed: Ev(), focus: Ev() };
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
      create: async (opts = {}) => snap(need(addTab({ windowId: opts.windowId ?? focusedWindow, url: opts.url, active: opts.active ?? true }))),
      remove: async (ids) => { for (const id of [ids].flat()) if (tab(id)) removeTab(id); },
      group: async ({ tabIds, groupId }) => {
        if (groupId === undefined) { groupId = nextGroup++; groups.set(groupId, { id: groupId, title: '', collapsed: false, color: 'grey', windowId: need([tabIds].flat()[0]).windowId }); }
        else if (!groups.has(groupId)) throw new Error('No group with id: ' + groupId);
        for (const id of [tabIds].flat()) setGroup(id, groupId);
        return groupId;
      },
      ungroup: async (ids) => { for (const id of [ids].flat()) if (tab(id)) setGroup(id, -1); },
    },
    tabGroups: {
      get: async (id) => { if (!groups.has(id)) throw new Error('No group with id: ' + id); return { ...groups.get(id) }; },
      query: async () => [...groups.values()].map((g) => ({ ...g })),
      update: async (id, props) => {
        const g = groups.get(id);
        if (!g) throw new Error('No group');
        Object.assign(g, props);
        // Collapsing a group that holds the active tab moves the browser to a tab outside it.
        const act = tabs.find((t) => t.windowId === g.windowId && t.active);
        if (props.collapsed && act?.groupId === id) { const out = tabs.find((t) => t.windowId === g.windowId && t.groupId !== id); if (out) activate(out.id); }
        return { ...g };
      },
    },
    windows: {
      WINDOW_ID_NONE: -1, onFocusChanged: ev.focus,
      get: async (id) => ({ ...windows.get(id) }),
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
    alarms: { create() {}, onAlarm: Ev() },
    runtime: { onMessage: Ev(), onStartup: Ev(), getURL: (p) => 'chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/' + p, reload() {} },
    action: { onClicked: Ev(), setBadgeText: ok, setTitle: ok, setBadgeBackgroundColor: ok },
  };
  return { chrome, windows, tabs, groups, attached, focusCalls, tab, addTab, removeTab, activate, focusWindow, store };
}

async function setup() {
  const b = makeBrowser();
  b.windows.set(1, { id: 1, focused: true, state: 'normal' });
  const U1 = b.addTab({ windowId: 1, url: 'https://mail.example/' });
  const U2 = b.addTab({ windowId: 1, url: 'https://news.example/', active: false });
  class FakeWS { static CONNECTING = 0; static OPEN = 1; static CLOSED = 3; constructor() { this.readyState = 0; } send() {} close() {} }
  const ctx = vm.createContext({ chrome: b.chrome, console: { log() {}, error: console.error, warn() {} }, setTimeout, clearTimeout, setInterval: () => 0, WebSocket: FakeWS, URLSearchParams, Promise, Date, JSON, Math, Map, Set, Error, String });
  vm.runInContext(CODE, ctx, { filename: 'background.mjs' });
  // SIM_DISABLE_FIX=1: treat every tab opened from an agent tab as the agent's (pre-2026-10-12 behaviour),
  // to check the scenarios still catch the original bug.
  if (process.env.SIM_DISABLE_FIX) ctx.isUserOpenedTab = () => false;
  await sleep(30);
  // An agent session: connect page in the background, a relay connection, the MCP auto-attaching.
  const told = new Set();
  let nextId = 1;
  const pending = new Map();
  const ws = { readyState: 1, close() {}, send(raw) {
    const m = JSON.parse(raw);
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'chrome.tabs.onCreated') { told.add(m.params[0].id); mcp('chrome.debugger.attach', [{ tabId: m.params[0].id }, '1.3']); }
  } };
  const mcp = (method, params) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); ws.onmessage({ data: JSON.stringify({ id, method, params }) }); });
  const connectTab = await ctx.openConnectPage(b.chrome.runtime.getURL('connect.html') + '?mcpRelayUrl=x');
  const conn = new ctx.RelayConnection(ws);
  new ctx.ConnectedTabGroup(conn, connectTab, 'sim', { title: '🤖 sim', color: 'green' }, () => false);
  await sleep(60);
  const A1 = connectTab.id;
  const A2 = (await mcp('chrome.tabs.create', [{ url: 'https://agent2.example/' }])).result.id;
  await mcp('chrome.debugger.attach', [{ tabId: A2 }, '1.3']);
  await sleep(60);
  const isAgent = async (id) => (await ctx.agentTabIds()).has(id);
  const active = () => b.tabs.find((t) => t.windowId === 1 && t.active)?.id;
  return { b, ctx, U1, U2, A1, A2, told, mcp, isAgent, active, conn };
}

const results = [];
async function scenario(name, fn) {
  const failures = [];
  const expect = (cond, msg) => { if (!cond) failures.push(msg); };
  try {
    const s = await setup();
    await fn(s, expect);
    // The extension must never focus a browser window: on Windows that raises the browser over the user's app.
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
    s.b.activate(s.A1); // the user opens the agent tab to review it (group expands)
    await sleep(80);
    const n = s.b.addTab({ windowId: 1, openerTabId: s.A1, active, groupId: grouped ? s.b.tab(s.A1).groupId : -1, url: 'https://terms.example/' });
    await sleep(400);
    return n;
  };
  const expectUsers = async (s, expect, n) => {
    expect(!(await s.isAgent(n)), 'new tab was adopted as an agent tab');
    expect(!s.told.has(n), 'agent MCP was told about the new tab');
    expect(!s.b.attached.has(n), 'debugger attached to the new tab');
    expect(s.b.tab(n)?.groupId === -1, `new tab still in group ${s.b.tab(n)?.groupId}`);
  };

  await scenario('the user clicks a target=_blank link in an agent tab they are viewing: they land on it, agent never sees it', async (s, expect) => {
    const n = await userOpensFromAgentTab(s, { active: true });
    expect(s.active() === n, `bounced: active is ${s.active()}, expected new tab ${n}`);
    await expectUsers(s, expect, n);
    expect(s.ctx.lastUserTab.get(1) === n, 'new tab not remembered as the user\'s last tab');
  });

  await scenario('the user middle-clicks a link in an agent tab: background tab is theirs, they stay put', async (s, expect) => {
    const n = await userOpensFromAgentTab(s, { active: false });
    expect(s.active() === s.A1, `active changed to ${s.active()}`);
    await expectUsers(s, expect, n);
  });

  await scenario('the user presses Ctrl+T while viewing an agent tab: new tab is theirs', async (s, expect) => {
    const n = await userOpensFromAgentTab(s, { active: true, grouped: false });
    expect(s.active() === n, `bounced to ${s.active()}`);
    await expectUsers(s, expect, n);
  });

  await scenario('a link opened from that tab is also theirs (no spreading)', async (s, expect) => {
    const n = await userOpensFromAgentTab(s, { active: true });
    const m = s.b.addTab({ windowId: 1, openerTabId: n, active: true });
    await sleep(400);
    expect(s.active() === m, `bounced to ${s.active()}`);
    await expectUsers(s, expect, m);
  });

  await scenario('the user clicks a target=_blank link in their own tab: nothing interferes', async (s, expect) => {
    const n = s.b.addTab({ windowId: 1, openerTabId: s.U1, active: true });
    await sleep(400);
    expect(s.active() === n, `bounced to ${s.active()}`);
    await expectUsers(s, expect, n);
  });

  await scenario('agent page pops a foreground tab (window.open from hidden tab): the user is put back, agent owns it', async (s, expect) => {
    const n = s.b.addTab({ windowId: 1, openerTabId: s.A2, active: true, groupId: s.b.tab(s.A2).groupId });
    await sleep(400);
    expect(s.active() === s.U1, `the user left on ${s.active()}, expected ${s.U1}`);
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

  for (const userInBrowser of [true, false]) {
    await scenario(`agent page opens a popup window while the user is ${userInBrowser ? 'in the browser' : 'in another app'}: minimized, no window focused`, async (s, expect) => {
      if (!userInBrowser) { s.b.windows.get(1).focused = false; s.b.chrome.windows.onFocusChanged.emit(-1); await sleep(50); }
      s.b.windows.set(2, { id: 2, focused: false, state: 'normal' });
      const n = s.b.addTab({ windowId: 2, openerTabId: s.A2, active: true });
      s.b.focusWindow(2);
      await sleep(400);
      expect(s.b.windows.get(2).state === 'minimized', 'popup window not minimized');
      expect(s.active() === s.U1, `the user's tab changed to ${s.active()}`);
      expect(await s.isAgent(n) && s.told.has(n), 'popup not adopted/told');
    });
  }

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
