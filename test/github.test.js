const test = require('node:test');
const assert = require('node:assert');
const { mapPRs, mapPushes, ciState } = require('../src/github');

const now = Date.parse('2026-10-07T12:00:00Z');

const prs = mapPRs({
  viewer: {
    login: 'me',
    pullRequests: {
      nodes: [
        {
          number: 7, title: 'Add island', url: 'https://github.com/me/app/pull/7', state: 'OPEN', isDraft: false,
          headRefName: 'feat/island', updatedAt: '2026-10-07T11:00:00Z', reviewDecision: null,
          repository: { nameWithOwner: 'me/app' },
          commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] },
        },
        {
          number: 8, title: 'No CI', url: 'https://github.com/me/app/pull/8', state: 'MERGED', isDraft: false,
          headRefName: 'fix/x', updatedAt: '2026-10-07T10:00:00Z', reviewDecision: 'APPROVED',
          repository: { nameWithOwner: 'me/app' },
          commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
        },
      ],
    },
  },
});

test('maps CI rollup states', () => {
  assert.deepStrictEqual(prs.map((p) => p.ci), ['fail', 'none']);
  assert.strictEqual(ciState('PENDING'), 'pending');
  assert.strictEqual(ciState('SUCCESS'), 'pass');
});

test('pushes: newest per branch, skips main and old pushes, links PRs', () => {
  const push = (ref, at, repo = 'me/app') => ({ type: 'PushEvent', created_at: at, repo: { name: repo }, payload: { ref } });
  const events = [
    push('refs/heads/feat/island', '2026-10-07T11:30:00Z'),
    push('refs/heads/feat/island', '2026-10-07T11:00:00Z'),
    push('refs/heads/main', '2026-10-07T11:00:00Z'),
    push('refs/heads/wip', '2026-10-07T09:00:00Z'),
    { type: 'WatchEvent', created_at: '2026-10-07T09:00:00Z', repo: { name: 'me/app' }, payload: {} },
    push('refs/heads/fix/x', '2026-10-07T08:00:00Z'),
    push('refs/heads/ancient', '2026-10-05T08:00:00Z'),
  ];
  const out = mapPushes(events, prs, now);
  assert.deepStrictEqual(out.map((p) => p.branch), ['feat/island', 'wip', 'fix/x']);
  assert.strictEqual(out[0].pr.number, 7);
  assert.strictEqual(out[1].pr, null);
  assert.strictEqual(out[1].compareUrl, 'https://github.com/me/app/compare/wip?expand=1');
  assert.strictEqual(out[2].pr.state, 'MERGED');
});
