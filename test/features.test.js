const test = require('node:test');
const assert = require('node:assert');
const { judge, compile } = require('../src/lockdown');
const { parsePayload, appLabel, filetimeToMs } = require('../src/notifications');
const { parseLrc, lineAt, cleanTitle } = require('../src/lyrics');
const { rainChanceAt, describe } = require('../src/weather');
const { looksSecret } = require('../src/stores');
const { reduce } = require('../src/claude');

const rules = compile({});
const tab = (title, exe = 'chrome') => judge({ hwnd: '1', exe, title }, rules);

test('lockdown closes distracting tabs', () => {
  assert.deepStrictEqual(tab('(1) Instagram - Google Chrome'), { action: 'closetab', label: 'Instagram' });
  assert.strictEqual(tab('Home / X - Google Chrome').label, 'X');
  assert.strictEqual(tab('r/funny - Reddit', 'msedge').action, 'closetab');
  assert.strictEqual(tab('Netflix', 'firefox').label, 'Netflix');
});

test('lockdown leaves YouTube, Spotify and normal work alone', () => {
  assert.strictEqual(tab('Instagram growth tips - YouTube - Google Chrome'), null);
  assert.strictEqual(tab('Spotify - Web Player: Music for everyone'), null);
  assert.strictEqual(tab('Standard and vertex form - Claude - Google Chrome'), null);
  assert.strictEqual(tab('Maths homework.docx - Word', 'WINWORD'), null);
  assert.strictEqual(tab('Exposé - Wikipedia'), null);
});

test('lockdown minimises matching non-browser windows and honours config', () => {
  assert.strictEqual(tab('#general | Friends - Discord', 'Discord').action, 'minimize');
  const custom = compile({ lockdown: { extraSites: ['chess.com'], unblock: ['Discord'], apps: ['RobloxPlayerBeta.exe'] } });
  assert.strictEqual(judge({ exe: 'chrome', title: 'Play chess.com' }, custom).label, 'chess.com');
  assert.strictEqual(judge({ exe: 'Discord', title: 'Discord' }, custom), null);
  assert.strictEqual(judge({ exe: 'RobloxPlayerBeta', title: 'Roblox' }, custom).action, 'minimize');
});

test('notifications: payload text and app names', () => {
  const xml = '<toast><visual><binding template="ToastGeneric"><text>Aisha</text><text>are you coming? &amp; bring notes</text></binding></visual></toast>';
  assert.deepStrictEqual(parsePayload(xml), { title: 'Aisha', body: 'are you coming? & bring notes' });
  assert.deepStrictEqual(appLabel('Microsoft.YourPhone_8wekyb3d8bbwe!YourPhoneNotifications_com.instagram.android'), { name: 'Instagram', phone: true, pkg: 'com.instagram.android' });
  assert.strictEqual(appLabel('5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App').name, 'WhatsApp');
  assert.strictEqual(filetimeToMs('116444736000000000'), 0);
});

test('lyrics: LRC parsing, line lookup and title cleanup', () => {
  const lines = parseLrc('[00:01.00] first\n[00:05.50]second\n[00:03.00][00:09.00] chorus\nnot a line');
  assert.deepStrictEqual(lines.map((l) => l.text), ['first', 'chorus', 'second', 'chorus']);
  assert.strictEqual(lineAt(lines, 0.5), -1);
  assert.strictEqual(lines[lineAt(lines, 6)].text, 'second');
  assert.strictEqual(cleanTitle('Revelations - 1998 Remastered Version'), 'Revelations');
  assert.strictEqual(cleanTitle('Sunshine (feat. Fousheé)'), 'Sunshine');
});

test('weather: rain lookup by local hour and code labels', () => {
  const hourly = { time: ['2026-10-07T14:00', '2026-10-07T15:00'], precipitation_probability: [10, 80] };
  assert.strictEqual(rainChanceAt(hourly, new Date(2026, 9, 7, 15, 35).getTime()), 80);
  assert.strictEqual(rainChanceAt(hourly, new Date(2026, 9, 8, 9, 0).getTime()), null);
  assert.strictEqual(describe(63).label, 'Rain');
});

test('clipboard masks things that look like passwords or tokens', () => {
  assert.strictEqual(looksSecret('gho_A1b2C3d4E5f6G7h8'), true);
  assert.strictEqual(looksSecret('hello world'), false);
  assert.strictEqual(looksSecret('https://github.com/FRENCHIIIFRIES/apron'), false);
});

test('claude: permission requests carry what to approve', () => {
  const s = reduce({}, { session_id: 'a', cwd: 'C:\\x\\emb3r', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'npm test' } }, 1);
  assert.deepStrictEqual(s.a.approval, { id: 't1', tool: 'Bash', detail: 'npm test' });
  const n = reduce(s, { session_id: 'a', hook_event_name: 'Notification', message: 'Claude needs your permission' }, 2);
  assert.strictEqual(n.a.approval.id, 't1');
  assert.strictEqual(reduce(n, { session_id: 'a', hook_event_name: 'PostToolUse' }, 3).a.approval, undefined);
});

test('phone extras: one-time codes and incoming calls', () => {
  const { detectCode, isCall } = require('../src/notifications');
  assert.strictEqual(detectCode('Instagram', '482913 is your Instagram code. Don\'t share it.'), '482913');
  assert.strictEqual(detectCode('Messages', 'G-731204 is your Google verification code.'), '731204');
  assert.strictEqual(detectCode('Bank', 'Your OTP for login is 5521. Valid for 5 mins'), '5521');
  assert.strictEqual(detectCode('Aisha', 'see you at 2025 reunion, 3:30?'), null);
  assert.strictEqual(detectCode('Swiggy', 'Your order of ₹4500 is on the way'), null);
  assert.strictEqual(isCall('Microsoft.YourPhone_8wekyb3d8bbwe!App', 'Mom', 'Incoming call'), true);
  assert.strictEqual(isCall('Microsoft.YourPhone_8wekyb3d8bbwe!YourPhoneNotifications_com.whatsapp', 'Mom', 'Incoming voice call'), false);
});

test('settings: only known keys with sane values get through', () => {
  const { sanitize } = require('../src/settingsSchema');
  assert.deepStrictEqual(sanitize({ accent: '#ABCDEF', offsetY: 999, rotateSeconds: '4', evil: 1, lyrics: 'yes', units: 'k' }), { accent: '#abcdef', offsetY: 60, rotateSeconds: 4 });
  assert.deepStrictEqual(sanitize({ icalUrls: ['https://a.ics', 'http://b.ics', 'javascript:x', 'https://a.ics'] }), { icalUrls: ['https://a.ics'] });
  const ld = sanitize({ lockdown: { extraSites: [' chess.com ', ''], apps: ['Steam.exe', 'rm -rf /;'], other: 1 } }).lockdown;
  assert.deepStrictEqual(ld, { extraSites: ['chess.com'], allowSites: [], unblock: [], apps: ['Steam.exe'] });
});
