const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('apron', {
  get: () => ipcRenderer.invoke('settings:get'),
  set: (patch) => ipcRenderer.invoke('settings:set', patch),
  action: (name) => ipcRenderer.invoke('settings:action', name),
  onChanged: (cb) => ipcRenderer.on('settings:changed', (_e, snap) => cb(snap)),
  searchApps: (q) => ipcRenderer.invoke('settings:search-apps', String(q)),
  pin: (path) => ipcRenderer.invoke('settings:pin', String(path)),
  wifi: () => ipcRenderer.invoke('settings:wifi'),
});
