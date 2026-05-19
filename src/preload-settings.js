const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mailappSettings', {
  load: () => ipcRenderer.invoke('settings:load'),
  loadAuthFromDrive: (drive) => ipcRenderer.invoke('settings:loadAuthFromDrive', drive),
  save: (data) => ipcRenderer.invoke('settings:save', data),
  checkUpdate: () => ipcRenderer.invoke('settings:checkUpdate'),
  installUpdate: () => ipcRenderer.invoke('settings:installUpdate'),
  openExternal: (url) => ipcRenderer.invoke('settings:openExternal', url),
  close: () => ipcRenderer.send('settings:close'),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update:downloaded', cb),
});
