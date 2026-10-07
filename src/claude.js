const http = require('http');
const path = require('path');

const WAITING_TTL = 30 * 60e3;
const IDLE_TTL = 60 * 60e3;

/** Apply one Claude Code hook payload to the session map. Returns a new map. */
function reduce(sessions, payload, now = Date.now()) {
  const id = payload && payload.session_id;
  if (!id) return sessions;
  const prev = sessions[id] || {};
  const base = {
    id,
    project: payload.cwd ? path.basename(payload.cwd) : prev.project || 'claude',
    cwd: payload.cwd || prev.cwd || '',
    at: now,
  };
  const next = { ...sessions };
  switch (payload.hook_event_name) {
    case 'PermissionRequest':
      next[id] = { ...base, state: 'waiting', message: permissionMessage(payload) };
      break;
    case 'Notification':
      next[id] = { ...base, state: 'waiting', message: payload.message || 'Claude needs your input' };
      break;
    case 'Stop':
      next[id] = { ...base, state: 'done', message: 'Finished' };
      break;
    case 'StopFailure':
      next[id] = { ...base, state: 'done', message: 'Stopped with an error' };
      break;
    case 'SessionStart':
    case 'UserPromptSubmit':
    case 'PostToolUse':
      if (prev.state === 'working') return sessions;
      next[id] = { ...base, state: 'working', message: '' };
      break;
    case 'SessionEnd':
      delete next[id];
      break;
    default:
      return sessions;
  }
  return next;
}

function permissionMessage(p) {
  return p.tool_name ? `Wants to use ${p.tool_name}` : 'Waiting for permission';
}

/** Drop stale sessions. Returns the same map when nothing changed. */
function prune(sessions, now = Date.now()) {
  let changed = false;
  const next = {};
  for (const s of Object.values(sessions)) {
    const age = now - s.at;
    if (age > IDLE_TTL || (s.state === 'waiting' && age > WAITING_TTL)) changed = true;
    else next[s.id] = s;
  }
  return changed ? next : sessions;
}

const ORDER = { waiting: 0, done: 1, working: 2 };
function list(sessions) {
  return Object.values(sessions).sort((a, b) => ORDER[a.state] - ORDER[b.state] || b.at - a.at);
}

function start(port, onUpdate) {
  let sessions = {};
  const server = http.createServer((req, res) => {
    // Requiring application/json means a web page can't post here without a CORS preflight.
    const json = String(req.headers['content-type'] || '').startsWith('application/json');
    if (req.method !== 'POST' || req.url !== '/hook' || !json) {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        const next = reduce(sessions, JSON.parse(body));
        if (next !== sessions) {
          sessions = next;
          onUpdate(list(sessions));
        }
      } catch {
        // ignore bad payloads
      }
      res.writeHead(204);
      res.end();
    });
  });
  server.on('error', (err) => console.error('[claude] hook server:', err.message));
  server.listen(port, '127.0.0.1');

  const timer = setInterval(() => {
    const next = prune(sessions);
    if (next !== sessions) {
      sessions = next;
      onUpdate(list(sessions));
    }
  }, 30e3);

  onUpdate([]);
  return {
    stop() {
      clearInterval(timer);
      server.close();
    },
  };
}

module.exports = { start, reduce, prune, list };
