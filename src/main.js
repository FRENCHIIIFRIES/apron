const { app, BrowserWindow, ipcMain, screen, shell, Tray, Menu, nativeImage, globalShortcut, clipboard, safeStorage, powerMonitor } = require('electron');
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
const launcher = require('./launcher');
const { pillPng } = require('./icon');
const updater = require('./updater');
const hooksInstall = require('./hooksInstall');
const { sanitize } = require('./settingsSchema');

const WIN_W = 480;
const WIN_H = 320;

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
  const t = state.timer;
  // Lockdown runs during focus, not during Pomodoro breaks.
  sources.lockdown.setActive(Boolean(t && t.lockdown && (t.phase || 'focus') === 'focus'));
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

function getAiKey() {
  if (!config.aiKeyEnc) return '';
  try {
    return safeStorage.decryptString(Buffer.from(config.aiKeyEnc, 'base64'));
  } catch {
    return '';
  }
}

function setAiKey(key) {
  const k = String(key || '').trim();
  if (!k) return setConfig({ aiKeyEnc: '' });
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows encryption isn't available, so the key wasn't saved");
  setConfig({ aiKeyEnc: safeStorage.encryptString(k).toString('base64') });
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
  const { aiKeyEnc, ...safeConfig } = config;
  return {
    config: safeConfig,
    hasAiKey: Boolean(aiKeyEnc),
    launcherShortcut,
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
    timer = setTimeout(() => applyConfig(loadConfig()), 300);
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
  if (patch && typeof patch.aiKey === 'string') {
    try {
      setAiKey(patch.aiKey.slice(0, 300));
    } catch (err) {
      return { ok: false, error: err.message, ...settingsSnapshot() };
    }
  }
  const clean = sanitize(patch);
  if (Object.keys(clean).length) setConfig(clean);
  return settingsSnapshot();
});
ipcMain.handle('settings:action', (_e, action) => {
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
  } else if (action === 'quit') app.quit();
  return { ok: true, ...settingsSnapshot() };
});

ipcMain.on('island:clipboard', (_e, op, arg) => {
  if (op === 'copy-code' && state.code) Promise.resolve(clipboard.writeText(state.code.code)).catch(() => {});
  if (op === 'copy') stores.clipboard.copy(Number(arg));
  else if (op === 'clear') stores.clipboard.clear();
});

// ---------- start ----------

app.whenReady().then(() => {
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
      update('media', v);
      lyricSource.track(v);
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
  sources.ask = ask.create(getAiKey, (v) => update('ask', v));
  sources.sleep = { stop: clearInterval.bind(null, setInterval(checkBedtime, 30e3)) };
  sources.claude = claude.start(config.claudePort, (v) => update('claude', v), { approvals: () => config.claudeApprovals !== false });
  sources.notifications = notifications.start(config, (n) => {
    // Distracting apps stay quiet during a locked-down focus session.
    if (state.timer && state.timer.lockdown && lockdown.judge({ exe: 'chrome', title: n.name }, lockdown.compile(config))) return;
    if (n.code) update('code', { code: n.code, from: n.name, at: Date.now() });
    emit({ type: 'notification', ...n });
  });

  const userData = app.getPath('userData');
  stores.todos = todoStore(path.join(userData, 'todos.json'), (v) => update('todos', v));
  stores.stats = statsStore(path.join(userData, 'stats.json'), (v) => update('stats', v));
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
    (c) => config.clipboard !== false && emit({ type: 'copied', ...c }),
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
