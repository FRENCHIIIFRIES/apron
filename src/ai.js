// One interface over the two AI providers Apron supports:
//   gemini - Google Gemini via its REST API (free tier with an AI Studio key)
//   claude - Anthropic's Claude via the official SDK
// Used by Ask, ask-about-screen, translation and the homework planner.
const AnthropicModule = require('@anthropic-ai/sdk');

const Anthropic = AnthropicModule.default || AnthropicModule;

// Flash-Lite is the default: on the free tier the bigger Flash models are often
// overloaded (503s or very slow), while Flash-Lite answers in a couple of seconds.
const DEFAULT_MODELS = { gemini: 'gemini-3.5-flash-lite', claude: 'claude-opus-5-5' };
// Tried in order when the chosen Gemini model is overloaded, rate-limited or slow.
const GEMINI_FALLBACKS = ['gemini-3.5-flash-lite', 'gemini-flash-lite-latest'];
const FIRST_BYTE_TIMEOUT = 25000;
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models';

class AiError extends Error {}

function friendly(provider, status, message) {
  if (status === 400 && /api key/i.test(message)) return 'That API key was rejected. Check it in Settings → AI.';
  if (status === 401 || status === 403) return 'That API key was rejected. Check it in Settings → AI.';
  if (status === 404) return `The model wasn't found. Check the model name in Settings → AI.`;
  if (status === 429) return provider === 'gemini' ? "Gemini's free limit is used up for now. Try again in a bit." : 'Rate limited. Try again in a moment.';
  return message || `Error ${status}`;
}

// ---------- Gemini (REST) ----------

/** thinking: e.g. 'minimal' for quick jobs like voice commands, where thinking only adds seconds. */
function geminiBody({ system, text, image, audio, json, thinking }) {
  const parts = [];
  if (image) parts.push({ inline_data: { mime_type: 'image/jpeg', data: image } });
  if (audio) parts.push({ inline_data: { mime_type: 'audio/wav', data: audio } });
  parts.push({ text });
  const body = { contents: [{ role: 'user', parts }] };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (json) body.generationConfig = { responseMimeType: 'application/json', responseJsonSchema: json };
  if (thinking) body.generationConfig = { ...(body.generationConfig || {}), thinkingConfig: { thinkingLevel: thinking } };
  return body;
}

function geminiText(data) {
  if (data.promptFeedback && data.promptFeedback.blockReason) throw new AiError("Gemini won't answer that one.");
  const cand = data.candidates && data.candidates[0];
  if (!cand) return '';
  if (cand.finishReason && /SAFETY|BLOCKLIST|PROHIBITED/i.test(cand.finishReason)) throw new AiError("Gemini won't answer that one.");
  return ((cand.content && cand.content.parts) || []).filter((p) => p.text && !p.thought).map((p) => p.text).join('');
}

/**
 * POSTs to the chosen model, moving down the fallback list if it's overloaded or slow.
 * models / timeout override the list and the per-model deadline (voice wants a fast answer).
 */
async function geminiFetch(ai, method, body, signal, { models: only, timeout = FIRST_BYTE_TIMEOUT } = {}) {
  const first = ai.model || DEFAULT_MODELS.gemini;
  const models = only || [first, ...GEMINI_FALLBACKS.filter((m) => m !== first)];
  let lastError = null;
  for (const model of models) {
    // Give each model a deadline for its first byte; the stream itself only stops on `signal`.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error('timeout')), timeout);
    const onAbort = () => ctl.abort(signal.reason);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    let res;
    try {
      res = await fetch(`${GEMINI}/${encodeURIComponent(model)}:${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': ai.key },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (signal && signal.aborted) throw err; // the user cancelled
      lastError = new AiError(`${model} took too long`);
      continue;
    }
    clearTimeout(timer);
    if (res.ok) return res;
    const err = await res.json().catch(() => ({}));
    lastError = new AiError(friendly('gemini', res.status, err.error && err.error.message));
    // Overloaded, rate-limited or retired model: try the next one. Anything else is final.
    if (![404, 429, 500, 503].includes(res.status)) throw lastError;
  }
  throw lastError || new AiError('Gemini is busy right now. Try again in a moment.');
}

// Answers here are short, so one regular request is used rather than SSE streaming:
// on the free tier streamGenerateContent often stalls before the first byte, while
// generateContent on Flash-Lite comes back in about two seconds.
async function* geminiStream(ai, opts, signal) {
  const res = await geminiFetch(ai, 'generateContent', geminiBody(opts), signal);
  const text = geminiText(await res.json());
  if (text) yield text;
}

// ---------- Claude (SDK) ----------

function claudeContent({ text, image }) {
  return image ? [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } }, { type: 'text', text }] : text;
}

function claudeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return new AiError('That API key was rejected. Check it in Settings → AI.');
  if (err instanceof Anthropic.RateLimitError) return new AiError('Rate limited. Try again in a moment.');
  if (err instanceof Anthropic.APIConnectionError) return new AiError("Couldn't reach Claude. Are you online?");
  if (err instanceof Anthropic.APIError) return new AiError(friendly('claude', err.status, err.message));
  return err;
}

function claudeParams(ai, opts, extra = {}) {
  return {
    model: ai.model || DEFAULT_MODELS.claude,
    max_tokens: 8000,
    // Quick answers run at low effort; if Claude declines on safety grounds the API
    // reroutes to its recommended fallback model.
    output_config: { effort: opts.effort || 'low', ...(extra.output_config || {}) },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    ...(opts.system ? { system: opts.system } : {}),
    messages: [{ role: 'user', content: claudeContent(opts) }],
  };
}

async function* claudeStream(ai, opts, signal) {
  const client = new Anthropic({ apiKey: ai.key });
  try {
    const stream = client.beta.messages.stream(claudeParams(ai, opts), { signal });
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') yield event.delta.text;
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') throw new AiError("Claude can't help with that one.");
  } catch (err) {
    throw claudeError(err);
  }
}

// ---------- public ----------

/** Streams text deltas. opts: { system, text, image?, effort? } */
function stream(ai, opts, signal) {
  if (!ai || !ai.key) throw new AiError(`Add your ${ai && ai.provider === 'claude' ? 'Anthropic' : 'Gemini'} API key in Settings → AI to use this.`);
  return ai.provider === 'claude' ? claudeStream(ai, opts, signal) : geminiStream(ai, opts, signal);
}

/** Whole answer as a string. */
async function complete(ai, opts) {
  let out = '';
  for await (const d of stream(ai, opts)) out += d;
  return out.trim();
}

/** JSON matching `schema` (plain JSON Schema). */
async function json(ai, opts, schema) {
  if (!ai || !ai.key) throw new AiError('Add your API key in Settings → AI first.');
  if (ai.provider === 'claude') {
    const client = new Anthropic({ apiKey: ai.key });
    try {
      const msg = await client.beta.messages.create(claudeParams(ai, { ...opts, effort: opts.effort || 'medium' }, { output_config: { format: { type: 'json_schema', schema } } }));
      if (msg.stop_reason === 'refusal') throw new AiError("Claude couldn't do that one.");
      return JSON.parse(msg.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
    } catch (err) {
      throw claudeError(err);
    }
  }
  const res = await geminiFetch(ai, 'generateContent', geminiBody({ ...opts, json: schema }), undefined, { models: opts.models, timeout: opts.timeout });
  return JSON.parse(geminiText(await res.json()));
}

module.exports = { stream, complete, json, AiError, DEFAULT_MODELS, GEMINI_FALLBACKS, geminiBody, geminiText };
