// Translation for the launcher ("tr …") and for copied text. Uses your AI (Gemini or
// Claude) when you've added a key, otherwise the free MyMemory API (no key, ~5000 chars/day).
const ai = require('./ai');

const NAMES = { en: 'English', hi: 'Hindi', fr: 'French', es: 'Spanish', de: 'German', ar: 'Arabic', ur: 'Urdu', te: 'Telugu' };

/** Rough source-language guess from the script. */
function detect(text) {
  if (/[ऀ-ॿ]/.test(text)) return 'hi';
  if (/[ఀ-౿]/.test(text)) return 'te';
  if (/[؀-ۿ]/.test(text)) return 'ar';
  return 'en';
}

/** Non-English text goes to English; English goes to `fallbackTarget`. */
function pickTarget(text, fallbackTarget = 'hi') {
  return detect(text) === 'en' ? fallbackTarget : 'en';
}

async function viaAi(cfg, text, to) {
  return ai.complete(cfg, {
    system: `Translate the user's text into ${NAMES[to] || to}. Reply with only the translation, nothing else. Keep names and numbers as they are.`,
    text,
  });
}

async function viaMyMemory(text, from, to) {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.slice(0, 480))}&langpair=${from}|${to}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const out = data && data.responseData && data.responseData.translatedText;
  if (!out || /MYMEMORY WARNING/i.test(out)) throw new Error('Free translation limit reached for today');
  return out;
}

/** cfg: { provider, key, model } from main (key may be empty). */
async function translate(text, { cfg, to } = {}) {
  const t = String(text || '').trim().slice(0, 3000);
  if (!t) return null;
  const target = to || pickTarget(t);
  const from = detect(t);
  const translated = cfg && cfg.key ? await viaAi(cfg, t, target) : await viaMyMemory(t, from, target);
  return { text: translated, from, to: target, toName: NAMES[target] || target };
}

module.exports = { translate, detect, pickTarget };
