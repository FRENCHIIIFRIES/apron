const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('launcher: prefixes, apps, sites and fallbacks', () => {
  const { search } = require('../src/launcher');
  const index = [
    { name: 'Spotify', path: 'C:/x/Spotify.lnk', type: 'app' },
    { name: 'Visual Studio Code', path: 'C:/x/Code.lnk', type: 'app' },
    { name: 'Discord', path: 'C:/x/Discord.lnk', type: 'app' },
  ];
  assert.strictEqual(search(index, 'spo')[0].title, 'Spotify');
  assert.strictEqual(search(index, 'vsc')[0].title, 'Visual Studio Code'); // initials
  assert.deepStrictEqual(search(index, 'n buy graph paper')[0], { kind: 'note', title: 'buy graph paper', hint: 'Save note' });
  assert.strictEqual(search(index, 't maths homework')[0].kind, 'todo');
  assert.strictEqual(search(index, '? what is a vertex')[0].kind, 'ask');
  const site = search(index, 'managebac.com');
  assert.strictEqual(site[0].kind, 'url');
  assert.strictEqual(site[0].url, 'https://managebac.com');
  const results = search(index, 'how do vertex forms work');
  assert.ok(results.some((r) => r.kind === 'ask'));
  assert.strictEqual(results[results.length - 1].kind, 'search');
});

test('notes: appended under a dated heading', () => {
  const { append } = require('../src/notes');
  const file = path.join(os.tmpdir(), `apron-notes-${process.pid}.md`);
  fs.rmSync(file, { force: true });
  const day = new Date(2026, 9, 7, 9, 5);
  append({ notesFile: file }, 'first idea', day);
  append({ notesFile: file }, 'second\nline', new Date(2026, 9, 7, 9, 6));
  append({ notesFile: file }, 'next day', new Date(2026, 9, 8, 8, 0));
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '## 2026-10-07\n\n- 09:05 first idea\n- 09:06 second line\n\n## 2026-10-08\n\n- 08:00 next day\n');
  fs.rmSync(file, { force: true });
});

test('pomodoro: focus -> break, long break every N rounds', () => {
  const { nextPhase } = require('../src/stores');
  const p = { focus: 25, break: 5, long: 15, every: 4 };
  assert.deepStrictEqual(nextPhase({ phase: 'focus', round: 1 }, p), { phase: 'break', round: 1, minutes: 5 });
  assert.deepStrictEqual(nextPhase({ phase: 'break', round: 1 }, p), { phase: 'focus', round: 2, minutes: 25 });
  assert.deepStrictEqual(nextPhase({ phase: 'focus', round: 4 }, p), { phase: 'long', round: 4, minutes: 15 });
});

test('focus streak counts consecutive days, alive until tomorrow', () => {
  const { statsStore } = require('../src/stores');
  const file = path.join(os.tmpdir(), `apron-stats-${process.pid}.json`);
  const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const ago = (n) => new Date(Date.now() - n * 864e5);
  fs.writeFileSync(file, JSON.stringify({ days: { [key(ago(1))]: 2, [key(ago(2))]: 1, [key(ago(4))]: 3 } }));
  let last;
  const stats = statsStore(file, (v) => (last = v));
  assert.deepStrictEqual([last.today, last.streak], [0, 2]); // yesterday + the day before
  stats.completeFocus(25);
  assert.deepStrictEqual([last.today, last.streak], [1, 3]);
  fs.rmSync(file, { force: true });
});

test('screen time buckets: distracting sites, YouTube, apps; ignores the shell', () => {
  const { bucket } = require('../src/screentime');
  const { judge, compile } = require('../src/lockdown');
  const j = (fg) => judge(fg, compile({}));
  assert.strictEqual(bucket({ exe: 'chrome', title: 'Instagram - Google Chrome' }, j), 'Instagram');
  assert.strictEqual(bucket({ exe: 'chrome', title: 'lofi beats - YouTube - Google Chrome' }, j), 'YouTube');
  assert.strictEqual(bucket({ exe: 'msedge', title: 'Khan Academy' }, j), 'Browsing');
  assert.strictEqual(bucket({ exe: 'Code', title: 'app.js - apron' }, j), 'Code');
  assert.strictEqual(bucket({ exe: 'explorer', title: '' }, j), null);
});

test('share falls back to a Spotify search link', () => {
  const { searchLink } = require('../src/share');
  assert.strictEqual(searchLink('Origami', 'The Rare Occasions'), 'https://open.spotify.com/search/Origami%20The%20Rare%20Occasions');
});
