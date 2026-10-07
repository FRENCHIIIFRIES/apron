const test = require('node:test');
const assert = require('node:assert');
const { reduce, prune, list } = require('../src/claude');

const cwd = 'C:\\Users\\dobar\\OneDrive\\Desktop\\emb3r';

test('permission request marks the session as waiting', () => {
  const s = reduce({}, { session_id: 'a', cwd, hook_event_name: 'PermissionRequest', tool_name: 'Bash' }, 1);
  assert.strictEqual(s.a.state, 'waiting');
  assert.strictEqual(s.a.project, 'emb3r');
  assert.strictEqual(s.a.message, 'Wants to use Bash');
});

test('a tool finishing clears waiting, stop marks done, session end removes', () => {
  let s = reduce({}, { session_id: 'a', cwd, hook_event_name: 'Notification', message: 'Claude needs your permission' }, 1);
  s = reduce(s, { session_id: 'a', cwd, hook_event_name: 'PostToolUse' }, 2);
  assert.strictEqual(s.a.state, 'working');
  s = reduce(s, { session_id: 'a', cwd, hook_event_name: 'Stop' }, 3);
  assert.strictEqual(s.a.state, 'done');
  s = reduce(s, { session_id: 'a', hook_event_name: 'SessionEnd' }, 4);
  assert.deepStrictEqual(s, {});
});

test('repeated working events return the same map (no re-render)', () => {
  const s = reduce({}, { session_id: 'a', cwd, hook_event_name: 'UserPromptSubmit' }, 1);
  assert.strictEqual(reduce(s, { session_id: 'a', cwd, hook_event_name: 'PostToolUse' }, 2), s);
});

test('ignores payloads without a session or with unknown events', () => {
  const s = {};
  assert.strictEqual(reduce(s, { hook_event_name: 'Stop' }), s);
  assert.strictEqual(reduce(s, { session_id: 'a', hook_event_name: 'PreCompact' }), s);
});

test('prune drops stale sessions and list puts waiting first', () => {
  const now = 100 * 60e3;
  const s = {
    a: { id: 'a', state: 'done', at: now - 1000 },
    b: { id: 'b', state: 'waiting', at: now - 2000 },
    c: { id: 'c', state: 'waiting', at: now - 31 * 60e3 },
    d: { id: 'd', state: 'working', at: now - 61 * 60e3 },
  };
  const pruned = prune(s, now);
  assert.deepStrictEqual(list(pruned).map((x) => x.id), ['b', 'a']);
  assert.strictEqual(prune(pruned, now), pruned);
});
