const test = require('node:test');
const assert = require('node:assert');

test('gemini request/response shapes', () => {
  const { geminiBody, geminiText } = require('../src/ai');
  const body = geminiBody({ system: 'be brief', text: 'what is this?', image: 'AAAA', json: { type: 'object' } });
  assert.deepStrictEqual(body.contents[0].parts, [{ inline_data: { mime_type: 'image/jpeg', data: 'AAAA' } }, { text: 'what is this?' }]);
  assert.deepStrictEqual(body.systemInstruction, { parts: [{ text: 'be brief' }] });
  assert.strictEqual(body.generationConfig.responseMimeType, 'application/json');
  assert.strictEqual(geminiText({ candidates: [{ content: { parts: [{ text: 'thinking', thought: true }, { text: 'Hi' }, { text: ' there' }] } }] }), 'Hi there');
  assert.throws(() => geminiText({ promptFeedback: { blockReason: 'SAFETY' } }), /won't answer/);
});

test('flashcards: question :: answer lines, not code', () => {
  const { parseCards } = require('../src/flashcards');
  const md = ['# Bio', '- mitosis :: division into two identical cells', 'meiosis ::: four non-identical gametes', '```', 'a :: b', '```', 'url: https://x.y', 'not a card'].join('\n');
  assert.deepStrictEqual(
    parseCards(md, 'Bio').map((c) => [c.q, c.a]),
    [
      ['mitosis', 'division into two identical cells'],
      ['meiosis', 'four non-identical gametes'],
    ],
  );
});

test('wifi parsing from netsh', () => {
  const { parseWifi } = require('../src/sysinfo');
  const out = '    Name                   : Wi-Fi\n    State                  : connected\n    SSID                   : SchoolNet\n    Band                   : 5 GHz\n    Signal                 : 88%\n';
  assert.deepStrictEqual(parseWifi(out), { connected: true, ssid: 'SchoolNet', signal: 88, band: '5 GHz' });
  assert.deepStrictEqual(parseWifi('    State : disconnected'), { connected: false });
});

test('translation direction and planner schema', () => {
  const { detect, pickTarget } = require('../src/translate');
  assert.strictEqual(detect('नमस्ते दोस्त'), 'hi');
  assert.strictEqual(pickTarget('नमस्ते'), 'en');
  assert.strictEqual(pickTarget('good morning'), 'hi');
  const { PLAN_SCHEMA } = require('../src/planner');
  assert.deepStrictEqual(PLAN_SCHEMA.required, ['blocks', 'summary']);
  assert.strictEqual(PLAN_SCHEMA.properties.blocks.items.additionalProperties, false);
});

test('launcher: screen questions, translate, cards; settings for new features', () => {
  const { search } = require('../src/launcher');
  assert.strictEqual(search([], '?? explain this graph')[0].kind, 'askscreen');
  assert.strictEqual(search([], 'tr good morning')[0].kind, 'translate');
  assert.strictEqual(search([], 'cards')[0].kind, 'cards');
  const { sanitize } = require('../src/settingsSchema');
  assert.deepStrictEqual(sanitize({ aiProvider: 'gemini', geminiModel: 'gemini-3.8-flash', voice: true, homeWidgets: ['music', 'x', 'system'] }), {
    aiProvider: 'gemini',
    geminiModel: 'gemini-3.8-flash',
    voice: true,
    homeWidgets: ['music', 'system'],
  });
  assert.deepStrictEqual(sanitize({ aiProvider: 'openai', geminiModel: 'a b/../c' }), {});
});

test('launcher includes Microsoft Store apps via shell:AppsFolder', () => {
  const L = require('../src/launcher');
  L.setStoreApps([
    { Name: 'Claude', AppID: 'Claude_pzs8sxrjxfjjc!Claude' },
    { Name: 'Bad; calc', AppID: 'x!y; calc' },
  ]);
  const idx = L.buildIndex();
  const claude = idx.find((i) => i.name === 'Claude');
  assert.strictEqual(claude.path, `shell:AppsFolder${String.fromCharCode(92)}Claude_pzs8sxrjxfjjc!Claude`);
  assert.ok(!idx.some((i) => i.name === 'Bad; calc'));
  assert.strictEqual(L.search(idx, 'clau')[0].title, 'Claude');
  L.setStoreApps([]);
});
