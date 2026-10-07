const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const COMMANDS = new Set(['toggle', 'next', 'prev']);
const SOURCE = path.join(__dirname, 'media', 'IslandMedia.cs');
const BINARY = path.join(__dirname, '..', 'bin', 'island-media.exe');

/**
 * Builds the helper with the C# compiler that ships with every Windows install
 * (.NET Framework 4.x), so there is nothing extra to install. Rebuilds when the source changes.
 */
function ensureBinary() {
  if (fs.existsSync(BINARY) && fs.statSync(BINARY).mtimeMs >= fs.statSync(SOURCE).mtimeMs) return BINARY;
  const fw = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const winmd = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WinMetadata');
  const refs = [
    path.join(fw, 'System.Runtime.dll'),
    path.join(winmd, 'Windows.Foundation.winmd'),
    path.join(winmd, 'Windows.Media.winmd'),
    path.join(winmd, 'Windows.Storage.winmd'),
  ];
  fs.mkdirSync(path.dirname(BINARY), { recursive: true });
  execFileSync(
    path.join(fw, 'csc.exe'),
    ['/nologo', '/optimize', '/target:winexe', `/out:${BINARY}`, ...refs.map((r) => `/r:${r}`), SOURCE],
    { windowsHide: true, stdio: 'pipe' },
  );
  return BINARY;
}

function start(onUpdate) {
  let proc = null;
  let stopped = false;

  let binary;
  try {
    binary = ensureBinary();
  } catch (err) {
    const output = String((err.stdout || '') + (err.stderr || '')).trim();
    console.error('[media] could not build helper:', output || err.message);
    onUpdate({ status: 'error', error: 'could not build the media helper', active: false });
    return { command() {}, stop() {} };
  }

  function launch() {
    let buf = '';
    proc = spawn(binary, [], { windowsHide: true });
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          onUpdate({ status: 'ok', ...JSON.parse(line) });
        } catch {
          // ignore a malformed line
        }
      }
    });
    proc.stderr.on('data', (d) => console.error('[media]', String(d).trim()));
    proc.on('error', (err) => onUpdate({ status: 'error', error: err.message, active: false }));
    proc.on('exit', () => {
      if (!stopped) setTimeout(launch, 3000);
    });
  }

  launch();
  return {
    command(cmd) {
      if (COMMANDS.has(cmd) && proc && proc.stdin.writable) proc.stdin.write(`${cmd}\n`);
    },
    stop() {
      stopped = true;
      if (proc) proc.kill();
    },
  };
}

module.exports = { start, ensureBinary };
