// "Ask Claude" from the launcher: a short streamed answer that fits in the notch.
const AnthropicModule = require('@anthropic-ai/sdk');

const Anthropic = AnthropicModule.default || AnthropicModule;
const MODEL = 'claude-opus-5-5';
const SYSTEM =
  'You answer quick questions inside a small notch at the top of a Windows desktop. ' +
  'The reader is a student who wants the answer at a glance. Lead with the answer itself, ' +
  'keep it under about 90 words, and use plain text: no Markdown headings, tables or code fences. ' +
  'If the question needs a long answer, give the key point and say it needs more room.';

function create(getKey, onUpdate) {
  let controller = null;
  let seq = 0;

  return {
    async ask(question) {
      const q = String(question || '').trim().slice(0, 2000);
      if (!q) return;
      const apiKey = getKey();
      const id = ++seq;
      if (!apiKey) {
        onUpdate({ id, question: q, status: 'error', text: 'Add your Anthropic API key in Settings → AI to use this.' });
        return;
      }
      if (controller) controller.abort();
      controller = new AbortController();
      onUpdate({ id, question: q, status: 'streaming', text: '' });
      const client = new Anthropic({ apiKey });
      let text = '';
      try {
        const stream = client.beta.messages.stream(
          {
            model: MODEL,
            max_tokens: 2000,
            // Quick answers: low effort keeps them fast. If the model declines on
            // safety grounds, the API reroutes to its recommended fallback model.
            output_config: { effort: 'low' },
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            system: SYSTEM,
            messages: [{ role: 'user', content: q }],
          },
          { signal: controller.signal },
        );
        for await (const event of stream) {
          if (id !== seq) return; // a newer question replaced this one
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            text += event.delta.text;
            onUpdate({ id, question: q, status: 'streaming', text });
          }
        }
        const final = await stream.finalMessage();
        if (final.stop_reason === 'refusal') {
          onUpdate({ id, question: q, status: 'error', text: "Claude can't help with that one." });
          return;
        }
        onUpdate({ id, question: q, status: 'done', text: text.trim() || '(no answer)' });
      } catch (err) {
        if (id !== seq) return;
        let message = 'Something went wrong. Try again.';
        if (err instanceof Anthropic.AuthenticationError) message = 'That API key was rejected. Check it in Settings → AI.';
        else if (err instanceof Anthropic.RateLimitError) message = 'Rate limited. Try again in a moment.';
        else if (err instanceof Anthropic.APIConnectionError) message = "Couldn't reach Claude. Are you online?";
        else if (err instanceof Anthropic.APIError) message = `Claude error ${err.status}.`;
        else if (err && err.name === 'AbortError') return;
        onUpdate({ id, question: q, status: 'error', text: message });
      }
    },
    cancel() {
      if (controller) controller.abort();
      seq++;
    },
  };
}

module.exports = { create, MODEL };
