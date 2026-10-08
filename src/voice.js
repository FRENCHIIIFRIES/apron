// Runs the offline "Hey Apron" voice helper while voice commands are switched on.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SOURCE = path.join(__dirname, 'voice', 'ApronVoice.cs');
const BINARY = path.join(__dirname, '..', 'bin', 'apron-voice.exe');

function ensureBinary() {
  if (fs.existsSync(BINARY) && fs.statSync(BINARY).mtimeMs >= fs.statSync(SOURCE).mtimeMs) return BINARY;
  const fw = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  fs.mkdirSync(path.dirname(BINARY), { recursive: true });
  execFileSync(
    path.join(fw, 'csc.exe'),
    ['/nologo', '/optimize', '/target:winexe', `/out:${BINARY}`, `/r:${path.join(fw, 'WPF', 'System.Speech.dll')}`, '/r:System.Core.dll', SOURCE],
    { windowsHide: true, stdio: 'pipe' },
  );
  return BINARY;
}

/**
 * onCommand({ cmd, minutes? }); onStatus({ status: 'listening' | 'off' | 'error', error? });
 * onHint({ wake: true } | { unsure: text } | { level: 0-100 })
 * logFile: where the helper's diagnostics go (what it matched and how sure it was; never audio).
 */
function create(onCommand, onStatus, onHint = () => {}, { logFile } = {}) {
  let proc = null;
  let wanted = false;

  function log(text) {
    if (!logFile) return;
    try {
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 256 * 1024) fs.renameSync(logFile, `${logFile}.old`);
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${text}\n`);
    } catch {
      // logging is best-effort
    }
  }

  function launch() {
    let binary;
    try {
      binary = ensureBinary();
    } catch (err) {
      onStatus({ status: 'error', error: 'could not build the voice helper' });
      return;
    }
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
          const msg = JSON.parse(line);
          if (msg.debug) log(msg.debug);
          else if (msg.error) {
            log(`error ${msg.error}`);
            onStatus({ status: 'error', error: msg.error });
          } else if (msg.ready) onStatus({ status: 'listening' });
          else if (msg.cmd) {
            log(`command ${msg.cmd}${msg.minutes ? ` ${msg.minutes}` : ''} ${msg.confidence}`);
            onCommand(msg);
          }
          else if (msg.wake || msg.unsure || msg.level !== undefined) onHint(msg);
        } catch {
          // ignore
        }
      }
    });
    proc.on('exit', () => {
      proc = null;
      if (wanted) setTimeout(() => wanted && !proc && launch(), 5000);
      else onStatus({ status: 'off' });
    });
  }

  return {
    setEnabled(on) {
      wanted = Boolean(on);
      if (wanted && !proc) launch();
      if (!wanted && proc) {
        proc.stdin.end();
        setTimeout(() => proc && proc.kill(), 1000);
      }
    },
    stop() {
      wanted = false;
      if (proc) proc.kill();
    },
  };
}

module.exports = { create, ensureBinary };
