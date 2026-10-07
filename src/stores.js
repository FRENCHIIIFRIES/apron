// Small pieces of state that live in the main process so every notch (one per
// screen) shows the same thing: to-dos (saved to disk), the focus timer, and
// clipboard history (memory only, never written anywhere).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function todoStore(file, onChange) {
  let items = [];
  try {
    items = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    items = [];
  }
  const save = () => {
    try {
      fs.writeFileSync(file, JSON.stringify(items, null, 2));
    } catch (err) {
      console.error('[todos] save failed:', err.message);
    }
    onChange(items);
  };
  onChange(items);
  return {
    add(text) {
      const t = String(text || '').trim().slice(0, 200);
      if (!t) return;
      items = [{ id: crypto.randomUUID(), text: t, done: false, at: Date.now() }, ...items];
      save();
    },
    toggle(id) {
      items = items.map((i) => (i.id === id ? { ...i, done: !i.done } : i));
      save();
    },
    remove(id) {
      items = items.filter((i) => i.id !== id);
      save();
    },
    clearDone() {
      items = items.filter((i) => !i.done);
      save();
    },
  };
}

/** Pomodoro phase after `phase` finishes. */
function nextPhase(timer, p) {
  if (timer.phase === 'focus') {
    const long = timer.round % p.every === 0;
    return { phase: long ? 'long' : 'break', round: timer.round, minutes: long ? p.long : p.break };
  }
  return { phase: 'focus', round: timer.round + 1, minutes: p.focus };
}

/**
 * Focus timer. Plain mode runs once; pomodoro mode cycles focus -> break (a long break
 * every N rounds) until stopped. Lockdown only applies during focus phases.
 * getPomodoro() -> { focus, break, long, every } in minutes.
 * onDone(phaseThatEnded, timerThatEnded, nextTimerOrNull)
 */
function timerStore(file, onChange, onDone, getPomodoro) {
  let timer = null;
  try {
    const t = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (t && t.end > Date.now()) timer = t;
  } catch {
    timer = null;
  }
  const save = () => {
    try {
      if (timer) fs.writeFileSync(file, JSON.stringify(timer));
      else fs.rmSync(file, { force: true });
    } catch {
      // the timer just won't survive a restart
    }
    onChange(timer);
  };
  onChange(timer);
  const make = (minutes, extra) => {
    const ms = Math.max(1, Math.min(240, Number(minutes) || 25)) * 60e3;
    return { end: Date.now() + ms, total: ms, ...extra };
  };
  const tick = setInterval(() => {
    if (!timer || Date.now() < timer.end) return;
    const ended = timer;
    if (ended.mode === 'pomodoro') {
      const n = nextPhase(ended, getPomodoro());
      timer = make(n.minutes, { mode: 'pomodoro', phase: n.phase, round: n.round, lockdown: ended.lockdown });
    } else timer = null;
    save();
    onDone(ended.phase || 'focus', ended, timer);
  }, 500);
  return {
    start(minutes, lockdown, mode) {
      if (mode === 'pomodoro') {
        const p = getPomodoro();
        timer = make(p.focus, { mode: 'pomodoro', phase: 'focus', round: 1, lockdown: lockdown !== false });
      } else timer = make(minutes, { mode: 'timer', phase: 'focus', lockdown: lockdown !== false });
      save();
    },
    add(minutes) {
      if (!timer) return this.start(minutes);
      timer = { ...timer, end: timer.end + minutes * 60e3, total: timer.total + minutes * 60e3 };
      save();
    },
    skip() {
      if (timer) timer = { ...timer, end: Date.now() };
    },
    setLockdown(on) {
      if (!timer) return;
      timer = { ...timer, lockdown: Boolean(on) };
      save();
    },
    stop() {
      timer = null;
      save();
    },
    stopTicking: () => clearInterval(tick),
  };
}

/** Completed focus sessions per day, and the current streak of days with at least one. */
function statsStore(file, onChange) {
  let days = {};
  try {
    days = JSON.parse(fs.readFileSync(file, 'utf8')).days || {};
  } catch {
    days = {};
  }
  const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const summary = (now = new Date()) => {
    let streak = 0;
    const d = new Date(now);
    // Today counts if you've done one; otherwise the streak is still alive from yesterday.
    if (!days[key(d)]) d.setDate(d.getDate() - 1);
    while (days[key(d)]) {
      streak++;
      d.setDate(d.getDate() - 1);
    }
    return { today: days[key(now)] || 0, streak, minutesToday: Math.round((days[`${key(now)}:min`] || 0)) };
  };
  onChange(summary());
  return {
    completeFocus(minutes) {
      const k = key(new Date());
      days[k] = (days[k] || 0) + 1;
      days[`${k}:min`] = (days[`${k}:min`] || 0) + minutes;
      try {
        fs.writeFileSync(file, JSON.stringify({ days }));
      } catch {
        // stats are best-effort
      }
      onChange(summary());
    },
    summary,
  };
}

// Strings that look like passwords/tokens are shown masked in the peek.
function looksSecret(text) {
  return !/\s/.test(text) && text.length >= 12 && text.length <= 128 && /[a-z]/.test(text) && /[A-Z0-9]/.test(text) && /[^a-z]/i.test(text) && !/^https?:/i.test(text);
}

function clipboardWatcher(clipboard, onChange, onCopied) {
  // Electron's clipboard.readText() is async (returns a Promise) in recent versions.
  let last = null;
  let history = [];
  let busy = false;
  onChange(history);
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const text = await clipboard.readText();
      if (typeof text !== 'string') return;
      if (last === null) {
        last = text; // whatever was already copied before Apron started
        return;
      }
      if (!text || text === last) return;
      last = text;
      if (text.length > 10000) return;
      const secret = looksSecret(text.trim());
      history = [{ text, secret, at: Date.now() }, ...history.filter((h) => h.text !== text)].slice(0, 10);
      onChange(history);
      onCopied({ text: secret ? '' : text.trim().slice(0, 120), secret, full: secret ? '' : text.trim() });
    } catch {
      // clipboard busy: try again next tick
    } finally {
      busy = false;
    }
  }, 700);
  return {
    copy(index) {
      const item = history[index];
      if (!item) return;
      last = item.text;
      Promise.resolve(clipboard.writeText(item.text)).catch(() => {});
    },
    clear() {
      history = [];
      onChange(history);
    },
    stop: () => clearInterval(timer),
  };
}

module.exports = { todoStore, timerStore, statsStore, nextPhase, clipboardWatcher, looksSecret };
