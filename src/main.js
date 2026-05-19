const { app, BrowserWindow, ipcMain, shell, Menu, Tray } = require('electron');
const { autoUpdater } = require('electron-updater');
const AutoLaunch = require('auto-launch');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Global settings file — stored in system-wide location accessible by all users
const GLOBAL_SETTINGS_PATH = process.platform === 'win32'
  ? path.join('C:\\ProgramData', 'MailApp', 'settings.json')
  : path.join('/etc', 'mailapp', 'settings.json');

const autoLauncher = new AutoLaunch({ name: 'MailApp' });

let mainWindow;
let settingsWindow;
let tray;

// --- Settings helpers ---

function readSettings() {
  try {
    if (fs.existsSync(GLOBAL_SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(GLOBAL_SETTINGS_PATH, 'utf-8'));
    }
  } catch (e) {
    console.error('Failed to read settings:', e);
  }
  return {};
}

function writeSettings(data) {
  try {
    const dir = path.dirname(GLOBAL_SETTINGS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('Failed to write settings:', e);
    return false;
  }
}

// --- Auth data helpers ---

function getAuthFilePath(settings) {
  const base = settings.authDataPath || app.getPath('userData');
  return path.join(base, 'auth.json');
}

function readAuth(settings) {
  try {
    const p = getAuthFilePath(settings);
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    }
  } catch (e) {}
  return null;
}

function writeAuth(settings, data) {
  try {
    const p = getAuthFilePath(settings);
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('Failed to write auth:', e);
    return false;
  }
}

// --- Auto-login injection ---

function buildAutoLoginScript(login, password) {
  // Tries to detect the mail.ru login form and fill it automatically
  return `
    (function tryLogin() {
      const loginInput = document.querySelector('input[name="username"], input[type="email"], #mailbox\\\\:login');
      const passInput  = document.querySelector('input[name="password"], input[type="password"], #mailbox\\\\:password');
      const submitBtn  = document.querySelector('button[type="submit"], .o-control');

      if (loginInput && passInput && submitBtn) {
        if (!loginInput.value) {
          loginInput.value = ${JSON.stringify(login)};
          loginInput.dispatchEvent(new Event('input', { bubbles: true }));
          passInput.value = ${JSON.stringify(password)};
          passInput.dispatchEvent(new Event('input', { bubbles: true }));
          submitBtn.click();
        }
      } else {
        // Retry after a short delay if form not yet rendered
        setTimeout(tryLogin, 800);
      }
    })();
  `;
}

// --- Main window ---

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'MailApp',
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Allow mail.ru to work properly
      webSecurity: true,
      partition: 'persist:mailru',
    },
  });

  mainWindow.loadURL('https://e.mail.ru');
  mainWindow.setMenuBarVisibility(false);

  // Inject settings button overlay after page loads
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.executeJavaScript(`
      (function() {
        if (document.getElementById('__mailapp_settings_btn__')) return;
        const btn = document.createElement('button');
        btn.id = '__mailapp_settings_btn__';
        btn.innerHTML = '⚙';
        btn.title = 'Настройки MailApp';
        btn.style.cssText = [
          'position:fixed',
          'bottom:18px',
          'right:18px',
          'z-index:2147483647',
          'width:40px',
          'height:40px',
          'border-radius:50%',
          'background:rgba(30,30,30,0.75)',
          'color:#fff',
          'font-size:20px',
          'border:none',
          'cursor:pointer',
          'display:flex',
          'align-items:center',
          'justify-content:center',
          'box-shadow:0 2px 8px rgba(0,0,0,0.4)',
          'backdrop-filter:blur(4px)',
          'transition:background 0.2s',
        ].join(';');
        btn.addEventListener('mouseenter', () => btn.style.background = 'rgba(30,30,30,0.95)');
        btn.addEventListener('mouseleave', () => btn.style.background = 'rgba(30,30,30,0.75)');
        btn.addEventListener('click', () => {
          window.__mailapp_ipc__.openSettings();
        });
        document.body.appendChild(btn);
      })();
    `);

    // Auto-login if credentials are saved
    const settings = readSettings();
    const auth = readAuth(settings);
    if (auth && auth.login && auth.password) {
      mainWindow.webContents.executeJavaScript(buildAutoLoginScript(auth.login, auth.password));
    }
  });

  // Keep button alive on SPA navigation
  mainWindow.webContents.on('did-navigate-in-page', () => {
    mainWindow.webContents.executeJavaScript(`
      setTimeout(() => {
        if (!document.getElementById('__mailapp_settings_btn__')) {
          window.dispatchEvent(new Event('__mailapp_reinject__'));
        }
      }, 500);
    `);
  });
}

// --- Settings window ---

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 520,
    height: 560,
    resizable: false,
    title: 'Настройки MailApp',
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    parent: mainWindow,
    modal: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-settings.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
  settingsWindow.setMenuBarVisibility(false);
}

// --- IPC handlers ---

ipcMain.handle('settings:load', () => {
  const settings = readSettings();
  const auth = readAuth(settings);
  return {
    settings,
    auth: auth ? { login: auth.login, password: auth.password } : { login: '', password: '' },
  };
});

ipcMain.handle('settings:save', async (_, { settings, auth }) => {
  const oldSettings = readSettings();

  const settingsOk = writeSettings(settings);
  const authOk = writeAuth(settings, auth);

  // Apply auto-launch setting
  try {
    const enabled = await autoLauncher.isEnabled();
    if (settings.autoLaunch && !enabled) await autoLauncher.enable();
    if (!settings.autoLaunch && enabled) await autoLauncher.disable();
  } catch (e) {
    console.error('AutoLaunch error:', e);
  }

  return { ok: settingsOk && authOk };
});

ipcMain.handle('settings:checkUpdate', async () => {
  try {
    const result = await autoUpdater.checkForUpdates();
    return { available: !!result?.updateInfo, version: result?.updateInfo?.version };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('settings:installUpdate', () => {
  autoUpdater.downloadUpdate();
});

ipcMain.handle('settings:openExternal', (_, url) => {
  shell.openExternal(url);
});

ipcMain.on('settings:close', () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
});

ipcMain.on('main:openSettings', () => {
  openSettings();
});

// --- Auto-updater events ---

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('update-downloaded', () => {
  // Notify settings window if open
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('update:downloaded');
  }
});

autoUpdater.on('error', (err) => {
  console.error('Updater error:', err);
});

// --- App lifecycle ---

app.whenReady().then(() => {
  createMainWindow();

  // Check for updates silently on startup (only in packaged app)
  if (app.isPackaged) {
    autoUpdater.checkForUpdates().catch(() => {});
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
