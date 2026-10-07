// "Ask" from the launcher: a short streamed answer that fits in the notch, optionally
// about a screenshot of your screen. Uses whichever AI you picked (Gemini or Claude).
const ai = require('./ai');

const SYSTEM =
  'You answer quick questions inside a small notch at the top of a Windows desktop. ' +
  'The reader is a student who wants the answer at a glance. Lead with the answer itself, ' +
  'keep it under about 90 words, and use plain text: no Markdown, no LaTeX or $ signs around maths (write x² or (2, -9) directly), no tables or code fences. ' +
  'If the question needs a long answer, give the key point and say it needs more room.';

/** getAi() -> { provider, key, model } */
function create(getAi, onUpdate) {
  let controller = null;
  let seq = 0;

  return {
    /** image: optional base64 JPEG of the screen, for "?? what's this graph" */
    async ask(question, image) {
      const q = String(question || '').trim().slice(0, 2000);
      if (!q) return;
      const id = ++seq;
      const cfg = getAi();
      const who = cfg.provider === 'claude' ? 'Claude' : 'Gemini';
      if (controller) controller.abort();
      controller = new AbortController();
      const base = { id, question: q, screen: Boolean(image), who };
      onUpdate({ ...base, status: 'streaming', text: '' });
      let text = '';
      try {
        const prompt = image ? `(This is a screenshot of my screen right now.) ${q}` : q;
        for await (const delta of ai.stream(cfg, { system: SYSTEM, text: prompt, image }, controller.signal)) {
          if (id !== seq) return; // a newer question replaced this one
          text += delta;
          onUpdate({ ...base, status: 'streaming', text });
        }
        onUpdate({ ...base, status: 'done', text: text.trim() || '(no answer)' });
      } catch (err) {
        if (id !== seq || (err && err.name === 'AbortError')) return;
        onUpdate({ ...base, status: 'error', text: err instanceof ai.AiError ? err.message : 'Something went wrong. Try again.' });
      }
    },
    cancel() {
      if (controller) controller.abort();
      seq++;
    },
  };
}

module.exports = { create };
