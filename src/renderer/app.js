const $ = (s) => document.querySelector(s);
const islandEl = $('#island');

const SOON = 10 * 60e3;
const DONE_FLASH = 10e3;
const ROTATE_MS = 6000;

const state = {
  calendar: null,
  media: null,
  claude: [],
  github: null,
  tab: 'media',
  expanded: false,
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
function icon(d) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
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

// ---------- collapsed pill ----------

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
      lead: h('span', { class: 'dot waiting' }),
      text: `${s.project} needs you`,
      trail: waiting.length > 1 ? `+${waiting.length - 1}` : fmtAgo(s.at),
    };
  }

  const done = sessions.find((s) => s.state === 'done' && now - s.at < DONE_FLASH);
  if (done) {
    return { id: 'done', tab: 'claude', lead: h('span', { class: 'dot done' }), text: `${done.project} is done`, trail: '✓' };
  }

  // Nothing urgent: rotate through whatever is available.
  const items = rotationItems(now);
  const v = items[Math.floor(now / ROTATE_MS) % items.length];
  v.tab = v.tab || null;
  return v;
}

function calLead() {
  const lead = h('span', { class: 'controls' });
  const svg = icon(ICONS.cal);
  svg.style.cssText = 'width:15px;height:15px;fill:var(--accent)';
  lead.append(svg);
  return lead;
}

function rotationItems(now) {
  const items = [];
  const events = (state.calendar && state.calendar.events) || [];
  const upcoming = events.filter((e) => !e.allDay && e.start - now > -5 * 60e3 && dayKey(e.start) === dayKey(now));
  const soon = upcoming.find((e) => e.start - now < SOON);
  if (soon) items.push({ id: 'soon', tab: 'calendar', lead: calLead(), text: soon.title, trail: fmtUntil(soon.start) });

  const m = state.media;
  if (m && m.active && m.playing && m.title) {
    items.push({
      id: 'music',
      tab: 'media',
      lead: m.art ? h('img', { src: m.art, alt: '' }) : h('span', { class: 'dot done' }),
      text: m.artist ? `${m.title} · ${m.artist}` : m.title,
      trail: h('span', { class: 'bars' }, h('i'), h('i'), h('i')),
    });
  }

  const next = upcoming.find((e) => e !== soon && e.start > now);
  if (next && !soon) items.push({ id: 'next', tab: 'calendar', lead: calLead(), text: `Next · ${next.title}`, trail: fmtTime(next.start) });

  const prs = (state.github && state.github.prs) || [];
  if (prs.length) {
    const worst = ['fail', 'pending', 'pass', 'none'].find((c) => prs.some((p) => p.ci === c));
    items.push({
      id: 'prs',
      tab: 'claude',
      lead: h('span', { class: `dot ${worst === 'fail' ? 'waiting' : 'done'}` }),
      text: `${prs.length} open PR${prs.length > 1 ? 's' : ''}${worst === 'fail' ? ' · CI failing' : ''}`,
      trail: CI_GLYPH[worst],
    });
  }

  const d = new Date(now);
  items.push({
    id: 'clock',
    lead: h('span', { class: 'dot' }),
    text: d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }),
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
  reportRect();
  // Rebuild only when something visible changed, so the art <img> doesn't flicker every tick.
  const lead = v.lead.tagName === 'IMG' ? `img${v.lead.src.length}` : v.lead.className;
  const key = [v.text, typeof v.trail === 'string' ? v.trail : 'node', lead].join('|');
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
  $('#compact-text').textContent = v.text;
  $('#compact-trail').replaceChildren(v.trail);
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

function renderMedia() {
  const m = state.media;
  const root = $('#media');
  if (!m || !m.active) {
    root.replaceChildren(h('div', { class: 'empty' }, m && m.status === 'error' ? `Media unavailable: ${m.error}` : 'Nothing playing'));
    return;
  }
  const pos = mediaPosition(m);
  const send = (cmd) => () => window.island.media(cmd);
  const playBtn = h('button', { class: 'play', title: m.playing ? 'Pause' : 'Play', onclick: send('toggle') });
  playBtn.append(icon(m.playing ? ICONS.pause : ICONS.play));
  const prevBtn = h('button', { title: 'Previous', onclick: send('prev'), disabled: !m.canPrev });
  prevBtn.append(icon(ICONS.prev));
  const nextBtn = h('button', { title: 'Next', onclick: send('next'), disabled: !m.canNext });
  nextBtn.append(icon(ICONS.next));

  root.replaceChildren(
    h(
      'div',
      { class: 'media-top' },
      m.art ? h('img', { class: 'media-art', src: m.art, alt: '' }) : h('div', { class: 'media-art' }),
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
  );
}

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
    items.push(
      h(
        'div',
        {
          id: isFocus ? 'cal-focus' : null,
          class: `row clickable${e.end < now && !e.allDay ? ' past' : ''}${isNow ? ' now' : ''}`,
          onclick: () => window.island.open(`https://calendar.google.com/calendar/r/day/${y}/${mo}/${d}`),
        },
        h('span', { class: 'stripe', style: `background:var(--cal-${e.calendar % 4})` }),
        h('span', { class: 'time' }, e.allDay ? 'All day' : fmtTime(e.start)),
        h('div', { class: 'main' }, h('div', { class: 'title' }, e.title), e.location && h('div', { class: 'sub' }, e.location)),
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
    items.push(h('div', { class: 'empty small' }, 'No Claude Code activity yet. Run "npm run hooks:install" once if you haven’t.'));
  }
  for (const s of sessions) {
    items.push(
      h(
        'div',
        { class: 'row' },
        h('span', { class: `dot ${s.state}` }),
        h(
          'div',
          { class: 'main' },
          h('div', { class: 'title' }, s.project),
          h('div', { class: 'sub' }, s.state === 'working' ? 'Working…' : s.message),
        ),
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
  const waiting = sessions.filter((s) => s.state === 'waiting').length;
  const failing = ((gh && gh.prs) || []).filter((p) => p.ci === 'fail').length;
  $('#claude-badge').textContent = waiting ? String(waiting) : failing ? '✗' : '';
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
  const w = state.expanded ? 440 : islandEl.classList.contains('alert') ? 330 : 250;
  const hgt = state.expanded ? 288 : 36;
  const r = { x: (WIN_W - w) / 2, y: 0, w, h: hgt };
  const key = JSON.stringify(r);
  if (key === reportRect.last) return;
  reportRect.last = key;
  window.island.reportRect(r);
}

const pinned = new URLSearchParams(location.search).get('expand');
if (pinned) {
  state.tab = pinned;
  state.expanded = true;
  islandEl.classList.add('expanded-state');
}

let collapseTimer = null;
window.island.onHover((inside) => {
  clearTimeout(collapseTimer);
  if (inside) {
    if (state.expanded) return;
    // Open on whatever the pill was showing.
    if (currentCompact && currentCompact.tab) state.tab = currentCompact.tab;
    state.expanded = true;
    scrollCalendar = true;
    islandEl.classList.add('expanded-state');
    swatchesEl.classList.remove('open');
    render();
  } else if (!pinned) {
    collapseTimer = setTimeout(() => {
      state.expanded = false;
      islandEl.classList.remove('expanded-state');
      render();
    }, 300);
  }
});

function render() {
  renderCompact();
  renderTabs();
  $('#clock').textContent = fmtTime(Date.now());
  if (!state.expanded) return;
  if (state.tab === 'media') renderMedia();
  if (state.tab === 'calendar') renderCalendar();
  if (state.tab === 'claude') renderClaude();
}

window.island.onUpdate((key, value) => {
  if (key === 'claude' && state.expanded && value.some((s) => s.state === 'waiting') && !(state.claude || []).some((s) => s.state === 'waiting')) {
    state.tab = 'claude';
  }
  state[key] = value;
  if (key === 'settings') applyAccent(value.accent);
  render();
});
window.island.getState().then((s) => {
  Object.assign(state, s);
  if (s.settings) applyAccent(s.settings.accent);
  render();
});

// Rebuilding lists under the cursor can eat clicks, so the 1s tick only touches
// the pill, the clock and the progress bar; lists refresh on new data or once a minute.
let ticks = 0;
setInterval(() => {
  ticks++;
  if (ticks % 60 === 0) return render();
  renderCompact();
  $('#clock').textContent = fmtTime(Date.now());
  if (state.expanded && state.tab === 'media') tickMedia();
}, 1000);
