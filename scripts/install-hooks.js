// Adds (or removes) Apron's Claude Code hooks in ~/.claude/settings.json.
//   node scripts/install-hooks.js            install
//   node scripts/install-hooks.js --dry-run  show what would change
//   node scripts/install-hooks.js --uninstall
const { run, EVENTS, SETTINGS, TARGET } = require('../src/hooksInstall');

const uninstall = process.argv.includes('--uninstall');
const dryRun = process.argv.includes('--dry-run');
const result = run({ uninstall, dryRun });

if (result === 'unchanged') console.log('Nothing to change.');
else if (result === 'would-change') {
  console.log(`Would ${uninstall ? 'remove' : 'add'} this hook on: ${EVENTS.join(', ')}`);
  console.log(`  node "${TARGET.replace(/\\/g, '/')}"`);
  console.log(`in ${SETTINGS}`);
} else console.log(`${uninstall ? 'Removed' : 'Installed'} Apron hooks in ${SETTINGS} (backup: settings.json.apron-backup)`);
