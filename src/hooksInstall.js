// Adds/removes Apron's Claude Code hooks in ~/.claude/settings.json. Used by the
// Settings window ("Connect Claude Code") and by scripts/install-hooks.js.
// Existing hooks are left untouched; installing twice is a no-op.
const fs = require('fs');
const os = require('os');
const path = require('path');

const EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure'];
// Old (island-hook.js) and current (apron-hook.js) entries are both treated as ours.
const MARKERS = ['island-hook.js', 'apron-hook.js'];
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const TARGET = path.join(APPDATA, 'Apron', 'apron-hook.js');
const SOURCE = path.join(__dirname, '..', 'hooks', 'apron-hook.js');

const isOurs = (group) => (group.hooks || []).some((h) => MARKERS.some((m) => String(h.command || '').includes(m)));

function read() {
  return fs.existsSync(SETTINGS) ? fs.readFileSync(SETTINGS, 'utf8') : '{}';
}

/** true when every event has an Apron hook. */
function status() {
  try {
    const hooks = JSON.parse(read()).hooks || {};
    return EVENTS.every((e) => (hooks[e] || []).some(isOurs));
  } catch {
    return false;
  }
}

/** Returns 'unchanged' | 'installed' | 'removed' | 'would-change'. */
function run({ uninstall = false, dryRun = false } = {}) {
  const before = read();
  const settings = JSON.parse(before);
  settings.hooks = settings.hooks || {};
  const command = `node "${TARGET.replace(/\\/g, '/')}"`;
  for (const event of EVENTS) {
    const groups = (settings.hooks[event] || []).filter((g) => !isOurs(g));
    // PermissionRequest waits for Allow/Deny from the notch; everything else is fire-and-forget.
    if (!uninstall) groups.push({ hooks: [{ type: 'command', command, timeout: event === 'PermissionRequest' ? 120 : 5 }] });
    if (groups.length) settings.hooks[event] = groups;
    else delete settings.hooks[event];
  }
  const after = `${JSON.stringify(settings, null, 2)}\n`;
  if (!uninstall) {
    fs.mkdirSync(path.dirname(TARGET), { recursive: true });
    if (!dryRun) fs.copyFileSync(SOURCE, TARGET);
  }
  if (after.trim() === before.trim()) return 'unchanged';
  if (dryRun) return 'would-change';
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, `${SETTINGS}.apron-backup`);
  fs.writeFileSync(SETTINGS, after);
  return uninstall ? 'removed' : 'installed';
}

module.exports = { run, status, EVENTS, SETTINGS, TARGET };
