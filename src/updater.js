// Auto-update from GitHub Releases (FRENCHIIIFRIES/apron) via electron-updater.
// New versions download in the background; they install on the next restart,
// or straight away from "Restart to update".
const { app } = require('electron');

const CHECK_EVERY = 4 * 3600e3;

function start(onUpdate) {
  let status = { status: app.isPackaged ? 'idle' : 'dev', version: app.getVersion() };
  const set = (patch) => {
    status = { ...status, ...patch };
    onUpdate(status);
  };
  onUpdate(status);
  if (!app.isPackaged) return { check() {}, install() {}, stop() {}, status: () => status };

  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: null }));
  autoUpdater.on('update-available', (info) => set({ status: 'downloading', next: info.version, percent: 0 }));
  autoUpdater.on('update-not-available', () => set({ status: 'current', checkedAt: Date.now() }));
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', next: info.version }));
  autoUpdater.on('error', (err) => set({ status: 'error', error: String(err.message || err).split('\n')[0] }));

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  const first = setTimeout(check, 15e3);
  const timer = setInterval(check, CHECK_EVERY);
  return {
    check,
    install: () => autoUpdater.quitAndInstall(true, true),
    stop() {
      clearTimeout(first);
      clearInterval(timer);
    },
    status: () => status,
  };
}

module.exports = { start };
