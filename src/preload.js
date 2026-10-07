const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('island', {
  getState: () => ipcRenderer.invoke('island:state'),
  onUpdate: (cb) => ipcRenderer.on('island:update', (_e, { key, value }) => cb(key, value)),
  onHover: (cb) => ipcRenderer.on('island:hover', (_e, inside) => cb(inside)),
  reportRect: (r) => ipcRenderer.send('island:rect', r),
  media: (cmd) => ipcRenderer.send('island:media', cmd),
  open: (url) => ipcRenderer.send('island:open', url),
  openConfig: () => ipcRenderer.send('island:open-config'),
  setAccent: (hex) => ipcRenderer.send('island:accent', hex),
});
