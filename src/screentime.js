// Screen time: how long the foreground window was each distracting site or app today.
// Only labels are stored (e.g. "Instagram", "Discord", "Code"), never window titles.
const fs = require('fs');

const KEEP_DAYS = 14;
const IDLE_AFTER = 120; // seconds without input stop the clock

const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Which bucket a foreground window counts towards. */
function bucket(fg, judge) {
  if (!fg || !fg.exe) return null;
  const exe = String(fg.exe);
  if (/^(apron|electron|explorer|lockapp|searchhost|shellexperiencehost|startmenuexperiencehost)$/i.test(exe)) return null;
  const verdict = judge(fg);
  if (verdict) return verdict.label; // a distracting site/app
  if (/^(chrome|msedge|firefox|brave|opera|vivaldi|arc)$/i.test(exe)) {
    if (/youtube/i.test(fg.title)) return 'YouTube';
    return 'Browsing';
  }
  return exe.charAt(0).toUpperCase() + exe.slice(1);
}

function create(file, { judge, idleSeconds, isBlocked }, onUpdate) {
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    data = {};
  }
  let current = null;
  let since = Date.now();
  let dirty = false;

  function add(label, ms) {
    if (!label || ms <= 0) return;
    const day = dayKey();
    data[day] = data[day] || {};
    data[day][label] = (data[day][label] || 0) + Math.round(ms / 1000);
    dirty = true;
  }

  function flush() {
    const now = Date.now();
    if (idleSeconds() < IDLE_AFTER) add(current, now - since);
    since = now;
  }

  function summary() {
    const today = data[dayKey()] || {};
    const items = Object.entries(today)
      .map(([label, seconds]) => ({ label, seconds, distracting: isBlocked(label) }))
      .sort((a, b) => b.seconds - a.seconds);
    return {
      items: items.slice(0, 8),
      total: items.reduce((s, i) => s + i.seconds, 0),
      distracting: items.filter((i) => i.distracting).reduce((s, i) => s + i.seconds, 0),
    };
  }

  function save() {
    if (!dirty) return;
    const keep = new Set(Array.from({ length: KEEP_DAYS }, (_, i) => dayKey(new Date(Date.now() - i * 864e5))));
    for (const k of Object.keys(data)) if (!keep.has(k)) delete data[k];
    try {
      fs.writeFileSync(file, JSON.stringify(data));
      dirty = false;
    } catch {
      // try again next minute
    }
  }

  const tick = setInterval(() => {
    flush();
    onUpdate(summary());
  }, 30e3);
  const saver = setInterval(save, 60e3);
  onUpdate(summary());

  return {
    onForeground(fg) {
      flush();
      current = bucket(fg, judge);
    },
    stop() {
      flush();
      save();
      clearInterval(tick);
      clearInterval(saver);
    },
  };
}

module.exports = { create, bucket, dayKey };
