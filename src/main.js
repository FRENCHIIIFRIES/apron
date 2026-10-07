const { app, BrowserWindow, ipcMain, screen, shell, Tray, Menu, nativeImage, globalShortcut, clipboard } = require('electron');
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
const { todoStore, timerStore, clipboardWatcher } = require('./stores');
const { pillPng } = require('./icon');
const updater = require('./updater');

const WIN_W = 480;
const WIN_H = 320;

let tray = null;
let config = loadConfig();

function settingsPayload() {
  return {
    accent: config.accent,
    artColor: Boolean(config.artColor),
    lockdownSites: lockdown.compile(config).block.map((b) => b.label),
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
  sources.github = github.start(config, (v) => update('github', v));
  sources.weather = weather.start(config, (v) => update('weather', v));
}

function stopSources() {
  for (const key of ['calendar', 'github', 'weather']) if (sources[key]) sources[key].stop();
}

function refreshLockdown() {
  const t = state.timer;
  sources.lockdown.setActive(Boolean(t && t.lockdown));
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
  Object.assign(config, patch);
  saveConfig(patch);
  update('settings', settingsPayload());
  rebuildTray();
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
        click: (i) => {
          setConfig({ displays: i.checked ? 'all' : 'primary' });
          syncNotches();
        },
      },
      { label: 'Phone & app notifications', type: 'checkbox', checked: config.notifications !== false, click: (i) => setConfig({ notifications: i.checked }) },
      { label: 'Clipboard peeks', type: 'checkbox', checked: config.clipboard !== false, click: (i) => setConfig({ clipboard: i.checked }) },
      { label: 'Open config', click: () => shell.openPath(CONFIG_PATH) },
      {
        label: 'Start with Windows',
        type: 'checkbox',
        checked: Boolean(config.startWithWindows),
        click: (i) => {
          setConfig({ startWithWindows: i.checked });
          applyLoginItem();
        },
      },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
}

function buildTray() {
  tray = new Tray(nativeImage.createFromBuffer(pillPng(32), { scaleFactor: 2 }));
  tray.setToolTip('Apron');
  rebuildTray();
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

function watchConfig() {
  let timer = null;
  fs.watchFile(CONFIG_PATH, { interval: 1000 }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const prev = config;
      config = loadConfig();
      // Only refetch when a source setting changed (not for e.g. an accent change).
      const sourceKeys = ['icalUrls', 'calendarRefreshMinutes', 'githubRefreshSeconds', 'weatherCity'];
      if (sourceKeys.some((k) => JSON.stringify(prev[k]) !== JSON.stringify(config[k]))) {
        stopSources();
        startSources();
      }
      sources.lockdown.setConfig(config);
      update('settings', settingsPayload());
      if (prev.startWithWindows !== config.startWithWindows) applyLoginItem();
      rebuildTray();
      syncNotches();
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
  if (op === 'start') t.start(arg && arg.minutes, arg && arg.lockdown);
  else if (op === 'add') t.add(Number(arg) || 1);
  else if (op === 'lockdown') t.setLockdown(arg === true);
  else if (op === 'stop') t.stop();
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
  globalShortcut.register('Control+Alt+Space', () => {
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const n = notches.get(d.id) || notches.values().next().value;
    if (n && !n.win.isDestroyed()) n.win.webContents.send('island:toggle');
  });

  const lyricSource = lyrics.create((v) => update('lyrics', v));
  sources.media = media.start(
    (v) => {
      update('media', v);
      lyricSource.track(v);
    },
    (fg) => sources.lockdown.onForeground(fg),
  );
  sources.lockdown = lockdown.create(config, sources.media, (label) => emit({ type: 'blocked', text: `${label} is blocked`, trail: 'FOCUS' }));
  sources.claude = claude.start(config.claudePort, (v) => update('claude', v));
  sources.notifications = notifications.start(config, (n) => {
    // Distracting apps stay quiet during a locked-down focus session.
    if (state.timer && state.timer.lockdown && lockdown.judge({ exe: 'chrome', title: n.name }, lockdown.compile(config))) return;
    if (n.code) update('code', { code: n.code, from: n.name, at: Date.now() });
    emit({ type: 'notification', ...n });
  });

  const userData = app.getPath('userData');
  stores.todos = todoStore(path.join(userData, 'todos.json'), (v) => update('todos', v));
  stores.timer = timerStore(
    path.join(userData, 'timer.json'),
    (v) => {
      update('timer', v);
      if (sources.lockdown) refreshLockdown();
    },
    () => emit({ type: 'timer-done' }),
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
