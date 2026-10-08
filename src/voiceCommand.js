// Turns a spoken clip into one Apron action with Gemini, which copes with any accent and
// with however you happen to phrase it ("put a 25 min timer", "skip this song", "what's
// my next class", "Apron, what is mitochondria"). Only used when you tap to talk.
const ai = require('./ai');

const ACTIONS = [
  'timer', // minutes
  'pomodoro',
  'stop', // stop the timer
  'pause',
  'play',
  'next',
  'prev',
  'volup',
  'voldown',
  'whatsnext', // next class / event
  'open', // text = app or website to open
  'search', // text = what to search the web for
  'ask', // a question: answer it in `answer`
  'askscreen', // a question about what's on screen: text = the question
  'note', // text = note to save
  'todo', // text = to-do to add
  'call', // text = who to call (one of the speed-dial names)
  'hotspot', // connect to the phone's hotspot
  'mute', // mute / unmute the microphone
  'launcher',
  'none',
];

const SCHEMA = {
  type: 'object',
  properties: {
    transcript: { type: 'string', description: 'What the user said, in English' },
    action: { type: 'string', enum: ACTIONS },
    minutes: { type: 'integer', description: 'For timer: length in minutes' },
    text: { type: 'string', description: 'For open, search, askscreen, note, todo, call' },
    answer: { type: 'string', description: 'For ask: the answer, plain text, at most 60 words' },
  },
  required: ['transcript', 'action'],
};

function systemPrompt({ now, apps = [], contacts = [] }) {
  return [
    'You are the voice control of Apron, a dynamic-island app on a student\'s Windows laptop in India.',
    'Listen to the audio clip and decide which single action the student wants. They may have an Indian English accent, mix in Hindi words, or start with "Apron" / "Hey Apron" (ignore that part).',
    `Actions: ${ACTIONS.join(', ')}.`,
    '- timer: set "minutes" (e.g. "half an hour" = 30). pomodoro: a Pomodoro / focus session. stop: stop or cancel the timer.',
    '- pause / play / next / prev: music. volup / voldown: volume. whatsnext: their next class or event.',
    '- open: "text" is the app or website name. search: "text" is the web search.',
    '- ask: any general question; put a short, correct answer in "answer" (plain text, no Markdown, under 60 words).',
    '- askscreen: questions about what is on their screen ("what is this", "explain this graph"); "text" is the question.',
    '- note / todo: "text" is what to save. call: "text" is who to call. hotspot: connect to the phone hotspot. mute: mute or unmute the mic.',
    '- none: silence, background noise, music, or talk that is not meant for Apron.',
    `Pinned apps: ${apps.join(', ') || 'none'}. Speed-dial contacts: ${contacts.join(', ') || 'none'}.`,
    `It is ${new Date(now).toString()}.`,
    'Always fill "transcript" with what was said, in English.',
  ].join('\n');
}

// On the free tier Flash with minimal thinking answers in ~1.5 s, while Flash-Lite can take
// 2-17 s; Flash has a lower per-minute limit, so Flash-Lite catches the overflow.
const VOICE_MODELS = ['gemini-3.5-flash', 'gemini-3.5-flash-lite'];

/** cfg: a Gemini { provider, key }. Returns { transcript, action, minutes?, text?, answer? }. */
async function interpret(cfg, wavBase64, context) {
  const out = await ai.json(
    cfg,
    { system: systemPrompt(context), text: 'Here is the clip.', audio: wavBase64, thinking: 'minimal', models: VOICE_MODELS, timeout: 12000 },
    SCHEMA,
  );
  return clean(out);
}

function clean(r) {
  const out = {
    transcript: String((r && r.transcript) || '').slice(0, 500),
    action: ACTIONS.includes(r && r.action) ? r.action : 'none',
  };
  const minutes = Math.round(Number(r && r.minutes));
  if (out.action === 'timer') out.minutes = Number.isFinite(minutes) && minutes > 0 ? Math.min(minutes, 240) : 25;
  if (r && typeof r.text === 'string' && r.text.trim()) out.text = r.text.trim().slice(0, 500);
  if (r && typeof r.answer === 'string' && r.answer.trim()) out.answer = r.answer.trim().slice(0, 1200);
  return out;
}

module.exports = { interpret, clean, ACTIONS, SCHEMA };
