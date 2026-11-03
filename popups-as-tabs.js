// Init script for every page the Playwright MCP server drives (--init-script in ~/.claude.json, added by
// patches/use-supervisor.cjs). The rule: agent work never reaches the user's screen, so no new windows.
// - Agent pages work in hidden background tabs. There, window.open (sign-in buttons, share buttons,
//   checkouts, target=_blank scripts) would put a tab in front of the user's (Brave always opens it as the
//   active tab) or open a popup window. So it opens nothing: the URL is logged with the marker below,
//   the extension (build-extension.cjs 9) opens it as a background tab in the agent's group, and the
//   page gets null, as if a popup blocker stopped it. Sign-in popups lose window.opener: prefer a
//   same-tab redirect or a magic link.
// - When the user is viewing the agent tab (visible), it is their click: a sized popup opens as a tab.
(() => {
  const open = window.open;
  if (typeof open !== 'function' || open.__agentTabs) return;
  const MARKER = '[agent] window.open blocked; opened in a background tab instead (see browser_tabs):';
  const debug = console.debug.bind(console);
  const asTab = function (url, target, features) {
    if (document.visibilityState === 'hidden') {
      let href = '';
      try { href = url ? new URL(String(url), location.href).href : ''; } catch {}
      if (/^https?:/i.test(href)) debug(MARKER, href);
      return null;
    }
    if (typeof features === 'string' && features.trim()) {
      // Keep only the flags that don't make a window: noopener/noreferrer.
      const keep = features.split(',').map((f) => f.trim()).filter((f) => /^(noopener|noreferrer)(\s*=|$)/i.test(f));
      return open.call(this, url, target, keep.join(','));
    }
    return open.apply(this, arguments);
  };
  Object.defineProperty(asTab, '__agentTabs', { value: true });
  Object.defineProperty(asTab, 'toString', { value: () => open.toString() });
  window.open = asTab;
})();
