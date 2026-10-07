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

function timerStore(file, onChange, onDone) {
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
  const tick = setInterval(() => {
    if (timer && Date.now() >= timer.end) {
      timer = null;
      save();
      onDone();
    }
  }, 500);
  return {
    start(minutes, lockdown) {
      const ms = Math.max(1, Math.min(240, Number(minutes) || 25)) * 60e3;
      timer = { end: Date.now() + ms, total: ms, lockdown: lockdown !== false };
      save();
    },
    add(minutes) {
      if (!timer) return this.start(minutes);
      timer = { ...timer, end: timer.end + minutes * 60e3, total: timer.total + minutes * 60e3 };
      save();
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
      onCopied({ text: secret ? '' : text.trim().slice(0, 120), secret });
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

module.exports = { todoStore, timerStore, clipboardWatcher, looksSecret };
