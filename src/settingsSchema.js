// What the Settings window is allowed to change, and how each value is cleaned up.
// Anything not listed here (or that fails validation) is ignored.

const HEX = /^#[0-9a-f]{6}$/i;
const bool = (v) => (typeof v === 'boolean' ? v : undefined);
const int = (min, max) => (v) => (Number.isFinite(Number(v)) ? Math.max(min, Math.min(max, Math.round(Number(v)))) : undefined);
const oneOf = (...opts) => (v) => (opts.includes(v) ? v : undefined);
const text = (max) => (v) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
const list = (max, itemMax, check = () => true) => (v) =>
  Array.isArray(v)
    ? [...new Set(v.filter((x) => typeof x === 'string').map((x) => x.trim().slice(0, itemMax)).filter((x) => x && check(x)))].slice(0, max)
    : undefined;

const isHttps = (u) => {
  try {
    return new URL(u).protocol === 'https:';
  } catch {
    return false;
  }
};

const SCHEMA = {
  accent: (v) => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : undefined),
  artColor: bool,
  displays: oneOf('all', 'primary'),
  offsetY: int(0, 60),
  rotateSeconds: int(3, 30),
  lyrics: bool,
  peek: bool,
  notifications: bool,
  clipboard: bool,
  startWithWindows: bool,
  claudeApprovals: bool,
  lockdownDefault: bool,
  weatherCity: text(80),
  units: oneOf('c', 'f'),
  icalUrls: list(10, 500, isHttps),
  lockdown: (v) => {
    if (!v || typeof v !== 'object') return undefined;
    const site = list(50, 60);
    return {
      extraSites: site(v.extraSites) || [],
      allowSites: site(v.allowSites) || [],
      unblock: site(v.unblock) || [],
      apps: list(30, 60, (a) => /^[\w .-]+$/.test(a))(v.apps) || [],
    };
  },
};

/** Keep only known keys with valid values. */
function sanitize(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  for (const [key, check] of Object.entries(SCHEMA)) {
    if (!(key in patch)) continue;
    const value = check(patch[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

module.exports = { sanitize, SCHEMA };
