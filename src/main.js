const { app, BrowserWindow, ipcMain, shell, Menu, Tray } = require('electron');
const { autoUpdater } = require('electron-updater');
const AutoLaunch = require('auto-launch');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Global settings — system-wide on Windows (all users), user-local elsewhere
const GLOBAL_SETTINGS_PATH = process.platform === 'win32'
  ? path.join('C:\\ProgramData', 'MailApp', 'settings.json')
  : path.join(os.homedir(), '.mailapp', 'settings.json');

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
  if (settings.authDrive) {
    return path.join(settings.authDrive + ':\\MailApp', 'auth.json');
  }
  return path.join(os.homedir(), '.mailapp', 'auth.json');
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
  // mail.ru login is served from id.vk.ru as a SPA.
  // Step 1: input#email (username without @domain) → button[type=submit]
  // Step 2 (SPA, no page reload): input[type=password] appears,
  //         OR a "Войти с паролем" button appears first (push-login default) — click it,
  //         then fill password → button[type=submit]
  return `
    (function() {
      const LOGIN = ${JSON.stringify(login)};
      const PASS  = ${JSON.stringify(password)};
      let state = 'idle'; // idle → filling_user → waiting_pass → done

      function setVal(el, val) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, val);
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }

      function tick() {
        if (state === 'done') return;

        // --- Step 2 (account.mail.ru/login?skip_first_step=1) ---
        // Password field is input[name="password"]; username already pre-filled via URL.
        const passInput = document.querySelector('input[name="password"], input[type="password"]');
        if (passInput && !passInput.dataset.mafilled) {
          setVal(passInput, PASS);
          passInput.dataset.mafilled = '1';
          state = 'done';
          setTimeout(() => {
            // Click the "Войти" submit (not the first submit which is "Все проекты")
            const btns = Array.from(document.querySelectorAll('button[type=submit]'));
            const loginBtn = btns.find(b => /войти/i.test(b.textContent)) || btns[btns.length - 1];
            if (loginBtn) loginBtn.click();
          }, 400);
          return;
        }

        // --- Step 1 (id.vk.ru) — fill email and click Next ---
        if (state === 'idle') {
          const emailInput = document.querySelector('input#email');
          if (emailInput && !emailInput.dataset.mafilled) {
            const MAIL_RU_DOMAINS = ['mail.ru','inbox.ru','list.ru','bk.ru'];
            const domain = LOGIN.includes('@') ? LOGIN.split('@')[1].toLowerCase() : '';
            const userPart = (!domain || MAIL_RU_DOMAINS.includes(domain))
              ? LOGIN.split('@')[0]
              : LOGIN;
            setVal(emailInput, userPart);
            emailInput.dataset.mafilled = '1';
            state = 'waiting_pass';
            setTimeout(() => {
              const btn = document.querySelector('button[type=submit]');
              if (btn) btn.click();
              else state = 'idle';
            }, 400);
          }

          // "Войти с паролем" button (push-login flow)
          const allBtns = Array.from(document.querySelectorAll('button, a'));
          const passBtn = allBtns.find(el =>
            /паролем|пароль/i.test(el.textContent) && !el.dataset.mafilled
          );
          if (passBtn) { passBtn.dataset.mafilled = '1'; passBtn.click(); }
        }

        setTimeout(tick, 700);
      }

      setTimeout(tick, 1200);
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
    const currentUrl = mainWindow.webContents.getURL();
    const isLoginPage = /id\.vk\.ru\/auth|account\.mail\.ru\/login/i.test(currentUrl);

    // Auto-login only on known login pages, never on security/settings pages
    if (isLoginPage) {
      const settings = readSettings();
      const auth = readAuth(settings);
      if (auth && auth.login && auth.password) {
        mainWindow.webContents.executeJavaScript(buildAutoLoginScript(auth.login, auth.password));
      }
    }

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
