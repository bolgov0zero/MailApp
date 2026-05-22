const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__mailapp_ipc__', {
  openSettings:  () => ipcRenderer.send('main:openSettings'),
  setUnread:     (count) => ipcRenderer.send('main:setUnread', count),
  manualLogout:  () => ipcRenderer.send('main:manualLogout'),
  openFile:      (path) => ipcRenderer.send('main:openFile', path),
});

