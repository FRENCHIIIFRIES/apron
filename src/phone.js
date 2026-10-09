// Your phone, through Phone Link: recent messages and missed calls (from the notifications
// Phone Link mirrors), where Reply and Call back should go, speed dial and the hotspot.
const { execFile } = require('child_process');

const MAX_MESSAGES = 6;
const MAX_CALLS = 5;

/** A phone number in the text, as dialable digits ("+91 98765 43210" -> "+919876543210"). */
function extractNumber(text) {
  const m = String(text || '').match(/(\+?\d[\d\s()-]{6,18}\d)/);
  if (!m) return null;
  const digits = m[1].replace(/[^\d+]/g, '');
  return digits.replace(/\D/g, '').length >= 7 ? digits : null;
}

/** Speed-dial numbers must look like phone numbers; returns the dialable form or null. */
function cleanNumber(n) {
  const s = String(n || '').trim();
  if (!/^\+?[\d\s()-]{3,24}$/.test(s)) return null;
  const digits = s.replace(/[^\d+]/g, '');
  return /^\+?\d{3,18}$/.test(digits) ? digits : null;
}

/**
 * Where "Reply" goes for a message: Phone Link's own messages for SMS, the app on this PC
 * when there is one (WhatsApp, Telegram, Discord), else its website, else Phone Link.
 * findApp(name) -> launcher path or null.
 */
function replyTarget(msg, findApp = () => null) {
  const pkg = String((msg && msg.pkg) || '');
  const name = String((msg && msg.app) || '');
  if (/messaging|\.mms|sms/i.test(pkg) || /^messages$/i.test(name)) return { url: 'sms:' };
  const web = {
    WhatsApp: 'https://web.whatsapp.com/',
    Telegram: 'https://web.telegram.org/',
    Instagram: 'https://www.instagram.com/direct/inbox/',
    Discord: 'https://discord.com/channels/@me',
    Gmail: 'https://mail.google.com/',
    Snapchat: 'https://web.snapchat.com/',
  }[name];
  const app = findApp(name);
  if (app) return { app };
  if (web) return { url: web };
  return { url: 'ms-phone:' };
}

/** Who called: Phone Link puts the name in the title or the body, next to "Missed call". */
function caller(n) {
  const strip = (s) => String(s || '').replace(/missed (voice |video )?call( from)?:?/i, '').replace(/^[\s·:,-]+|[\s·:,-]+$/g, '');
  return strip(n.title) || strip(n.body) || 'Unknown';
}

/** Keeps the latest phone messages and missed calls. onChange({ messages, calls }). */
function inbox(onChange) {
  let messages = [];
  let calls = [];
  const emit = () => onChange({ messages, calls });
  emit();
  return {
    /** n: a notification from notifications.js. */
    add(n) {
      if (!n || n.code || n.call) return;
      if (n.missed) {
        const who = caller(n);
        calls = [{ id: `${n.at}`, name: who.slice(0, 60), number: extractNumber(`${n.title} ${n.body}`), at: n.at }, ...calls].slice(0, MAX_CALLS);
      } else if (n.phone || /whatsapp|telegram/i.test(n.name || '')) {
        messages = [
          { id: `${n.at}`, app: String(n.name || '').slice(0, 30), pkg: n.pkg || '', title: String(n.title || '').slice(0, 80), body: String(n.body || '').slice(0, 200), at: n.at },
          ...messages,
        ].slice(0, MAX_MESSAGES);
      } else return;
      emit();
    },
    message: (id) => messages.find((m) => m.id === id) || null,
    call: (id) => calls.find((c) => c.id === id) || null,
    dismiss(id) {
      messages = messages.filter((m) => m.id !== id);
      calls = calls.filter((c) => c.id !== id);
      emit();
    },
  };
}

/** `netsh wlan show profiles` lists each saved network as an indented "All User Profile : <name>". */
function parseProfiles(out) {
  const names = [...String(out || '').matchAll(/^[ \t]+[^:\r\n]+?[ \t]*:[ \t]*([^\r\n]+?)[ \t]*\r?$/gm)].map((m) => m[1]).filter((n) => n.length <= 64);
  return [...new Set(names)];
}

/** Saved Wi-Fi networks (for picking the phone's hotspot in Settings). */
function wifiProfiles() {
  return new Promise((resolve) => {
    execFile('netsh', ['wlan', 'show', 'profiles'], { windowsHide: true, timeout: 10000 }, (err, out) => {
      if (err) return resolve([]);
      resolve(parseProfiles(out));
    });
  });
}

/** Joins a saved Wi-Fi network by name (only names netsh already knows). */
async function connectWifi(name) {
  const known = await wifiProfiles();
  if (!known.includes(name)) throw new Error(`"${name}" isn't a saved Wi-Fi network`);
  return new Promise((resolve, reject) => {
    execFile('netsh', ['wlan', 'connect', `name=${name}`], { windowsHide: true, timeout: 15000 }, (err, out) => (err ? reject(new Error(String(out || err.message).trim())) : resolve()));
  });
}

module.exports = { extractNumber, cleanNumber, replyTarget, caller, inbox, parseProfiles, wifiProfiles, connectWifi };
