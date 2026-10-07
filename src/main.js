const { app, BrowserWindow, ipcMain, screen, shell, Tray, Menu, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { loadConfig, saveConfig, CONFIG_PATH, HEX } = require('./config');
const calendar = require('./calendar');
const media = require('./media');
const claude = require('./claude');
const github = require('./github');
const { pillPng } = require('./icon');

const WIN_W = 480;
const WIN_H = 320;

let win = null;
let tray = null;
let config = loadConfig();
const state = { calendar: null, media: null, claude: [], github: null, settings: { accent: config.accent } };

const ACCENTS = [
  ['Nothing red', '#d71921'],
  ['White', '#ffffff'],
  ['Yellow', '#ffc700'],
  ['Green', '#3ddc84'],
  ['Blue', '#2f6bff'],
  ['Pink', '#ff5fa2'],
];
const sources = {};

if (!app.requestSingleInstanceLock()) app.exit(0);

function update(key, value) {
  state[key] = value;
  if (win && !win.isDestroyed()) win.webContents.send('island:update', { key, value });
}

function place() {
  const displays = screen.getAllDisplays();
  const d = typeof config.display === 'number' && displays[config.display] ? displays[config.display] : screen.getPrimaryDisplay();
  const { x, y, width } = d.bounds;
  win.setBounds({ x: Math.round(x + (width - WIN_W) / 2), y: y + config.offsetY, width: WIN_W, height: WIN_H });
}

function createWindow() {
  win = new BrowserWindow({
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
  // ISLAND_EXPAND=media|calendar|claude pins the island open on that tab (for screenshots/debugging).
  const query = process.env.ISLAND_EXPAND ? { expand: process.env.ISLAND_EXPAND } : {};
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query });
  win.once('ready-to-show', () => {
    place();
    win.showInactive();
  });
  // Clicking the taskbar can knock us below it; quietly reassert.
  setInterval(() => win && !win.isDestroyed() && win.setAlwaysOnTop(true, 'screen-saver'), 10e3);
}

function startSources() {
  sources.calendar = calendar.start(config, (v) => update('calendar', v));
  sources.github = github.start(config, (v) => update('github', v));
}

function stopSources() {
  for (const key of ['calendar', 'github']) if (sources[key]) sources[key].stop();
}

function loginItemOptions() {
  // In dev we run electron.exe with the app folder as an argument.
  const base = { name: 'Island' };
  return app.isPackaged ? base : { ...base, path: process.execPath, args: [app.getAppPath()] };
}

function applyLoginItem() {
  app.setLoginItemSettings({ ...loginItemOptions(), openAtLogin: Boolean(config.startWithWindows) });
}

function setAccent(hex) {
  if (!HEX.test(hex)) return;
  config.accent = hex.toLowerCase();
  saveConfig({ accent: config.accent });
  update('settings', { accent: config.accent });
  rebuildTray();
}

function rebuildTray() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Refresh', click: () => Object.values(sources).forEach((s) => s.refresh && s.refresh()) },
      {
        label: 'Accent colour',
        submenu: ACCENTS.map(([label, hex]) => ({
          label,
          type: 'radio',
          checked: config.accent === hex,
          click: () => setAccent(hex),
        })),
      },
      { label: 'Open config', click: () => shell.openPath(CONFIG_PATH) },
      {
        label: 'Start with Windows',
        type: 'checkbox',
        checked: Boolean(config.startWithWindows),
        click: (item) => {
          config.startWithWindows = item.checked;
          saveConfig({ startWithWindows: item.checked });
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
  tray.setToolTip('Island');
  rebuildTray();
}

function watchConfig() {
  let timer = null;
  fs.watchFile(CONFIG_PATH, { interval: 1000 }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const prev = config;
      config = loadConfig();
      // Only refetch when a source setting changed (not for e.g. an accent change).
      const sourceKeys = ['icalUrls', 'calendarRefreshMinutes', 'githubRefreshSeconds'];
      if (sourceKeys.some((k) => JSON.stringify(prev[k]) !== JSON.stringify(config[k]))) {
        stopSources();
        startSources();
      }
      if (prev.accent !== config.accent) update('settings', { accent: config.accent });
      if (prev.startWithWindows !== config.startWithWindows) applyLoginItem();
      rebuildTray();
      place();
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

ipcMain.handle('island:state', () => state);
// The renderer tells us where the pill is; we poll the cursor ourselves because
// mouseleave doesn't fire reliably on a non-focusable, click-through window.
let pillRect = null;
let hovering = false;
ipcMain.on('island:rect', (_e, r) => {
  pillRect = r;
});

function trackHover() {
  setInterval(() => {
    if (!win || win.isDestroyed() || !pillRect) return;
    const p = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const x = p.x - b.x;
    const y = p.y - b.y;
    const inside = x >= pillRect.x && x <= pillRect.x + pillRect.w && y >= pillRect.y - 4 && y <= pillRect.y + pillRect.h;
    if (inside === hovering) return;
    hovering = inside;
    win.setIgnoreMouseEvents(!inside, { forward: true });
    win.webContents.send('island:hover', inside);
  }, 80);
}
ipcMain.on('island:media', (_e, cmd) => sources.media && sources.media.command(cmd));
ipcMain.on('island:open', (_e, url) => isSafeUrl(url) && shell.openExternal(url));
ipcMain.on('island:open-config', () => shell.openPath(CONFIG_PATH));
ipcMain.on('island:accent', (_e, hex) => setAccent(String(hex)));

app.whenReady().then(() => {
  createWindow();
  buildTray();
  applyLoginItem();
  trackHover();
  sources.media = media.start((v) => update('media', v));
  sources.claude = claude.start(config.claudePort, (v) => update('claude', v));
  startSources();
  watchConfig();
  screen.on('display-metrics-changed', place);
  screen.on('display-added', place);
  screen.on('display-removed', place);
});

app.on('before-quit', () => {
  for (const s of Object.values(sources)) s.stop();
});
app.on('window-all-closed', () => app.quit());
