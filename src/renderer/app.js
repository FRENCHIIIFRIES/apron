const $ = (s) => document.querySelector(s);
const islandEl = $('#island');

const SOON = 10 * 60e3;
const DONE_FLASH = 10e3;
const ROTATE_MS = 6000;
const PEEK_MS = 4000;
const TIMER_DONE_FLASH = 12e3;

const state = {
  calendar: null,
  media: null,
  claude: [],
  github: null,
  tab: 'media',
  expanded: false,
  held: false, // opened with Ctrl+Alt+Space: stays open until pressed again
  peekUntil: 0, // track-change preview
  flash: null, // { id, lead, text, trail, until, alert }
  timer: loadTimer(), // { end, total } while running
  timerDoneAt: 0,
};

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
    return { id: 'timer', tab: 'timer', lead: h('span', { class: 'glyph' }, icon(ICONS.timer)), text: 'Focus', trail: fmtDuration(left) };
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
    if (soon && Math.floor(now / ROTATE_MS) % 2) {
      return { id: 'soon', tab: 'calendar', lead: calLead(), text: soon.title, trail: fmtUntil(soon.start) };
    }
    return music;
  }

  const items = rotationItems(now, events, soon);
  return items[Math.floor(now / ROTATE_MS) % items.length];
}

function rotationItems(now, events, soon) {
  const items = [];
  const current = events.find((e) => !e.allDay && e.start <= now && e.end > now);
  if (current) {
    items.push({ id: 'class', tab: 'calendar', lead: calLead(), text: current.title, trail: `${Math.ceil((current.end - now) / 60e3)}m left` });
  }
  if (soon) items.push({ id: 'soon', tab: 'calendar', lead: calLead(), text: soon.title, trail: fmtUntil(soon.start) });
  const next = events.find((e) => !e.allDay && e.start > now && e !== soon && dayKey(e.start) === dayKey(now));
  if (next && !soon) items.push({ id: 'next', tab: 'calendar', lead: calLead(), text: `Next · ${next.title}`, trail: fmtTime(next.start) });

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
  $('#compact-lead').replaceChildren(v.lead);
  $('#compact-text').replaceChildren(v.text);
  $('#compact-trail').replaceChildren(v.trail);
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
    root.replaceChildren(
      h('div', { class: 'empty' }, m && m.status === 'error' ? `Media unavailable: ${m.error}` : 'Nothing playing'),
      m && volumeRow(m),
    );
    return;
  }
  const pos = mediaPosition(m);
  const send = (cmd) => () => window.island.media(cmd);
  const playBtn = h('button', { class: 'play', title: m.playing ? 'Pause' : 'Play', onclick: send('toggle') }, icon(m.playing ? ICONS.pause : ICONS.play));
  const prevBtn = h('button', { title: 'Previous', onclick: send('prev'), disabled: !m.canPrev }, icon(ICONS.prev));
  const nextBtn = h('button', { title: 'Next', onclick: send('next'), disabled: !m.canNext }, icon(ICONS.next));

  root.replaceChildren(
    h(
      'div',
      { class: 'media-top' },
      m.art ? h('img', { class: `media-art${m.playing ? ' spinning' : ''}`, src: m.art, alt: '' }) : h('div', { class: 'media-art' }),
      h(
        'div',
        { class: 'media-meta' },
        h('div', { class: 'media-title' }, m.title || 'Unknown'),
        h('div', { class: 'media-artist' }, m.artist || ''),
        h('div', { class: 'media-app' }, appName(m.app)),
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
    h('div', { class: 'controls' }, prevBtn, playBtn, nextBtn),
    volumeRow(m),
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
    root.replaceChildren(h('div', { class: 'empty' }, 'Loading calendar…'));
    return;
  }
  if (c.status === 'unconfigured') {
    root.replaceChildren(
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

  let lastDay = null;
  let focusSet = false;
  for (const e of c.events) {
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
  if (!c.events.length) items.push(h('div', { class: 'empty' }, 'Nothing today or tomorrow 🎉'));
  root.replaceChildren(...items);
  // On open, jump past the classes that already happened.
  if (scrollCalendar) {
    scrollCalendar = false;
    const focus = $('#cal-focus');
    root.scrollTop = focus ? focus.offsetTop - root.offsetTop - 26 : 0;
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
    items.push(
      h(
        'div',
        { class: 'row' },
        dot(s.state),
        h('div', { class: 'main' }, h('div', { class: 'title' }, s.project), h('div', { class: 'sub' }, s.state === 'working' ? 'Working…' : s.message)),
        h('span', { class: 'side' }, fmtAgo(s.at)),
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

  root.replaceChildren(...items);
}

function renderBadge() {
  const waiting = (state.claude || []).filter((s) => s.state === 'waiting').length;
  const failing = ((state.github && state.github.prs) || []).filter((p) => p.ci === 'fail').length;
  $('#claude-badge').textContent = waiting ? String(waiting) : failing ? '✗' : '';
}

// ---------- focus timer ----------

function loadTimer() {
  try {
    const t = JSON.parse(localStorage.getItem('island.timer'));
    return t && t.end > Date.now() ? t : null;
  } catch {
    return null;
  }
}

function saveTimer() {
  try {
    if (state.timer) localStorage.setItem('island.timer', JSON.stringify(state.timer));
    else localStorage.removeItem('island.timer');
  } catch {
    // storage unavailable: the timer just won't survive a restart
  }
}

function startTimer(minutes) {
  state.timer = { end: Date.now() + minutes * 60e3, total: minutes * 60e3 };
  saveTimer();
  render();
}

function addTime(minutes) {
  if (!state.timer) return startTimer(minutes);
  state.timer.end += minutes * 60e3;
  state.timer.total += minutes * 60e3;
  saveTimer();
  render();
}

function stopTimer() {
  state.timer = null;
  saveTimer();
  render();
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

function checkTimer() {
  if (state.timer && Date.now() >= state.timer.end) {
    state.timer = null;
    saveTimer();
    state.timerDoneAt = Date.now();
    chime();
    render();
  }
}

function renderTimer() {
  const root = $('#timer');
  const t = state.timer;
  if (!t) {
    root.replaceChildren(
      h('div', { class: 'timer-big idle' }, '00:00'),
      h('div', { class: 'timer-label' }, 'Focus timer'),
      h('div', { class: 'timer-presets' }, ...[5, 15, 25, 50].map((m) => h('button', { class: 'pill-btn ghost', onclick: () => startTimer(m) }, `${m} min`))),
    );
    return;
  }
  const left = Math.max(0, (t.end - Date.now()) / 1000);
  root.replaceChildren(
    h('div', { class: 'timer-big' }, fmtDuration(left).padStart(5, '0')),
    h('div', { class: 'track timer-track' }, h('i', { style: `width:${(1 - (left * 1000) / t.total) * 100}%` })),
    h('div', { class: 'timer-label' }, `Ends at ${fmtTime(t.end)}`),
    h('div', { class: 'timer-presets' }, h('button', { class: 'pill-btn ghost', onclick: () => addTime(1) }, '+1 min'), h('button', { class: 'pill-btn ghost', onclick: () => addTime(5) }, '+5 min'), h('button', { class: 'pill-btn', onclick: stopTimer }, 'Stop')),
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

// ---------- tabs + expand/collapse ----------

function renderTabs() {
  for (const b of document.querySelectorAll('.tabs button[data-tab]')) b.classList.toggle('active', b.dataset.tab === state.tab);
  for (const p of document.querySelectorAll('.panel')) p.classList.toggle('active', p.dataset.panel === state.tab);
}

for (const b of document.querySelectorAll('.tabs button[data-tab]')) {
  b.addEventListener('click', () => {
    state.tab = b.dataset.tab;
    scrollCalendar = true;
    render();
  });
}

// Pill geometry in window coordinates, so the main process can tell when the cursor is over it.
const WIN_W = 480;
function reportRect() {
  let w = 250;
  let hgt = 36;
  if (state.expanded) [w, hgt] = [440, 288];
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
  // Open on whatever the pill was showing.
  if (currentCompact && currentCompact.tab) state.tab = currentCompact.tab;
  state.expanded = true;
  state.peekUntil = 0;
  scrollCalendar = true;
  islandEl.classList.add('expanded-state');
  swatchesEl.classList.remove('open');
  render();
}

function collapse() {
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
  else if (!pinned && !state.held) collapseTimer = setTimeout(collapse, 300);
});

window.island.onToggle(() => {
  state.held = !state.held;
  if (state.held) expand();
  else collapse();
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
}

function onMedia(m) {
  const prev = state.media;
  const key = m && m.active ? `${m.title}|${m.artist}` : '';
  const prevKey = prev && prev.active ? `${prev.title}|${prev.artist}` : '';
  // Peek on a new song (not on first load, and not while the island is open).
  if (prev && key && key !== prevKey && m.playing && !state.expanded) state.peekUntil = Date.now() + PEEK_MS;
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
  // Volume-only changes shouldn't rebuild the music tab under the cursor.
  const volumeOnly =
    key === 'media' && state.media && value && JSON.stringify({ ...value, volume: 0, muted: 0 }) === JSON.stringify({ ...state.media, volume: 0, muted: 0 });
  state[key] = value;
  if (key === 'settings') applyAccent(value.accent);
  if (volumeOnly) {
    if (state.expanded && state.tab === 'media') updateVolume();
    return;
  }
  render();
});
window.island.getState().then((s) => {
  Object.assign(state, s);
  if (s.settings) applyAccent(s.settings.accent);
  if (s.media) onMedia(s.media);
  render();
});

// Rebuilding lists under the cursor can eat clicks, so the 1s tick only touches
// the pill, the clock and the progress bars; lists refresh on new data or once a minute.
let ticks = 0;
setInterval(() => {
  ticks++;
  checkTimer();
  if (ticks % 60 === 0) return render();
  renderCompact();
  $('#clock').textContent = fmtTime(Date.now());
  if (state.expanded && state.tab === 'media') tickMedia();
  if (state.expanded && state.tab === 'timer') tickTimer();
}, 1000);
