const { app, BrowserWindow, ipcMain, screen, shell, Tray, Menu, nativeImage, globalShortcut, clipboard, safeStorage, powerMonitor, desktopCapturer } = require('electron');
const fs = require('fs');
const path = require('path');
const { loadConfig, saveConfig, CONFIG_PATH, HEX } = require('./config');
const calendar = require('./calendar');
const media = require('./media');
const claude = require('./claude');
const github = require('./github');
const weather = require('./weather');
const lyrics = require('./lyrics');
const notifications = require('./notifications');
const lockdown = require('./lockdown');
const { todoStore, timerStore, statsStore, clipboardWatcher } = require('./stores');
const screentime = require('./screentime');
const share = require('./share');
const notes = require('./notes');
const ask = require('./ask');
const ai = require('./ai');
const launcher = require('./launcher');
const sysinfo = require('./sysinfo');
const translator = require('./translate');
const flashcards = require('./flashcards');
const planner = require('./planner');
const spotify = require('./spotify');
const voice = require('./voice');
const voiceCommand = require('./voiceCommand');
const phone = require('./phone');
const { shelfStore } = require('./shelf');
const { screenshotWatcher } = require('./screenshots');
const { appIconPng } = require('./icon');
const updater = require('./updater');
const hooksInstall = require('./hooksInstall');
const { sanitize, NOTCH_ITEMS } = require('./settingsSchema');

const WIN_W = 640;
const WIN_H = 380;

let tray = null;
let settingsWin = null;
let config = loadConfig();
// What's currently in effect, so a config change (from Settings or the file) only
// restarts the parts that actually changed.
let applied = JSON.parse(JSON.stringify(config));
// Global shortcuts actually registered (another app may own the first choice).
let voiceShortcut = '';
let micShortcut = '';

function settingsPayload() {
  return {
    accent: config.accent,
    artColor: Boolean(config.artColor),
    lockdownSites: lockdown.compile(config).block.map((b) => b.label),
    lockdownDefault: config.lockdownDefault !== false,
    rotateSeconds: config.rotateSeconds,
    lyrics: config.lyrics !== false,
    peek: config.peek !== false,
    countdowns: config.countdowns || [],
    homeWidgets: config.homeWidgets,
    dockOrder: config.dockOrder,
    notchShow: config.notchShow,
    notchPriority: config.notchPriority,
    dockHidden: config.dockHidden,
    speedDial: (config.speedDial || []).map((c) => c.name),
    hotspot: config.hotspot || '',
    voice: config.voice !== false,
    voiceShortcut,
    micShortcut,
  };
}

// Everything the notches render. Each key is pushed to every window when it changes.
const state = {
  calendar: null,
  media: null,
  claude: [],
  github: null,
  update: null,
  weather: null,
  lyrics: null,
  todos: [],
  timer: null,
  clipboard: [],
  homework: null, // due items from ManageBac / Classroom feeds
  screentime: null, // today's time per site/app
  stats: null, // focus sessions today + streak
  privacy: { mic: [], cam: [] }, // apps using the mic / camera right now
  sys: null, // cpu, memory, wifi
  classMode: false, // inside school hours right now
  plan: null, // homework plan blocks
  planning: null, // { status: 'working' | 'error', error }
  spotify: null, // { connected, id, liked, playlists }
  voice: null, // tap-to-talk: { status: 'idle' | 'listening' | 'thinking' | 'error' }
  voiceLevel: 0, // mic level while listening, for the animation
  phone: null, // { name, battery, connected } over Bluetooth
  micMuted: null,
  inbox: { messages: [], calls: [] }, // recent phone messages and missed calls
  shelf: [], // files dropped on the notch
  shot: null, // latest screenshot on the clipboard { thumb, width, height, at }
  flashcards: { count: 0 },
  apps: [], // pinned quick-access apps, with icons
  ask: null, // the latest "Ask Claude" answer
  code: null, // last one-time code seen in a notification
  event: null, // short-lived: notification / copied / blocked / timer-done
  settings: settingsPayload(),
};

const ACCENTS = [
  ['Nothing red', '#d71921'],
  ['White', '#ffffff'],
  ['Yellow', '#ffc700'],
  ['Green', '#3ddc84'],
  ['Blue', '#2f6bff'],
  ['Pink', '#ff5fa2'],
];
const sources = {};
const stores = {};

if (!app.requestSingleInstanceLock()) app.exit(0);

// ---------- windows: one notch per screen ----------

/** displayId -> { win, rect, hovering } */
const notches = new Map();

function update(key, value) {
  state[key] = value;
  for (const { win } of notches.values()) if (!win.isDestroyed()) win.webContents.send('island:update', { key, value });
}

function emit(event) {
  update('event', { ...event, at: Date.now() });
}

function wantedDisplays() {
  const all = screen.getAllDisplays();
  if (config.displays === 'all') return all;
  if (typeof config.display === 'number' && all[config.display]) return [all[config.display]];
  return [screen.getPrimaryDisplay()];
}

function place(win, display) {
  const { x, y, width } = display.bounds;
  win.setBounds({ x: Math.round(x + (width - WIN_W) / 2), y: y + config.offsetY, width: WIN_W, height: WIN_H });
}

function createNotch(display) {
  const win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });
  // APRON_EXPAND=media|calendar|claude|focus|todo|clip pins Apron open on that tab (for screenshots).
  const query = { primary: display.id === screen.getPrimaryDisplay().id ? '1' : '0' };
  if (process.env.APRON_EXPAND) query.expand = process.env.APRON_EXPAND;
  if (process.env.APRON_QUERY) query.q = process.env.APRON_QUERY;
  // APRON_CONSOLE=1 copies the notch's console (and any script errors) to stdout, for debugging.
  if (process.env.APRON_CONSOLE) {
    win.webContents.on('console-message', (e, level, message, line, source) => {
      const m = typeof e.message === 'string' ? e : { level, message, lineNumber: line, sourceId: source };
      console.log(`[notch:${m.level}] ${m.message} (${path.basename(String(m.sourceId || ''))}:${m.lineNumber})`);
    });
  }
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query });
  win.once('ready-to-show', () => {
    place(win, display);
    win.showInactive();
    // APRON_NOTCH_SHOT=<file.png> saves just this window's pixels (for docs/debugging).
    if (process.env.APRON_NOTCH_SHOT && query.primary === '1') {
      setTimeout(async () => fs.writeFileSync(process.env.APRON_NOTCH_SHOT, (await win.webContents.capturePage()).toPNG()), Number(process.env.APRON_SHOT_DELAY) || 6000);
    }
  });
  notches.set(display.id, { win, rect: null, hovering: false });
}

function syncNotches() {
  const wanted = wantedDisplays();
  const ids = new Set(wanted.map((d) => d.id));
  for (const [id, n] of notches) {
    if (!ids.has(id)) {
      if (!n.win.isDestroyed()) n.win.destroy();
      notches.delete(id);
    }
  }
  for (const d of wanted) {
    const n = notches.get(d.id);
    if (n) place(n.win, d);
    else createNotch(d);
  }
}

function notchFor(webContents) {
  for (const n of notches.values()) if (!n.win.isDestroyed() && n.win.webContents === webContents) return n;
  return null;
}

// The renderer tells us where its pill is; we poll the cursor ourselves because
// mouseleave doesn't fire reliably on a non-focusable, click-through window.
function trackHover() {
  setInterval(() => {
    const p = screen.getCursorScreenPoint();
    for (const n of notches.values()) {
      if (n.win.isDestroyed() || !n.rect) continue;
      const b = n.win.getBounds();
      const x = p.x - b.x;
      const y = p.y - b.y;
      const r = n.rect;
      const inside = x >= r.x && x <= r.x + r.w && y >= r.y - 4 && y <= r.y + r.h;
      if (inside === n.hovering) continue;
      n.hovering = inside;
      n.win.setIgnoreMouseEvents(!inside, { forward: true });
      n.win.webContents.send('island:hover', inside);
    }
  }, 80);
  // Clicking the taskbar can knock us below it; quietly reassert.
  setInterval(() => {
    for (const n of notches.values()) if (!n.win.isDestroyed()) n.win.setAlwaysOnTop(true, 'screen-saver');
  }, 10e3);
}

// ---------- sources ----------

function startSources() {
  sources.calendar = calendar.start(config, (v) => update('calendar', v));
  sources.homework = calendar.start(config, (v) => update('homework', v), { urls: config.homeworkUrls || [], days: 14 });
  sources.github = github.start(config, (v) => update('github', v));
  sources.weather = weather.start(config, (v) => update('weather', v));
}

function stopSources() {
  for (const key of ['calendar', 'homework', 'github', 'weather']) if (sources[key]) sources[key].stop();
}

function refreshLockdown() {
  if (!sources.lockdown) return;
  const t = state.timer;
  // Lockdown runs during focus, not during Pomodoro breaks.
  const focusing = Boolean(t && t.lockdown && (t.phase || 'focus') === 'focus');
  const cm = config.classMode || {};
  sources.lockdown.setActive(focusing || (state.classMode && cm.lockdown !== false));
  refreshWatch();
}

// The foreground-window watcher feeds both lockdown and screen time.
let watching = null;
function refreshWatch() {
  if (!sources.media || !sources.lockdown) return;
  const on = config.screenTime !== false || sources.lockdown.isActive();
  if (on === watching) return;
  watching = on;
  sources.media.command(on ? 'watch on' : 'watch off');
}

// ---------- AI key (encrypted at rest with Windows DPAPI via safeStorage) ----------

function decrypt(field) {
  if (!config[field]) return '';
  try {
    return safeStorage.decryptString(Buffer.from(config[field], 'base64'));
  } catch {
    return '';
  }
}

/** The AI the user picked: Gemini (default) or Claude, with its key and model. */
function getAi() {
  const provider = config.aiProvider === 'claude' ? 'claude' : 'gemini';
  return {
    provider,
    key: decrypt(provider === 'claude' ? 'aiKeyEnc' : 'geminiKeyEnc'),
    model: (provider === 'gemini' ? config.geminiModel : config.claudeModel) || ai.DEFAULT_MODELS[provider],
  };
}

/**
 * A key typed straight into config.json ("geminiKey" / "anthropicKey") is encrypted
 * into geminiKeyEnc / aiKeyEnc and the plain copy is removed from the file.
 */
function importPlainKeys() {
  const raw = (() => {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch {
      return {};
    }
  })();
  const plain = [
    ['geminiKey', 'geminiKeyEnc'],
    ['anthropicKey', 'aiKeyEnc'],
  ].filter(([k]) => typeof raw[k] === 'string' && raw[k].trim());
  if (!plain.length || !safeStorage.isEncryptionAvailable()) return false;
  const patch = {};
  for (const [k, enc] of plain) {
    patch[enc] = safeStorage.encryptString(raw[k].trim()).toString('base64');
    patch[k] = undefined; // JSON.stringify drops it, so the plain key leaves the file
  }
  saveConfig(patch);
  return true;
}

/** field: 'aiKeyEnc' (Anthropic) or 'geminiKeyEnc' (Google). */
function setKey(field, key) {
  const k = String(key || '').trim();
  if (!k) return setConfig({ [field]: '' });
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows encryption isn't available, so the key wasn't saved");
  setConfig({ [field]: safeStorage.encryptString(k).toString('base64') });
}

// ---------- class mode (school hours) ----------

function inClassHours(now = new Date()) {
  const cm = config.classMode || {};
  if (!cm.enabled) return false;
  const days = Array.isArray(cm.days) ? cm.days : [1, 2, 3, 4, 5];
  if (!days.includes(now.getDay())) return false;
  const mins = (hhmm) => {
    const [h, m] = String(hhmm || '').split(':').map(Number);
    return h * 60 + m;
  };
  const t = now.getHours() * 60 + now.getMinutes();
  return t >= mins(cm.start || '08:00') && t < mins(cm.end || '15:30');
}

function checkClassMode() {
  const on = inClassHours();
  if (on === state.classMode) return;
  update('classMode', on);
  emit({ type: 'info', text: on ? 'Class mode on · notifications quiet' : 'Class mode off', trail: on ? 'CLASS' : '' });
  refreshLockdown();
}

// ---------- daily summary ----------

let summaryDay = '';
function buildSummary() {
  const st = state.stats || { today: 0, minutesToday: 0, streak: 0 };
  const scr = state.screentime || { total: 0, distracting: 0, items: [] };
  const topBad = (scr.items || []).find((i) => i.distracting);
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  const dayAfter = tomorrow + 864e5;
  const firstTomorrow = ((state.calendar && state.calendar.events) || []).find((e) => !e.allDay && e.start >= tomorrow && e.start < dayAfter);
  const dueTomorrow = ((state.homework && state.homework.events) || []).filter((e) => e.start < dayAfter && e.start >= now.getTime());
  return {
    focusMinutes: st.minutesToday || 0,
    sessions: st.today || 0,
    streak: st.streak || 0,
    screenMinutes: Math.round((scr.total || 0) / 60),
    distractedMinutes: Math.round((scr.distracting || 0) / 60),
    topDistraction: topBad ? topBad.label : null,
    firstTomorrow: firstTomorrow ? { title: firstTomorrow.title, start: firstTomorrow.start } : null,
    due: dueTomorrow.slice(0, 3).map((e) => e.title),
  };
}

function checkSummary() {
  const ds = config.dailySummary || {};
  if (ds.enabled === false) return;
  const [h, m] = String(ds.time || '21:30').split(':').map(Number);
  const now = new Date();
  const day = now.toDateString();
  if (summaryDay === day) return;
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m).getTime();
  if (Date.now() >= at && Date.now() - at < 60 * 60e3) {
    summaryDay = day;
    emit({ type: 'summary', ...buildSummary() });
  }
}

// ---------- homework planner ----------

const seenBlocks = new Set();
function checkPlan() {
  if (!stores.plan) return;
  for (const b of stores.plan.due(seenBlocks)) {
    seenBlocks.add(b.start);
    emit({ type: 'plan-start', task: b.task, minutes: b.minutes });
  }
}

async function makePlan() {
  const cfg = getAi();
  if (!cfg.key) {
    update('planning', { status: 'error', error: `Add your ${cfg.provider === 'claude' ? 'Anthropic' : 'Gemini'} API key in Settings → AI first` });
    return;
  }
  update('planning', { status: 'working' });
  try {
    const now = Date.now();
    const plan = await planner.makePlan(cfg, {
      now,
      bedtime: config.bedtime || '23:00',
      schedule: ((state.calendar && state.calendar.events) || []).filter((e) => !e.allDay && e.end > now),
      due: ((state.homework && state.homework.events) || []).filter((e) => e.start > now),
      focusMinutes: (config.pomodoro && config.pomodoro.focus) || 25,
    });
    stores.plan.set(plan);
    update('planning', null);
    emit({ type: 'info', text: plan.blocks.length ? `Planned ${plan.blocks.length} focus block${plan.blocks.length > 1 ? 's' : ''}` : 'Nothing to plan', trail: '✎' });
  } catch (err) {
    update('planning', { status: 'error', error: err.message });
  }
}

// ---------- flashcards ----------

let cards = [];
function loadFlashcards() {
  const folder = config.flashcardsFolder || notes.obsidianVault();
  const res = flashcards.scan(folder);
  cards = res.cards;
  update('flashcards', { count: cards.length, folder: folder || null });
}

// ---------- spotify ----------

async function refreshSpotify() {
  if (!sources.spotify || !sources.spotify.connected()) {
    update('spotify', { connected: false });
    return;
  }
  const m = state.media;
  const base = { connected: true, playlists: (state.spotify && state.spotify.playlists) || null };
  if (!m || !/spotify/i.test(m.app || '')) return update('spotify', { ...base, id: null, liked: false });
  try {
    const cur = await sources.spotify.current();
    update('spotify', { ...base, id: cur ? cur.id : null, liked: cur ? cur.liked : false });
  } catch (err) {
    update('spotify', { ...base, error: err.message });
  }
}

// ---------- voice (tap to talk) ----------

/** Voice always uses Gemini (it understands audio), whatever you picked for Ask. */
function geminiAi() {
  return { provider: 'gemini', key: decrypt('geminiKeyEnc'), model: config.geminiModel || ai.DEFAULT_MODELS.gemini };
}

function toggleVoice() {
  if (!sources.voice) return;
  if (!geminiAi().key && sources.voice.status !== 'listening') {
    emit({ type: 'info', text: 'Add a Gemini key in Settings → AI to use voice', trail: '🎙' });
    return;
  }
  sources.voice.toggle();
}

async function onClip(clip) {
  try {
    const r = await voiceCommand.interpret(geminiAi(), clip, {
      now: Date.now(),
      apps: (config.pinnedApps || []).map((a) => a.name),
      contacts: (config.speedDial || []).map((c) => c.name),
    });
    await runVoice(r);
  } catch (err) {
    emit({ type: 'info', text: err instanceof ai.AiError ? err.message : "Couldn't make that out. Try again", trail: '🎙' });
  } finally {
    sources.voice.done();
  }
}

/** Does what Gemini heard. r: { transcript, action, minutes?, text?, answer? } */
async function runVoice(r) {
  const say = (text, trail = '🎙') => emit({ type: 'info', text, trail });
  const what = r.text || r.transcript;
  switch (r.action) {
    case 'open': {
      const hit = launcher.search(getIndex(), r.text || '').find((x) => x.kind === 'open' || x.kind === 'url');
      if (!hit) return say(`Couldn't find "${(r.text || '').slice(0, 30)}"`);
      if (hit.kind === 'url') {
        if (isSafeUrl(hit.url)) shell.openExternal(hit.url);
      } else openItem(hit.path);
      return say(`Opening ${hit.title}`, '↗');
    }
    case 'search':
    case 'note':
    case 'todo':
      return runLauncher({ kind: r.action, title: what });
    case 'ask': {
      if (r.answer) update('ask', { id: Date.now(), question: r.transcript || what, status: 'done', text: r.answer, who: 'Gemini' });
      const pending = r.answer ? null : sources.ask.ask(what);
      showAnswer();
      return pending;
    }
    case 'askscreen': {
      let image;
      try {
        image = await captureScreen();
      } catch {
        return say("Couldn't capture the screen");
      }
      const pending = sources.ask.ask(what, image);
      showAnswer();
      return pending;
    }
    case 'call':
      return callContact(r.text || '');
    case 'hotspot':
      return joinHotspot();
    case 'mute':
      return sources.media.command('micmute');
    case 'none':
      return say(r.transcript ? `"${r.transcript.slice(0, 40)}" · not a command` : "Didn't catch that");
    default:
      return onVoice({ cmd: r.action, minutes: r.minutes });
  }
}

// ---------- phone (through Phone Link) ----------

function dial(number, name) {
  const n = phone.cleanNumber(number);
  if (!n) return;
  shell.openExternal(`tel:${n}`);
  emit({ type: 'info', text: `Calling ${name || n} · Phone Link`, trail: '☎' });
}

function callContact(who) {
  const q = String(who || '').toLowerCase().trim();
  const list = config.speedDial || [];
  const hit = list.find((c) => c.name.toLowerCase() === q) || list.find((c) => q && (c.name.toLowerCase().includes(q) || q.includes(c.name.toLowerCase())));
  if (!hit) return emit({ type: 'info', text: q ? `No speed dial for "${who.slice(0, 20)}" · add it in Settings → Phone` : 'Who should I call?', trail: '☎' });
  return dial(hit.number, hit.name);
}

async function joinHotspot() {
  if (!config.hotspot) return emit({ type: 'info', text: 'Pick your hotspot in Settings → Phone', trail: '📶' });
  emit({ type: 'info', text: `Joining ${config.hotspot}…`, trail: '📶' });
  try {
    await phone.connectWifi(config.hotspot);
    emit({ type: 'info', text: `Connected to ${config.hotspot}`, trail: '📶' });
  } catch (err) {
    emit({ type: 'info', text: `Hotspot: ${err.message.slice(0, 60)}. Is it switched on?`, trail: '!' });
  }
}

function findAppPath(name) {
  if (!name) return null;
  const hit = getIndex().find((i) => i.type === 'app' && i.name.toLowerCase() === String(name).toLowerCase());
  return hit ? hit.path : null;
}

// ---------- end-of-class nudge ----------

const nudgedClasses = new Set();
function checkClassEnd() {
  if (config.classNudge === false) return;
  const now = Date.now();
  const events = (state.calendar && state.calendar.events) || [];
  const cur = events.find((e) => !e.allDay && e.start <= now && e.end > now && e.end - e.start <= 4 * 3600e3);
  if (!cur) return;
  const left = (cur.end - now) / 60e3;
  const key = `${cur.title}|${cur.end}`;
  if (left > 5 || left < 1 || nudgedClasses.has(key)) return;
  nudgedClasses.add(key);
  const next = events.find((e) => !e.allDay && e !== cur && e.start >= cur.end - 60e3 && e.start - cur.end < 60 * 60e3);
  emit({
    type: 'classend',
    title: cur.title,
    left: Math.round(left),
    next: next ? { title: next.title, location: next.location || '', start: next.start } : null,
  });
}

// ---------- shelf ----------

const shelfIcons = new Map();
async function publishShelf(items) {
  for (const it of items) {
    if (shelfIcons.has(it.path)) continue;
    try {
      shelfIcons.set(it.path, await app.getFileIcon(it.path, { size: 'normal' }));
    } catch {
      // generic tile
    }
  }
  update(
    'shelf',
    items.map((it) => ({ ...it, icon: shelfIcons.has(it.path) ? shelfIcons.get(it.path).toDataURL() : null })),
  );
}

function saveScreenshot() {
  const png = stores.shots && stores.shots.png();
  if (!png) return;
  const dir = path.join(app.getPath('pictures'), 'Screenshots');
  const pad = (n) => String(n).padStart(2, '0');
  const d = new Date();
  const file = path.join(dir, `Apron ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}.png`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, png);
    if (stores.shelf) stores.shelf.add([file]);
    emit({ type: 'info', text: 'Saved to Pictures › Screenshots (and the shelf)', trail: '✓' });
  } catch (err) {
    emit({ type: 'info', text: `Couldn't save: ${err.message}`, trail: '!' });
  }
}

// ---------- voice commands (also used by tap-to-talk) ----------

function onVoice(c) {
  const say = (text, trail = '🎙') => emit({ type: 'info', text, trail });
  switch (c.cmd) {
    case 'timer':
      stores.timer.start(c.minutes, config.lockdownDefault !== false);
      return say(`${c.minutes}-minute timer started`);
    case 'pomodoro':
      stores.timer.start(0, config.lockdownDefault !== false, 'pomodoro');
      return say('Pomodoro started');
    case 'stop':
      stores.timer.stop();
      return say('Timer stopped');
    case 'pause':
      if (state.media && state.media.playing) sources.media.command('toggle');
      return say('Paused');
    case 'play':
      if (state.media && !state.media.playing) sources.media.command('toggle');
      return say('Playing');
    case 'next':
    case 'prev':
    case 'volup':
    case 'voldown':
      sources.media.command(c.cmd);
      return say({ next: 'Next song', prev: 'Previous song', volup: 'Volume up', voldown: 'Volume down' }[c.cmd]);
    case 'whatsnext': {
      const now = Date.now();
      const next = ((state.calendar && state.calendar.events) || []).find((e) => !e.allDay && e.start > now);
      return say(next ? `Next: ${next.title} at ${new Date(next.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'Nothing else today');
    }
    case 'launcher':
      return openLauncherOn(screen.getPrimaryDisplay().id);
    default:
  }
}

// ---------- screen questions ----------

async function captureScreen() {
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const scale = Math.min(1, 1568 / Math.max(d.size.width, d.size.height));
  const sources_ = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(d.size.width * scale), height: Math.round(d.size.height * scale) },
  });
  const src = sources_.find((x) => String(x.display_id) === String(d.id)) || sources_[0];
  if (!src) throw new Error('no screen to capture');
  return src.thumbnail.toJPEG(80).toString('base64');
}

// ---------- sleep reminder ----------

let lastSleepNudge = 0;
let windDownDay = '';
function checkBedtime() {
  if (!config.sleepReminder || !/^\d\d:\d\d$/.test(config.bedtime || '')) return;
  const now = new Date();
  const [hh, mm] = config.bedtime.split(':').map(Number);
  const bed = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm);
  // After midnight, bedtime was "yesterday".
  if (now.getHours() < 5 && hh >= 12) bed.setDate(bed.getDate() - 1);
  const diff = now - bed;
  const label = bed.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const day = bed.toDateString();
  if (diff >= -30 * 60e3 && diff < -25 * 60e3 && windDownDay !== day) {
    windDownDay = day;
    emit({ type: 'sleep', soft: true, text: `Wind down · bed at ${label}` });
  } else if (diff >= 0 && diff < 5 * 3600e3 && Date.now() - lastSleepNudge > 20 * 60e3) {
    lastSleepNudge = Date.now();
    emit({ type: 'sleep', soft: false, text: diff < 60e3 ? `It's ${label}. Bedtime` : `${Math.round(diff / 60e3)}m past bedtime` });
  }
}

// ---------- quick-access apps ----------

const iconCache = new Map();

/** Clean icons for .lnk shortcuts, via icons.ps1 (Electron's lookup shows a blank page). */
function extractLnkIcons(paths) {
  return new Promise((resolve) => {
    if (!paths.length) return resolve({});
    require('child_process').execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'icons.ps1')],
      { windowsHide: true, timeout: 30000, maxBuffer: 20e6, env: { ...process.env, APRON_ICON_PATHS: JSON.stringify(paths) } },
      (err, out) => {
        try {
          resolve(err ? {} : JSON.parse(out || '{}'));
        } catch {
          resolve({});
        }
      },
    );
  });
}

async function appIcon(file) {
  if (isStoreApp(file)) return null; // Store apps show their first letter
  if (iconCache.has(file)) return iconCache.get(file);
  let url = null;
  try {
    url = (await app.getFileIcon(file, { size: 'large' })).toDataURL();
  } catch {
    url = null;
  }
  iconCache.set(file, url);
  return url;
}

async function refreshApps() {
  const list = (config.pinnedApps || []).filter((a) => a && a.path && (isStoreApp(a.path) || fs.existsSync(a.path)));
  const lnks = list.map((a) => a.path).filter((p) => /\.lnk$/i.test(p) && !iconCache.has(p));
  const found = await extractLnkIcons(lnks);
  for (const p of lnks) if (found[p]) iconCache.set(p, found[p]);
  update('apps', await Promise.all(list.map(async (a) => ({ name: a.name, path: a.path, icon: await appIcon(a.path) }))));
}

/** Only things the launcher indexed (Start menu + Desktop) can be pinned. */
function pinApp(file) {
  const hit = getIndex().find((i) => i.path === file);
  if (!hit) return null;
  const list = config.pinnedApps || [];
  if (!list.some((a) => a.path === hit.path)) setConfig({ pinnedApps: [...list, { name: hit.name, path: hit.path }].slice(0, 16) });
  return hit.name;
}

// ---------- launcher ----------

let launcherShortcut = null;
function openLauncherOn(displayId) {
  const n = notches.get(displayId) || notches.values().next().value;
  if (!n || n.win.isDestroyed()) return;
  n.win.setFocusable(true);
  n.win.focus();
  n.win.webContents.send('island:toggle');
}

/** Opens the launcher's answer view (for a spoken question) on the screen you're on. */
function showAnswer() {
  const n = notches.get(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id) || notches.values().next().value;
  if (!n || n.win.isDestroyed()) return;
  n.win.setFocusable(true);
  n.win.focus();
  n.win.webContents.send('island:answer');
}

let launcherIndex = null;
let launcherBuiltAt = 0;

/** Store apps for the launcher, from Windows' own Start menu list (runs in the background). */
function loadStoreApps() {
  const { execFile } = require('child_process');
  execFile(
    'powershell.exe',
    ['-NoProfile', '-Command', "Get-StartApps | Where-Object { $_.AppID -match '!' } | Select-Object Name, AppID | ConvertTo-Json -Compress"],
    { windowsHide: true, timeout: 30000, maxBuffer: 5e6 },
    (err, out) => {
      if (err) return;
      try {
        const list = JSON.parse(out);
        launcher.setStoreApps(Array.isArray(list) ? list : [list]);
        launcherIndex = null; // rebuild with them next time
        refreshApps();
      } catch {
        // keep what we have
      }
    },
  );
}

const isStoreApp = (p) => /^shell:AppsFolder\\[\w.-]+![\w.-]+$/.test(String(p));

/** Opens an indexed/pinned item: Store apps go through explorer's AppsFolder. */
function openItem(p) {
  if (isStoreApp(p)) require('child_process').spawn('explorer.exe', [p], { detached: true, stdio: 'ignore' }).unref();
  else shell.openPath(p);
}
function getIndex() {
  if (!launcherIndex || Date.now() - launcherBuiltAt > 10 * 60e3) {
    launcherIndex = launcher.buildIndex();
    launcherBuiltAt = Date.now();
  }
  return launcherIndex;
}

async function runLauncher(item) {
  if (!item || typeof item !== 'object') return;
  const text = String(item.title || '').slice(0, 2000);
  switch (item.kind) {
    case 'open': {
      // Only open things that are actually in the index.
      const hit = getIndex().find((i) => i.path === item.path);
      if (hit) openItem(hit.path);
      break;
    }
    case 'url':
      if (isSafeUrl(item.url)) shell.openExternal(item.url);
      break;
    case 'search':
      shell.openExternal(`https://www.google.com/search?q=${encodeURIComponent(text)}`);
      break;
    case 'ask':
      sources.ask.ask(text);
      break;
    case 'askscreen':
      try {
        sources.ask.ask(text, await captureScreen());
      } catch (err) {
        update('ask', { id: Date.now(), question: text, status: 'error', text: `Couldn't capture the screen: ${err.message}` });
      }
      break;
    case 'askshot': {
      const img = stores.shots && stores.shots.jpeg();
      if (!img) update('ask', { id: Date.now(), question: text, status: 'error', text: 'No screenshot to ask about. Take one with Win+Shift+S.' });
      else sources.ask.ask(text, img);
      break;
    }
    case 'translate': {
      const id = Date.now();
      update('ask', { id, question: `Translate: ${text}`, status: 'streaming', text: '' });
      try {
        const r = await translator.translate(text, { cfg: getAi(), to: item.to });
        update('ask', { id, question: `Translate → ${r.toName}`, status: 'done', text: r.text });
      } catch (err) {
        update('ask', { id, question: 'Translate', status: 'error', text: err.message });
      }
      break;
    }
    case 'cards':
      emit({ type: 'open-tab', tab: 'timer', cards: true });
      break;
    case 'note': {
      try {
        const where = notes.append(config, text);
        emit({ type: 'info', text: 'Note saved', trail: '✓', detail: where });
      } catch (err) {
        emit({ type: 'info', text: `Couldn't save note: ${err.message}`, trail: '!' });
      }
      break;
    }
    case 'addfeed': {
      const url = String(item.url || '').replace(/^webcal:\/\//i, 'https://');
      const clean = sanitize({ homeworkUrls: [...(config.homeworkUrls || []), url] });
      if (clean.homeworkUrls && clean.homeworkUrls.includes(url)) {
        setConfig(clean);
        emit({ type: 'info', text: 'Homework feed added', trail: '✎' });
      } else emit({ type: 'info', text: "That link didn't look like a calendar feed", trail: '!' });
      break;
    }
    case 'todo':
      stores.todos.add(text);
      emit({ type: 'info', text: 'Added to your to-dos', trail: '☐' });
      break;
    default:
  }
}

function loginItemOptions() {
  // In dev we run electron.exe with the app folder as an argument.
  const base = { name: 'Apron' };
  return app.isPackaged ? base : { ...base, path: process.execPath, args: [app.getAppPath()] };
}

function applyLoginItem() {
  app.setLoginItemSettings({ ...loginItemOptions(), openAtLogin: Boolean(config.startWithWindows) });
}

function setConfig(patch) {
  saveConfig(patch);
  applyConfig(loadConfig());
}

/** Make `next` the live config, restarting only what changed. */
function applyConfig(next) {
  const prev = applied;
  config = next;
  applied = JSON.parse(JSON.stringify(next));
  const changed = (...keys) => keys.some((k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]));
  if (changed('icalUrls', 'calendarRefreshMinutes', 'githubRefreshSeconds', 'weatherCity', 'units')) {
    stopSources();
    startSources();
  }
  if (sources.lockdown) sources.lockdown.setConfig(config);
  refreshWatch();
  if (changed('startWithWindows')) applyLoginItem();
  if (changed('displays', 'display', 'offsetY')) syncNotches();
  if (changed('voice')) registerVoiceShortcut();
  if (changed('flashcardsFolder', 'notesFile')) loadFlashcards();
  if (changed('classMode')) checkClassMode();
  if (changed('pinnedApps')) refreshApps();
  update('settings', settingsPayload());
  rebuildTray();
  sendSettings();
}

// ---------- tap-to-talk shortcut ----------

function registerVoiceShortcut() {
  if (voiceShortcut) globalShortcut.unregister(voiceShortcut.replace('Ctrl', 'Control'));
  voiceShortcut = '';
  if (config.voice === false) return;
  for (const combo of ['Control+Alt+V', 'Alt+Shift+V']) {
    if (globalShortcut.register(combo, toggleVoice)) {
      voiceShortcut = combo.replace('Control', 'Ctrl');
      break;
    }
  }
}

// ---------- tray ----------

function updateMenuItem() {
  const u = state.update || {};
  if (u.status === 'ready') return { label: `Restart to update to ${u.next}`, click: () => sources.updater.install() };
  if (u.status === 'downloading') return { label: `Downloading ${u.next || 'update'}… ${u.percent || 0}%`, enabled: false };
  if (u.status === 'dev') return { label: 'Updates: off in dev mode', enabled: false };
  return { label: u.status === 'checking' ? 'Checking for updates…' : 'Check for updates', click: () => sources.updater.check() };
}

function rebuildTray() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Apron ${app.getVersion()}`, enabled: false },
      updateMenuItem(),
      { type: 'separator' },
      { label: 'Settings…', click: openSettings },
      { label: 'Refresh', click: () => Object.values(sources).forEach((s) => s.refresh && s.refresh()) },
      {
        label: 'Accent colour',
        submenu: ACCENTS.map(([label, hex]) => ({ label, type: 'radio', checked: config.accent === hex, click: () => setConfig({ accent: hex }) })),
      },
      { label: 'Colour album art', type: 'checkbox', checked: Boolean(config.artColor), click: (i) => setConfig({ artColor: i.checked }) },
      {
        label: 'Show on all screens',
        type: 'checkbox',
        checked: config.displays === 'all',
        click: (i) => setConfig({ displays: i.checked ? 'all' : 'primary' }),
      },
      { label: 'Phone & app notifications', type: 'checkbox', checked: config.notifications !== false, click: (i) => setConfig({ notifications: i.checked }) },
      { label: 'Clipboard peeks', type: 'checkbox', checked: config.clipboard !== false, click: (i) => setConfig({ clipboard: i.checked }) },
      { label: 'Open config', click: () => shell.openPath(CONFIG_PATH) },
      {
        label: 'Start with Windows',
        type: 'checkbox',
        checked: Boolean(config.startWithWindows),
        click: (i) => setConfig({ startWithWindows: i.checked }),
      },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
}

function buildTray() {
  tray = new Tray(nativeImage.createFromBuffer(appIconPng(32), { scaleFactor: 2 }));
  tray.setToolTip('Apron');
  tray.on('click', openSettings);
  rebuildTray();
}

// ---------- settings window ----------

function settingsSnapshot() {
  const { aiKeyEnc, geminiKeyEnc, spotifyRefreshEnc, ...safeConfig } = config;
  return {
    config: safeConfig,
    hasAiKey: Boolean(aiKeyEnc),
    hasGeminiKey: Boolean(geminiKeyEnc),
    aiDefaults: ai.DEFAULT_MODELS,
    launcherShortcut,
    hasSpotify: Boolean(config.spotifyRefreshEnc),
    flashcards: state.flashcards,
    voice: state.voice,
    voiceShortcut,
    micShortcut,
    phone: state.phone,
    notesTarget: notes.target(config).label,
    version: app.getVersion(),
    configPath: CONFIG_PATH,
    builtInSites: lockdown.DEFAULT_BLOCK.map(([label]) => label),
    hooksInstalled: hooksInstall.status(),
    update: state.update,
  };
}

function sendSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('settings:changed', settingsSnapshot());
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 560,
    height: 760,
    minWidth: 460,
    minHeight: 500,
    title: 'Apron Settings',
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#000000', symbolColor: '#ffffff', height: 40 },
    icon: nativeImage.createFromBuffer(appIconPng(64)),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'settings', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWin.loadFile(path.join(__dirname, 'settings', 'index.html'));
  settingsWin.once('ready-to-show', () => {
    settingsWin.show();
    // APRON_SETTINGS_SHOT=<file.png> saves a screenshot of the window (for docs/debugging).
    if (process.env.APRON_SETTINGS_SHOT) {
      setTimeout(async () => {
        // APRON_SETTINGS_FIND=<section title> scrolls to that section first.
        const find = process.env.APRON_SETTINGS_FIND;
        if (find) await settingsWin.webContents.executeJavaScript(`[...document.querySelectorAll('h2')].find((x) => x.textContent.includes(${JSON.stringify(find)}))?.scrollIntoView()`);
        const img = await settingsWin.webContents.capturePage();
        fs.writeFileSync(process.env.APRON_SETTINGS_SHOT, img.toPNG());
      }, 1500);
    }
  });
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

// Claude Code hooks point at a copy of the hook script in %APPDATA%\Apron, so they keep
// working wherever the app (or this repo) lives. Refresh it on every start.
function syncHookScript() {
  try {
    const src = path.join(__dirname, '..', 'hooks', 'apron-hook.js');
    const dest = path.join(app.getPath('userData'), 'apron-hook.js');
    const body = fs.readFileSync(src);
    if (!fs.existsSync(dest) || !fs.readFileSync(dest).equals(body)) fs.writeFileSync(dest, body);
  } catch (err) {
    console.error('[hooks] could not copy hook script:', err.message);
  }
}

// Hand edits to config.json apply live too.
function watchConfig() {
  let timer = null;
  fs.watchFile(CONFIG_PATH, { interval: 1000 }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (importPlainKeys()) return; // rewrote the file; the watcher fires again
      applyConfig(loadConfig());
    }, 300);
  });
}

function isSafeUrl(url) {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

// ---------- IPC from the notches ----------

ipcMain.handle('island:state', () => state);
ipcMain.on('island:rect', (e, r) => {
  const n = notchFor(e.sender);
  if (n) n.rect = r;
});
// Typing (to-do box) needs a focusable window; give it back as soon as you're done.
ipcMain.on('island:focus', (e, on) => {
  const n = notchFor(e.sender);
  if (!n) return;
  n.win.setFocusable(Boolean(on));
  if (on) n.win.focus();
  else n.win.blur();
});
ipcMain.on('island:media', (_e, cmd) => sources.media && sources.media.command(String(cmd)));
ipcMain.on('island:open', (_e, url) => isSafeUrl(url) && shell.openExternal(url));
ipcMain.on('island:open-config', () => shell.openPath(CONFIG_PATH));
ipcMain.on('island:accent', (_e, hex) => HEX.test(String(hex)) && setConfig({ accent: String(hex).toLowerCase() }));
ipcMain.on('island:art-color', (_e, on) => setConfig({ artColor: on === true }));
ipcMain.on('island:install-update', () => sources.updater && sources.updater.install());
ipcMain.on('island:claude-decide', (_e, id, allow) => {
  if (!sources.claude.decide(String(id), allow === true)) emit({ type: 'info', text: 'Answer that one in the terminal', trail: '↩' });
});
ipcMain.on('island:todo', (_e, op, arg) => {
  const t = stores.todos;
  if (op === 'add') t.add(arg);
  else if (op === 'toggle') t.toggle(String(arg));
  else if (op === 'remove') t.remove(String(arg));
  else if (op === 'clear-done') t.clearDone();
});
ipcMain.on('island:timer', (_e, op, arg) => {
  const t = stores.timer;
  if (op === 'start') t.start(arg && arg.minutes, arg && arg.lockdown, arg && arg.mode);
  else if (op === 'skip') t.skip();
  else if (op === 'add') t.add(Number(arg) || 1);
  else if (op === 'lockdown') t.setLockdown(arg === true);
  else if (op === 'stop') t.stop();
});
ipcMain.on('island:open-settings', () => openSettings());
ipcMain.handle('island:launcher-search', (_e, input) => launcher.search(getIndex(), String(input || '').slice(0, 300)));
ipcMain.on('island:launcher-run', (_e, item) => runLauncher(item));
ipcMain.on('island:pin', (_e, file) => {
  const name = pinApp(String(file));
  emit({ type: 'info', text: name ? `${name} pinned to Apps` : "Couldn't pin that", trail: name ? '📌' : '!' });
});
ipcMain.on('island:unpin', (_e, file) => setConfig({ pinnedApps: (config.pinnedApps || []).filter((a) => a.path !== String(file)) }));
ipcMain.on('island:open-app', (_e, file) => {
  // Only open what you pinned.
  const hit = (config.pinnedApps || []).find((a) => a.path === String(file));
  if (hit && (isStoreApp(hit.path) || fs.existsSync(hit.path))) openItem(hit.path);
});
// 'auto' / 'rotate', or a notch item (right-click on a widget) to put at the top of the list.
ipcMain.on('island:notch', (_e, mode) => {
  const m = String(mode);
  if (m === 'auto' || m === 'rotate') return setConfig({ notchShow: m });
  if (!NOTCH_ITEMS.includes(m)) return undefined;
  const group = m === 'class' ? ['class', 'soon', 'next'] : [m];
  const rest = (config.notchPriority || NOTCH_ITEMS).filter((x) => !group.includes(x));
  return setConfig({ notchShow: 'auto', notchPriority: [...group, ...rest] });
});
ipcMain.on('island:voice', (_e, op) => {
  if (op === 'cancel') sources.voice && sources.voice.cancel();
  else toggleVoice();
});
ipcMain.on('island:mic', () => sources.media && sources.media.command('micmute'));
ipcMain.on('island:phone', (_e, op, arg) => {
  const inbox = stores.inbox;
  if (op === 'reply') {
    const m = inbox.message(String(arg));
    if (!m) return;
    const t = phone.replyTarget(m, findAppPath);
    if (t.app) openItem(t.app);
    else shell.openExternal(t.url);
  } else if (op === 'callback') {
    const c = inbox.call(String(arg));
    if (!c) return;
    if (c.number) dial(c.number, c.name);
    else shell.openExternal('ms-phone:');
  } else if (op === 'dismiss') inbox.dismiss(String(arg));
  else if (op === 'dial') {
    const c = (config.speedDial || [])[Number(arg)];
    if (c) dial(c.number, c.name);
  } else if (op === 'hotspot') joinHotspot();
  else if (op === 'open') shell.openExternal('ms-phone:');
});
ipcMain.on('island:shelf', (_e, op, arg) => {
  const sh = stores.shelf;
  if (op === 'add') {
    const n = sh.add(Array.isArray(arg) ? arg.map(String).slice(0, 20) : []);
    if (n) emit({ type: 'info', text: `${n} item${n > 1 ? 's' : ''} on the shelf`, trail: '⇩' });
  } else if (op === 'open' && sh.has(String(arg))) shell.openPath(String(arg));
  else if (op === 'reveal' && sh.has(String(arg))) shell.showItemInFolder(String(arg));
  else if (op === 'remove') sh.remove(String(arg));
  else if (op === 'clear') sh.clear();
});
// Dragging a shelf item out of the notch into another app.
ipcMain.on('island:shelf-drag', (e, file) => {
  const p = String(file);
  if (!stores.shelf || !stores.shelf.has(p)) return;
  e.sender.startDrag({ file: p, icon: shelfIcons.get(p) || nativeImage.createFromBuffer(appIconPng(32)) });
});
ipcMain.on('island:shot', (_e, op) => {
  if (op === 'save') saveScreenshot();
  else if (op === 'dismiss') {
    update('shot', null);
    if (stores.shots) stores.shots.forget();
  }
});
// Drag-to-reorder from the notch.
ipcMain.on('island:order', (_e, kind, list) => {
  const key = { dock: 'dockOrder', home: 'homeWidgets', apps: 'pinnedApps' }[kind];
  if (!key) return;
  if (key === 'pinnedApps') {
    const byPath = new Map((config.pinnedApps || []).map((a) => [a.path, a]));
    return setConfig({ pinnedApps: (Array.isArray(list) ? list : []).map((p) => byPath.get(p)).filter(Boolean) });
  }
  const clean = sanitize({ [key]: list });
  if (clean[key]) setConfig(clean);
});
ipcMain.handle('settings:search-apps', (_e, q) => launcher.search(getIndex(), String(q || '').slice(0, 100)).filter((r) => r.kind === 'open'));
ipcMain.handle('settings:pin', (_e, file) => {
  pinApp(String(file));
  return settingsSnapshot();
});
ipcMain.handle('island:flashcard', () => (cards.length ? cards[Math.floor(Math.random() * cards.length)] : null));
ipcMain.on('island:plan', (_e, op) => {
  if (op === 'make') makePlan();
  else if (op === 'clear') stores.plan.clear();
});
ipcMain.handle('island:spotify', async (_e, op, arg) => {
  try {
    if (op === 'like') {
      const cur = state.spotify;
      if (!cur || !cur.id) return { ok: false, error: 'Nothing playing on Spotify' };
      const liked = await sources.spotify.setLiked(cur.id, !cur.liked);
      update('spotify', { ...cur, liked });
      return { ok: true, liked };
    }
    if (op === 'playlists') {
      const list = await sources.spotify.playlists();
      update('spotify', { ...(state.spotify || {}), playlists: list });
      return { ok: true, playlists: list };
    }
    if (op === 'play') {
      await sources.spotify.play(String(arg));
      return { ok: true };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return { ok: false };
});
// The ⌕ button in the notch: same as the shortcut, but for the notch that was clicked.
ipcMain.on('island:open-launcher', (e) => {
  for (const [id, n] of notches) if (!n.win.isDestroyed() && n.win.webContents === e.sender) openLauncherOn(id);
});
ipcMain.on('island:ask-cancel', () => sources.ask && sources.ask.cancel());
ipcMain.handle('island:share', async () => {
  const m = state.media;
  if (!m || !m.title) return { ok: false };
  const link = await share.spotifyLink(m.title, m.artist);
  await clipboard.writeText(link.url);
  return { ok: true, ...link };
});

// From the Settings window.
ipcMain.handle('settings:get', () => settingsSnapshot());
ipcMain.handle('settings:wifi', () => phone.wifiProfiles());
ipcMain.handle('settings:set', (_e, patch) => {
  try {
    if (patch && typeof patch.aiKey === 'string') setKey('aiKeyEnc', patch.aiKey.slice(0, 300));
    if (patch && typeof patch.geminiKey === 'string') setKey('geminiKeyEnc', patch.geminiKey.slice(0, 300));
  } catch (err) {
    return { ok: false, error: err.message, ...settingsSnapshot() };
  }
  const clean = sanitize(patch);
  // Settings can reorder or remove pinned apps; new pins go through settings:pin (index-checked).
  if (clean.pinnedApps) {
    const known = new Set((config.pinnedApps || []).map((x) => x.path));
    clean.pinnedApps = clean.pinnedApps.filter((x) => known.has(x.path));
  }
  if (Object.keys(clean).length) setConfig(clean);
  return settingsSnapshot();
});
ipcMain.handle('settings:action', async (_e, action) => {
  if (action === 'check-update') sources.updater.check();
  else if (action === 'install-update') sources.updater.install();
  else if (action === 'open-config') shell.openPath(CONFIG_PATH);
  else if (action === 'connect-claude') {
    try {
      hooksInstall.run();
    } catch (err) {
      return { ok: false, error: err.message, ...settingsSnapshot() };
    }
  } else if (action === 'disconnect-claude') {
    try {
      hooksInstall.run({ uninstall: true });
    } catch (err) {
      return { ok: false, error: err.message, ...settingsSnapshot() };
    }
  } else if (action === 'spotify-connect') {
    try {
      await sources.spotify.connect();
      refreshSpotify();
    } catch (err) {
      return { ok: false, error: `Spotify: ${err.message}`, ...settingsSnapshot() };
    }
  } else if (action === 'spotify-disconnect') {
    sources.spotify.disconnect();
    refreshSpotify();
  } else if (action === 'rescan-cards') loadFlashcards();
  else if (action === 'quit') app.quit();
  return { ok: true, ...settingsSnapshot() };
});

ipcMain.on('island:clipboard', (_e, op, arg) => {
  if (op === 'copy-code' && state.code) Promise.resolve(clipboard.writeText(state.code.code)).catch(() => {});
  if (op === 'copy') stores.clipboard.copy(Number(arg));
  else if (op === 'clear') stores.clipboard.clear();
});

// ---------- start ----------

app.whenReady().then(() => {
  if (importPlainKeys()) applyConfig(loadConfig());
  syncHookScript();
  syncNotches();
  buildTray();
  applyLoginItem();
  trackHover();

  // Ctrl+Alt+Space holds the notch on the screen you're on open (and closes it again).
  if (process.env.APRON_SETTINGS) openSettings();
  // Ctrl+Alt+Space opens the launcher on the screen you're on (and closes it again).
  // If another app already owns it, fall back to the next free combo.
  for (const combo of ['Control+Alt+Space', 'Control+Shift+Space', 'Alt+Shift+Space']) {
    if (globalShortcut.register(combo, () => openLauncherOn(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id))) {
      launcherShortcut = combo.replace('Control', 'Ctrl');
      break;
    }
  }

  // Ctrl+Alt+M mutes / unmutes your mic from anywhere.
  for (const combo of ['Control+Alt+M', 'Alt+Shift+M']) {
    if (globalShortcut.register(combo, () => sources.media && sources.media.command('micmute'))) {
      micShortcut = combo.replace('Control', 'Ctrl');
      break;
    }
  }

  const lyricSource = lyrics.create((v) => update('lyrics', v));
  sources.media = media.start(
    (v) => {
      const prevKey = state.media ? `${state.media.title}|${state.media.artist}` : '';
      update('media', v);
      lyricSource.track(v);
      if (`${v.title}|${v.artist}` !== prevKey) setTimeout(refreshSpotify, 1500);
    },
    (fg) => {
      sources.lockdown.onForeground(fg);
      if (sources.screentime) sources.screentime.onForeground(fg);
    },
    (p) => update('privacy', config.privacyDots === false ? { mic: [], cam: [] } : p),
    (d) => {
      if ('phone' in d) {
        update('phone', d.phone);
        sendSettings();
      }
      if ('micMuted' in d) {
        const was = state.micMuted;
        update('micMuted', d.micMuted);
        if (was != null && d.micMuted != null && was !== d.micMuted) emit({ type: 'mic', muted: d.micMuted });
      }
    },
  );
  sources.lockdown = lockdown.create(config, sources.media, (label) => emit({ type: 'blocked', text: `${label} is blocked`, trail: 'FOCUS' }));
  sources.screentime = screentime.create(
    path.join(app.getPath('userData'), 'screentime.json'),
    {
      judge: (fg) => lockdown.judge(fg, lockdown.compile(config)),
      isBlocked: (label) => lockdown.compile(config).block.some((b) => b.label === label),
      idleSeconds: () => powerMonitor.getSystemIdleTime(),
    },
    (v) => update('screentime', v),
  );
  sources.ask = ask.create(getAi, (v) => update('ask', v));
  sources.sleep = {
    stop: clearInterval.bind(
      null,
      setInterval(() => {
        checkBedtime();
        checkClassMode();
        checkSummary();
        checkPlan();
        checkClassEnd();
      }, 30e3),
    ),
  };
  sources.sys = sysinfo.start((v) => update('sys', v));
  sources.spotify = spotify.create({
    clientId: () => config.spotifyClientId || '',
    loadRefresh: () => {
      try {
        return config.spotifyRefreshEnc ? safeStorage.decryptString(Buffer.from(config.spotifyRefreshEnc, 'base64')) : null;
      } catch {
        return null;
      }
    },
    saveRefresh: (tok) => setConfig({ spotifyRefreshEnc: tok ? safeStorage.encryptString(tok).toString('base64') : '' }),
    openUrl: (u) => shell.openExternal(u),
  });
  sources.voice = voice.create({
    onState: (v) => {
      update('voice', v);
      if (v.status === 'idle' && v.heard === false) emit({ type: 'info', text: "Didn't hear anything", trail: '🎙' });
      if (v.status === 'error') emit({ type: 'info', text: `Voice: ${v.error}`, trail: '!' });
      sendSettings();
    },
    onLevel: (level) => update('voiceLevel', level),
    onClip: (clip) => onClip(clip),
    logFile: path.join(app.getPath('userData'), 'voice.log'),
  });
  registerVoiceShortcut();
  loadFlashcards();
  refreshApps();
  loadStoreApps();
  sources.storeApps = { stop: clearInterval.bind(null, setInterval(loadStoreApps, 30 * 60e3)) };
  sources.cards = { stop: clearInterval.bind(null, setInterval(loadFlashcards, 30 * 60e3)) };
  sources.claude = claude.start(config.claudePort, (v) => update('claude', v), { approvals: () => config.claudeApprovals !== false });
  sources.notifications = notifications.start(config, (n) => {
    if (stores.inbox) stores.inbox.add(n);
    // Distracting apps stay quiet during a locked-down focus session.
    if (state.timer && state.timer.lockdown && lockdown.judge({ exe: 'chrome', title: n.name }, lockdown.compile(config))) return;
    // Class mode: only calls and one-time codes get through.
    if (state.classMode && (config.classMode || {}).quiet !== false && !n.call && !n.code) return;
    if (n.code) update('code', { code: n.code, from: n.name, at: Date.now() });
    emit({ type: 'notification', ...n });
  });

  const userData = app.getPath('userData');
  stores.todos = todoStore(path.join(userData, 'todos.json'), (v) => update('todos', v));
  stores.stats = statsStore(path.join(userData, 'stats.json'), (v) => update('stats', v));
  stores.plan = planner.store(path.join(userData, 'plan.json'), (v) => update('plan', v));
  stores.inbox = phone.inbox((v) => update('inbox', v));
  stores.shelf = shelfStore(path.join(userData, 'shelf.json'), (items) => publishShelf(items));
  stores.shots = screenshotWatcher(clipboard, (shot) => {
    if (config.screenshotPeek === false) return;
    update('shot', shot);
    emit({ type: 'shot' });
  });
  stores.timer = timerStore(
    path.join(userData, 'timer.json'),
    (v) => {
      update('timer', v);
      if (sources.lockdown) refreshLockdown();
    },
    (phase, ended, next) => {
      if (phase === 'focus') stores.stats.completeFocus(Math.round(ended.total / 60e3));
      if (next) emit({ type: 'phase', phase: next.phase, round: next.round, minutes: Math.round(next.total / 60e3) });
      else emit({ type: 'timer-done' });
    },
    () => ({ focus: 25, break: 5, long: 15, every: 4, ...(config.pomodoro || {}) }),
  );
  refreshLockdown();
  stores.clipboard = clipboardWatcher(
    clipboard,
    (v) => update('clipboard', v),
    async (c) => {
      if (config.clipboard !== false) emit({ type: 'copied', text: c.text, secret: c.secret });
      // Translate copied text that isn't English (or isn't your target language).
      if (config.translateCopies && !c.secret && c.full && c.full.length <= 1000 && translator.detect(c.full) !== 'en') {
        try {
          const r = await translator.translate(c.full, { cfg: getAi(), to: 'en' });
          emit({ type: 'translated', text: r.text, toName: r.toName });
        } catch {
          // quietly skip
        }
      }
    },
  );

  startSources();
  sources.updater = updater.start((v) => {
    update('update', v);
    rebuildTray();
    sendSettings();
  });
  watchConfig();
  screen.on('display-metrics-changed', syncNotches);
  screen.on('display-added', syncNotches);
  screen.on('display-removed', syncNotches);
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('before-quit', () => {
  for (const s of Object.values(sources)) if (s && s.stop) s.stop();
  for (const s of Object.values(stores)) if (s && s.stop) s.stop();
  if (stores.timer) stores.timer.stopTicking();
});
app.on('window-all-closed', () => {
  // Notches come and go with screens; only quit from the tray.
});
