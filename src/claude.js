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
      next[id] = { ...base, state: 'waiting', message: permissionMessage(payload), approval: approvalFor(payload) };
      break;
    case 'Notification':
      // Keep a pending approval: the permission_prompt notification follows the request.
      next[id] = { ...base, state: 'waiting', message: payload.message || 'Claude needs your input', approval: prev.approval || null };
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

/** What the notch shows for an Allow/Deny prompt. */
function approvalFor(p) {
  const input = p.tool_input || {};
  const detail = input.command || input.file_path || input.url || input.pattern || input.path || input.description || input.prompt || '';
  return { id: p.tool_use_id || `${p.session_id}:${Date.now()}`, tool: p.tool_name || 'a tool', detail: String(detail).slice(0, 160) };
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

/** opts.approvals(): whether to hold permission requests for Allow/Deny in the notch. */
function start(port, onUpdate, opts = {}) {
  const approvalsOn = opts.approvals || (() => true);
  let sessions = {};
  // PermissionRequest hooks hold their HTTP request open until you pick Allow/Deny
  // in the notch, you answer in the terminal (any later event for that session),
  // or it times out. id -> { res, sessionId, timer }
  const pending = new Map();

  function settle(id, decision) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    if (decision) {
      p.res.writeHead(200, { 'content-type': 'application/json' });
      p.res.end(JSON.stringify(decision));
    } else {
      p.res.writeHead(204);
      p.res.end();
    }
  }

  function settleSession(sessionId) {
    for (const [id, p] of pending) if (p.sessionId === sessionId) settle(id, null);
  }

  function clearApproval(sessionId) {
    const s = sessions[sessionId];
    if (!s || !s.approval) return;
    sessions = { ...sessions, [sessionId]: { ...s, approval: null, state: 'working', message: '', at: Date.now() } };
    onUpdate(list(sessions));
  }
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
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(204);
        res.end();
        return;
      }
      const event = payload.hook_event_name;
      // Anything else from this session means the prompt was answered elsewhere.
      if (event !== 'PermissionRequest' && event !== 'Notification') settleSession(payload.session_id);
      const next = reduce(sessions, payload);
      if (next !== sessions) {
        sessions = next;
        onUpdate(list(sessions));
      }
      const wantsDecision = event === 'PermissionRequest' && req.headers['x-apron-wait'] === '1' && approvalsOn() && sessions[payload.session_id];
      if (!wantsDecision) {
        res.writeHead(204);
        res.end();
        return;
      }
      const id = sessions[payload.session_id].approval.id;
      settle(id, null); // a duplicate request replaces the old one
      const timer = setTimeout(() => settle(id, null), 110e3);
      pending.set(id, { res, sessionId: payload.session_id, timer });
      // The hook gave up (timeout, or Claude moved on): forget it. Note: listen on the
      // response, since a request's 'close' fires as soon as its body has been read.
      res.on('close', () => {
        if (pending.get(id) && pending.get(id).res === res) {
          clearTimeout(timer);
          pending.delete(id);
        }
      });
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
    /** Answer a pending permission request from the notch. */
    decide(id, allow) {
      const p = pending.get(id);
      if (!p) return false;
      settle(id, allow ? { behavior: 'allow' } : { behavior: 'deny', message: 'Denied from Apron' });
      clearApproval(p.sessionId);
      return true;
    },
    stop() {
      clearInterval(timer);
      for (const id of [...pending.keys()]) settle(id, null);
      server.close();
    },
  };
}

module.exports = { start, reduce, prune, list };
