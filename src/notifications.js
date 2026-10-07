// Mirrors Windows notifications (Discord, WhatsApp, your phone via Phone Link, ...) into
// the notch by reading the Windows notification database (read-only). Desktop apps
// can't use the notification listener API without Store packaging, so this is the route.
const os = require('os');
const path = require('path');

const DB = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Microsoft', 'Windows', 'Notifications', 'wpndatabase.db');
const FILETIME_EPOCH_MS = 11644473600000n;

const KNOWN = {
  'com.instagram.android': 'Instagram',
  'com.whatsapp': 'WhatsApp',
  'com.whatsapp.w4b': 'WhatsApp',
  'com.discord': 'Discord',
  'com.snapchat.android': 'Snapchat',
  'org.telegram.messenger': 'Telegram',
  'com.google.android.gm': 'Gmail',
  'com.google.android.apps.messaging': 'Messages',
  'com.google.android.youtube': 'YouTube',
  'com.spotify.music': 'Spotify',
};

// Apps we never mirror (ourselves, Claude, Windows chatter).
const SKIP = /claude|apron|electron|windows\.|microsoft\.windows|securityhealth|windowsupdate/i;

/** "Microsoft.YourPhone_...!YourPhoneNotifications_com.instagram.android" -> "Instagram" (phone). */
function appLabel(aumid) {
  const id = String(aumid || '');
  const phone = id.match(/YourPhoneNotifications_(.+)$/);
  if (phone) return { name: KNOWN[phone[1]] || phone[1].split('.').pop(), phone: true };
  if (/whatsapp/i.test(id)) return { name: 'WhatsApp', phone: false };
  if (/discord/i.test(id)) return { name: 'Discord', phone: false };
  if (/telegram/i.test(id)) return { name: 'Telegram', phone: false };
  const base = id.split('!').pop().split(/[\\/]/).pop().replace(/\.exe$/i, '');
  return { name: base.split(/[._]/).filter(Boolean).pop() || base, phone: false };
}

const decode = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');

/** Toast XML -> { title, body } from its <text> elements. */
function parsePayload(xml) {
  const texts = [...String(xml || '').matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gi)].map((m) => decode(m[1]).trim()).filter(Boolean);
  return { title: texts[0] || '', body: texts.slice(1).join(' · ') };
}

/** A one-time / 2FA code in the notification text, or null. */
function detectCode(title, body) {
  const text = `${title} ${body}`;
  const google = text.match(/\bG-(\d{6})\b/);
  if (google) return google[1];
  if (!/\b(code|otp|verif\w*|passcode|pin|one[- ]time|log ?in|sign ?in|2fa|security)\b/i.test(text)) return null;
  // Prefer 4-8 digit runs; skip things that look like years, times or amounts.
  const candidates = [...text.matchAll(/(?<![\d.,:$₹£€])(\d{3}[ -]?\d{3}|\d{4,8})(?![\d,:%]|\.\d)/g)].map((m) => m[1].replace(/[ -]/g, ''));
  return candidates.find((c) => c.length >= 4 && c.length <= 8 && !/^(19|20)\d\d$/.test(c)) || null;
}

/** Phone Link shows incoming calls as notifications from its main app. */
function isCall(aumid, title, body) {
  return /YourPhone/i.test(aumid) && !/YourPhoneNotifications_/i.test(aumid) && /\b(incoming (voice |video )?call|is calling|calling\b)/i.test(`${title} ${body}`);
}

function filetimeToMs(ft) {
  return Number(BigInt(ft) / 10000n - FILETIME_EPOCH_MS);
}

function start(config, onNotification) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    return { stop() {} };
  }
  let since = null; // FILETIME as a decimal string
  let stopped = false;

  function poll() {
    if (stopped || config.notifications === false) return;
    let db;
    try {
      db = new DatabaseSync(DB, { readOnly: true });
      if (since === null) {
        const row = db.prepare('select cast(max(ArrivalTime) as text) as t from Notification').get();
        since = (row && row.t) || '0';
        return;
      }
      const rows = db
        .prepare(
          "select h.PrimaryId as app, cast(n.ArrivalTime as text) as t, cast(n.Payload as text) as payload from Notification n join NotificationHandler h on h.RecordId = n.HandlerId where n.Type = 'toast' and n.ArrivalTime > cast(? as integer) order by n.ArrivalTime asc limit 10",
        )
        .all(since);
      for (const r of rows) {
        since = r.t;
        if (SKIP.test(r.app)) continue;
        const { title, body } = parsePayload(r.payload);
        if (!title && !body) continue;
        const call = isCall(r.app, title, body);
        onNotification({
          ...(call ? { name: 'Phone', phone: true } : appLabel(r.app)),
          title,
          body,
          at: filetimeToMs(r.t),
          code: detectCode(title, body),
          call,
        });
      }
    } catch (err) {
      // DB busy or unavailable: try again next tick.
    } finally {
      if (db) db.close();
    }
  }

  poll();
  const timer = setInterval(poll, 2000);
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

module.exports = { start, parsePayload, appLabel, filetimeToMs, detectCode, isCall };
