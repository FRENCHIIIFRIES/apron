// Adds (or removes) the island's Claude Code hooks in ~/.claude/settings.json.
// Existing hooks are left untouched; running it twice is a no-op.
//   node scripts/install-hooks.js            install
//   node scripts/install-hooks.js --dry-run  show what would change
//   node scripts/install-hooks.js --uninstall
const fs = require('fs');
const os = require('os');
const path = require('path');

const EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure'];
const MARKER = 'island-hook.js';
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const script = path.resolve(__dirname, '..', 'hooks', MARKER).replace(/\\/g, '/');
const command = `node "${script}"`;

const dryRun = process.argv.includes('--dry-run');
const uninstall = process.argv.includes('--uninstall');

const before = fs.existsSync(SETTINGS) ? fs.readFileSync(SETTINGS, 'utf8') : '{}';
const settings = JSON.parse(before);
settings.hooks = settings.hooks || {};

const isOurs = (group) => (group.hooks || []).some((h) => String(h.command || '').includes(MARKER));

for (const event of EVENTS) {
  const groups = (settings.hooks[event] || []).filter((g) => !isOurs(g));
  if (!uninstall) groups.push({ hooks: [{ type: 'command', command, timeout: 5 }] });
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

fs.copyFileSync(SETTINGS, `${SETTINGS}.island-backup`);
fs.writeFileSync(SETTINGS, after);
console.log(`${uninstall ? 'Removed' : 'Installed'} island hooks in ${SETTINGS} (backup: settings.json.island-backup)`);
