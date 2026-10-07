// Homework planner: Claude looks at what's due and your free time over the next two
// days and suggests focus blocks. The plan lives in Apron (it doesn't write to Google
// Calendar); when a block starts, the notch offers to start a focus timer for it.
const fs = require('fs');
const ai = require('./ai');

// Plain JSON Schema so it works for both Gemini (responseJsonSchema) and Claude (structured outputs).
const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'What to work on, short, e.g. "Biology SA 3: revise cell division"' },
          start: { type: 'string', description: 'Local start time as YYYY-MM-DDTHH:MM' },
          minutes: { type: 'integer', description: 'Length of the block in minutes' },
          why: { type: 'string', description: 'One short reason, e.g. "due tomorrow 13:00"' },
        },
        required: ['task', 'start', 'minutes', 'why'],
        additionalProperties: false,
      },
    },
    summary: { type: 'string', description: 'One sentence overview of the plan' },
  },
  required: ['blocks', 'summary'],
  additionalProperties: false,
};

const pad = (n) => String(n).padStart(2, '0');
const local = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function buildPrompt({ now, bedtime, schedule, due, focusMinutes }) {
  const sched = schedule.length ? schedule.map((e) => `- ${local(e.start)} to ${local(e.end)}: ${e.title}`).join('\n') : '- (nothing scheduled)';
  const work = due.length ? due.map((e) => `- ${e.title} (due ${local(e.start)})`).join('\n') : '- (nothing due)';
  return [
    `It is now ${local(now)}. Bedtime is ${bedtime}. A focus session is usually ${focusMinutes} minutes.`,
    '',
    'Schedule for today and tomorrow (school classes and events, so the student is busy then):',
    sched,
    '',
    'Homework and assessments coming up:',
    work,
    '',
    'Plan focus blocks for the rest of today and tomorrow to get ahead of what is due. Rules:',
    '- Only use free time: not during scheduled events, not before 07:00, and finish before bedtime.',
    '- Start no earlier than 10 minutes from now. Put the most urgent work first.',
    '- Blocks are 25 to 90 minutes, with breaks between them; at most 4 hours of blocks per day.',
    '- Use start times on the quarter hour. Keep task names short and specific.',
    '- If nothing is due, return an empty list and say so in the summary.',
  ].join('\n');
}

/** Keep only sane blocks: in the future, within ~2 days, sorted. */
function cleanPlan(plan, now) {
  const blocks = (plan.blocks || [])
    .map((b) => {
      const m = String(b.start).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
      if (!m) return null;
      const start = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
      const minutes = Math.max(10, Math.min(120, Math.round(b.minutes || 25)));
      return { task: String(b.task).slice(0, 80), why: String(b.why || '').slice(0, 80), start, minutes };
    })
    .filter((b) => b && b.start > now - 5 * 60e3 && b.start < now + 2.5 * 864e5)
    .sort((a, b) => a.start - b.start);
  return { blocks, summary: String(plan.summary || '').slice(0, 200), madeAt: now };
}

/** cfg: { provider, key, model } */
async function makePlan(cfg, input) {
  const plan = await ai.json(cfg, { text: buildPrompt(input), effort: 'medium' }, PLAN_SCHEMA);
  if (!plan || !Array.isArray(plan.blocks)) throw new Error('The plan came back in the wrong shape; try again');
  return cleanPlan(plan, input.now);
}

function store(file, onChange) {
  let plan = null;
  try {
    plan = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    plan = null;
  }
  const drop = () => {
    // Forget blocks that ended more than an hour ago.
    if (plan) plan = { ...plan, blocks: plan.blocks.filter((b) => b.start + b.minutes * 60e3 > Date.now() - 3600e3) };
  };
  drop();
  onChange(plan);
  return {
    set(p) {
      plan = p;
      try {
        fs.writeFileSync(file, JSON.stringify(plan));
      } catch {
        // keep it in memory
      }
      onChange(plan);
    },
    clear() {
      this.set(null);
    },
    get: () => plan,
    /** Blocks starting now (within the last minute), each reported once. */
    due(seen) {
      drop();
      const now = Date.now();
      return (plan ? plan.blocks : []).filter((b) => b.start <= now && now - b.start < 90e3 && !seen.has(b.start));
    },
  };
}

module.exports = { makePlan, cleanPlan, buildPrompt, store, PLAN_SCHEMA };
