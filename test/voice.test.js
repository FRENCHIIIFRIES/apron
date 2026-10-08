// Runs the real voice helper on synthesized speech (Windows only).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const skip = process.platform !== 'win32' && 'needs Windows speech';

function speak(text, file) {
  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    '$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)',
    '$s.SetOutputToWaveFile($env:APRON_WAV, $f)',
    '$s.Speak($env:APRON_SAY)',
    '$s.Dispose()',
  ].join('; ');
  execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { env: { ...process.env, APRON_WAV: file, APRON_SAY: text }, windowsHide: true });
}

// Scales a 16-bit wav's samples, e.g. -30 dB to imitate a laptop mic array that arrives far too quiet.
function attenuate(file, db) {
  const b = fs.readFileSync(file);
  const at = b.indexOf('data') + 8;
  const g = 10 ** (db / 20);
  for (let i = at; i + 1 < b.length; i += 2) b.writeInt16LE(Math.round(b.readInt16LE(i) * g), i);
  fs.writeFileSync(file, b);
}

function listen(file) {
  const { ensureBinary } = require('../src/voice');
  const out = execFileSync(ensureBinary(), [file], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  return out
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

test('voice: commands, a far-too-quiet mic, and chatter', { skip, timeout: 180000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apron-voice-'));
  try {
    const timer = path.join(dir, 'timer.wav');
    speak('Hey Apron, ten minute timer', timer);
    assert.deepStrictEqual(
      listen(timer).filter((m) => m.cmd).map((m) => [m.cmd, m.minutes]),
      [['timer', 10]],
    );

    const quiet = path.join(dir, 'quiet.wav');
    speak('Apron, next song', quiet);
    attenuate(quiet, -30);
    assert.deepStrictEqual(listen(quiet).filter((m) => m.cmd).map((m) => m.cmd), ['next']);

    const chatter = path.join(dir, 'chatter.wav');
    speak('I think the weather will be nice tomorrow, so we should go to the park after school.', chatter);
    assert.deepStrictEqual(listen(chatter).filter((m) => m.cmd || m.wake), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
