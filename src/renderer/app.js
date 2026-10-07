const $ = (s) => document.querySelector(s);
const islandEl = $('#island');

const SOON = 10 * 60e3;
const DONE_FLASH = 10e3;
const rotateMs = () => ((state.settings && state.settings.rotateSeconds) || 6) * 1000;
const PEEK_MS = 4000;
const TIMER_DONE_FLASH = 12e3;

const state = {
  calendar: null,
  media: null,
  claude: [],
  github: null,
  tab: 'home',
  expanded: false,
  held: false, // opened with Ctrl+Alt+Space: stays open until pressed again
  peekUntil: 0, // track-change preview
  flash: null, // { id, lead, text, trail, until, alert }
  timer: null, // { end, total, lockdown } while a focus session runs (owned by main)
  timerDoneAt: 0,
  weather: null,
  lyrics: null,
  todos: [],
  clipboard: [],
  homework: null,
  screentime: null,
  stats: null,
  privacy: { mic: [], cam: [] },
  ask: null,
  launching: false,
  sys: null,
  battery: null, // { level, charging, dischargingTime }
  spotify: null,
  plan: null,
  planning: null,
  flashcards: { count: 0 },
  classMode: false,
  card: null, // { q, a, flipped }
  cardsMode: false,
};
const isPrimary = new URLSearchParams(location.search).get('primary') !== '0';

// ---------- tiny DOM helper (textContent only, never innerHTML with data) ----------

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** replaceChildren, minus null/false/'' (replaceChildren would print them as text). */
function fill(el, ...kids) {
  el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false && k !== ''));
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function icon(d, cssText) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  if (cssText) svg.style.cssText = cssText;
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}
const ICONS = {
  play: 'M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z',
  pause: 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z',
  next: 'M5 6.2v11.6a.8.8 0 0 0 1.2.7l8.3-5.8a.8.8 0 0 0 0-1.4L6.2 5.5a.8.8 0 0 0-1.2.7zM16.5 5.5h2.5v13h-2.5z',
  prev: 'M19 6.2v11.6a.8.8 0 0 1-1.2.7L9.5 12.7a.8.8 0 0 1 0-1.4l8.3-5.8a.8.8 0 0 1 1.2.7zM5 5.5h2.5v13H5z',
  cal: 'M7 2v2H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2V2h-2v2H9V2zm-2 7h14v10H5z',
  speaker: 'M4 9v6h4l5 4V5L8 9zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z',
  home: 'M12 3 2 11.5h3V21h5.5v-6h3v6H19v-9.5h3z',
  music: 'M19 3v12.6A3.5 3.5 0 1 1 17 12.5V7.3l-8 1.8v8.5A3.5 3.5 0 1 1 7 14.5V5.5z',
  claude: 'M12 2l1.8 6.2L20 6l-4.2 4.8L22 12l-6.2 1.2L20 18l-6.2-2.2L12 22l-1.8-6.2L4 18l4.2-4.8L2 12l6.2-1.2L4 6l6.2 2.2z',
  check: 'M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6L21 7.5l-1.4-1.4z',
  clip: 'M9 2h6a1 1 0 0 1 1 1v1h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2V3a1 1 0 0 1 1-1zm1 2v2h4V4zM8 10v2h8v-2zm0 4v2h6v-2z',
  sys: 'M9 2v2H7a3 3 0 0 0-3 3v2H2v2h2v2H2v2h2v2a3 3 0 0 0 3 3h2v2h2v-2h2v2h2v-2h2a3 3 0 0 0 3-3v-2h2v-2h-2v-2h2V9h-2V7a3 3 0 0 0-3-3h-2V2h-2v2h-2V2zm0 6h6v8H9z',
  heart: 'M12 21s-7.5-4.6-9.5-9.2C1 8.2 3.2 4.5 7 4.5c2 0 3.6 1.1 5 2.8 1.4-1.7 3-2.8 5-2.8 3.8 0 6 3.7 4.5 7.3C19.5 16.4 12 21 12 21z',
  shuffle: 'M17 3l4 4-4 4V8h-2.6l-7.3 9H3v-2h3.1l7.3-9H17zm0 10l4 4-4 4v-3h-3.9l-2.1-2.6 1.3-1.6 1.8 2.2H17zM3 7h4.1l2.1 2.6-1.3 1.6L6.1 9H3z',
  repeat: 'M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2z',
  list: 'M3 5h13v2H3zm0 6h13v2H3zm0 6h9v2H3zm15-6v6.3A2.5 2.5 0 1 0 20 20v-7h2v-2z',
  muted: 'M4 9v6h4l5 4V5L8 9zm16.6 0-1.4-1.4-2.6 2.6-2.6-2.6L12.6 9l2.6 2.6-2.6 2.6 1.4 1.4 2.6-2.6 2.6 2.6 1.4-1.4-2.6-2.6z',
  timer: 'M9 1h6v2H9zm3 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm1 8.4V8h-2v6.6l4.2 2.5 1-1.7z',
};

// ---------- formatting ----------

const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function fmtDuration(sec) {
  sec = Math.max(0, Math.floor(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function fmtAgo(ms) {
  const m = Math.round((Date.now() - ms) / 60e3);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const hrs = Math.round(m / 60);
  return hrs < 24 ? `${hrs}h` : `${Math.round(hrs / 24)}d`;
}

function fmtUntil(ms) {
  const m = Math.ceil((ms - Date.now()) / 60e3);
  return m <= 0 ? 'now' : `in ${m}m`;
}

function appName(id) {
  if (!id) return '';
  const base = id.split('!').pop().replace(/\.exe$/i, '');
  return base.split(/[._]/).filter(Boolean).pop() || base;
}

function mediaPosition(m) {
  if (!m.duration) return 0;
  const drift = m.playing && m.updatedAt ? (Date.now() - m.updatedAt) / 1000 : 0;
  return Math.min(m.duration, m.position + drift);
}

function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

const dot = (cls = '') => h('span', { class: `dot ${cls}` });
const calLead = () => h('span', { class: 'glyph' }, icon(ICONS.cal));
const isPlaying = (m) => m && m.active && m.playing && m.title;

// ---------- collapsed pill ----------
// Priority: things that need you > short flashes > timer > music > rotating info.

function compactView() {
  const now = Date.now();
  const sessions = state.claude || [];

  const waiting = sessions.filter((s) => s.state === 'waiting');
  if (waiting.length) {
    const s = waiting[0];
    return {
      alert: true,
      id: 'waiting',
      tab: 'claude',
      lead: dot('waiting'),
      text: `${s.project} needs you`,
      trail: waiting.length > 1 ? `+${waiting.length - 1}` : fmtAgo(s.at),
    };
  }

  if (now - state.timerDoneAt < TIMER_DONE_FLASH) {
    return { alert: true, id: 'timer-done', tab: 'timer', lead: dot('waiting'), text: "Time's up", trail: '00:00' };
  }

  const done = sessions.find((s) => s.state === 'done' && now - s.at < DONE_FLASH);
  if (done) return { id: 'done', tab: 'claude', lead: dot('done'), text: `${done.project} is done`, trail: '✓' };

  if (state.flash && state.flash.until > now) return state.flash;
  if (state.flash && state.flash.until <= now) state.flash = null;

  const m = state.media;
  if (isPlaying(m) && now < state.peekUntil) {
    return {
      id: `peek:${m.title}`,
      tab: 'media',
      peek: true,
      lead: m.art ? h('img', { src: m.art, alt: '' }) : dot('done'),
      text: h('span', { class: 'two' }, h('b', {}, m.title), h('small', {}, m.artist || appName(m.app))),
      textKey: `${m.title}|${m.artist}`,
      trail: h('span', { class: 'bars' }, h('i'), h('i'), h('i'), h('i')),
    };
  }

  if (state.timer) {
    const left = Math.max(0, (state.timer.end - now) / 1000);
    const t = state.timer;
    const phase = t.phase === 'break' ? 'Break' : t.phase === 'long' ? 'Long break' : t.lockdown ? 'Focus · locked' : 'Focus';
    const round = t.mode === 'pomodoro' && t.phase === 'focus' ? ` · ${t.round}` : '';
    return { id: `timer:${t.phase}`, tab: 'timer', lead: h('span', { class: `glyph${t.phase !== 'focus' ? ' resting' : ''}` }, icon(ICONS.timer)), text: phase + round, trail: fmtDuration(left) };
  }

  const events = (state.calendar && state.calendar.events) || [];
  const soon = events.find((e) => !e.allDay && e.start - now < SOON && e.start - now > 0);

  // Music stays up while it plays; an imminent event takes turns with it.
  if (isPlaying(m)) {
    const music = {
      id: 'music',
      tab: 'media',
      lead: m.art ? h('img', { src: m.art, alt: '' }) : dot('done'),
      text: m.artist ? `${m.title} · ${m.artist}` : m.title,
      trail: h('span', { class: 'bars' }, h('i'), h('i'), h('i')),
    };
    if (soon && Math.floor(now / rotateMs()) % 2) {
      return { id: 'soon', tab: 'calendar', lead: calLead(), text: soon.title, trail: fmtUntil(soon.start) };
    }
    return music;
  }

  const items = rotationItems(now, events, soon);
  return items[Math.floor(now / rotateMs()) % items.length];
}

const DAY = 864e5;
const startOfDay = (ms) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** Countdowns from Settings plus "31 days to exam" style all-day calendar events. */
function countdowns(now = Date.now()) {
  const out = [];
  for (const c of (state.settings && state.settings.countdowns) || []) {
    const [y, m, d] = c.date.split('-').map(Number);
    const days = Math.round((new Date(y, m - 1, d).getTime() - startOfDay(now)) / DAY);
    if (days >= 0) out.push({ title: c.title, days });
  }
  const events = (state.calendar && state.calendar.events) || [];
  for (const e of events) {
    if (!e.allDay || dayKey(e.start) !== dayKey(now)) continue;
    const m = e.title.match(/(\d+)\s+days?\s+(?:to|until|till|left(?: for| until)?)\s+(.+)$/i);
    if (m) out.push({ title: m[2].replace(/[.!]+$/, ''), days: Number(m[1]) });
  }
  return out.sort((a, b) => a.days - b.days);
}

const fmtDays = (n) => (n === 0 ? 'today' : n === 1 ? '1 day' : `${n} days`);

/** Homework due in the next two weeks, soonest first. */
function dueItems(now = Date.now()) {
  const hw = state.homework;
  if (!hw || !hw.events) return [];
  return hw.events.filter((e) => e.end >= now - 3600e3).sort((a, b) => a.start - b.start);
}

function fmtDue(ms, now = Date.now()) {
  const days = Math.round((startOfDay(ms) - startOfDay(now)) / DAY);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 7) return new Date(ms).toLocaleDateString([], { weekday: 'short' });
  return `in ${days}d`;
}

function rotationItems(now, events, soon) {
  const items = [];
  const due = dueItems(now).find((e) => e.start - now < 3 * DAY);
  if (due) items.push({ id: 'due', tab: 'calendar', lead: h('span', { class: 'glyph-text' }, '✎'), text: `${due.title}`, trail: `due ${fmtDue(due.start, now)}` });
  const cd = countdowns(now)[0];
  if (cd) items.push({ id: 'countdown', tab: 'calendar', lead: h('span', { class: 'glyph-text' }, '⏳'), text: cd.title, trail: cd.days === 0 ? 'today' : `${cd.days}d` });
  const current = events.find((e) => !e.allDay && e.start <= now && e.end > now);
  if (current) {
    items.push({ id: 'class', tab: 'calendar', lead: calLead(), text: current.title, trail: `${Math.ceil((current.end - now) / 60e3)}m left` });
  }
  if (soon) items.push({ id: 'soon', tab: 'calendar', lead: calLead(), text: soon.title, trail: fmtUntil(soon.start) });
  const next = events.find((e) => !e.allDay && e.start > now && e !== soon && dayKey(e.start) === dayKey(now));
  if (next && !soon) items.push({ id: 'next', tab: 'calendar', lead: calLead(), text: `Next · ${next.title}`, trail: fmtTime(next.start) });

  const w = state.weather;
  if (w && w.status === 'ok') {
    // Rain warning for the next class within the hour.
    const nextClass = events.find((e) => !e.allDay && e.start > now && e.start - now < 60 * 60e3);
    const rain = nextClass ? rainChance(w, nextClass.start) : null;
    if (rain != null && rain >= 50) {
      items.push({ id: 'rain', tab: 'calendar', lead: h('span', { class: 'glyph-text' }, '🌧'), text: `Rain likely at ${fmtTime(nextClass.start)}`, trail: `${rain}%` });
    }
    items.push({ id: 'weather', tab: 'calendar', lead: h('span', { class: 'glyph-text' }, w.glyph), text: `${w.label} · ${w.place}`, trail: `${w.temp}°` });
  }

  const openTodos = (state.todos || []).filter((t) => !t.done);
  if (openTodos.length) items.push({ id: 'todo', tab: 'todo', lead: dot(), text: openTodos[0].text, trail: openTodos.length > 1 ? `+${openTodos.length - 1}` : '☐' });

  const prs = (state.github && state.github.prs) || [];
  if (prs.length) {
    const worst = ['fail', 'pending', 'pass', 'none'].find((c) => prs.some((p) => p.ci === c));
    items.push({
      id: 'prs',
      tab: 'claude',
      lead: dot(worst === 'fail' ? 'waiting' : 'done'),
      text: `${prs.length} open PR${prs.length > 1 ? 's' : ''}${worst === 'fail' ? ' · CI failing' : ''}`,
      trail: CI_GLYPH[worst],
    });
  }

  items.push({
    id: 'clock',
    lead: dot(),
    text: new Date(now).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }),
    trail: fmtTime(now),
  });
  return items;
}

let lastCompactKey = '';
let lastCompactId = '';
let currentCompact = null;
function renderCompact() {
  const v = compactView();
  currentCompact = v;
  islandEl.classList.toggle('alert', Boolean(v.alert) && !state.expanded);
  islandEl.classList.toggle('peek', Boolean(v.peek) && !state.expanded);
  reportRect();
  // Rebuild only when something visible changed, so the art <img> doesn't flicker every tick.
  const lead = v.lead.tagName === 'IMG' ? `img${v.lead.src.length}` : v.lead.className;
  const text = typeof v.text === 'string' ? v.text : v.textKey;
  const key = [v.id, text, typeof v.trail === 'string' ? v.trail : 'node', lead].join('|');
  if (key === lastCompactKey) return;
  lastCompactKey = key;
  // Animate only when switching to a different kind of item, not on every clock tick.
  if (v.id !== lastCompactId) {
    const el = $('.compact');
    el.classList.remove('swap');
    void el.offsetWidth;
    el.classList.add('swap');
    lastCompactId = v.id;
  }
  fill($('#compact-lead'), v.lead);
  fill($('#compact-text'), v.text);
  fill($('#compact-trail'), v.trail);
}

function rainChance(w, ms) {
  if (!w.hourly) return null;
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
  const i = w.hourly.time.indexOf(key);
  return i >= 0 ? w.hourly.precipitation_probability[i] : null;
}

function flash(item, ms = 4000) {
  state.flash = { ...item, until: Date.now() + ms };
  renderCompact();
}

// ---------- album-art colour ----------

let artKey = '';
function tintFromArt(src) {
  if (!src) {
    document.documentElement.style.removeProperty('--art');
    return;
  }
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, 16, 16);
    const px = ctx.getImageData(0, 0, 16, 16).data;
    // Weight colourful pixels so a mostly-black cover still yields its accent colour.
    let r = 0;
    let g = 0;
    let b = 0;
    let wsum = 0;
    for (let i = 0; i < px.length; i += 4) {
      const max = Math.max(px[i], px[i + 1], px[i + 2]);
      const min = Math.min(px[i], px[i + 1], px[i + 2]);
      const w = ((max - min) / 255) ** 2 * (max / 255) + 0.001;
      r += px[i] * w;
      g += px[i + 1] * w;
      b += px[i + 2] * w;
      wsum += w;
    }
    [r, g, b] = [r / wsum, g / wsum, b / wsum];
    // Lift it so it reads on black.
    const lift = 200 / Math.max(r, g, b, 1);
    const k = Math.max(1, lift);
    const hex = (v) => Math.round(Math.min(255, v * k)).toString(16).padStart(2, '0');
    document.documentElement.style.setProperty('--art', `#${hex(r)}${hex(g)}${hex(b)}`);
  };
  img.src = src;
}

// ---------- media tab ----------

// Called every second: move the progress bar without rebuilding the buttons.
function tickMedia() {
  const m = state.media;
  if (!m || !m.active || !m.duration) return;
  const pos = mediaPosition(m);
  const bar = $('#media .track i');
  const elapsed = $('#media .progress span');
  if (bar) bar.style.width = `${(pos / m.duration) * 100}%`;
  if (elapsed) elapsed.textContent = fmtDuration(pos);
}

function volumeRow(m) {
  if (m.volume == null) return null;
  const set = (ev) => {
    const r = ev.currentTarget.getBoundingClientRect();
    const pct = Math.round(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * 100);
    state.media.volume = pct;
    window.island.media(`vol ${pct}`);
    updateVolume();
  };
  return h(
    'div',
    { class: 'volume' },
    h('button', { class: 'vol-icon', title: m.muted ? 'Unmute' : 'Mute', onclick: () => window.island.media('mute') }, icon(m.muted ? ICONS.muted : ICONS.speaker)),
    h('div', { class: 'track vol-track', onclick: set }, h('i', { style: `width:${m.muted ? 0 : m.volume}%` })),
    h('span', { class: 'vol-pct' }, m.muted ? 'MUTE' : `${m.volume}`),
  );
}

function updateVolume() {
  const m = state.media;
  const bar = $('#media .vol-track i');
  const pct = $('#media .vol-pct');
  if (bar) bar.style.width = `${m.muted ? 0 : m.volume}%`;
  if (pct) pct.textContent = m.muted ? 'MUTE' : `${m.volume}`;
}

function renderMedia() {
  const m = state.media;
  const root = $('#media');
  if (!m || !m.active) {
    fill(root, 
      h('div', { class: 'empty' }, m && m.status === 'error' ? `Media unavailable: ${m.error}` : 'Nothing playing'),
      m && volumeRow(m),
    );
    return;
  }
  const pos = mediaPosition(m);
  const send = (cmd) => () => window.island.media(cmd);
  const toggle = () => {
    window.island.media('toggle');
    // Flip the icon straight away; the real state follows a moment later.
    state.media = { ...state.media, playing: !state.media.playing };
    renderMedia();
  };
  const playBtn = h('button', { class: 'play', title: m.playing ? 'Pause' : 'Play', onclick: toggle }, icon(m.playing ? ICONS.pause : ICONS.play));
  const prevBtn = h('button', { title: 'Previous', onclick: send('prev'), disabled: !m.canPrev }, icon(ICONS.prev));
  const nextBtn = h('button', { title: 'Next', onclick: send('next'), disabled: !m.canNext }, icon(ICONS.next));

  fill(root, 
    h(
      'div',
      { class: 'media-top' },
      m.art ? h('img', { class: `media-art${m.playing ? ' spinning' : ''}`, src: m.art, alt: '' }) : h('div', { class: 'media-art' }),
      h(
        'div',
        { class: 'media-meta' },
        h('div', { class: 'media-title' }, m.title || 'Unknown'),
        h('div', { class: 'media-artist' }, m.artist || ''),
        h(
          'div',
          { class: 'media-app' },
          appName(m.app),
          h(
            'button',
            {
              class: 'share-btn',
              title: 'Copy a link that opens this song in Spotify (and other apps)',
              onclick: async () => {
                flash({ id: `sharing:${Date.now()}`, lead: dot(), text: 'Finding the song…', trail: '' }, 4000);
                const r = await window.island.share();
                if (r && r.ok) flash({ id: `shared:${Date.now()}`, lead: dot('done'), text: r.exact ? 'Song link copied · opens in Spotify' : 'Spotify search link copied', trail: '⧉' }, 2500);
                else flash({ id: `shared:${Date.now()}`, lead: dot(), text: "Couldn't find it", trail: '' }, 2500);
              },
            },
            'Share',
          ),
        ),
      ),
    ),
    m.duration > 0 &&
      h(
        'div',
        { class: 'progress' },
        h('span', {}, fmtDuration(pos)),
        h('div', { class: 'track' }, h('i', { style: `width:${(pos / m.duration) * 100}%` })),
        fmtDuration(m.duration),
      ),
    (!state.settings || state.settings.lyrics !== false) && h('div', { class: 'lyric' }, h('span', { class: 'lyric-now' }), h('span', { class: 'lyric-next' })),
    h(
      'div',
      { class: 'controls' },
      m.canShuffle && h('button', { class: `mini-ctl${m.shuffle ? ' on' : ''}`, title: 'Shuffle', onclick: send('shuffle') }, icon(ICONS.shuffle)),
      prevBtn,
      playBtn,
      nextBtn,
      m.canRepeat && h('button', { class: `mini-ctl${m.repeat !== 'none' ? ' on' : ''}`, title: `Repeat: ${m.repeat}`, onclick: send('repeat') }, icon(ICONS.repeat), m.repeat === 'track' ? h('b', { class: 'one' }, '1') : null),
    ),
    spotifyRow(m),
    volumeRow(m),
  );
  lastLyric = null;
  tickLyrics();
}

// ---------- lyrics ----------

let lastLyric = null;
function lyricIndex(lines, pos) {
  let ans = -1;
  for (let i = 0; i < lines.length && lines[i].t <= pos; i++) ans = i;
  return ans;
}

function tickLyrics() {
  const el = $('#media .lyric');
  if (!el) return;
  const m = state.media;
  const l = state.lyrics;
  const mine = l && m && l.key === `${m.title}|${m.artist}`;
  let now = '';
  let next = '';
  if (mine && l.lines && l.lines.length) {
    const i = lyricIndex(l.lines, mediaPosition(m) + 0.3);
    now = i >= 0 ? l.lines[i].text || '♪' : '♪';
    next = (l.lines[i + 1] && l.lines[i + 1].text) || '';
  }
  const key = `${now}|${next}`;
  if (key === lastLyric) return;
  lastLyric = key;
  el.classList.toggle('empty-lyric', !now);
  el.firstChild.textContent = now;
  el.lastChild.textContent = next;
  el.classList.remove('swap');
  void el.offsetWidth;
  el.classList.add('swap');
}

// Like / playlists through the Spotify Web API (once connected in Settings).
function spotifyRow(m) {
  const sp = state.spotify;
  if (!sp || !sp.connected || !/spotify/i.test(m.app || '')) return null;
  const like = h(
    'button',
    {
      class: `sp-btn${sp.liked ? ' liked' : ''}`,
      title: sp.liked ? 'Remove from Liked Songs' : 'Save to Liked Songs',
      onclick: async () => {
        const r = await window.island.spotify('like');
        if (r && r.ok) flash({ id: `like:${Date.now()}`, lead: dot('done'), text: r.liked ? 'Saved to Liked Songs' : 'Removed from Liked Songs', trail: '♥' }, 2000);
        else flash({ id: `like:${Date.now()}`, lead: dot(), text: (r && r.error) || "Couldn't do that", trail: '' }, 3000);
      },
    },
    icon(ICONS.heart),
  );
  const lists = h(
    'button',
    {
      class: 'sp-btn',
      title: 'Your playlists',
      onclick: async () => {
        state.showPlaylists = !state.showPlaylists;
        if (state.showPlaylists && !(sp.playlists && sp.playlists.length)) await window.island.spotify('playlists');
        renderMedia();
      },
    },
    icon(ICONS.list),
  );
  const row = h('div', { class: 'sp-row' }, like, lists);
  if (!state.showPlaylists) return row;
  const pl = (sp.playlists || []).slice(0, 30);
  return h(
    'div',
    { class: 'sp-wrap' },
    row,
    h(
      'div',
      { class: 'playlists' },
      pl.length
        ? pl.map((p) =>
            h(
              'button',
              {
                class: 'playlist',
                onclick: async () => {
                  const r = await window.island.spotify('play', p.uri);
                  flash({ id: `pl:${Date.now()}`, lead: dot(r && r.ok ? 'done' : ''), text: r && r.ok ? `Playing ${p.name}` : (r && r.error) || "Couldn't play that", trail: '' }, 3000);
                  state.showPlaylists = false;
                  renderMedia();
                },
              },
              p.name,
            ),
          )
        : h('div', { class: 'empty small' }, 'Loading playlists…'),
    ),
  );
}

// Scroll anywhere on the music tab to change the volume.
let lastWheel = 0;
islandEl.addEventListener(
  'wheel',
  (ev) => {
    if (!state.expanded || state.tab !== 'media' || !state.media || state.media.volume == null) return;
    ev.preventDefault();
    const now = Date.now();
    if (now - lastWheel < 40) return;
    lastWheel = now;
    const up = ev.deltaY < 0;
    window.island.media(up ? 'volup' : 'voldown');
    state.media.volume = Math.max(0, Math.min(100, state.media.volume + (up ? 4 : -4)));
    if (up) state.media.muted = false;
    updateVolume();
  },
  { passive: false },
);

// ---------- calendar tab ----------

let scrollCalendar = true;

function renderCalendar() {
  const c = state.calendar;
  const root = $('#calendar');
  if (!c) {
    fill(root, h('div', { class: 'empty' }, 'Loading calendar…'));
    return;
  }
  if (c.status === 'unconfigured') {
    fill(root, 
      h(
        'div',
        { class: 'empty' },
        'Paste your Google Calendar secret iCal address into config.json',
        h('button', { class: 'pill-btn', onclick: () => window.island.openConfig() }, 'Open config'),
      ),
    );
    return;
  }

  const now = Date.now();
  const today = dayKey(now);
  const items = [];
  if (c.status === 'error') items.push(h('div', { class: 'empty small' }, `⚠ ${c.error}`));
  const w = state.weather;
  if (w && w.status === 'ok') {
    const rainHours = (w.hourly.time || [])
      .map((t, i) => ({ t: new Date(t).getTime(), p: w.hourly.precipitation_probability[i] }))
      .filter((x) => x.t > now && x.t - now < 12 * 3600e3 && x.p >= 50);
    items.push(
      h(
        'div',
        { class: 'weather-row' },
        h('span', { class: 'weather-temp' }, `${w.temp}°`),
        h('span', { class: 'weather-desc' }, `${w.glyph} ${w.label} · ${w.place}`),
        h('span', { class: 'side' }, rainHours.length ? `Rain from ${fmtTime(rainHours[0].t)} · ${rainHours[0].p}%` : 'No rain soon'),
      ),
    );
  }

  const cds = countdowns(now).slice(0, 3);
  if (cds.length) {
    items.push(
      h(
        'div',
        { class: 'countdowns' },
        ...cds.map((c) => h('div', { class: 'countdown' }, h('span', { class: 'cd-days' }, c.days === 0 ? 'TODAY' : String(c.days)), h('span', { class: 'cd-label' }, c.days === 0 ? c.title : `day${c.days === 1 ? '' : 's'} to ${c.title}`))),
      ),
    );
  }
  const due = dueItems(now).slice(0, 5);
  if (due.length) {
    items.push(h('div', { class: 'heading' }, 'Due soon'));
    for (const e of due) {
      items.push(
        h(
          'div',
          { class: `row${e.start - now < DAY ? ' now' : ''}` },
          h('span', { class: 'time' }, fmtDue(e.start, now)),
          h('div', { class: 'main' }, h('div', { class: 'title' }, e.title), e.location && h('div', { class: 'sub' }, e.location)),
        ),
      );
    }
  }

  let lastDay = null;
  let focusSet = false;
  const earlier = c.events.filter((e) => !e.allDay && e.end <= now).length;
  for (const e of c.events) {
    // Finished classes just push what's next out of view; skip them.
    if (!e.allDay && e.end <= now) continue;
    const day = e.allDay ? dayKey(e.start) : dayKey(Math.max(e.start, now));
    if (day !== lastDay) {
      items.push(h('div', { class: 'heading' }, day === today ? 'Today' : 'Tomorrow'));
      lastDay = day;
    }
    const [y, mo, d] = day.split('/');
    const isNow = !e.allDay && e.start <= now && e.end > now;
    const isFocus = !focusSet && !e.allDay && e.end > now;
    if (isFocus) focusSet = true;
    const progress = isNow && h('i', { class: 'row-progress', style: `width:${((now - e.start) / (e.end - e.start)) * 100}%` });
    items.push(
      h(
        'div',
        {
          id: isFocus ? 'cal-focus' : null,
          class: `row clickable${e.end < now && !e.allDay ? ' past' : ''}${isNow ? ' now' : ''}`,
          onclick: () => window.island.open(`https://calendar.google.com/calendar/r/day/${y}/${mo}/${d}`),
        },
        progress,
        h('span', { class: 'stripe', style: `background:var(--cal-${e.calendar % 4})` }),
        h('span', { class: 'time' }, e.allDay ? 'All day' : fmtTime(e.start)),
        h('div', { class: 'main' }, h('div', { class: 'title' }, e.title), e.location && h('div', { class: 'sub' }, e.location)),
        isNow && h('span', { class: 'side' }, `${Math.ceil((e.end - now) / 60e3)}m left`),
        e.joinUrl &&
          e.end > now &&
          h(
            'button',
            {
              class: 'pill-btn',
              onclick: (ev) => {
                ev.stopPropagation();
                window.island.open(e.joinUrl);
              },
            },
            'Join',
          ),
      ),
    );
  }
  // Homework plan from Claude
  if (due.length || (state.plan && state.plan.blocks && state.plan.blocks.length)) {
    const p = state.plan;
    const busy = state.planning && state.planning.status === 'working';
    items.push(
      h(
        'div',
        { class: 'heading plan-head' },
        'Plan',
        h('button', { class: 'pill-btn ghost', disabled: busy, onclick: () => window.island.plan('make') }, busy ? 'Planning…' : p && p.blocks && p.blocks.length ? 'Re-plan' : 'Plan my homework'),
      ),
    );
    if (state.planning && state.planning.status === 'error') items.push(h('div', { class: 'empty small' }, `⚠ ${state.planning.error}`));
    if (p && p.summary) items.push(h('div', { class: 'empty small' }, p.summary));
    for (const b of (p && p.blocks) || []) {
      const live = b.start <= now && b.start + b.minutes * 60e3 > now;
      items.push(
        h(
          'div',
          { class: `row${live ? ' now' : ''}` },
          h('span', { class: 'time' }, `${fmtDue(b.start, now) === 'today' ? '' : `${fmtDue(b.start, now)} `}${fmtTime(b.start)}`),
          h('div', { class: 'main' }, h('div', { class: 'title' }, b.task), h('div', { class: 'sub' }, `${b.minutes} min · ${b.why}`)),
          live && h('button', { class: 'pill-btn', onclick: () => startTimer(b.minutes) }, 'Start'),
        ),
      );
    }
  }
  if (earlier) items.push(h('div', { class: 'empty small' }, `${earlier} earlier today already done`));
  if (!c.events.length) items.push(h('div', { class: 'empty' }, 'Nothing today or tomorrow 🎉'));
  fill(root, ...items);
  // On open, jump past the classes that already happened.
  if (scrollCalendar) {
    scrollCalendar = false;
    // Finished classes are hidden now, so the top (weather, countdowns, due) is what's next.
    root.scrollTop = 0;
  }
}

// ---------- claude tab ----------

const CI_GLYPH = { pass: '✓', fail: '✗', pending: '●', none: '–' };

function renderClaude() {
  const root = $('#claude');
  const sessions = state.claude || [];
  const gh = state.github;
  const items = [];

  items.push(h('div', { class: 'heading' }, 'Sessions'));
  if (!sessions.length) {
    items.push(h('div', { class: 'empty small' }, 'No Claude Code activity yet. Sessions show up here as soon as one starts.'));
  }
  for (const s of sessions) {
    const a = s.state === 'waiting' && s.approval;
    items.push(
      h(
        'div',
        { class: `row${a ? ' approval' : ''}` },
        dot(s.state),
        h(
          'div',
          { class: 'main' },
          h('div', { class: 'title' }, s.project),
          h('div', { class: 'sub' }, s.state === 'working' ? 'Working…' : s.message),
          a && a.detail && h('div', { class: 'detail' }, a.detail),
        ),
        a
          ? h(
              'div',
              { class: 'decide' },
              h('button', { class: 'pill-btn ghost', onclick: () => window.island.claudeDecide(a.id, false) }, 'Deny'),
              h('button', { class: 'pill-btn', onclick: () => window.island.claudeDecide(a.id, true) }, 'Allow'),
            )
          : h('span', { class: 'side' }, fmtAgo(s.at)),
      ),
    );
  }

  items.push(h('div', { class: 'heading' }, 'Your pull requests'));
  if (!gh) items.push(h('div', { class: 'empty small' }, 'Checking GitHub…'));
  else if (gh.status === 'error') items.push(h('div', { class: 'empty small' }, `⚠ gh: ${gh.error}`));
  if (gh && gh.prs.length === 0 && gh.status === 'ok') items.push(h('div', { class: 'empty small' }, 'No open PRs'));
  for (const pr of (gh && gh.prs) || []) {
    items.push(
      h(
        'div',
        { class: 'row clickable', onclick: () => window.island.open(pr.url), title: pr.url },
        h('span', { class: `ci ${pr.ci}`, title: `CI: ${pr.ci}` }, CI_GLYPH[pr.ci]),
        h(
          'div',
          { class: 'main' },
          h('div', { class: 'title' }, pr.title),
          h('div', { class: 'sub' }, `${pr.repo} #${pr.number}${pr.draft ? ' · draft' : ''}${pr.review === 'APPROVED' ? ' · approved' : ''}${pr.review === 'CHANGES_REQUESTED' ? ' · changes requested' : ''}`),
        ),
        h('span', { class: 'side' }, fmtAgo(pr.updatedAt)),
      ),
    );
  }

  if (gh && gh.pushes.length) {
    items.push(h('div', { class: 'heading' }, 'Pushed in the last day'));
    for (const p of gh.pushes) {
      const action = p.pr
        ? h('button', { class: 'pill-btn ghost', onclick: () => window.island.open(p.pr.url) }, `#${p.pr.number}${p.pr.state === 'OPEN' ? '' : ` ${p.pr.state.toLowerCase()}`}`)
        : h('button', { class: 'pill-btn', onclick: () => window.island.open(p.compareUrl) }, 'Open PR');
      items.push(
        h(
          'div',
          { class: 'row' },
          h('div', { class: 'main' }, h('div', { class: 'title' }, p.branch), h('div', { class: 'sub' }, `${p.repo} · ${fmtAgo(p.at)} ago${p.pr ? '' : ' · no PR yet'}`)),
          action,
        ),
      );
    }
  }

  fill(root, ...items);
}

function renderBadge() {
  const waiting = (state.claude || []).filter((s) => s.state === 'waiting').length;
  const failing = ((state.github && state.github.prs) || []).filter((p) => p.ci === 'fail').length;
  $('#claude-badge').textContent = waiting ? String(waiting) : failing ? '✗' : '';
  $('#todo-badge').textContent = (state.todos || []).some((t) => !t.done) ? '•' : '';
}

// ---------- focus timer + lockdown ----------

// Starts from the "Lockdown on by default" setting; the switch here overrides it per session.
let lockdownPref = null;
const lockdownOn = () => (lockdownPref === null ? !state.settings || state.settings.lockdownDefault !== false : lockdownPref);

function startTimer(minutes, mode) {
  window.island.timer('start', { minutes, lockdown: lockdownOn(), mode });
}

function fmtSpent(sec) {
  const m = Math.round(sec / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function statsLine() {
  const st = state.stats;
  if (!st) return null;
  const parts = [];
  if (st.streak) parts.push(`🔥 ${st.streak}-day streak`);
  parts.push(`${st.today} session${st.today === 1 ? '' : 's'} today`);
  return h('div', { class: 'stats-line' }, parts.join(' · '));
}

function screenTimeBlock() {
  const s = state.screentime;
  if (!s || !s.items.length) return null;
  const max = Math.max(...s.items.map((i) => i.seconds), 1);
  return h(
    'div',
    { class: 'screentime' },
    h('div', { class: 'heading' }, `Screen time today · ${fmtSpent(s.total)}${s.distracting ? ` · ${fmtSpent(s.distracting)} distracted` : ''}`),
    ...s.items.slice(0, 6).map((i) =>
      h(
        'div',
        { class: `st-row${i.distracting ? ' bad' : ''}` },
        h('span', { class: 'st-label' }, i.label),
        h('span', { class: 'st-bar' }, h('i', { style: `width:${Math.max(3, (i.seconds / max) * 100)}%` })),
        h('span', { class: 'st-time' }, fmtSpent(i.seconds)),
      ),
    ),
  );
}

function chime() {
  try {
    const ctx = new AudioContext();
    [0, 0.18, 0.36].forEach((t, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = [880, 1175, 1568][i];
      g.gain.setValueAtTime(0.0001, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.35);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + t);
      o.stop(ctx.currentTime + t + 0.4);
    });
  } catch {
    // no audio: the flash is enough
  }
}

function lockdownToggle(on, onClick) {
  return h('button', { class: `lock-toggle${on ? ' on' : ''}`, onclick: onClick, title: 'Close distracting sites while the timer runs' }, h('span', { class: 'lock-dot' }), on ? 'Lockdown on' : 'Lockdown off');
}

function blockedList() {
  const sites = (state.settings && state.settings.lockdownSites) || [];
  return h('div', { class: 'blocked-list', title: 'Edit in config.json → lockdown' }, `Blocks ${sites.slice(0, 6).join(', ')}${sites.length > 6 ? ` +${sites.length - 6}` : ''} · YouTube & Spotify allowed`);
}

function newCard() {
  window.island.flashcard().then((c) => {
    state.card = c ? { ...c, flipped: false } : null;
    if (state.tab === 'timer') renderTimer();
  });
}

function flashcardBlock() {
  const c = state.card;
  if (!state.flashcards || !state.flashcards.count) {
    return h('div', { class: 'card empty-card' }, 'No flashcards yet. In any Obsidian note write a line like ', h('b', {}, 'mitosis :: cell division into two identical cells'));
  }
  if (!c) {
    newCard();
    return h('div', { class: 'card' }, 'Shuffling…');
  }
  return h(
    'div',
    { class: `card${c.flipped ? ' flipped' : ''}`, onclick: () => ((c.flipped = !c.flipped), renderTimer()) },
    h('div', { class: 'card-q' }, c.q),
    c.flipped ? h('div', { class: 'card-a' }, c.a) : h('div', { class: 'card-hint' }, 'tap to flip'),
    c.flipped &&
      h(
        'div',
        { class: 'card-btns' },
        h('button', { class: 'pill-btn ghost', onclick: (e) => (e.stopPropagation(), newCard()) }, 'Again'),
        h('button', { class: 'pill-btn', onclick: (e) => (e.stopPropagation(), newCard()) }, 'Got it'),
      ),
    h('div', { class: 'card-src' }, c.source),
  );
}

function plannedNow() {
  const p = state.plan;
  if (!p || !p.blocks) return null;
  const now = Date.now();
  const b = p.blocks.find((x) => x.start <= now + 5 * 60e3 && x.start + x.minutes * 60e3 > now);
  if (!b || state.timer) return null;
  return h('div', { class: 'planned' }, h('span', {}, `Planned now: ${b.task}`), h('button', { class: 'pill-btn', onclick: () => startTimer(b.minutes) }, `Start ${b.minutes}m`));
}

function renderTimer() {
  const root = $('#timer');
  const t = state.timer;
  const resting = t && t.phase && t.phase !== 'focus';
  if (state.cardsMode || resting) {
    // Breaks (and "cards" from the launcher) are for flashcards.
    if (state.cardsMode && !resting) {
      fill(root, flashcardBlock(), h('button', { class: 'pill-btn ghost', onclick: () => ((state.cardsMode = false), renderTimer()) }, 'Done'));
      return;
    }
  }
  if (!t) {
    fill(root, 
      h('div', { class: 'timer-big idle' }, '00:00'),
      h(
        'div',
        { class: 'timer-presets' },
        h('button', { class: 'pill-btn', onclick: () => startTimer(0, 'pomodoro'), title: 'Focus/break cycles that keep going' }, 'Pomodoro'),
        ...[15, 25, 50].map((m) => h('button', { class: 'pill-btn ghost', onclick: () => startTimer(m) }, `${m} min`)),
      ),
      lockdownToggle(lockdownOn(), () => {
        lockdownPref = !lockdownOn();
        renderTimer();
      }),
      lockdownOn() && blockedList(),
      plannedNow(),
      statsLine(),
      state.flashcards && state.flashcards.count ? h('button', { class: 'pill-btn ghost', onclick: () => ((state.cardsMode = true), newCard()) }, `Flashcards · ${state.flashcards.count}`) : null,
      screenTimeBlock(),
    );
    return;
  }
  const left = Math.max(0, (t.end - Date.now()) / 1000);
  fill(root, 
    h('div', { class: `timer-big${t.lockdown ? ' locked' : ''}` }, fmtDuration(left).padStart(5, '0')),
    h('div', { class: 'track timer-track' }, h('i', { style: `width:${(1 - (left * 1000) / t.total) * 100}%` })),
    h(
      'div',
      { class: 'timer-label' },
      t.mode === 'pomodoro' ? `${t.phase === 'focus' ? `Focus · round ${t.round}` : t.phase === 'long' ? 'Long break' : 'Break'} · ends ${fmtTime(t.end)}` : `Ends at ${fmtTime(t.end)}`,
    ),
    h(
      'div',
      { class: 'timer-presets' },
      t.mode === 'pomodoro'
        ? h('button', { class: 'pill-btn ghost', onclick: () => window.island.timer('skip') }, t.phase === 'focus' ? 'Skip to break' : 'Skip break')
        : h('button', { class: 'pill-btn ghost', onclick: () => window.island.timer('add', 5) }, '+5 min'),
      lockdownToggle(t.lockdown, () => window.island.timer('lockdown', !t.lockdown)),
      h('button', { class: 'pill-btn', onclick: () => window.island.timer('stop') }, 'Stop'),
    ),
    resting ? flashcardBlock() : statsLine(),
    resting ? null : screenTimeBlock(),
  );
}

function tickTimer() {
  const t = state.timer;
  if (!t) return;
  const left = Math.max(0, (t.end - Date.now()) / 1000);
  const big = $('#timer .timer-big');
  const bar = $('#timer .timer-track i');
  if (big) big.textContent = fmtDuration(left).padStart(5, '0');
  if (bar) bar.style.width = `${(1 - (left * 1000) / t.total) * 100}%`;
}

// ---------- to-do ----------

const todoInput = $('#todo-input');
$('#todo-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  if (todoInput.value.trim()) window.island.todo('add', todoInput.value);
  todoInput.value = '';
});
// The notch window can't take keyboard focus until you click the box.
let typing = false;
todoInput.addEventListener('mousedown', () => {
  typing = true;
  window.island.setFocus(true);
});
todoInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') todoInput.blur();
});
todoInput.addEventListener('blur', () => {
  typing = false;
  window.island.setFocus(false);
});

function renderTodo() {
  const root = $('#todo');
  const todos = state.todos || [];
  if (!todos.length) {
    fill(root, h('div', { class: 'empty' }, 'Nothing to do. Nice.'));
    return;
  }
  const done = todos.filter((t) => t.done).length;
  fill(root, 
    ...todos.map((t) =>
      h(
        'div',
        { class: `row todo-row${t.done ? ' done' : ''}` },
        h('button', { class: `check${t.done ? ' on' : ''}`, onclick: () => window.island.todo('toggle', t.id), title: t.done ? 'Mark not done' : 'Mark done' }),
        h('div', { class: 'main' }, h('div', { class: 'title' }, t.text)),
        h('button', { class: 'x', onclick: () => window.island.todo('remove', t.id), title: 'Delete' }, '×'),
      ),
    ),
    done ? h('button', { class: 'pill-btn ghost clear-done', onclick: () => window.island.todo('clear-done') }, `Clear ${done} done`) : null,
  );
}

// ---------- clipboard ----------

function codeCard() {
  const c = state.code;
  if (!c || Date.now() - c.at > 10 * 60e3) return null;
  return h(
    'div',
    { class: 'row code-row' },
    h('div', { class: 'main' }, h('div', { class: 'code' }, c.code), h('div', { class: 'sub' }, `${c.from} code · ${fmtAgo(c.at)}`)),
    h(
      'button',
      {
        class: 'pill-btn',
        onclick: () => {
          window.island.clipboard('copy-code');
          flash({ id: `codecopied:${Date.now()}`, lead: dot('done'), text: 'Code copied', trail: '✓' }, 1500);
        },
      },
      'Copy',
    ),
  );
}

function renderClip() {
  const root = $('#clip');
  const items = state.clipboard || [];
  if (!items.length) {
    fill(root, codeCard() || '', h('div', { class: 'empty' }, 'Copy something and it shows up here. Kept in memory only.'));
    return;
  }
  fill(root, 
    codeCard() || '',
    ...items.map((c, i) =>
      h(
        'div',
        {
          class: 'row clickable',
          title: 'Copy again',
          onclick: () => {
            window.island.clipboard('copy', i);
            flash({ id: `recopied:${Date.now()}`, lead: dot('done'), text: 'Copied again', trail: '⧉' }, 1500);
          },
        },
        h('div', { class: 'main' }, h('div', { class: 'title clip-text' }, c.secret ? '•••••••••••• (hidden)' : c.text.replace(/\s+/g, ' ').slice(0, 140))),
        h('span', { class: 'side' }, fmtAgo(c.at)),
      ),
    ),
    h('button', { class: 'pill-btn ghost clear-done', onclick: () => window.island.clipboard('clear') }, 'Clear history'),
  );
}

// ---------- home screen (widgets) ----------

const DEFAULT_WIDGETS = ['music', 'next', 'weather', 'due', 'focus', 'todo', 'claude', 'system'];
const open = (tab) => (e) => {
  if (e.target.closest('button, input')) return;
  state.tab = tab;
  render();
};
const stop = (fn) => (e) => {
  e.stopPropagation();
  fn(e);
};

function widget(kind, tab, title, ...body) {
  return h('div', { class: `widget w-${kind}`, onclick: open(tab) }, h('div', { class: 'w-title' }, title), ...body);
}

const WIDGET_RENDER = {
  music() {
    const m = state.media;
    if (!m || !m.active || !m.title) return widget('music wide', 'media', 'Music', h('div', { class: 'w-big muted' }, 'Nothing playing'));
    const send = (cmd) => stop(() => window.island.media(cmd));
    return widget(
      'music wide',
      'media',
      appName(m.app) || 'Music',
      h(
        'div',
        { class: 'w-row' },
        m.art ? h('img', { class: 'w-art', src: m.art, alt: '' }) : h('div', { class: 'w-art' }),
        h('div', { class: 'w-col' }, h('div', { class: 'w-song' }, m.title), h('div', { class: 'w-sub' }, m.artist || '')),
        h(
          'div',
          { class: 'w-ctl' },
          h('button', { onclick: send('prev'), title: 'Previous' }, icon(ICONS.prev)),
          h('button', { class: 'play', onclick: send('toggle'), title: m.playing ? 'Pause' : 'Play' }, icon(m.playing ? ICONS.pause : ICONS.play)),
          h('button', { onclick: send('next'), title: 'Next' }, icon(ICONS.next)),
        ),
      ),
      m.duration > 0 && h('div', { class: 'track w-track' }, h('i', { style: `width:${(mediaPosition(m) / m.duration) * 100}%` })),
    );
  },
  next() {
    const now = Date.now();
    const events = (state.calendar && state.calendar.events) || [];
    const cur = events.find((e) => !e.allDay && e.start <= now && e.end > now);
    const nxt = events.find((e) => !e.allDay && e.start > now);
    const cd = countdowns(now)[0];
    const extra = cd ? ` · ${cd.days}d to ${cd.title}` : '';
    if (cur) return widget('next', 'calendar', `Now · ${cur.title}`, h('div', { class: 'w-big' }, `${Math.ceil((cur.end - now) / 60e3)}m`), h('div', { class: 'w-sub' }, `left${extra}`));
    if (nxt) return widget('next', 'calendar', `Next · ${nxt.title}`, h('div', { class: 'w-big' }, fmtTime(nxt.start)), h('div', { class: 'w-sub' }, `${dayKey(nxt.start) === dayKey(now) ? fmtUntil(nxt.start) : 'tomorrow'}${extra}`));
    return widget('next', 'calendar', 'Next', h('div', { class: 'w-big muted' }, 'Free'), h('div', { class: 'w-sub' }, `nothing else today${extra}`));
  },
  weather() {
    const w = state.weather;
    if (!w || w.status !== 'ok') return widget('weather', 'calendar', 'Weather', h('div', { class: 'w-sub' }, w && w.status === 'unconfigured' ? 'Set your city in Settings' : 'Loading…'));
    return widget('weather', 'calendar', w.place, h('div', { class: 'w-big' }, `${w.temp}°`), h('div', { class: 'w-sub' }, `${w.glyph} ${w.label}`));
  },
  due() {
    const items = dueItems().slice(0, 3);
    return widget(
      'due',
      'calendar',
      'Due',
      items.length ? items.map((e) => h('div', { class: 'w-item' }, h('span', { class: 'w-when' }, fmtDue(e.start)), h('span', { class: 'w-what' }, e.title))) : h('div', { class: 'w-sub' }, state.homework && state.homework.status === 'unconfigured' ? 'Add ManageBac in Settings' : 'Nothing due 🎉'),
    );
  },
  focus() {
    const t = state.timer;
    if (t) {
      const left = Math.max(0, (t.end - Date.now()) / 1000);
      return widget('focus', 'timer', t.phase && t.phase !== 'focus' ? 'Break' : t.lockdown ? 'Focus · locked' : 'Focus', h('div', { class: 'w-big w-timer' }, fmtDuration(left).padStart(5, '0')), h('div', { class: 'w-sub' }, `ends ${fmtTime(t.end)}`));
    }
    const st = state.stats;
    return widget(
      'focus',
      'timer',
      'Focus',
      h('button', { class: 'pill-btn', onclick: stop(() => startTimer(0, 'pomodoro')) }, 'Pomodoro'),
      h('div', { class: 'w-sub' }, st ? `${st.streak ? `🔥 ${st.streak}d · ` : ''}${st.today} today` : ''),
    );
  },
  todo() {
    const open_ = (state.todos || []).filter((t) => !t.done);
    return widget(
      'todo',
      'todo',
      `To-do${open_.length ? ` · ${open_.length}` : ''}`,
      open_.length
        ? open_.slice(0, 3).map((t) => h('div', { class: 'w-item' }, h('button', { class: 'check', onclick: stop(() => window.island.todo('toggle', t.id)) }), h('span', { class: 'w-what' }, t.text)))
        : h('div', { class: 'w-sub' }, 'All clear'),
    );
  },
  claude() {
    const sessions = state.claude || [];
    const waiting = sessions.filter((x) => x.state === 'waiting');
    const prs = (state.github && state.github.prs) || [];
    return widget(
      'claude',
      'claude',
      'Claude',
      waiting.length
        ? [h('div', { class: 'w-big w-alert' }, String(waiting.length)), h('div', { class: 'w-sub' }, `waiting · ${waiting[0].project}`)]
        : [h('div', { class: 'w-big' }, String(sessions.filter((x) => x.state === 'working').length)), h('div', { class: 'w-sub' }, 'working')],
      h('div', { class: 'w-foot' }, `${prs.length} PR${prs.length === 1 ? '' : 's'}${prs.some((p) => p.ci === 'fail') ? ' · CI ✗' : ''}`),
    );
  },
  system() {
    const sy = state.sys;
    const b = state.battery;
    return widget(
      'system',
      'sys',
      'System',
      sysBar('CPU', sy ? sy.cpu : 0, sy ? `${sy.cpu}%` : '…'),
      sysBar('RAM', sy ? (sy.mem.used / sy.mem.total) * 100 : 0, sy ? `${Math.round((sy.mem.used / sy.mem.total) * 100)}%` : '…'),
      b && sysBar('BAT', b.level * 100, `${Math.round(b.level * 100)}%${b.charging ? '⚡' : ''}`),
    );
  },
  stats() {
    const st = state.stats || { minutesToday: 0, streak: 0 };
    const scr = state.screentime || { distracting: 0 };
    return widget('stats', 'timer', 'Today', h('div', { class: 'w-big' }, `${st.minutesToday || 0}m`), h('div', { class: 'w-sub' }, `focused · ${fmtSpent(scr.distracting || 0)} distracted`));
  },
  plan() {
    const p = state.plan;
    const now = Date.now();
    const b = p && p.blocks && p.blocks.find((x) => x.start + x.minutes * 60e3 > now);
    return widget(
      'plan',
      'calendar',
      'Plan',
      b ? [h('div', { class: 'w-line' }, b.task), h('div', { class: 'w-big' }, fmtTime(b.start)), h('div', { class: 'w-sub' }, `${b.minutes} min`)] : h('button', { class: 'pill-btn ghost', onclick: stop(() => window.island.plan('make')) }, 'Plan homework'),
    );
  },
  clip() {
    const c = (state.clipboard || [])[0];
    return widget('clip', 'clip', 'Last copied', h('div', { class: 'w-clip' }, c ? (c.secret ? '•••••••• (hidden)' : c.text.replace(/\s+/g, ' ').slice(0, 90)) : 'Nothing yet'));
  },
};

function sysBar(label, pct, text) {
  return h('div', { class: 'sys-bar' }, h('span', { class: 'sb-label' }, label), h('span', { class: 'st-bar' }, h('i', { style: `width:${Math.max(2, Math.min(100, pct))}%` })), h('span', { class: 'sb-val' }, text));
}

function renderHome() {
  const list = (state.settings && state.settings.homeWidgets) || DEFAULT_WIDGETS;
  fill($('#home'), ...list.map((k) => WIDGET_RENDER[k] && WIDGET_RENDER[k]()), h('button', { class: 'widget add-widget', onclick: () => window.island.openSettings(), title: 'Choose widgets in Settings' }, '+'));
}

// The 1s tick only nudges numbers on the home screen (no rebuild under the cursor).
function tickHome() {
  const t = state.timer;
  const el = $('#home .w-timer');
  if (el && t) el.textContent = fmtDuration(Math.max(0, (t.end - Date.now()) / 1000)).padStart(5, '0');
  const m = state.media;
  const bar = $('#home .w-track i');
  if (bar && m && m.duration) bar.style.width = `${(mediaPosition(m) / m.duration) * 100}%`;
}

// ---------- system tab ----------

function fmtUptime(sec) {
  const hrs = Math.floor(sec / 3600);
  const d = Math.floor(hrs / 24);
  return d ? `${d}d ${hrs % 24}h` : `${hrs}h ${Math.floor((sec % 3600) / 60)}m`;
}

function renderSys() {
  const sy = state.sys;
  const b = state.battery;
  const items = [h('div', { class: 'heading' }, 'This PC')];
  if (sy) {
    items.push(sysBar('CPU', sy.cpu, `${sy.cpu}%`));
    items.push(sysBar('RAM', (sy.mem.used / sy.mem.total) * 100, `${(sy.mem.used / 1073741824).toFixed(1)} / ${Math.round(sy.mem.total / 1073741824)} GB`));
  }
  if (b) {
    const left = !b.charging && Number.isFinite(b.dischargingTime) ? ` · ${fmtUptime(b.dischargingTime)} left` : b.charging ? ' · charging' : '';
    items.push(sysBar('BAT', b.level * 100, `${Math.round(b.level * 100)}%${left}`));
  }
  if (sy) {
    items.push(h('div', { class: 'sys-line' }, sy.wifi && sy.wifi.connected ? `Wi-Fi · ${sy.wifi.ssid} · ${sy.wifi.signal}%` : 'Wi-Fi · not connected', h('span', { class: 'side' }, `up ${fmtUptime(sy.uptime)}`)));
  }
  if (state.classMode) items.push(h('div', { class: 'sys-line' }, '● Class mode is on (notifications quiet)'));
  // Today recap (the same numbers the bedtime summary uses)
  const st = state.stats || { minutesToday: 0, today: 0, streak: 0 };
  const scr = state.screentime || { total: 0, distracting: 0, items: [] };
  items.push(h('div', { class: 'heading' }, 'Today'));
  items.push(
    h(
      'div',
      { class: 'recap' },
      h('div', { class: 'rc' }, h('b', {}, `${st.minutesToday || 0}m`), h('small', {}, 'focused')),
      h('div', { class: 'rc' }, h('b', {}, String(st.today || 0)), h('small', {}, 'sessions')),
      h('div', { class: 'rc' }, h('b', {}, fmtSpent(scr.total || 0)), h('small', {}, 'on screen')),
      h('div', { class: `rc${scr.distracting ? ' bad' : ''}` }, h('b', {}, fmtSpent(scr.distracting || 0)), h('small', {}, 'distracted')),
    ),
  );
  fill($('#sys'), ...items);
}

if (navigator.getBattery) {
  navigator.getBattery().then((b) => {
    const read = () => {
      state.battery = { level: b.level, charging: b.charging, dischargingTime: b.dischargingTime };
    };
    read();
    for (const ev of ['levelchange', 'chargingchange', 'dischargingtimechange']) b.addEventListener(ev, read);
  });
}

// ---------- mic / camera dots (like a phone's privacy indicators) ----------

function renderPrivacy() {
  const p = state.privacy || { mic: [], cam: [] };
  const el = $('#priv');
  const dots = [];
  if (p.cam.length) dots.push(h('i', { class: 'cam', title: `Camera: ${p.cam.join(', ')}` }));
  if (p.mic.length) dots.push(h('i', { class: 'mic', title: `Microphone: ${p.mic.join(', ')}` }));
  fill(el, ...dots);
}

// ---------- launcher (Ctrl+Alt+Space) ----------

const launchInput = $('#launch-input');
const launchResults = $('#launch-results');
let launchItems = [];
let launchSel = 0;
let searchSeq = 0;
const KIND_GLYPH = { askscreen: '◩', translate: '文', cards: '▤', addfeed: '✎', open: '↗', url: '🌐', search: '⌕', ask: '✦', note: '✎', todo: '☐', hint: '…' };

function renderLaunchResults() {
  const a = state.ask;
  const showAnswer = a && state.askOpen;
  if (showAnswer) {
    fill(launchResults, 
      h(
        'div',
        { class: `answer${a.status === 'error' ? ' err' : ''}` },
        h('div', { class: 'answer-q' }, `✦ ${a.question}`),
        h('div', { class: 'answer-text' }, a.text || (a.status === 'streaming' ? 'Thinking…' : '')),
        a.status === 'streaming' ? h('div', { class: 'answer-meta' }, `${a.who || 'AI'} is answering · Esc to stop`) : h('div', { class: 'answer-meta' }, `${a.who ? `${a.who} · ` : ''}Enter a new question, or Esc to close`),
      ),
    );
    const t = launchResults.querySelector('.answer-text');
    t.scrollTop = t.scrollHeight;
    return;
  }
  fill(launchResults, 
    ...launchItems.map((it, i) =>
      h(
        'div',
        { class: `lr${i === launchSel ? ' sel' : ''}`, onmousedown: (ev) => ev.preventDefault(), onclick: () => runLaunch(i) },
        h('span', { class: 'lr-glyph' }, KIND_GLYPH[it.kind] || '•'),
        h('span', { class: 'lr-title' }, it.title),
        h('span', { class: 'lr-hint' }, it.hint),
      ),
    ),
  );
}

async function updateLaunch() {
  const seq = ++searchSeq;
  const items = await window.island.launcherSearch(launchInput.value);
  if (seq !== searchSeq) return;
  launchItems = items;
  launchSel = 0;
  state.askOpen = false;
  renderLaunchResults();
}

function runLaunch(i) {
  const it = launchItems[i];
  if (!it || it.kind === 'hint') return;
  window.island.launcherRun(it);
  if (it.kind === 'ask') {
    state.askOpen = true;
    launchInput.value = '? ';
    renderLaunchResults();
    return; // stay open to show the answer
  }
  closeLauncher();
}

function openLauncher() {
  state.launching = true;
  state.askOpen = false;
  expand();
  islandEl.classList.add('launching');
  launchInput.value = '';
  launchItems = [];
  renderLaunchResults();
  setTimeout(() => launchInput.focus(), 30);
}

function closeLauncher() {
  if (!state.launching) return;
  state.launching = false;
  islandEl.classList.remove('launching');
  if (state.ask && state.ask.status === 'streaming') window.island.askCancel();
  launchInput.blur();
  collapse();
}

launchInput.addEventListener('input', () => updateLaunch());
launchInput.addEventListener('focus', () => {
  typing = true;
});
launchInput.addEventListener('blur', () => {
  typing = false;
  window.island.setFocus(false);
  if (state.launching) setTimeout(() => state.launching && document.activeElement !== launchInput && closeLauncher(), 150);
});
launchInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    ev.preventDefault();
    closeLauncher();
  } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    if (!launchItems.length) return;
    launchSel = (launchSel + (ev.key === 'ArrowDown' ? 1 : -1) + launchItems.length) % launchItems.length;
    renderLaunchResults();
  } else if (ev.key === 'Enter') {
    ev.preventDefault();
    runLaunch(launchSel);
  }
});

// ---------- events from main (notifications, copies, lockdown, timer) ----------

function onEvent(e) {
  if (!e || Date.now() - e.at > 5000) return;
  if (e.type === 'notification' && e.call) {
    flash(
      {
        id: `call:${e.at}`,
        alert: true,
        peek: true,
        lead: h('span', { class: 'app-badge ringing' }, '☎'),
        text: h('span', { class: 'two' }, h('b', {}, e.title || 'Incoming call'), h('small', {}, 'Calling your phone · answer in Phone Link')),
        textKey: `call:${e.at}`,
        trail: '',
      },
      20000,
    );
  } else if (e.type === 'notification' && e.code) {
    flash(
      {
        id: `code:${e.at}`,
        peek: true,
        tab: 'clip',
        lead: h('span', { class: 'app-badge' }, '#'),
        text: h('span', { class: 'two' }, h('b', { class: 'code' }, e.code.replace(/^(\d{3})(\d{3})$/, '$1 $2')), h('small', {}, `${e.name} code · hover to copy`)),
        textKey: `code:${e.at}`,
        trail: '',
      },
      30000,
    );
  } else if (e.type === 'notification') {
    flash(
      {
        id: `n:${e.at}`,
        peek: true,
        lead: h('span', { class: 'app-badge' }, (e.name || '?').slice(0, 1)),
        text: h('span', { class: 'two' }, h('b', {}, e.title || e.name), h('small', {}, `${e.name}${e.phone ? ' · phone' : ''}${e.body ? ` · ${e.body}` : ''}`)),
        textKey: `${e.at}`,
        trail: '',
      },
      6000,
    );
  } else if (e.type === 'copied') {
    flash({ id: `c:${e.at}`, tab: 'clip', lead: h('span', { class: 'glyph-text' }, '⧉'), text: e.secret ? 'Copied · hidden' : e.text.replace(/\s+/g, ' '), trail: 'COPIED' }, 2500);
  } else if (e.type === 'blocked') {
    flash({ id: `b:${e.at}`, alert: true, tab: 'timer', lead: dot('waiting'), text: e.text, trail: e.trail }, 3500);
  } else if (e.type === 'info') {
    flash({ id: `i:${e.at}`, lead: dot(), text: e.text, trail: e.trail || '' }, 3000);
  } else if (e.type === 'phase') {
    const rest = e.phase !== 'focus';
    flash({ id: `ph:${e.at}`, alert: !rest, tab: 'timer', lead: dot(rest ? 'done' : 'waiting'), text: rest ? `${e.phase === 'long' ? 'Long break' : 'Break'} · stand up, stretch` : `Back to focus · round ${e.round}`, trail: `${e.minutes}m` }, 6000);
    if (isPrimary) chime();
  } else if (e.type === 'sleep') {
    flash({ id: `sl:${e.at}`, alert: !e.soft, lead: h('span', { class: 'glyph-text' }, '☾'), text: e.text, trail: e.soft ? '' : 'SLEEP' }, e.soft ? 8000 : 12000);
  } else if (e.type === 'plan-start') {
    flash({ id: `plan:${e.at}`, alert: true, tab: 'timer', lead: h('span', { class: 'glyph-text' }, '✎'), text: `Time for: ${e.task}`, trail: `${e.minutes}m` }, 15000);
    if (isPrimary) chime();
  } else if (e.type === 'summary') {
    const lines = [`${e.focusMinutes}m focused`, `${e.screenMinutes}m on screen`];
    if (e.distractedMinutes) lines.push(`${e.distractedMinutes}m distracted${e.topDistraction ? ` (${e.topDistraction})` : ''}`);
    const tomorrow = e.firstTomorrow ? `Tomorrow: ${e.firstTomorrow.title} at ${fmtTime(e.firstTomorrow.start)}` : 'Nothing early tomorrow';
    flash(
      {
        id: `sum:${e.at}`,
        peek: true,
        tab: 'sys',
        lead: h('span', { class: 'app-badge' }, '☾'),
        text: h('span', { class: 'two' }, h('b', {}, lines.join(' · ')), h('small', {}, `${tomorrow}${e.due.length ? ` · due: ${e.due.join(', ')}` : ''}`)),
        textKey: `sum:${e.at}`,
        trail: '',
      },
      15000,
    );
  } else if (e.type === 'translated') {
    flash(
      { id: `tr:${e.at}`, peek: true, tab: 'clip', lead: h('span', { class: 'app-badge' }, '文'), text: h('span', { class: 'two' }, h('b', {}, e.text), h('small', {}, `Translated to ${e.toName}`)), textKey: `tr:${e.at}`, trail: '' },
      9000,
    );
  } else if (e.type === 'open-tab') {
    if (e.cards) {
      state.cardsMode = true;
      state.card = null;
    }
    state.tab = e.tab;
    if (state.launching) closeLauncher();
    if (isPrimary) expand();
    render();
  } else if (e.type === 'timer-done') {
    state.timerDoneAt = e.at;
    if (isPrimary) chime();
  }
}

// ---------- battery ----------

function batteryLead(level, charging) {
  return h('span', { class: `batt${charging ? ' charging' : ''}${level <= 0.15 && !charging ? ' low' : ''}` }, h('i', { style: `width:${Math.round(level * 100)}%` }));
}

if (navigator.getBattery) {
  navigator.getBattery().then((b) => {
    let warned = false;
    b.addEventListener('chargingchange', () => {
      flash({ id: 'battery', lead: batteryLead(b.level, b.charging), text: b.charging ? 'Charging' : 'On battery', trail: `${Math.round(b.level * 100)}%` });
      if (b.charging) warned = false;
    });
    b.addEventListener('levelchange', () => {
      if (!b.charging && b.level <= 0.15 && !warned) {
        warned = true;
        flash({ id: 'battery-low', alert: true, lead: batteryLead(b.level, false), text: 'Battery low', trail: `${Math.round(b.level * 100)}%` }, 8000);
      }
    });
  });
}

// ---------- accent colour ----------

const PRESETS = ['#d71921', '#ffffff', '#ffc700', '#3ddc84', '#2f6bff', '#ff5fa2'];
const swatchesEl = $('#swatches');
const customInput = $('#custom-accent');

function applyAccent(hex) {
  document.documentElement.style.setProperty('--accent', hex);
  customInput.value = hex;
  for (const b of swatchesEl.querySelectorAll('button')) b.classList.toggle('current', b.dataset.color === hex);
}

function pickAccent(hex) {
  applyAccent(hex);
  window.island.setAccent(hex);
}

for (const color of PRESETS) {
  const b = h('button', { title: color, style: `background:${color}`, onclick: () => pickAccent(color) });
  b.dataset.color = color;
  swatchesEl.insertBefore(b, customInput);
}
customInput.addEventListener('input', () => applyAccent(customInput.value));
customInput.addEventListener('change', () => pickAccent(customInput.value));
$('#swatch-toggle').addEventListener('click', () => swatchesEl.classList.toggle('open'));
$('#gear').addEventListener('click', () => window.island.openSettings());
$('#search-btn').addEventListener('click', () => window.island.openLauncher());

// Album art: Nothing-style black & white, or its real colours.
const artToggle = $('#art-toggle');
function applyArtColor(on) {
  document.documentElement.classList.toggle('art-color', on);
  artToggle.textContent = on ? 'Art: Colour' : 'Art: B&W';
  artToggle.classList.toggle('on', on);
}
artToggle.addEventListener('click', () => {
  const on = !document.documentElement.classList.contains('art-color');
  applyArtColor(on);
  window.island.setArtColor(on);
});

function applySettings(s) {
  if (!s) return;
  applyAccent(s.accent);
  applyArtColor(Boolean(s.artColor));
}

// ---------- tabs + expand/collapse ----------

const TAB_NAMES = { home: 'Home', media: 'Music', calendar: 'Calendar', claude: 'Claude', timer: 'Focus', todo: 'To-do', clip: 'Clipboard', sys: 'System' };
for (const b of document.querySelectorAll('.dock button[data-icon]')) b.prepend(icon(ICONS[b.dataset.icon]));

function renderTabs() {
  for (const b of document.querySelectorAll('.tabs button[data-tab]')) b.classList.toggle('active', b.dataset.tab === state.tab);
  for (const p of document.querySelectorAll('.panel')) p.classList.toggle('active', p.dataset.panel === state.tab);
  $('#tab-name').textContent = state.tab === 'home' ? '' : TAB_NAMES[state.tab] || '';
}

for (const b of document.querySelectorAll('.tabs button[data-tab]')) {
  b.addEventListener('click', () => {
    state.tab = b.dataset.tab;
    scrollCalendar = true;
    render();
  });
}

// Pill geometry in window coordinates, so the main process can tell when the cursor is over it.
const WIN_W = 640;
function reportRect() {
  let w = 250;
  let hgt = 36;
  if (state.expanded) [w, hgt] = [580, 330];
  else if (islandEl.classList.contains('peek')) [w, hgt] = [340, 58];
  else if (islandEl.classList.contains('alert')) w = 330;
  const r = { x: (WIN_W - w) / 2, y: 0, w, h: hgt };
  const key = JSON.stringify(r);
  if (key === reportRect.last) return;
  reportRect.last = key;
  window.island.reportRect(r);
}

const pinned = new URLSearchParams(location.search).get('expand');

function expand() {
  if (state.expanded) return;
  // Alerts and peeks open on their tab; otherwise you land on Home.
  state.tab = currentCompact && (currentCompact.alert || currentCompact.peek) && currentCompact.tab ? currentCompact.tab : 'home';
  state.expanded = true;
  state.peekUntil = 0;
  scrollCalendar = true;
  islandEl.classList.add('expanded-state');
  swatchesEl.classList.remove('open');
  render();
}

function collapse() {
  if (typing) todoInput.blur();
  state.expanded = false;
  islandEl.classList.remove('expanded-state');
  render();
}

if (pinned) {
  state.tab = pinned;
  state.expanded = true;
  islandEl.classList.add('expanded-state');
}

let collapseTimer = null;
window.island.onHover((inside) => {
  clearTimeout(collapseTimer);
  if (inside) expand();
  else if (!pinned && !state.held && !typing && !state.launching) collapseTimer = setTimeout(collapse, 300);
});

window.island.onToggle(() => {
  if (state.launching) closeLauncher();
  else openLauncher();
});

function render() {
  renderCompact();
  renderTabs();
  renderBadge();
  $('#clock').textContent = fmtTime(Date.now());
  if (!state.expanded) return;
  if (state.tab === 'media') renderMedia();
  if (state.tab === 'calendar') renderCalendar();
  if (state.tab === 'claude') renderClaude();
  if (state.tab === 'timer') renderTimer();
  if (state.tab === 'todo') renderTodo();
  if (state.tab === 'clip') renderClip();
  if (state.tab === 'home') renderHome();
  if (state.tab === 'sys') renderSys();
}

function mediaShape(m) {
  return [m.active, m.app, m.title, m.artist, m.playing, m.canNext, m.canPrev, (m.art || '').length, m.duration > 0, m.volume == null].join('|');
}

// "Update" button in the tab bar once a new version has downloaded.
const updateBtn = $('#update-btn');
updateBtn.addEventListener('click', () => window.island.installUpdate());
function renderUpdateButton() {
  const u = state.update;
  const ready = Boolean(u && u.status === 'ready');
  updateBtn.hidden = !ready;
  if (ready) updateBtn.title = `Restart Apron to update to ${u.next}`;
}

function onMedia(m) {
  const prev = state.media;
  const key = m && m.active ? `${m.title}|${m.artist}` : '';
  const prevKey = prev && prev.active ? `${prev.title}|${prev.artist}` : '';
  // Peek on a new song (not on first load, and not while the island is open).
  const peekOn = !state.settings || state.settings.peek !== false;
  if (peekOn && prev && key && key !== prevKey && m.playing && !state.expanded) state.peekUntil = Date.now() + PEEK_MS;
  const art = (m && m.art) || '';
  if (art !== artKey) {
    artKey = art;
    tintFromArt(art);
  }
}

window.island.onUpdate((key, value) => {
  if (key === 'claude' && state.expanded && value.some((s) => s.state === 'waiting') && !(state.claude || []).some((s) => s.state === 'waiting')) {
    state.tab = 'claude';
  }
  if (key === 'media') onMedia(value);
  if (key === 'event') {
    state.event = value;
    onEvent(value);
    renderCompact();
    if (value && value.type === 'timer-done') render();
    return;
  }
  if (key === 'lyrics') {
    state.lyrics = value;
    if (state.expanded && state.tab === 'media') tickLyrics();
    return;
  }
  if (key === 'sys') {
    state.sys = value;
    if (state.expanded && state.tab === 'sys') renderSys();
    if (state.expanded && state.tab === 'home') {
      const w = $('#home .w-system');
      if (w) w.replaceWith(WIDGET_RENDER.system());
    }
    return;
  }
  if (key === 'privacy') {
    state.privacy = value;
    renderPrivacy();
    return;
  }
  if (key === 'ask') {
    state.ask = value;
    if (state.launching) renderLaunchResults();
    return;
  }
  if (key === 'screentime' && !(state.expanded && state.tab === 'timer')) {
    state.screentime = value;
    return;
  }
  if (key === 'clipboard' && !(state.expanded && state.tab === 'clip')) {
    state.clipboard = value;
    return;
  }
  // Position/volume ticks mustn't rebuild the music tab: a rebuild between mousedown
  // and mouseup swallows the click on play/pause.
  const sameShape = key === 'media' && state.media && value && mediaShape(value) === mediaShape(state.media);
  state[key] = value;
  if (key === 'settings') applySettings(value);
  if (key === 'update') renderUpdateButton();
  if (sameShape) {
    if (state.expanded && state.tab === 'media') {
      tickMedia();
      updateVolume();
      tickLyrics();
    }
    renderCompact();
    return;
  }
  render();
});
// APRON_EXPAND=launcher (optionally APRON_QUERY=…) opens the launcher, for screenshots.
if (pinned === 'launcher') {
  setTimeout(() => {
    openLauncher();
    const q = new URLSearchParams(location.search).get('q');
    if (q) {
      launchInput.value = q;
      updateLaunch();
    }
  }, 300);
}

window.island.getState().then((s) => {
  Object.assign(state, s);
  applySettings(s.settings);
  renderUpdateButton();
  renderPrivacy();
  if (s.media) onMedia(s.media);
  render();
});

// Rebuilding lists under the cursor can eat clicks, so the 1s tick only touches
// the pill, the clock and the progress bars; lists refresh on new data or once a minute.
let ticks = 0;
setInterval(() => {
  ticks++;
  // Keep the to-do box alive while typing.
  if (ticks % 60 === 0 && !typing) return render();
  renderCompact();
  $('#clock').textContent = fmtTime(Date.now());
  if (state.expanded && state.tab === 'media') {
    tickMedia();
    tickLyrics();
  }
  if (state.expanded && state.tab === 'timer') tickTimer();
  if (state.expanded && state.tab === 'home') tickHome();
}, 1000);
