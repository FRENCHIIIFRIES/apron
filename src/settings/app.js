// Apron settings window. Every control writes straight to config via the main
// process (validated there) and the notch updates live.
const root = document.getElementById('root');
let snap = null;

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

let toastTimer = null;
function toast(text) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = h('div', { class: 'toast' });
    document.body.append(el);
  }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1600);
}

async function set(patch, message) {
  snap = await window.apron.set(patch);
  render();
  if (message) toast(message);
}

async function action(name, message) {
  const res = await window.apron.action(name);
  if (res && res.config) snap = res;
  render();
  if (res && res.ok === false) toast(`Couldn't: ${res.error}`);
  else if (message) toast(message);
}

// ---------- building blocks ----------

const section = (title, ...items) => h('section', {}, h('h2', {}, title), ...items);
const label = (title, sub) => h('div', { class: 'label' }, h('b', {}, title), sub && h('small', {}, sub));

const DEFAULT_OFF = new Set(['artColor', 'sleepReminder']);
function toggle(title, sub, key, { invert = false } = {}) {
  const on = DEFAULT_OFF.has(key) ? snap.config[key] === true : snap.config[key] !== false;
  const value = invert ? !on : on;
  return h(
    'div',
    { class: 'item' },
    label(title, sub),
    h('button', {
      class: `switch${value ? ' on' : ''}`,
      role: 'switch',
      'aria-checked': String(value),
      'aria-label': title,
      onclick: () => set({ [key]: invert ? value : !value }),
    }),
  );
}

function slider(title, sub, key, min, max, unit) {
  const out = h('output', {}, `${snap.config[key]}${unit}`);
  const input = h('input', {
    type: 'range',
    min,
    max,
    value: snap.config[key],
    'aria-label': title,
    oninput: (e) => (out.textContent = `${e.target.value}${unit}`),
    onchange: (e) => set({ [key]: Number(e.target.value) }),
  });
  return h('div', { class: 'item' }, label(title, sub), h('div', { class: 'slider' }, input, out));
}

function segmented(title, sub, key, options) {
  return h(
    'div',
    { class: 'item' },
    label(title, sub),
    h('div', { class: 'seg' }, ...options.map(([value, text]) => h('button', { class: snap.config[key] === value ? 'on' : '', onclick: () => set({ [key]: value }) }, text))),
  );
}

/** A chip list with an "add" box. */
function chipEditor(title, sub, items, onRemove, onAdd, placeholder) {
  const input = h('input', { class: 'text', placeholder });
  const add = () => {
    const v = input.value.trim();
    if (v) onAdd(v);
    input.value = '';
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && add());
  return h(
    'div',
    { class: 'item stack' },
    label(title, sub),
    items.length ? h('div', { class: 'chips' }, ...items.map((it) => h('span', { class: 'chip' }, it, h('button', { class: 'x', title: 'Remove', onclick: () => onRemove(it) }, '×')))) : null,
    h('div', { class: 'row-line' }, input, h('button', { class: 'btn', onclick: add }, 'Add')),
  );
}

// ---------- sections ----------

const PRESETS = [
  ['#d71921', 'Nothing red'],
  ['#ffffff', 'White'],
  ['#ffc700', 'Yellow'],
  ['#3ddc84', 'Green'],
  ['#2f6bff', 'Blue'],
  ['#ff5fa2', 'Pink'],
  ['#ff7a00', 'Orange'],
  ['#9b5cff', 'Purple'],
];

function appearance() {
  const c = snap.config;
  const custom = h('input', { type: 'color', value: c.accent, title: 'Any colour', onchange: (e) => set({ accent: e.target.value }) });
  return section(
    'Look',
    h(
      'div',
      { class: 'item stack' },
      label('Accent colour', 'Dots, alerts, the focus timer and buttons'),
      h(
        'div',
        { class: 'swatches' },
        ...PRESETS.map(([hex, name]) => h('button', { class: c.accent === hex ? 'current' : '', title: name, style: `background:${hex}`, onclick: () => set({ accent: hex }) })),
        custom,
      ),
    ),
    toggle('Album art in colour', 'Off = Nothing-style black & white', 'artColor'),
    h(
      'div',
      { class: 'item' },
      label('Notch on every screen', 'Off = main screen only'),
      h('button', {
        class: `switch${c.displays === 'all' ? ' on' : ''}`,
        role: 'switch',
        'aria-label': 'Notch on every screen',
        onclick: () => set({ displays: c.displays === 'all' ? 'primary' : 'all' }),
      }),
    ),
    slider('Distance from the top', 'Push the notch down if a bar sits up there', 'offsetY', 0, 60, 'px'),
    slider('Switch items every', 'How long each thing shows in the closed notch', 'rotateSeconds', 3, 30, 's'),
  );
}

function music() {
  return section('Music', toggle('Lyrics', 'Synced lyrics from LRCLIB under the song', 'lyrics'), toggle('Song-change peek', 'The notch widens for a moment on a new track', 'peek'));
}

function calendarWeather() {
  const c = snap.config;
  const mask = (u) => {
    try {
      const url = new URL(u);
      const id = decodeURIComponent(url.pathname.split('/')[3] || url.hostname);
      return `${id} · ${u.includes('/private-') ? 'private link' : 'public link'}`;
    } catch {
      return u.slice(0, 40);
    }
  };
  const cityInput = h('input', { class: 'text', value: c.weatherCity || '', placeholder: 'City, country code (e.g. Hyderabad, IN)' });
  const saveCity = () => cityInput.value.trim() !== (c.weatherCity || '') && set({ weatherCity: cityInput.value }, 'Weather updated');
  cityInput.addEventListener('keydown', (e) => e.key === 'Enter' && saveCity());
  cityInput.addEventListener('blur', saveCity);

  const linkInput = h('input', { class: 'text', placeholder: 'Paste a Google Calendar iCal link (https://…/basic.ics)' });
  const addLink = () => {
    const v = linkInput.value.trim();
    if (!v) return;
    if (!/^https:\/\//.test(v)) return toast('That needs to be an https:// link');
    set({ icalUrls: [...(c.icalUrls || []), v] }, 'Calendar added');
  };
  linkInput.addEventListener('keydown', (e) => e.key === 'Enter' && addLink());

  return section(
    'Calendar & weather',
    h(
      'div',
      { class: 'item stack' },
      label('Calendars', 'Google Calendar → Settings → your calendar → Secret address in iCal format'),
      (c.icalUrls || []).length
        ? h(
            'div',
            { class: 'chips' },
            ...c.icalUrls.map((u) => h('span', { class: 'chip' }, mask(u), h('button', { class: 'x', title: 'Remove', onclick: () => set({ icalUrls: c.icalUrls.filter((x) => x !== u) }, 'Calendar removed') }, '×'))),
          )
        : null,
      h('div', { class: 'row-line' }, linkInput, h('button', { class: 'btn', onclick: addLink }, 'Add')),
    ),
    h('div', { class: 'item stack' }, label('Weather city', 'Used for the temperature and rain warnings'), h('div', { class: 'row-line' }, cityInput, h('button', { class: 'btn', onclick: saveCity }, 'Save'))),
    segmented('Temperature', null, 'units', [
      ['c', '°C'],
      ['f', '°F'],
    ]),
  );
}

function focus() {
  const c = snap.config;
  const ld = { extraSites: [], allowSites: [], unblock: [], apps: [], ...(c.lockdown || {}) };
  const setLd = (patch, msg) => set({ lockdown: { ...ld, ...patch } }, msg);
  const unblocked = new Set(ld.unblock.map((s) => s.toLowerCase()));
  return section(
    'Focus & lockdown',
    toggle('Lockdown on by default', 'New focus timers close distracting sites', 'lockdownDefault'),
    pomodoroRow(),
    h(
      'div',
      { class: 'item stack' },
      label('Blocked during focus', 'Click one to allow it. YouTube and Spotify are always allowed.'),
      h(
        'div',
        { class: 'chips' },
        ...snap.builtInSites.map((site) => {
          const off = unblocked.has(site.toLowerCase());
          return h(
            'button',
            {
              class: `chip${off ? ' off' : ' blocked'}`,
              title: off ? 'Allowed: click to block again' : 'Blocked: click to allow',
              onclick: () => setLd({ unblock: off ? ld.unblock.filter((s) => s.toLowerCase() !== site.toLowerCase()) : [...ld.unblock, site] }),
            },
            site,
          );
        }),
      ),
    ),
    chipEditor('Also block', 'Any word in the tab title, e.g. chess.com or Amazon', ld.extraSites, (s) => setLd({ extraSites: ld.extraSites.filter((x) => x !== s) }), (s) => setLd({ extraSites: [...ld.extraSites, s] }, `${s} blocked`), 'Add a site'),
    chipEditor('Always allow', 'Wins over anything blocked', ld.allowSites, (s) => setLd({ allowSites: ld.allowSites.filter((x) => x !== s) }), (s) => setLd({ allowSites: [...ld.allowSites, s] }, `${s} allowed`), 'Add a site'),
    chipEditor('Minimise these apps', 'Program names, e.g. RobloxPlayerBeta.exe or Steam.exe', ld.apps, (s) => setLd({ apps: ld.apps.filter((x) => x !== s) }), (s) => setLd({ apps: [...ld.apps, s] }), 'Add an app'),
  );
}

function pomodoroRow() {
  const p = { focus: 25, break: 5, long: 15, every: 4, ...(snap.config.pomodoro || {}) };
  const field = (key, label, min, max) =>
    h(
      'label',
      { class: 'mini' },
      h('input', {
        type: 'number',
        min,
        max,
        value: p[key],
        class: 'num',
        onchange: (e) => set({ pomodoro: { ...p, [key]: Number(e.target.value) } }),
      }),
      h('small', {}, label),
    );
  return h(
    'div',
    { class: 'item stack' },
    label('Pomodoro', 'Focus and break lengths in minutes; a long break every few rounds'),
    h('div', { class: 'row-line' }, field('focus', 'focus', 5, 120), field('break', 'break', 1, 30), field('long', 'long break', 5, 60), field('every', 'rounds', 2, 8)),
  );
}

function schoolSection() {
  const c = snap.config;
  const mask = (u) => {
    try {
      const url = new URL(u);
      return `${url.hostname} · …${url.pathname.slice(-10)}`;
    } catch {
      return u.slice(0, 30);
    }
  };
  const hwInput = h('input', { class: 'text', placeholder: 'ManageBac / Classroom calendar link (https://…)' });
  const addHw = () => {
    let v = hwInput.value.trim().replace(/^webcal:\/\//i, 'https://');
    if (!v) return;
    if (!/^https:\/\//.test(v)) return toast('That needs to be an https:// or webcal:// link');
    set({ homeworkUrls: [...(c.homeworkUrls || []), v] }, 'Homework feed added');
  };
  hwInput.addEventListener('keydown', (e) => e.key === 'Enter' && addHw());

  const cdTitle = h('input', { class: 'text', placeholder: 'What (e.g. IB exams)' });
  const cdDate = h('input', { class: 'text date', type: 'date' });
  const addCd = () => {
    if (!cdTitle.value.trim() || !cdDate.value) return toast('Add a name and a date');
    set({ countdowns: [...(c.countdowns || []), { title: cdTitle.value.trim(), date: cdDate.value }] }, 'Countdown added');
  };

  return section(
    'School',
    h(
      'div',
      { class: 'item stack' },
      label('Homework due dates', 'ManageBac: Calendar → Subscribe (copy the link). Classroom: its Google Calendar → Settings → Secret address.'),
      (c.homeworkUrls || []).length
        ? h('div', { class: 'chips' }, ...c.homeworkUrls.map((u) => h('span', { class: 'chip' }, mask(u), h('button', { class: 'x', title: 'Remove', onclick: () => set({ homeworkUrls: c.homeworkUrls.filter((x) => x !== u) }) }, '×'))))
        : null,
      h('div', { class: 'row-line' }, hwInput, h('button', { class: 'btn', onclick: addHw }, 'Add')),
    ),
    h(
      'div',
      { class: 'item stack' },
      label('Countdowns', '"31 days to exam" style calendar events are picked up automatically too'),
      (c.countdowns || []).length
        ? h('div', { class: 'chips' }, ...c.countdowns.map((cd) => h('span', { class: 'chip' }, `${cd.title} · ${cd.date}`, h('button', { class: 'x', title: 'Remove', onclick: () => set({ countdowns: c.countdowns.filter((x) => x !== cd) }) }, '×'))))
        : null,
      h('div', { class: 'row-line' }, cdTitle, cdDate, h('button', { class: 'btn', onclick: addCd }, 'Add')),
    ),
  );
}

function notesAiSection() {
  const c = snap.config;
  const pathInput = h('input', { class: 'text', value: c.notesFile || '', placeholder: 'Leave empty to use your Obsidian vault' });
  const savePath = () => pathInput.value.trim() !== (c.notesFile || '') && set({ notesFile: pathInput.value }, 'Notes location saved');
  pathInput.addEventListener('keydown', (e) => e.key === 'Enter' && savePath());
  pathInput.addEventListener('blur', savePath);

  const keyInput = h('input', { class: 'text', type: 'password', placeholder: snap.hasAiKey ? '•••••••• saved (paste to replace)' : 'sk-ant-…', autocomplete: 'off' });
  const saveKey = async () => {
    const v = keyInput.value.trim();
    if (!v) return;
    const res = await window.apron.set({ aiKey: v });
    if (res && res.ok === false) return toast(res.error);
    snap = res;
    render();
    toast('Key saved (encrypted)');
  };
  keyInput.addEventListener('keydown', (e) => e.key === 'Enter' && saveKey());

  return section(
    'Launcher, notes & AI',
    h('div', { class: 'item' }, label('Quick launcher', 'Ctrl+Alt+Space, then type an app or site. "n …" saves a note, "t …" adds a to-do, "? …" asks Claude.')),
    h('div', { class: 'item stack' }, label('Notes go to', snap.notesTarget), h('div', { class: 'row-line' }, pathInput, h('button', { class: 'btn', onclick: savePath }, 'Save'))),
    h(
      'div',
      { class: 'item stack' },
      label('Anthropic API key', 'For "? …" questions (Claude Opus 5.5). Get one at console.anthropic.com. Stored encrypted on this PC.'),
      h(
        'div',
        { class: 'row-line' },
        keyInput,
        h('button', { class: 'btn primary', onclick: saveKey }, 'Save'),
        snap.hasAiKey ? h('button', { class: 'btn danger', onclick: () => set({ aiKey: '' }, 'Key removed') }, 'Remove') : null,
      ),
    ),
  );
}

function wellbeingSection() {
  const c = snap.config;
  const bed = h('input', { class: 'text date', type: 'time', value: c.bedtime || '23:00', onchange: (e) => set({ bedtime: e.target.value }, 'Bedtime saved') });
  return section(
    'Wellbeing & privacy',
    toggle('Sleep reminder', 'A heads-up 30 minutes before bed, then a nudge every 20 minutes after', 'sleepReminder'),
    h('div', { class: 'item' }, label('Bedtime', null), bed),
    toggle('Screen time', 'Counts time per site/app on this PC (labels only, never page titles)', 'screenTime'),
    toggle('Mic & camera dots', 'Orange dot = mic in use, green = camera, next to the notch', 'privacyDots'),
  );
}

function alerts() {
  return section(
    'Notifications',
    toggle('App & phone notifications', 'Discord, WhatsApp and other Windows notifications peek in the notch', 'notifications'),
    toggle('Clipboard peeks', 'Show what you just copied (history is memory-only)', 'clipboard'),
  );
}

function claudeSection() {
  const connected = snap.hooksInstalled;
  return section(
    'Claude Code',
    h(
      'div',
      { class: 'item' },
      label('Connection', connected ? 'Sessions, "needs you" alerts and approvals show in the notch' : 'Adds Apron hooks to ~/.claude/settings.json (your other hooks are kept)'),
      h('span', { class: `status${connected ? ' ok' : ''}` }, connected ? 'Connected' : 'Not connected'),
      connected
        ? h('button', { class: 'btn danger', onclick: () => action('disconnect-claude', 'Disconnected') }, 'Disconnect')
        : h('button', { class: 'btn primary', onclick: () => action('connect-claude', 'Connected to Claude Code') }, 'Connect'),
    ),
    toggle('Allow / Deny from the notch', 'Answer permission prompts without the terminal', 'claudeApprovals'),
  );
}

function general() {
  const u = snap.update || {};
  const updateText =
    u.status === 'ready' ? `Version ${u.next} is ready` : u.status === 'downloading' ? `Downloading ${u.next || ''} ${u.percent || 0}%` : u.status === 'checking' ? 'Checking…' : u.status === 'dev' ? 'Off while running from source' : u.status === 'error' ? `Last check failed` : 'Up to date';
  return section(
    'General',
    toggle('Start with Windows', null, 'startWithWindows'),
    h(
      'div',
      { class: 'item' },
      label(`Updates · v${snap.version}`, updateText),
      u.status === 'ready'
        ? h('button', { class: 'btn primary', onclick: () => action('install-update') }, 'Restart & update')
        : h('button', { class: 'btn', onclick: () => action('check-update', 'Checking for updates') }, 'Check now'),
    ),
    h('div', { class: 'item' }, label('Config file', snap.configPath), h('button', { class: 'btn', onclick: () => action('open-config') }, 'Open')),
    h('div', { class: 'item' }, label('Quit Apron', 'It starts again next time you sign in'), h('button', { class: 'btn danger', onclick: () => action('quit') }, 'Quit')),
  );
}

function render() {
  if (!snap) return;
  document.documentElement.style.setProperty('--accent', snap.config.accent);
  document.getElementById('version').textContent = `Settings · v${snap.version}`;
  const scroll = window.scrollY;
  root.replaceChildren(appearance(), music(), calendarWeather(), schoolSection(), focus(), notesAiSection(), alerts(), wellbeingSection(), claudeSection(), general());
  window.scrollTo(0, scroll);
}

window.apron.get().then((s) => {
  snap = s;
  render();
});

// Changes from elsewhere (tray, notch, config file). Don't rebuild under someone typing.
window.apron.onChanged((s) => {
  snap = s;
  const typing = document.activeElement && (document.activeElement.classList.contains('text') || document.activeElement.classList.contains('num'));
  if (!typing) render();
});
