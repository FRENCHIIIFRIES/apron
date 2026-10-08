// Tap-to-talk: runs the mic helper (src/voice/ApronVoice.cs) and hands each finished clip
// to whoever is listening. The helper only opens the mic between start and the end of a clip.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SOURCE = path.join(__dirname, 'voice', 'ApronVoice.cs');
const BINARY = path.join(__dirname, '..', 'bin', 'apron-voice.exe');

function ensureBinary() {
  if (fs.existsSync(BINARY) && fs.statSync(BINARY).mtimeMs >= fs.statSync(SOURCE).mtimeMs) return BINARY;
  const fw = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  fs.mkdirSync(path.dirname(BINARY), { recursive: true });
  execFileSync(path.join(fw, 'csc.exe'), ['/nologo', '/optimize', '/target:winexe', `/out:${BINARY}`, SOURCE], { windowsHide: true, stdio: 'pipe' });
  return BINARY;
}

/**
 * onState({ status: 'idle' | 'listening' | 'thinking' | 'error', error? });
 * onLevel(0-100) while listening; onClip(base64Wav, ms) once you stop talking.
 * logFile: short diagnostics (what happened, never audio).
 */
function create({ onState, onLevel = () => {}, onClip, logFile } = {}) {
  let proc = null;
  let status = 'idle';

  function log(text) {
    if (!logFile) return;
    try {
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 256 * 1024) fs.renameSync(logFile, `${logFile}.old`);
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${text}\n`);
    } catch {
      // logging is best-effort
    }
  }

  function setStatus(s, extra = {}) {
    status = s;
    onState({ status: s, ...extra });
  }

  function launch() {
    let binary;
    try {
      binary = ensureBinary();
    } catch {
      setStatus('error', { error: 'could not build the voice helper' });
      return false;
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
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.debug) log(msg.debug);
        else if (msg.level !== undefined) onLevel(msg.level);
        else if (msg.listening) setStatus('listening');
        else if (msg.speech) log('speech started');
        else if (msg.clip) {
          log(`clip ${msg.ms} ms`);
          setStatus('thinking');
          onClip(msg.clip, msg.ms);
        } else if (msg.silent) {
          log('no speech heard');
          setStatus('idle', { heard: false });
        } else if (msg.cancelled) setStatus('idle');
        else if (msg.error) {
          log(`error ${msg.error}`);
          setStatus('error', { error: msg.error });
        }
      }
    });
    proc.on('exit', () => {
      proc = null;
      if (status === 'listening') setStatus('idle');
    });
    return true;
  }

  return {
    /** Starts listening, or (if already listening) finishes the clip now. */
    toggle() {
      if (status === 'listening') return this.finish();
      if (status === 'thinking') return undefined;
      if (!proc && !launch()) return undefined;
      proc.stdin.write('start\n');
      return undefined;
    },
    finish() {
      if (proc && status === 'listening') proc.stdin.write('stop\n');
    },
    cancel() {
      if (proc && status === 'listening') proc.stdin.write('cancel\n');
    },
    /** Back to idle once the clip has been dealt with. */
    done() {
      if (status === 'thinking') setStatus('idle');
    },
    get status() {
      return status;
    },
    /** Ends the helper (Apron is quitting). */
    stop() {
      if (proc) {
        proc.stdin.end();
        const p = proc;
        setTimeout(() => p.kill(), 1000);
      }
    },
  };
}

module.exports = { create, ensureBinary };
