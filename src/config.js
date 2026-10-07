const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
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
