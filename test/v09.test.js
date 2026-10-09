const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('voice commands: cleaned up from what Gemini returns', () => {
  const { clean } = require('../src/voiceCommand');
  assert.deepStrictEqual(clean({ transcript: 'put a half hour timer', action: 'timer', minutes: 30 }), { transcript: 'put a half hour timer', action: 'timer', minutes: 30 });
  assert.strictEqual(clean({ transcript: 'x', action: 'timer' }).minutes, 25);
  assert.strictEqual(clean({ transcript: 'x', action: 'timer', minutes: 9999 }).minutes, 240);
  assert.strictEqual(clean({ transcript: 'rm -rf', action: 'delete everything' }).action, 'none');
  assert.deepStrictEqual(clean({ transcript: 'open spotify', action: 'open', text: '  Spotify ' }), { transcript: 'open spotify', action: 'open', text: 'Spotify' });
  assert.strictEqual(clean(null).action, 'none');
});

test('gemini request carries the audio clip', () => {
  const { geminiBody } = require('../src/ai');
  const body = geminiBody({ text: 'clip', audio: 'UklGRg==' });
  assert.deepStrictEqual(body.contents[0].parts[0], { inline_data: { mime_type: 'audio/wav', data: 'UklGRg==' } });
});

test('phone: numbers, reply targets, missed calls and messages', () => {
  const phone = require('../src/phone');
  assert.strictEqual(phone.extractNumber('Missed call from +91 98765 43210'), '+919876543210');
  assert.strictEqual(phone.extractNumber('Missed call · Mom'), null);
  assert.strictEqual(phone.cleanNumber('+91 (987) 654-3210'), '+919876543210');
  assert.strictEqual(phone.cleanNumber('call me; rm -rf'), null);
  assert.deepStrictEqual(phone.replyTarget({ app: 'Messages', pkg: 'com.google.android.apps.messaging' }), { url: 'sms:' });
  assert.deepStrictEqual(phone.replyTarget({ app: 'WhatsApp', pkg: 'com.whatsapp' }, (n) => (n === 'WhatsApp' ? 'shell:AppsFolder\\5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App' : null)), { app: 'shell:AppsFolder\\5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App' });
  assert.deepStrictEqual(phone.replyTarget({ app: 'WhatsApp' }), { url: 'https://web.whatsapp.com/' });
  assert.deepStrictEqual(phone.replyTarget({ app: 'Zomato' }), { url: 'ms-phone:' });

  // Phone Link puts the caller in the title or in the body.
  assert.strictEqual(phone.caller({ title: 'Missed call', body: 'Mom' }), 'Mom');
  assert.strictEqual(phone.caller({ title: 'Mom', body: 'Missed call' }), 'Mom');
  assert.strictEqual(phone.caller({ title: 'Missed voice call', body: '' }), 'Unknown');

  let seen = null;
  const box = phone.inbox((v) => (seen = v));
  box.add({ name: 'Phone', phone: true, missed: true, title: 'Missed call', body: 'Mom', at: 1 });
  box.add({ name: 'WhatsApp', phone: true, pkg: 'com.whatsapp', title: 'Riya', body: 'maths hw?', at: 2 });
  box.add({ name: 'Bank', phone: true, code: '123456', title: 'OTP', at: 3 }); // codes don't go in the inbox
  box.add({ name: 'Discord', phone: false, title: 'server', at: 4 }); // not from the phone
  assert.strictEqual(seen.calls.length, 1);
  assert.deepStrictEqual(seen.messages.map((m) => m.title), ['Riya']);
  box.dismiss('2');
  assert.strictEqual(seen.messages.length, 0);

  const netsh = 'Profiles on interface Wi-Fi:\r\n\r\nGroup policy profiles (read only)\r\n---------------------------------\r\n    <None>\r\n\r\nUser profiles\r\n-------------\r\n    All User Profile     : School-WiFi\r\n    All User Profile     : Asha\'s Nothing Phone\r\n';
  assert.deepStrictEqual(phone.parseProfiles(netsh), ['School-WiFi', "Asha's Nothing Phone"]);
});

test('missed calls are told apart from incoming ones', () => {
  const { isMissedCall, isCall } = require('../src/notifications');
  const app = 'Microsoft.YourPhone_8wekyb3d8bbwe!App';
  assert.strictEqual(isMissedCall(app, 'Missed call', 'Mom'), true);
  assert.strictEqual(isMissedCall(app, 'Dismissed', 'calling'), false);
  assert.strictEqual(isCall(app, 'Mom', 'Incoming voice call'), true);
});

test('shelf: keeps real files, newest first, no duplicates', () => {
  const { shelfStore } = require('../src/shelf');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apron-shelf-'));
  try {
    const a = path.join(dir, 'essay.docx');
    const b = path.join(dir, 'graph.png');
    fs.writeFileSync(a, 'hello');
    fs.writeFileSync(b, 'png');
    let items = [];
    const shelf = shelfStore(path.join(dir, 'shelf.json'), (v) => (items = v));
    assert.strictEqual(shelf.add([a, 'relative/path.txt', path.join(dir, 'missing.txt')]), 1);
    shelf.add([b, a]);
    assert.deepStrictEqual(items.map((i) => i.name), ['graph.png', 'essay.docx']);
    assert.strictEqual(shelf.has(a), true);
    assert.strictEqual(shelf.has('C:\\Windows\\System32\\cmd.exe'), false);
    // survives a restart
    const again = shelfStore(path.join(dir, 'shelf.json'), (v) => (items = v));
    assert.strictEqual(again.list().length, 2);
    again.remove(b);
    assert.deepStrictEqual(items.map((i) => i.name), ['essay.docx']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('screenshots: a new image on the clipboard peeks once; text and old images do not', async () => {
  const { screenshotWatcher } = require('../src/screenshots');
  // A stand-in for Electron's clipboard and NativeImage.
  const image = (id, w = 1920, h = 1080) => ({
    isEmpty: () => false,
    getSize: () => ({ width: w, height: h }),
    resize: () => image(id, 48, 27),
    toBitmap: () => Buffer.from(`pixels-${id}`),
    toDataURL: () => `data:image/png;base64,${id}`,
    toJPEG: () => Buffer.from(`jpeg-${id}`),
    toPNG: () => Buffer.from(`png-${id}`),
  });
  let current = image('old'); // already there when Apron starts
  const clipboard = { availableFormats: () => (current ? ['image/png'] : ['text/plain']), readImage: () => current };
  const shots = [];
  const w = screenshotWatcher(clipboard, (s) => shots.push(s));
  const tick = () => new Promise((r) => setTimeout(r, 1100));
  try {
    await tick();
    assert.strictEqual(shots.length, 0, 'an image from before start is not new');
    current = image('new');
    await tick();
    await tick();
    assert.strictEqual(shots.length, 1, 'the new screenshot peeks exactly once');
    assert.deepStrictEqual([shots[0].width, shots[0].height], [1920, 1080]);
    assert.strictEqual(w.jpeg(), Buffer.from('jpeg-new').toString('base64'));
    current = null; // copied some text
    await tick();
    assert.strictEqual(shots.length, 1);
  } finally {
    w.stop();
  }
});

test('calendar links: recognised when copied or pasted, and sent to the right place', () => {
  const { feedLink, googleSubscribeUrl } = require('../src/calendar');
  const mb = feedLink('webcal://school.managebac.com/student/events/token/0000-aaaa.ics');
  assert.deepStrictEqual(mb, { url: 'https://school.managebac.com/student/events/token/0000-aaaa.ics', kind: 'homework', source: 'ManageBac' });
  const g = feedLink('https://calendar.google.com/calendar/ical/someone%40example.org/private-abc/basic.ics');
  assert.deepStrictEqual([g.kind, g.source], ['calendar', 'Google Calendar']);
  const cls = feedLink('https://calendar.google.com/calendar/ical/classroom123%40group.calendar.google.com/private-x/basic.ics');
  assert.deepStrictEqual([cls.kind, cls.source], ['homework', 'Google Classroom']);
  assert.strictEqual(feedLink('https://example.org/term.ics').source, 'example.org');
  // not calendar links
  for (const t of ['https://www.youtube.com/watch?v=1', 'https://calendar.google.com/calendar/u/0/r', 'hello world', 'http://example.org/a.ics', '']) assert.strictEqual(feedLink(t), null, t);
  // Google's own "Add this calendar?" prompt
  assert.strictEqual(googleSubscribeUrl(mb.url), 'https://calendar.google.com/calendar/r?cid=webcal%3A%2F%2Fschool.managebac.com%2Fstudent%2Fevents%2Ftoken%2F0000-aaaa.ics');

  const launcher = require('../src/launcher');
  const res = launcher.search([], 'webcal://school.managebac.com/student/events/token/0000-aaaa.ics');
  assert.deepStrictEqual(res.map((r) => r.kind), ['addfeed', 'gsub']);
  assert.match(res[0].title, /ManageBac/);
});

test('settings: notch priority, speed dial and hotspot are validated', () => {
  const { sanitize } = require('../src/settingsSchema');
  assert.deepStrictEqual(sanitize({ notchPriority: ['phone', 'music', 'hack', 'music'] }).notchPriority, ['phone', 'music']);
  assert.strictEqual(sanitize({ notchShow: 'music' }).notchShow, undefined); // only auto / rotate now
  assert.deepStrictEqual(sanitize({ speedDial: [{ name: 'Mom', number: '+91 98765 43210' }, { name: 'x', number: 'javascript:alert(1)' }] }).speedDial, [{ name: 'Mom', number: '+91 98765 43210' }]);
  assert.strictEqual(sanitize({ hotspot: 'Phone"; calc' }).hotspot, undefined);
  assert.strictEqual(sanitize({ hotspot: "Asha's Nothing Phone" }).hotspot, "Asha's Nothing Phone");
});
