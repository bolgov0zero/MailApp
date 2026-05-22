const { app, BrowserWindow, ipcMain, shell, Notification, nativeImage, safeStorage } = require('electron');
const crypto = require('crypto');
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

// --- Auth helpers ---

// AES-256-GCM key — cross-machine symmetric encryption (magic byte 0x02)
// Format: [0x02][12b IV][16b authTag][ciphertext]
const AES_KEY = crypto.scryptSync('MailApp-Nebolit-2026', 'mailapp-salt-v1', 32);
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

function aesEncrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', AES_KEY, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([0x02]), iv, tag, enc]);
}

function aesDecrypt(buf) {
  const iv  = buf.slice(1, 13);
  const tag = buf.slice(13, 29);
  const enc = buf.slice(29);
  const decipher = crypto.createDecipheriv('aes-256-gcm', AES_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf-8');
}

function readAuthFromFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath);
    if (raw[0] === 0x02) {
      return JSON.parse(aesDecrypt(raw));
    }
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
    fs.writeFileSync(p, aesEncrypt(json));
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

// --- App icon as base64 (for injection into web pages) ---
const APP_ICON_B64 = (() => {
  try {
    const p = path.join(__dirname, '..', 'icon.png');
    return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
  } catch { return ''; }
})();

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

  // Task 1: cancel "download" files with no extension (technical redirects, not real attachments)
  // Task 2: after real download completes, offer to open the file
  mainWindow.webContents.session.on('will-download', (event, item) => {
    const name = item.getFilename() || '';
    const hasExt = path.extname(name).length > 0;
    if (!hasExt && (name === '' || name === 'download')) {
      event.preventDefault();
      return;
    }
    item.on('done', (e, state) => {
      if (state !== 'completed') return;
      const filePath = item.getSavePath();
      const { dialog } = require('electron');
      const safeFilePath = JSON.stringify(filePath);
      const safeName     = JSON.stringify(name);
      mainWindow.webContents.executeJavaScript(`
        (function() {
          if (document.getElementById('__mailapp_dl_toast__')) document.getElementById('__mailapp_dl_toast__').remove();
          const toast = document.createElement('div');
          toast.id = '__mailapp_dl_toast__';
          toast.style.cssText = 'position:fixed;bottom:80px;right:20px;z-index:2147483647;background:#fff;border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,0.18);padding:16px 20px;display:flex;align-items:center;gap:14px;min-width:280px;max-width:360px;animation:__ma_slide__ 0.3s ease';
          toast.innerHTML = \`
            <style>@keyframes __ma_slide__{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}</style>
            <div style="width:40px;height:40px;border-radius:10px;background:#f0f1fb;display:flex;align-items:center;justify-content:center;flex-shrink:0">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#5c6bc0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            </div>
            <div style="flex:1;overflow:hidden">
              <div style="font-size:13px;font-weight:600;color:#1a1a2e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">\${${safeName}}</div>
              <div style="font-size:11px;color:#9999bb;margin-top:2px">Загрузка завершена</div>
            </div>
            <div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0">
              <button id="__mailapp_dl_open__" style="padding:6px 14px;border:none;border-radius:8px;background:#5c6bc0;color:#fff;font-size:12px;font-weight:600;cursor:pointer">Открыть</button>
              <button id="__mailapp_dl_close__" style="padding:6px 14px;border:none;border-radius:8px;background:#f0f1fb;color:#9999bb;font-size:12px;font-weight:600;cursor:pointer">Закрыть</button>
            </div>
          \`;
          document.body.appendChild(toast);
          document.getElementById('__mailapp_dl_open__').onclick  = () => { window.__mailapp_ipc__.openFile(${safeFilePath}); toast.remove(); };
          document.getElementById('__mailapp_dl_close__').onclick = () => toast.remove();
          setTimeout(() => { if (toast.parentNode) toast.remove(); }, 8000);
        })();
      `).catch(() => {});
    });
  });

  // Grant notification + push permissions (needed for service worker push)
  const ses = mainWindow.webContents.session;
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    callback(true);
  });
  ses.setPermissionCheckHandler((wc, permission) => {
    return true;
  });

  // Intercept logout at the network level — fires before any navigation
  ses.webRequest.onBeforeRequest(
    { urls: ['*://account.mail.ru/user/logout*', '*://account.mail.ru/logout*', '*://auth.mail.ru/cgi-bin/logout*', '*://id.vk.ru/logout*'] },
    (details, callback) => {
      writeSettings({ ...readSettings(), manualLogout: true });
      callback({});
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL('https://e.mail.ru');
      }, 500);
    }
  );

  // Task 3: retry on white screen (did-fail-load)
  let failRetryCount = 0;
  mainWindow.webContents.on('did-fail-load', (e, code, desc, url) => {
    if (code === -3) return; // ERR_ABORTED — deliberate navigation cancel, ignore
    if (failRetryCount < 3) {
      failRetryCount++;
      setTimeout(() => mainWindow.loadURL('https://e.mail.ru'), 2000 * failRetryCount);
    } else {
      // Show offline placeholder after 3 failed retries
      mainWindow.webContents.executeJavaScript(`
        (function() {
          document.body.innerHTML = '';
          document.body.style.cssText = 'margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#f4f5fb;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;flex-direction:column;gap:16px';
          const t = document.createElement('div');
          t.style.cssText = 'font-size:15px;color:#9999bb;font-weight:500';
          t.textContent = 'Нет соединения';
          const b = document.createElement('button');
          b.textContent = 'Повторить';
          b.style.cssText = 'padding:10px 24px;border:none;border-radius:10px;background:#5c6bc0;color:#fff;font-size:13px;font-weight:600;cursor:pointer';
          b.onclick = () => location.replace('https://e.mail.ru');
          document.body.appendChild(t);
          document.body.appendChild(b);
        })();
      `);
    }
  });

  mainWindow.webContents.on('did-finish-load', () => {
    failRetryCount = 0; // reset on successful load
    const currentUrl = mainWindow.webContents.getURL();
    const isLoginPage = /id\.vk\.ru\/auth|account\.mail\.ru\/login/i.test(currentUrl);
    const isMailPage  = /e\.mail\.ru/i.test(currentUrl) && !isLoginPage;

    if (isLoginPage) {
      const settings = readSettings();
      const hasAuth = !!(readAuth(settings.authDrive || null, settings.authLogin || null));

      // Task 4: show auth overlay if we're going to auto-login
      if (!settings.manualLogout && hasAuth) {
        mainWindow.webContents.executeJavaScript(`
          (function() {
            if (document.getElementById('__mailapp_auth_overlay__')) return;
            const ov = document.createElement('div');
            ov.id = '__mailapp_auth_overlay__';
            ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#5c6bc0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px';
            ov.innerHTML = \`
              <img src="${APP_ICON_B64}" style="width:72px;height:72px;border-radius:18px;box-shadow:0 4px 20px rgba(0,0,0,0.25)" />
              <div style="color:#fff;font-size:18px;font-weight:600;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;letter-spacing:0.02em">
                Авторизация<span id="__mailapp_dots__"></span>
              </div>
            \`;
            document.body.appendChild(ov);
            let d = 0;
            setInterval(() => {
              const el = document.getElementById('__mailapp_dots__');
              if (el) el.textContent = '.'.repeat((d++ % 3) + 1);
            }, 500);
          })();
        `);
      }

      if (!settings.manualLogout) {
        const auth = readAuth(settings.authDrive || null, settings.authLogin || null);
        if (auth && auth.login && auth.password) {
          mainWindow.webContents.executeJavaScript(buildAutoLoginScript(auth.login, auth.password));
        }
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

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, menuBarVisible: false } };
  });

  mainWindow.webContents.on('did-create-window', (win) => {
    win.setMenuBarVisibility(false);
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
    width: 720,
    height: 600,
    resizable: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
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
  if (process.platform !== 'win32') return ['C', 'D'];
  return 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').filter(l => {
    try { fs.accessSync(l + ':\\'); return true; } catch { return false; }
  });
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
    authLogin: auth.login || '',
    manualLogout: false,  // clear on profile save so relogin works
  });
  const authOk = auth.login ? writeAuth(settings.authDrive || null, auth) : true;
  try {
    const enabled = await autoLauncher.isEnabled();
    if (settings.autoLaunch && !enabled) await autoLauncher.enable();
    if (!settings.autoLaunch && enabled) await autoLauncher.disable();
  } catch (e) {}
  return { ok: settingsOk && authOk };
});

ipcMain.handle('settings:relogin', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // Clear cookies for all mail.ru / vk.ru domains so session is dropped
  const ses = mainWindow.webContents.session;
  const cookies = await ses.cookies.get({});
  const mailDomains = /mail\.ru|vk\.ru|mycdn\.me|mcs\.mail\.ru/i;
  await Promise.all(
    cookies
      .filter(c => mailDomains.test(c.domain))
      .map(c => {
        const url = `https://${c.domain.replace(/^\./, '')}${c.path}`;
        return ses.cookies.remove(url, c.name);
      })
  );
  mainWindow.loadURL('https://e.mail.ru');
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

ipcMain.handle('settings:deleteProfile', (_, { drive, login }) => {
  try {
    const p = getAuthFilePath(drive || null, login);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('settings:openExternal', (_, url) => { shell.openExternal(url); });
ipcMain.on('settings:close',    () => { if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close(); });
ipcMain.on('settings:minimize', () => { if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.minimize(); });;
ipcMain.on('main:openSettings', () => { openSettings(); });

// Unread badge from renderer
ipcMain.on('main:setUnread',    (_, count) => { setUnreadBadge(count); });
ipcMain.on('main:manualLogout', ()         => { writeSettings({ ...readSettings(), manualLogout: true }); });
ipcMain.on('main:openFile',     (_, filePath) => { shell.openPath(filePath); });


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
