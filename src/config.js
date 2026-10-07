const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// The installed app keeps its settings in %APPDATA%\Island so reinstalling doesn't wipe them.
function configDir() {
  try {
    const { app } = require('electron');
    if (app && app.isPackaged) return app.getPath('userData');
  } catch {
    // not running inside Electron (tests)
  }
  return ROOT;
}

const CONFIG_PATH = path.join(configDir(), 'config.json');
const EXAMPLE_PATH = path.join(ROOT, 'config.example.json');

const DEFAULTS = {
  icalUrls: [],
  display: 'primary',
  offsetY: 0,
  claudePort: 47777,
  calendarRefreshMinutes: 5,
  githubRefreshSeconds: 60,
  accent: '#d71921',
  startWithWindows: true,
  artColor: false,
  displays: 'all', // 'all' screens or 'primary'
  weatherCity: '', // e.g. "Hyderabad, IN"
  notifications: true,
  clipboard: true,
  lockdown: {}, // { extraSites: [], allowSites: [], unblock: [], apps: [] }
  lockdownDefault: true, // lockdown switched on when you start a focus timer
  rotateSeconds: 6, // how long each item shows in the closed notch
  lyrics: true,
  peek: true, // widen the notch briefly when the song changes
  units: 'c', // 'c' or 'f'
  claudeApprovals: true, // Allow/Deny permission requests from the notch
  pomodoro: { focus: 25, break: 5, long: 15, every: 4 },
  homeworkUrls: [], // ManageBac / Classroom calendar feeds (iCal)
  countdowns: [], // [{ title, date: 'YYYY-MM-DD' }]
  notesFile: '', // empty = "Apron Inbox.md" in your Obsidian vault
  sleepReminder: false,
  bedtime: '23:00',
  screenTime: true,
  privacyDots: true,
  aiKeyEnc: '', // Anthropic API key, encrypted with Windows' DPAPI (safeStorage)
  classMode: { enabled: false, start: '08:00', end: '15:30', days: [1, 2, 3, 4, 5], lockdown: true, quiet: true },
  dailySummary: { enabled: true, time: '21:30' },
  voice: false, // "Hey Apron" voice commands (offline)
  aiProvider: 'gemini', // 'gemini' or 'claude' for Ask, translation and the planner
  geminiKeyEnc: '', // Google AI Studio key, encrypted like aiKeyEnc
  geminiModel: '', // empty = ai.js default
  claudeModel: '',
  translateCopies: false,
  spotifyClientId: '',
  spotifyRefreshEnc: '',
  flashcardsFolder: '', // empty = your Obsidian vault
  homeWidgets: ['music', 'apps', 'next', 'weather', 'due', 'focus', 'todo', 'claude', 'system'],
  dockOrder: ['home', 'media', 'calendar', 'claude', 'timer', 'todo', 'clip', 'sys'],
  dockHidden: [],
  notchShow: 'auto', // closed notch: 'auto', 'rotate', or one thing ('music', 'next', 'weather', 'clock', ...)
  pinnedApps: [], // [{ name, path }] from the Start menu / Desktop
};

const HEX = /^#[0-9a-f]{6}$/i;

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) fs.copyFileSync(EXAMPLE_PATH, CONFIG_PATH);
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    console.error('[config] config.json is not valid JSON, using defaults:', err.message);
  }
  const config = { ...DEFAULTS, ...user };
  if (typeof config.icalUrls === 'string') config.icalUrls = [config.icalUrls];
  config.icalUrls = config.icalUrls.filter((u) => typeof u === 'string' && u.trim());
  if (!HEX.test(config.accent)) config.accent = DEFAULTS.accent;
  config.accent = config.accent.toLowerCase();
  config.artColor = config.artColor === true;
  return config;
}

/** Merge `patch` into config.json, keeping whatever else the user wrote there. */
function saveConfig(patch) {
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    // unreadable file: start fresh rather than lose the change
  }
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify({ ...user, ...patch }, null, 2)}\n`);
}

module.exports = { loadConfig, saveConfig, CONFIG_PATH, HEX };
