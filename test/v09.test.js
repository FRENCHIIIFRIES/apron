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

test('settings: notch priority, speed dial and hotspot are validated', () => {
  const { sanitize } = require('../src/settingsSchema');
  assert.deepStrictEqual(sanitize({ notchPriority: ['phone', 'music', 'hack', 'music'] }).notchPriority, ['phone', 'music']);
  assert.strictEqual(sanitize({ notchShow: 'music' }).notchShow, undefined); // only auto / rotate now
  assert.deepStrictEqual(sanitize({ speedDial: [{ name: 'Mom', number: '+91 98765 43210' }, { name: 'x', number: 'javascript:alert(1)' }] }).speedDial, [{ name: 'Mom', number: '+91 98765 43210' }]);
  assert.strictEqual(sanitize({ hotspot: 'Phone"; calc' }).hotspot, undefined);
  assert.strictEqual(sanitize({ hotspot: "Asha's Nothing Phone" }).hotspot, "Asha's Nothing Phone");
});
