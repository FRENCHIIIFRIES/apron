const { execFile } = require('child_process');

const QUERY = `query {
  viewer {
    login
    pullRequests(first: 40, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number title url state isDraft headRefName updatedAt reviewDecision
        repository { nameWithOwner }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`;

const PUSH_WINDOW = 24 * 3600e3;
const DEFAULT_BRANCHES = new Set(['main', 'master']);

function gh(args) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { windowsHide: true, maxBuffer: 20e6, timeout: 30e3 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().split('\n')[0]));
      else resolve(stdout);
    });
  });
}

function ciState(rollup) {
  if (!rollup) return 'none';
  if (rollup === 'SUCCESS') return 'pass';
  if (rollup === 'FAILURE' || rollup === 'ERROR') return 'fail';
  return 'pending';
}

function mapPRs(data) {
  return data.viewer.pullRequests.nodes.map((n) => {
    const last = n.commits.nodes[0];
    return {
      repo: n.repository.nameWithOwner,
      number: n.number,
      title: n.title,
      url: n.url,
      state: n.state,
      draft: n.isDraft,
      branch: n.headRefName,
      review: n.reviewDecision,
      updatedAt: Date.parse(n.updatedAt),
      ci: ciState(last && last.commit.statusCheckRollup && last.commit.statusCheckRollup.state),
    };
  });
}

/** Branches you pushed in the last day, newest first, with the PR they belong to (if any). */
function mapPushes(events, prs, now = Date.now()) {
  const seen = new Set();
  const out = [];
  for (const e of events) {
    if (e.type !== 'PushEvent') continue;
    const at = Date.parse(e.created_at);
    if (now - at > PUSH_WINDOW) continue;
    const branch = String((e.payload && e.payload.ref) || '').replace(/^refs\/heads\//, '');
    if (!branch || DEFAULT_BRANCHES.has(branch)) continue;
    const repo = e.repo.name;
    const key = `${repo}#${branch}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const pr = prs.find((p) => p.repo === repo && p.branch === branch);
    out.push({
      repo,
      branch,
      at,
      pr: pr ? { number: pr.number, state: pr.state, url: pr.url } : null,
      compareUrl: `https://github.com/${repo}/compare/${branch.split('/').map(encodeURIComponent).join('/')}?expand=1`,
    });
  }
  return out;
}

function start(config, onUpdate) {
  let last = { prs: [], pushes: [] };

  async function refresh() {
    try {
      const data = JSON.parse(await gh(['api', 'graphql', '-f', `query=${QUERY}`])).data;
      const all = mapPRs(data);
      const events = JSON.parse(await gh(['api', `users/${data.viewer.login}/events?per_page=60`]));
      last = {
        prs: all.filter((p) => p.state === 'OPEN'),
        pushes: mapPushes(events, all),
      };
      onUpdate({ status: 'ok', login: data.viewer.login, ...last, updatedAt: Date.now() });
    } catch (err) {
      onUpdate({ status: 'error', error: err.message, ...last });
    }
  }

  refresh();
  const timer = setInterval(refresh, config.githubRefreshSeconds * 1000);
  return {
    refresh,
    stop: () => clearInterval(timer),
  };
}

module.exports = { start, mapPRs, mapPushes, ciState };
