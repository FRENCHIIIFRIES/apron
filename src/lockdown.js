// Focus lockdown: while a focus session runs, close browser tabs (and minimise app
// windows) whose title matches a distracting site. Allowed sites always win, so a
// YouTube video titled "Instagram tips" stays open.

const BROWSERS = new Set(['chrome', 'msedge', 'firefox', 'brave', 'opera', 'opera_gx', 'vivaldi', 'arc', 'zen', 'thorium']);

// Matched against window titles. Each entry: [label, regex source].
const DEFAULT_BLOCK = [
  ['Instagram', '\\binstagram\\b'],
  ['TikTok', '\\btiktok\\b'],
  ['X', '(^|\\s)\\/ X$|\\bon X:|^X$|\\btwitter\\b'],
  ['Reddit', '\\breddit\\b'],
  ['Facebook', '\\bfacebook\\b'],
  ['Snapchat', '\\bsnapchat\\b'],
  ['Threads', '\\bthreads\\b'],
  ['Netflix', '\\bnetflix\\b'],
  ['Prime Video', '\\bprime video\\b'],
  ['Disney+', '\\bdisney\\+'],
  ['Hotstar', '\\bhotstar\\b'],
  ['Twitch', '\\btwitch\\b'],
  ['Discord', '\\bdiscord\\b'],
  ['Pinterest', '\\bpinterest\\b'],
  ['Tumblr', '\\btumblr\\b'],
  ['Roblox', '\\broblox\\b'],
  ['9GAG', '\\b9gag\\b'],
];
const DEFAULT_ALLOW = ['\\byoutube\\b', '\\bspotify\\b'];

function compile(config = {}) {
  const lc = config.lockdown || {};
  const block = [
    ...DEFAULT_BLOCK.filter(([label]) => !(lc.unblock || []).some((u) => u.toLowerCase() === label.toLowerCase())),
    ...(lc.extraSites || []).map((site) => [site, `\\b${String(site).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`]),
  ].map(([label, src]) => ({ label, re: new RegExp(src, 'i') }));
  const allow = [...DEFAULT_ALLOW, ...(lc.allowSites || []).map((s) => `\\b${String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)].map(
    (src) => new RegExp(src, 'i'),
  );
  const apps = new Set((lc.apps || []).map((a) => String(a).toLowerCase().replace(/\.exe$/, '')));
  return { block, allow, apps };
}

/** What to do with this foreground window: { action: 'closetab' | 'minimize', label } or null. */
function judge(fg, rules) {
  if (!fg || !fg.title) return null;
  const exe = String(fg.exe || '').toLowerCase();
  if (exe === 'apron' || exe === 'electron') return null;
  if (rules.apps.has(exe)) return { action: 'minimize', label: fg.exe };
  // Browsers suffix titles with " - Google Chrome" etc.; drop that before matching.
  const title = fg.title.replace(/\s+[-—–]\s+(Google Chrome|Microsoft​? Edge|Mozilla Firefox|Brave|Opera|Vivaldi|Arc)$/i, '');
  if (rules.allow.some((re) => re.test(title))) return null;
  const hit = rules.block.find((b) => b.re.test(title));
  if (!hit) return null;
  return { action: BROWSERS.has(exe) ? 'closetab' : 'minimize', label: hit.label };
}

function create(config, media, onBlocked) {
  let rules = compile(config);
  let active = false;
  let lastHwnd = null;
  let lastAt = 0;

  return {
    setConfig(next) {
      rules = compile(next);
    },
    // The foreground watcher itself is switched on by main (screen time uses it too).
    setActive(on) {
      active = Boolean(on);
    },
    isActive: () => active,
    onForeground(fg) {
      if (!active) return;
      const verdict = judge(fg, rules);
      if (!verdict) return;
      // Don't hammer the same window if a close is still in flight.
      const now = Date.now();
      if (fg.hwnd === lastHwnd && now - lastAt < 1200) return;
      lastHwnd = fg.hwnd;
      lastAt = now;
      media.command(`${verdict.action} ${fg.hwnd}`);
      onBlocked(verdict.label);
    },
  };
}

module.exports = { create, judge, compile, DEFAULT_BLOCK };
