const { app, BrowserWindow, ipcMain, shell, Notification, nativeImage, safeStorage } = require('electron');
const { autoUpdater } = require('electron-updater');
const AutoLaunch = require('auto-launch');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');

// Global settings — system-wide on Windows (all users), user-local elsewhere
const GLOBAL_SETTINGS_PATH = process.platform === 'win32'
  ? path.join('C:\\ProgramData', 'MailApp', 'settings.json')
  : path.join(os.homedir(), '.mailapp', 'settings.json');

const autoLauncher = new AutoLaunch({ name: 'MailApp' });

let mainWindow;
let settingsWindow;

// --- Settings helpers ---

function readSettings() {
  try {
    if (fs.existsSync(GLOBAL_SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(GLOBAL_SETTINGS_PATH, 'utf-8'));
    }
  } catch (e) {}
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

// --- Auth helpers (safeStorage encryption) ---

// --- Auth helpers ---
// File name = username part of email (before @), e.g. reg@nebolit.ru → reg.json
// Location: {drive}:\MailApp\reg.json  or  ~/.mailapp/reg.json

function getAuthDir(drive) {
  if (drive) return path.join(drive + ':\\MailApp');
  return path.join(os.homedir(), '.mailapp');
}

function loginToFilename(login) {
  const user = login && login.includes('@') ? login.split('@')[0] : (login || 'default');
  // Sanitize: only keep safe filename chars
  return user.replace(/[^a-zA-Z0-9._-]/g, '_') + '.json';
}

function getAuthFilePath(drive, login) {
  return path.join(getAuthDir(drive), loginToFilename(login));
}

// List all auth files in a directory → [{ filename, login, hasPassword }]
function listAuthFiles(drive) {
  const dir = getAuthDir(drive);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const auth = readAuthFromFile(path.join(dir, f));
      return { filename: f, login: auth?.login || f.replace('.json', ''), hasPassword: !!auth?.password };
    });
}

function readAuthFromFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath);
    if (safeStorage.isEncryptionAvailable() && raw[0] === 0x01) {
      return JSON.parse(safeStorage.decryptString(raw.slice(1)));
    }
    return JSON.parse(raw.toString('utf-8'));
  } catch (e) {
    return null;
  }
}

function readAuth(drive, login) {
  if (!login) {
    // No login specified — try auto-detect: if exactly one file exists, use it
    const files = listAuthFiles(drive);
    if (files.length === 1) {
      return readAuthFromFile(path.join(getAuthDir(drive), files[0].filename));
    }
    return null;
  }
  return readAuthFromFile(getAuthFilePath(drive, login));
}

function writeAuth(drive, data) {
  try {
    const p = getAuthFilePath(drive, data.login);
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const json = JSON.stringify(data);
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(json);
      fs.writeFileSync(p, Buffer.concat([Buffer.from([0x01]), encrypted]));
    } else {
      fs.writeFileSync(p, json, 'utf-8');
    }
    return true;
  } catch (e) {
    console.error('Failed to write auth:', e);
    return false;
  }
}

// --- Taskbar badge (unread count overlay icon) ---
// Pure-JS 16x16 PNG — red circle, no native dependencies

function makePng(width, height, pixels) {
  // pixels: Uint8Array of RGBA values, row by row top-to-bottom
  function crc32(buf) {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c;
    }
    let crc = 0xFFFFFFFF;
    for (const b of buf) crc = table[(crc ^ b) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function chunk(type, data) {
    const t = Buffer.from(type);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crcBuf = Buffer.concat([t, data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc32(crcBuf));
    return Buffer.concat([len, t, data, c]);
  }
  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  // IDAT: filter byte 0 before each row
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    for (let x = 0; x < width; x++) {
      const si = (y * width + x) * 4;
      const di = y * (1 + width * 4) + 1 + x * 4;
      raw[di]   = pixels[si];
      raw[di+1] = pixels[si+1];
      raw[di+2] = pixels[si+2];
      raw[di+3] = pixels[si+3];
    }
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function makeBadgeIcon(count) {
  const S = 16;
  const cx = S / 2, cy = S / 2, r = S / 2 - 0.5;
  const pixels = new Uint8Array(S * S * 4);

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const dist = Math.sqrt(dx*dx + dy*dy);
      const i = (y * S + x) * 4;
      if (dist <= r) {
        // Red circle
        pixels[i] = 229; pixels[i+1] = 57; pixels[i+2] = 53; pixels[i+3] = 255;
      }
      // else transparent
    }
  }

  // Draw digit pixels manually for single digits (simple 3x5 font)
  const GLYPHS = {
    '0':[[1,1,1],[1,0,1],[1,0,1],[1,0,1],[1,1,1]],
    '1':[[0,1,0],[1,1,0],[0,1,0],[0,1,0],[1,1,1]],
    '2':[[1,1,1],[0,0,1],[0,1,0],[1,0,0],[1,1,1]],
    '3':[[1,1,1],[0,0,1],[0,1,1],[0,0,1],[1,1,1]],
    '4':[[1,0,1],[1,0,1],[1,1,1],[0,0,1],[0,0,1]],
    '5':[[1,1,1],[1,0,0],[1,1,1],[0,0,1],[1,1,1]],
    '6':[[1,1,1],[1,0,0],[1,1,1],[1,0,1],[1,1,1]],
    '7':[[1,1,1],[0,0,1],[0,1,0],[0,1,0],[0,1,0]],
    '8':[[1,1,1],[1,0,1],[1,1,1],[1,0,1],[1,1,1]],
    '9':[[1,1,1],[1,0,1],[1,1,1],[0,0,1],[1,1,1]],
    '+':[[0,0,0],[0,1,0],[1,1,1],[0,1,0],[0,0,0]],
  };

  const label = count > 99 ? '99+' : String(count);
  const charW = 3, charH = 5, gap = 1;
  const totalW = label.length * charW + (label.length - 1) * gap;
  let ox = Math.floor((S - totalW) / 2);
  const oy = Math.floor((S - charH) / 2);

  for (const ch of label) {
    const glyph = GLYPHS[ch] || GLYPHS['0'];
    for (let row = 0; row < charH; row++) {
      for (let col = 0; col < charW; col++) {
        if (glyph[row][col]) {
          const px = ox + col, py = oy + row;
          if (px >= 0 && px < S && py >= 0 && py < S) {
            const i = (py * S + px) * 4;
            pixels[i] = 255; pixels[i+1] = 255; pixels[i+2] = 255; pixels[i+3] = 255;
          }
        }
      }
    }
    ox += charW + gap;
  }

  return nativeImage.createFromBuffer(makePng(S, S, pixels));
}

function setUnreadBadge(count) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (count > 0) {
    mainWindow.setOverlayIcon(makeBadgeIcon(count), `${count} непрочитанных`);
  } else {
    mainWindow.setOverlayIcon(null, '');
  }
}

// --- Auto-login injection ---

function buildAutoLoginScript(login, password) {
  return `
    (function() {
      const LOGIN = ${JSON.stringify(login)};
      const PASS  = ${JSON.stringify(password)};
      let state = 'idle';

      function setVal(el, val) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, val);
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }

      function tick() {
        if (state === 'done') return;

        const passInput = document.querySelector('input[name="password"], input[type="password"]');
        if (passInput && !passInput.dataset.mafilled) {
          setVal(passInput, PASS);
          passInput.dataset.mafilled = '1';
          state = 'done';
          setTimeout(() => {
            const btns = Array.from(document.querySelectorAll('button[type=submit]'));
            const loginBtn = btns.find(b => /войти/i.test(b.textContent)) || btns[btns.length - 1];
            if (loginBtn) loginBtn.click();
          }, 400);
          return;
        }

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

// --- Unread count poller (injected into mail page) ---

const UNREAD_POLLER = `
  (function() {
    if (window.__mailapp_poller__) return;
    window.__mailapp_poller__ = true;

    function getCount() {
      // mail.ru shows unread count in page title like "(5) Входящие" or in a badge element
      const titleMatch = document.title.match(/\\((\\d+)\\)/);
      if (titleMatch) return parseInt(titleMatch[1], 10);

      // Try badge/counter elements used by mail.ru
      const badge = document.querySelector(
        '[class*="unread"],[class*="counter"],[class*="badge"],[class*="Count"]'
      );
      if (badge) {
        const n = parseInt(badge.textContent.trim(), 10);
        if (!isNaN(n)) return n;
      }
      return 0;
    }

    let last = -1;
    setInterval(() => {
      const count = getCount();
      if (count !== last) {
        last = count;
        window.__mailapp_ipc__.setUnread(count);
      }
    }, 3000);
  })();
`;

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
      webSecurity: true,
      partition: 'persist:mailru',
    },
  });

  mainWindow.loadURL('https://e.mail.ru');
  mainWindow.setMenuBarVisibility(false);

  // Allow mail.ru to show notifications via Electron's system notifications
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'notifications') {
      callback(true); // grant, but we intercept in preload
    } else {
      callback(true);
    }
  });

  mainWindow.webContents.on('did-finish-load', () => {
    const currentUrl = mainWindow.webContents.getURL();
    const isLoginPage = /id\.vk\.ru\/auth|account\.mail\.ru\/login/i.test(currentUrl);
    const isMailPage  = /e\.mail\.ru/i.test(currentUrl) && !isLoginPage;

    if (isLoginPage) {
      const settings = readSettings();
      const auth = readAuth(settings.authDrive || null, settings.authLogin || null);
      if (auth && auth.login && auth.password) {
        mainWindow.webContents.executeJavaScript(buildAutoLoginScript(auth.login, auth.password));
      }
    }

    if (isMailPage) {
      mainWindow.webContents.executeJavaScript(UNREAD_POLLER);
    }

    // Settings button overlay
    mainWindow.webContents.executeJavaScript(`
      (function() {
        if (document.getElementById('__mailapp_settings_btn__')) return;
        const btn = document.createElement('button');
        btn.id = '__mailapp_settings_btn__';
        btn.innerHTML = '⚙';
        btn.title = 'Настройки MailApp';
        btn.style.cssText = [
          'position:fixed','bottom:18px','right:18px','z-index:2147483647',
          'width:40px','height:40px','border-radius:50%',
          'background:rgba(30,30,30,0.75)','color:#fff','font-size:20px',
          'border:none','cursor:pointer','display:flex',
          'align-items:center','justify-content:center',
          'box-shadow:0 2px 8px rgba(0,0,0,0.4)',
          'backdrop-filter:blur(4px)','transition:background 0.2s',
        ].join(';');
        btn.addEventListener('mouseenter', () => btn.style.background = 'rgba(30,30,30,0.95)');
        btn.addEventListener('mouseleave', () => btn.style.background = 'rgba(30,30,30,0.75)');
        btn.addEventListener('click', () => window.__mailapp_ipc__.openSettings());
        document.body.appendChild(btn);
      })();
    `);
  });

  mainWindow.webContents.on('did-navigate-in-page', () => {
    const currentUrl = mainWindow.webContents.getURL();
    if (/e\.mail\.ru/i.test(currentUrl)) {
      mainWindow.webContents.executeJavaScript(UNREAD_POLLER);
    }
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

ipcMain.handle('settings:getAppInfo', () => {
  return { version: app.getVersion() };
});

// Returns drive letters that actually exist on this Windows machine
ipcMain.handle('settings:getDrives', () => {
  if (process.platform !== 'win32') {
    // On non-Windows return fake drives for dev/testing
    return ['C', 'D'];
  }
  const { execSync } = require('child_process');
  try {
    // wmic logicaldisk get name returns lines like "C:\n", "D:\n" etc.
    const out = execSync('wmic logicaldisk get name', { encoding: 'utf8', timeout: 3000 });
    return out.split('\n')
      .map(l => l.trim().replace(':', ''))
      .filter(l => /^[A-Z]$/i.test(l))
      .map(l => l.toUpperCase());
  } catch (e) {
    return [];
  }
});

// List auth files on a drive → [{filename, login, hasPassword}]
ipcMain.handle('settings:listAuthFiles', (_, drive) => {
  return listAuthFiles(drive || null);
});

// Load one auth file by login name
ipcMain.handle('settings:loadAuthByLogin', (_, { drive, login }) => {
  const auth = readAuth(drive || null, login || null);
  return auth ? { login: auth.login, password: auth.password } : { login: '', password: '' };
});

ipcMain.handle('settings:load', () => {
  const settings = readSettings();
  // Auto-load: use saved authLogin, or auto-detect if only one file
  const auth = readAuth(settings.authDrive || null, settings.authLogin || null);
  return {
    settings,
    auth: auth ? { login: auth.login, password: auth.password } : { login: '', password: '' },
  };
});

ipcMain.handle('settings:save', async (_, { settings, auth }) => {
  const settingsOk = writeSettings({
    ...settings,
    // Remember which login was last selected
    authLogin: auth.login || '',
  });
  const authOk = auth.login ? writeAuth(settings.authDrive || null, auth) : true;
  try {
    const enabled = await autoLauncher.isEnabled();
    if (settings.autoLaunch && !enabled) await autoLauncher.enable();
    if (!settings.autoLaunch && enabled) await autoLauncher.disable();
  } catch (e) {}
  return { ok: settingsOk && authOk };
});

ipcMain.handle('settings:checkUpdate', async () => {
  try {
    const result = await autoUpdater.checkForUpdates();
    const latest = result?.updateInfo?.version;
    const current = app.getVersion();
    const available = !!latest && latest !== current;
    return { available, version: latest };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('settings:openExternal', (_, url) => { shell.openExternal(url); });
ipcMain.on('settings:close', () => { if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close(); });
ipcMain.on('main:openSettings', () => { openSettings(); });

// Unread badge from renderer
ipcMain.on('main:setUnread', (_, count) => { setUnreadBadge(count); });

// System notification forwarded from renderer (intercept mail.ru web notifications)
ipcMain.on('main:notify', (_, { title, body, icon }) => {
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: title || 'MailApp',
    body: body || '',
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
  });
  n.on('click', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
  n.show();
});

// --- Auto-updater ---

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

autoUpdater.on('download-progress', (progress) => {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('update:progress', Math.floor(progress.percent));
  }
});

autoUpdater.on('update-downloaded', () => {
  // Silent install + relaunch immediately after download
  autoUpdater.quitAndInstall(true, true);
});

ipcMain.handle('settings:downloadAndInstall', () => {
  autoUpdater.downloadUpdate();
});

// --- App lifecycle ---

app.whenReady().then(() => {
  createMainWindow();
  if (app.isPackaged) autoUpdater.checkForUpdates().catch(() => {});
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
