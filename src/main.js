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
const { pillPng } = require('./icon');
const updater = require('./updater');
const hooksInstall = require('./hooksInstall');
const { sanitize } = require('./settingsSchema');

const WIN_W = 640;
const WIN_H = 380;

let tray = null;
let settingsWin = null;
let config = loadConfig();
// What's currently in effect, so a config change (from Settings or the file) only
// restarts the parts that actually changed.
let applied = JSON.parse(JSON.stringify(config));

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
  voice: null, // { status }
  flashcards: { count: 0 },
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
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query });
  win.once('ready-to-show', () => {
    place(win, display);
    win.showInactive();
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

// ---------- voice ----------

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

// ---------- launcher ----------

let launcherShortcut = null;
function openLauncherOn(displayId) {
  const n = notches.get(displayId) || notches.values().next().value;
  if (!n || n.win.isDestroyed()) return;
  n.win.setFocusable(true);
  n.win.focus();
  n.win.webContents.send('island:toggle');
}

let launcherIndex = null;
let launcherBuiltAt = 0;
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
      if (hit) await shell.openPath(hit.path);
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
  if (changed('voice') && sources.voice) sources.voice.setEnabled(config.voice === true);
  if (changed('flashcardsFolder', 'notesFile')) loadFlashcards();
  if (changed('classMode')) checkClassMode();
  update('settings', settingsPayload());
  rebuildTray();
  sendSettings();
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
  tray = new Tray(nativeImage.createFromBuffer(pillPng(32), { scaleFactor: 2 }));
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
    icon: nativeImage.createFromBuffer(pillPng(64)),
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
ipcMain.handle('settings:set', (_e, patch) => {
  try {
    if (patch && typeof patch.aiKey === 'string') setKey('aiKeyEnc', patch.aiKey.slice(0, 300));
    if (patch && typeof patch.geminiKey === 'string') setKey('geminiKeyEnc', patch.geminiKey.slice(0, 300));
  } catch (err) {
    return { ok: false, error: err.message, ...settingsSnapshot() };
  }
  const clean = sanitize(patch);
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
  sources.voice = voice.create(onVoice, (v) => {
    update('voice', v);
    sendSettings();
  });
  sources.voice.setEnabled(config.voice === true);
  loadFlashcards();
  sources.cards = { stop: clearInterval.bind(null, setInterval(loadFlashcards, 30 * 60e3)) };
  sources.claude = claude.start(config.claudePort, (v) => update('claude', v), { approvals: () => config.claudeApprovals !== false });
  sources.notifications = notifications.start(config, (n) => {
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
