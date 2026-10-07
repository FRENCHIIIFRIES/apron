#!/usr/bin/env node
// Claude Code hook: forwards the hook payload to Apron.
// Must never slow down or break Claude: no output and exit 0 unless Apron answers.
//
// For PermissionRequest it waits (up to ~110s) for Allow/Deny from the notch. Claude
// shows its own prompt in the terminal at the same time, so whichever you answer first
// wins; if Apron isn't running this returns immediately.
const http = require('http');

const port = Number(process.env.APRON_PORT || process.env.ISLAND_PORT) || 47777;
let body = '';

let kill = setTimeout(() => process.exit(0), 1500);
kill.unref();

process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (body += c));
process.stdin.on('end', () => {
  let event = '';
  try {
    event = JSON.parse(body).hook_event_name;
  } catch {
    process.exit(0);
  }
  const wait = event === 'PermissionRequest';
  if (wait) {
    clearTimeout(kill);
    kill = setTimeout(() => process.exit(0), 115e3);
    kill.unref();
  }

  const headers = { 'content-type': 'application/json' };
  if (wait) headers['x-apron-wait'] = '1';
  const req = http.request(
    // The connect timeout stays short so a missing Apron never delays Claude.
    { host: '127.0.0.1', port, path: '/hook', method: 'POST', headers, timeout: wait ? 115e3 : 500 },
    (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (out += c));
      res.on('end', () => {
        if (wait && res.statusCode === 200) {
          try {
            const decision = JSON.parse(out);
            if (decision.behavior === 'allow' || decision.behavior === 'deny') {
              process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }));
            }
          } catch {
            // no decision: Claude's own prompt handles it
          }
        }
        process.exit(0);
      });
    },
  );
  req.on('socket', (socket) => {
    const connectTimer = setTimeout(() => {
      req.destroy();
      process.exit(0);
    }, 500);
    socket.on('connect', () => clearTimeout(connectTimer));
  });
  req.on('error', () => process.exit(0));
  req.on('timeout', () => {
    req.destroy();
    process.exit(0);
  });
  req.end(body);
});
