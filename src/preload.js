const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__mailapp_ipc__', {
  openSettings: () => ipcRenderer.send('main:openSettings'),
  setUnread:    (count) => ipcRenderer.send('main:setUnread', count),
});

// Intercept web Notification API — forward to Electron system notifications
const OriginalNotification = Notification;

window.Notification = function(title, options = {}) {
  // Forward to main process for Electron notification
  ipcRenderer.send('main:notify', {
    title,
    body: options.body || '',
    icon: options.icon || '',
  });
  // Also create native notification so it works even without IPC
  try { return new OriginalNotification(title, options); } catch(e) {}
  const fake = Object.create(OriginalNotification.prototype);
  fake.addEventListener = () => {}; fake.close = () => {};
  return fake;
};
// Copy static props
Object.defineProperties(window.Notification, {
  permission:        { get: () => 'granted', configurable: true },
  requestPermission: { value: () => Promise.resolve('granted'), configurable: true },
  maxActions:        { get: () => OriginalNotification.maxActions, configurable: true },
});
