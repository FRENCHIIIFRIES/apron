// What the Settings window is allowed to change, and how each value is cleaned up.
// Anything not listed here (or that fails validation) is ignored.

const HEX = /^#[0-9a-f]{6}$/i;
const WIDGETS = ['music', 'next', 'weather', 'due', 'focus', 'todo', 'claude', 'system', 'stats', 'plan', 'clip'];
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
  pomodoro: (v) => {
    if (!v || typeof v !== 'object') return undefined;
    return { focus: int(5, 120)(v.focus) || 25, break: int(1, 30)(v.break) || 5, long: int(5, 60)(v.long) || 15, every: int(2, 8)(v.every) || 4 };
  },
  homeworkUrls: list(10, 500, isHttps),
  countdowns: (v) =>
    Array.isArray(v)
      ? v
          .filter((c) => c && typeof c.title === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c.date))
          .map((c) => ({ title: c.title.trim().slice(0, 60), date: c.date }))
          .filter((c) => c.title)
          .slice(0, 10)
      : undefined,
  notesFile: text(400),
  sleepReminder: bool,
  bedtime: (v) => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : undefined),
  screenTime: bool,
  privacyDots: bool,
  classMode: (v) => {
    if (!v || typeof v !== 'object') return undefined;
    const t = (x, d) => (typeof x === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(x) ? x : d);
    return {
      enabled: v.enabled === true,
      start: t(v.start, '08:00'),
      end: t(v.end, '15:30'),
      days: Array.isArray(v.days) ? [...new Set(v.days.map(Number).filter((d) => d >= 0 && d <= 6))] : [1, 2, 3, 4, 5],
      lockdown: v.lockdown !== false,
      quiet: v.quiet !== false,
    };
  },
  dailySummary: (v) => {
    if (!v || typeof v !== 'object') return undefined;
    return { enabled: v.enabled !== false, time: typeof v.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v.time) ? v.time : '21:30' };
  },
  voice: bool,
  aiProvider: oneOf('gemini', 'claude'),
  geminiModel: (v) => (typeof v === 'string' && /^[\w.-]{0,80}$/.test(v.trim()) ? v.trim() : undefined),
  claudeModel: (v) => (typeof v === 'string' && /^[\w.-]{0,80}$/.test(v.trim()) ? v.trim() : undefined),
  translateCopies: bool,
  spotifyClientId: (v) => (typeof v === 'string' && /^[0-9a-f]{0,64}$/i.test(v.trim()) ? v.trim() : undefined),
  flashcardsFolder: text(400),
  homeWidgets: (v) => (Array.isArray(v) ? [...new Set(v.filter((w) => typeof w === 'string' && WIDGETS.includes(w)))] : undefined),
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

module.exports = { sanitize, SCHEMA, WIDGETS };
