// Runs the real tap-to-talk recorder's end-of-speech detection on synthesized speech (Windows only).
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

/**
 * Rewrites a 16-bit wav: optional gain (dB), silence padding (s) and a little room noise;
 * tailNoise is louder noise that starts once the speech ends (a TV coming on, say).
 */
function shape(file, { db = 0, padBefore = 0, padAfter = 0, noise = 0, tailNoise = 0 } = {}) {
  const b = fs.readFileSync(file);
  const at = b.indexOf('data') + 8;
  const g = 10 ** (db / 20);
  const src = [];
  for (let i = at; i + 1 < b.length; i += 2) src.push(b.readInt16LE(i) * g);
  const all = [...new Array(Math.round(padBefore * 16000)).fill(0), ...src, ...new Array(Math.round(padAfter * 16000)).fill(0)];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  const pcm = Buffer.alloc(all.length * 2);
  const tailFrom = all.length - Math.round(padAfter * 16000);
  all.forEach((v, i) => pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v + rnd() * (i >= tailFrom && tailNoise ? tailNoise : noise)))), i * 2));
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(16000, 24);
  head.writeUInt32LE(32000, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([head, pcm]));
  return all.length / 16000;
}

function record(file) {
  const { ensureBinary } = require('../src/voice');
  const out = execFileSync(ensureBinary(), ['--file', file], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  return out
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

test('voice: finds the speech, trims the silence, and ignores an empty clip', { skip, timeout: 180000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apron-voice-'));
  try {
    // Speech with a second of quiet room noise before and two after: one clip, trimmed.
    const said = path.join(dir, 'said.wav');
    speak('Apron, set a timer for twenty five minutes', said);
    const total = shape(said, { padBefore: 1, padAfter: 2, noise: 30 });
    const clip = record(said).find((m) => m.clip);
    assert.ok(clip, 'expected a clip');
    const wav = Buffer.from(clip.clip, 'base64');
    assert.strictEqual(wav.toString('ascii', 0, 4), 'RIFF');
    assert.strictEqual(wav.readUInt32LE(24), 16000);
    assert.ok(clip.ms > 1200 && clip.ms < (total - 1.5) * 1000, `clip ${clip.ms} ms of ${total}s`);

    // A laptop mic array that arrives ~30 dB too quiet still counts as speech.
    const quiet = path.join(dir, 'quiet.wav');
    speak('Apron, next song', quiet);
    shape(quiet, { db: -30, padBefore: 0.5, padAfter: 1.5, noise: 2 });
    assert.ok(record(quiet).some((m) => m.clip), 'quiet speech should still make a clip');

    // Background sound that starts after you stop talking doesn't keep the mic open.
    const tv = path.join(dir, 'tv.wav');
    speak('Apron, what is my next class', tv);
    const tvTotal = shape(tv, { padBefore: 0.5, padAfter: 4, noise: 10, tailNoise: 700 });
    const tvClip = record(tv).find((m) => m.clip);
    assert.ok(tvClip && tvClip.ms < (tvTotal - 2.5) * 1000, `clip ${tvClip && tvClip.ms} ms of ${tvTotal}s`);

    // Nothing but room noise: no clip.
    const empty = path.join(dir, 'empty.wav');
    fs.copyFileSync(quiet, empty);
    shape(empty, { db: -120, padAfter: 3, noise: 30 });
    const res = record(empty);
    assert.ok(res.some((m) => m.silent) && !res.some((m) => m.clip), JSON.stringify(res));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
