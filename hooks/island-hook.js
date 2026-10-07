#!/usr/bin/env node
// Claude Code hook: forwards the hook payload to the island.
// Must never slow down or break Claude: short timeout, no output, always exit 0.
const http = require('http');

const port = Number(process.env.ISLAND_PORT) || 47777;
let body = '';

setTimeout(() => process.exit(0), 1500).unref();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (body += c));
process.stdin.on('end', () => {
  const req = http.request(
    { host: '127.0.0.1', port, path: '/hook', method: 'POST', headers: { 'content-type': 'application/json' }, timeout: 500 },
    (res) => {
      res.resume();
      res.on('end', () => process.exit(0));
    },
  );
  req.on('error', () => process.exit(0));
  req.on('timeout', () => {
    req.destroy();
    process.exit(0);
  });
  req.end(body);
});
