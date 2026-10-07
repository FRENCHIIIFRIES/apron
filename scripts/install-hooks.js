// Adds (or removes) Apron's Claude Code hooks in ~/.claude/settings.json.
// Existing hooks are left untouched; running it twice is a no-op.
//   node scripts/install-hooks.js            install
//   node scripts/install-hooks.js --dry-run  show what would change
//   node scripts/install-hooks.js --uninstall
const fs = require('fs');
const os = require('os');
const path = require('path');

const EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure'];
// Old (island-hook.js) and current (apron-hook.js) entries are both treated as ours.
const MARKERS = ['island-hook.js', 'apron-hook.js'];
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
// Hooks run a copy in %APPDATA%\Apron (the app also refreshes it on every start),
// so they keep working wherever the app or this repo lives.
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const target = path.join(appData, 'Apron', 'apron-hook.js');
const script = target.replace(/\\/g, '/');
const command = `node "${script}"`;

const dryRun = process.argv.includes('--dry-run');
const uninstall = process.argv.includes('--uninstall');

const before = fs.existsSync(SETTINGS) ? fs.readFileSync(SETTINGS, 'utf8') : '{}';
const settings = JSON.parse(before);
settings.hooks = settings.hooks || {};

const isOurs = (group) => (group.hooks || []).some((h) => MARKERS.some((m) => String(h.command || '').includes(m)));

for (const event of EVENTS) {
  const groups = (settings.hooks[event] || []).filter((g) => !isOurs(g));
  // PermissionRequest waits for Allow/Deny from the notch; everything else is fire-and-forget.
  if (!uninstall) groups.push({ hooks: [{ type: 'command', command, timeout: event === 'PermissionRequest' ? 120 : 5 }] });
  if (groups.length) settings.hooks[event] = groups;
  else delete settings.hooks[event];
}

const after = `${JSON.stringify(settings, null, 2)}\n`;
if (after.trim() === before.trim()) {
  console.log('Nothing to change.');
  process.exit(0);
}

if (dryRun) {
  console.log(`Would ${uninstall ? 'remove' : 'add'} this hook on: ${EVENTS.join(', ')}`);
  console.log(`  ${command}`);
  console.log(`in ${SETTINGS}`);
  process.exit(0);
}

if (!uninstall) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'hooks', 'apron-hook.js'), target);
}
fs.copyFileSync(SETTINGS, `${SETTINGS}.apron-backup`);
fs.writeFileSync(SETTINGS, after);
console.log(`${uninstall ? 'Removed' : 'Installed'} Apron hooks in ${SETTINGS} (backup: settings.json.apron-backup)`);
