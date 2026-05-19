const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__mailapp_ipc__', {
  openSettings: () => ipcRenderer.send('main:openSettings'),
  setUnread:    (count) => ipcRenderer.send('main:setUnread', count),
});

// Intercept web Notification API — forward to system notifications via main process
const OriginalNotification = Notification;

// Override window.Notification so mail.ru's push notifications become system ones
window.Notification = function(title, options = {}) {
  ipcRenderer.send('main:notify', {
    title,
    body: options.body || '',
    icon: options.icon || '',
  });
  // Still return a fake object so mail.ru doesn't crash
  const fake = Object.create(OriginalNotification.prototype);
  fake.addEventListener = () => {};
  fake.close = () => {};
  return fake;
};
window.Notification.permission = 'granted';
window.Notification.requestPermission = () => Promise.resolve('granted');
