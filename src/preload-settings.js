const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mailappSettings', {
  getAppInfo:       ()      => ipcRenderer.invoke('settings:getAppInfo'),
  getDrives:        ()      => ipcRenderer.invoke('settings:getDrives'),
  load:             ()      => ipcRenderer.invoke('settings:load'),
  loadAuthFromDrive:(drive) => ipcRenderer.invoke('settings:loadAuthFromDrive', drive),
  save:             (data)  => ipcRenderer.invoke('settings:save', data),
  checkUpdate:          ()  => ipcRenderer.invoke('settings:checkUpdate'),
  downloadAndInstall:   ()  => ipcRenderer.invoke('settings:downloadAndInstall'),
  onUpdateProgress: (cb)    => ipcRenderer.on('update:progress', (_, pct) => cb(pct)),
  openExternal:     (url)   => ipcRenderer.invoke('settings:openExternal', url),
  close:            ()      => ipcRenderer.send('settings:close'),
  onUpdateDownloaded: (cb)  => ipcRenderer.on('update:downloaded', cb),
});
