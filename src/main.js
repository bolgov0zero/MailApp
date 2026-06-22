const { app, BrowserWindow, ipcMain, shell, Notification, nativeImage, safeStorage, Menu } = require('electron');
const crypto = require('crypto');
const { autoUpdater } = require('electron-updater');
const AutoLaunch = require('auto-launch');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const serverLink = require('./server-link');

// Headless update mode: launched as "MailApp.exe --run-update", normally by the
// SYSTEM scheduled task so it can install into Program Files without UAC. Runs
// the updater and never shows the GUI.
if (process.argv.includes('--run-update')) {
  require('./update-runner');
  return;
}

// Global settings — system-wide on Windows (all users), user-local elsewhere
const GLOBAL_SETTINGS_PATH = process.platform === 'win32'
  ? path.join('C:\\ProgramData', 'MailApp', 'settings.json')
  : path.join(os.homedir(), '.mailapp', 'settings.json');

const LOG_DIR = path.dirname(GLOBAL_SETTINGS_PATH);
const NAV_LOG_PATH = path.join(LOG_DIR, 'nav.log');
// Diagnostics logging is opt-in via settings (default enabled). Cached so
// navLog stays cheap; updated when the toggle changes.
let loggingEnabled = (() => { try { return readSettings().diagnostics !== false; } catch (e) { return true; } })();
function navLog(event, extra) {
  if (!loggingEnabled) return;
  try {
    const dir = path.dirname(NAV_LOG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const line = `${new Date().toISOString()} [${event}] ${extra || ''}\n`;
    fs.appendFileSync(NAV_LOG_PATH, line);
  } catch (e) {}
}

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

// --- Widget dismisser: auto-close "Interesting events" sidebar popup ---
// Widget dismisser runs inside the widgets.mail.ru iframe (not main page)
// Injected via WebFrameMain.executeJavaScript from did-frame-finish-load
const WIDGET_DISMISSER_IFRAME = `
  (function() {
    if (window.__mailapp_widget_dismisser__) return;
    window.__mailapp_widget_dismisser__ = true;

    function tryDismiss() {
      // × close button in TabsHeader (accent-colored, top-right of widget)
      const closeBtn = document.querySelector('button[class*="TabsHeader_button"][class*="appearance-accent"]');
      if (closeBtn) { closeBtn.click(); return true; }
      // "Пропустить" button ("Интересные события" view)
      for (const btn of document.querySelectorAll('button, [role="button"]')) {
        if (btn.textContent?.trim() === 'Пропустить') { btn.click(); return true; }
      }
      return false;
    }

    if (!tryDismiss()) {
      const observer = new MutationObserver(() => {
        if (tryDismiss()) observer.disconnect();
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => observer.disconnect(), 30000);
    }
  })();
`;

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
    const p = path.join(__dirname, '..', 'assets', 'icon.png');
    return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
  } catch { return ''; }
})();

// --- Main window ---

function createMainWindow() {
  const saved = readSettings().windowBounds || {};
  const winWidth  = saved.width      || 1280;
  const winHeight = saved.height     || 800;
  const winX      = saved.x          ?? undefined;
  const winY      = saved.y          ?? undefined;
  const winMax    = saved.maximized  || false;

  mainWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x: winX,
    y: winY,
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
      backgroundThrottling: false,
    },
  });

  if (winMax) mainWindow.maximize();

  // Save window bounds on resize/move
  function saveWindowBounds() {
    if (mainWindow.isMaximized()) {
      writeSettings({ ...readSettings(), windowBounds: { ...readSettings().windowBounds, maximized: true } });
    } else {
      const b = mainWindow.getBounds();
      writeSettings({ ...readSettings(), windowBounds: { width: b.width, height: b.height, x: b.x, y: b.y, maximized: false } });
    }
  }
  mainWindow.on('resize', saveWindowBounds);
  mainWindow.on('move',   saveWindowBounds);
  mainWindow.on('maximize',   saveWindowBounds);
  mainWindow.on('unmaximize', saveWindowBounds);
  mainWindow.on('restore', () => mainWindow.webContents.invalidate());

  mainWindow.loadURL('https://e.mail.ru');
  mainWindow.setMenuBarVisibility(false);

  // Task 1: cancel "download" files with no extension (technical redirects, not real attachments)
  // Task 2: after real download completes, offer to open the file
  mainWindow.webContents.session.on('will-download', (event, item) => {
    const name = item.getFilename() || '';
    const dlUrl = item.getURL() || '';
    const hasExt = path.extname(name).length > 0;
    // Auth/login redirect responses sometimes arrive as a "download" (octet-stream),
    // producing a bogus save dialog titled e.g. "https://o2.mail.ru/login".
    // Never treat auth endpoints as downloads — cancel and restart the mail load.
    if (/o2\.mail\.ru|auth\.mail\.ru|id\.vk\.|account\.mail\.ru/i.test(dlUrl)) {
      event.preventDefault();
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL('https://e.mail.ru');
      }, 300);
      return;
    }
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
  // Cooldown prevents repeated triggers during post-auth redirect chains
  let lastLogoutTime = 0;
  const LOGOUT_COOLDOWN_MS = 10000;

  ses.webRequest.onBeforeRequest(
    { urls: ['*://account.mail.ru/user/logout*', '*://account.mail.ru/logout*', '*://auth.mail.ru/cgi-bin/logout*', '*://id.vk.ru/logout*'] },
    (details, callback) => {
      const now = Date.now();
      // Only handle main frame navigation, ignore sub-resources and redirect chains
      if (details.resourceType !== 'mainFrame' || now - lastLogoutTime < LOGOUT_COOLDOWN_MS) {
        callback({});
        return;
      }
      lastLogoutTime = now;
      writeSettings({ ...readSettings(), manualLogout: true });
      callback({});
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL('https://e.mail.ru');
      }, 500);
    }
  );

  function revealPage() {} // no-op: overlays cover the page, no CSS hiding needed

  // Inject all overlays on dom-ready, then reveal the page
  mainWindow.webContents.on('dom-ready', () => {
    const currentUrl = mainWindow.webContents.getURL();
    const isLoginPage = /id\.vk\.ru\/auth|account\.mail\.ru\/login/i.test(currentUrl);

    const scripts = [];

    if (isLoginPage) {
      const settings = readSettings();
      const hasAuth  = !!(readAuth(settings.authDrive || null, settings.authLogin || null));

      if (!hasAuth || settings.manualLogout) {
        scripts.push(`
          (function() {
            if (document.getElementById('__mailapp_auth_overlay__')) return;
            const ov = document.createElement('div');
            ov.id = '__mailapp_auth_overlay__';
            ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px';
            ov.innerHTML = \`
              <img src="${APP_ICON_B64}" style="width:80px;height:80px;border-radius:20px;box-shadow:0 4px 24px rgba(92,107,192,0.25)" />
              <div style="color:#1a1a2e;font-size:22px;font-weight:700;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;margin-top:4px">MailApp</div>
              <div style="color:#9999bb;font-size:14px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">Выберите профиль для авторизации</div>
              <button id="__mailapp_open_settings__" style="margin-top:8px;padding:10px 28px;border:none;border-radius:12px;background:#5c6bc0;color:#fff;font-size:14px;font-weight:600;cursor:pointer;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif"
                onmouseover="this.style.background='#4a5ab0'" onmouseout="this.style.background='#5c6bc0'">
                Открыть настройки
              </button>
            \`;
            document.documentElement.appendChild(ov);
            document.getElementById('__mailapp_open_settings__').onclick = () => window.__mailapp_ipc__.openSettingsProfiles();
          })();
        `);
      } else {
        scripts.push(`
          (function() {
            if (document.getElementById('__mailapp_auth_overlay__')) return;
            const ov = document.createElement('div');
            ov.id = '__mailapp_auth_overlay__';
            ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px';
            ov.innerHTML = \`
              <img src="${APP_ICON_B64}" style="width:72px;height:72px;border-radius:18px;box-shadow:0 4px 20px rgba(92,107,192,0.25)" />
              <div style="color:#1a1a2e;font-size:18px;font-weight:600;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;letter-spacing:0.02em">
                Авторизация<span id="__mailapp_dots__" style="color:#5c6bc0"></span>
              </div>
            \`;
            document.documentElement.appendChild(ov);
            let d = 0;
            setInterval(() => { const el = document.getElementById('__mailapp_dots__'); if (el) el.textContent = '.'.repeat((d++ % 3) + 1); }, 500);
          })();
        `);
      }
    }

    // Settings button — on every page
    scripts.push(`
      (function() {
        if (document.getElementById('__mailapp_settings_btn__')) return;
        const btn = document.createElement('button');
        btn.id = '__mailapp_settings_btn__';
        btn.innerHTML = '⚙';
        btn.title = 'Настройки MailApp';
        btn.style.cssText = [
          'position:fixed','bottom:18px','right:18px','z-index:2147483646',
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
        document.documentElement.appendChild(btn);
      })();
    `);

    Promise.all(scripts.map(s => mainWindow.webContents.executeJavaScript(s).catch(() => {})))
      .then(revealPage);
  });

  // Block programmatic reloads caused by the calendar widget
  // Pattern: widget initializes → navigates to /agenda/... → redirects back to /inbox → cycle
  function shouldBlockCalendarNav(url) {
    // Block agenda navigations (calendar widget trying to open its view)
    if (/e\.mail\.ru\/agenda\//.test(url)) return true;
    return false;
  }

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const currentUrl = mainWindow.webContents.getURL();
    // Block ONLY a truly identical reload (same URL including query). Do NOT
    // collapse by path: the post-auth "sota/next redirect" navigates
    // /inbox?authid=... → /inbox?octavius-snr=1&... (same path, new query) and
    // must be allowed, otherwise the page hangs with title "sota/next redirect".
    const stripHash = u => u.split('#')[0];
    if (stripHash(currentUrl) === stripHash(url) && url.includes('e.mail.ru')) {
      event.preventDefault();
      return;
    }
    // Block calendar agenda navigations
    if (shouldBlockCalendarNav(url)) {
      event.preventDefault();
    }
  });

  mainWindow.webContents.on('will-redirect', (event, url) => {
    if (shouldBlockCalendarNav(url)) {
      event.preventDefault();
    }
  });

  // Watchdog: the auth flow passes through intermediate redirect pages
  // (page title "sota/next redirect") that occasionally hang — the page loads
  // fully (white screen) but the JS redirect never fires, so the window is
  // stuck. The transient page is identified by its TITLE, not its URL, so we
  // detect it on did-finish-load / page-title-updated and, if we're still
  // there after a short timeout, reload e.mail.ru to restart the chain.
  let authStuckTimer = null;
  let authRecoverCount = 0;
  const AUTH_RECOVER_MAX = 4;
  const LIMBO_TIMEOUT_MS = 10000;
  // "Limbo" = anything that is neither the real mail page nor the login UI we
  // show an overlay on. The auth chain passes through several limbo redirect
  // pages (e.g. title "sota/next redirect"); each should transition within a
  // second or two. If we sit in limbo with no progress for LIMBO_TIMEOUT_MS,
  // the chain has hung — recover by hard-reloading (like reopening the app).
  function isLimbo() {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    const url = mainWindow.webContents.getURL() || '';
    if (url.startsWith('about:blank')) return false; // mid-recovery
    // The login UI (where we show an overlay / autologin) is not a hang.
    if (/id\.vk\.ru\/auth|account\.mail\.ru\/login/i.test(url)) return false;
    // The mail app itself is e.mail.ru. Normally not a hang — BUT the post-auth
    // redirect placeholder ("sota/next redirect" / "Перенаправление") lives on
    // e.mail.ru and can get stuck. Treat it as limbo only while showing that
    // placeholder title; the real inbox has a different title, so no loop.
    if (/^https?:\/\/(e|win|my)\.mail\.ru/i.test(url)) {
      const title = mainWindow.webContents.getTitle() || '';
      return /sota|redirect|перенаправл/i.test(title);
    }
    // Anything else is a transient auth-redirect host (o2.mail.ru,
    // account.mail.ru sota pages, auth.mail.ru, id.vk.ru intermediate, ...).
    return true;
  }
  function recoverFromStuck() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    navLog('RECOVER', `attempt=${authRecoverCount} url=${mainWindow.webContents.getURL()} title=${mainWindow.webContents.getTitle()}`);
    // Hard reset like reopening the app: blank the renderer first, then reload.
    mainWindow.loadURL('about:blank');
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL('https://e.mail.ru');
    }, 400);
  }
  // Refresh the limbo watchdog: cleared + re-armed on every progress event, so
  // it only fires when we've been stuck in limbo with no progress.
  function checkAuthStuck() {
    if (authStuckTimer) { clearTimeout(authStuckTimer); authStuckTimer = null; }
    if (!isLimbo()) { authRecoverCount = 0; return; }
    authStuckTimer = setTimeout(() => {
      authStuckTimer = null;
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (isLimbo() && authRecoverCount < AUTH_RECOVER_MAX) {
        authRecoverCount++;
        recoverFromStuck();
      } else {
        navLog('GIVEUP', `count=${authRecoverCount} stillLimbo=${isLimbo()}`);
      }
    }, LIMBO_TIMEOUT_MS);
  }
  mainWindow.webContents.on('page-title-updated', (e, title) => { navLog('TITLE', title); checkAuthStuck(); });
  mainWindow.webContents.on('did-start-navigation', (e, url, isInPlace, isMainFrame) => { if (isMainFrame) { navLog('START-NAV', url); checkAuthStuck(); } });
  mainWindow.webContents.on('did-navigate', (e, url) => { navLog('DID-NAV', url); checkAuthStuck(); });
  mainWindow.webContents.on('did-stop-loading', () => { navLog('STOP-LOADING', mainWindow.webContents.getURL()); checkAuthStuck(); });

  // Task 3: retry on white screen (did-fail-load)
  let failRetryCount = 0;
  mainWindow.webContents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    navLog('FAIL-LOAD', `mainFrame=${isMainFrame} code=${code} desc=${desc} url=${url}`);
    if (!isMainFrame) return; // ignore subframe/iframe failures — they must not trigger page reload
    if (code === -3) return; // ERR_ABORTED — deliberate navigation cancel, ignore
    if (failRetryCount < 3) {
      failRetryCount++;
      setTimeout(() => mainWindow.loadURL('https://e.mail.ru'), 2000 * failRetryCount);
    } else {
      // Show offline placeholder after 3 failed retries
      mainWindow.webContents.executeJavaScript(`
        (function() {
          document.body.innerHTML = '';
          document.body.style.cssText = 'margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#fff;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;flex-direction:column;gap:16px';
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
    navLog('FINISH-LOAD', `url=${mainWindow.webContents.getURL()} title=${mainWindow.webContents.getTitle()}`);
    checkAuthStuck();
    const currentUrl = mainWindow.webContents.getURL();
    const isLoginPage = /id\.vk\.ru\/auth|account\.mail\.ru\/login/i.test(currentUrl);
    const isMailPage  = /e\.mail\.ru/i.test(currentUrl) && !isLoginPage;

    if (isLoginPage) {
      const settings = readSettings();
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
  });

  // Inject widget dismisser into widgets.mail.ru iframe when it finishes loading
  mainWindow.webContents.on('did-frame-finish-load', (event, isMainFrame) => {
    if (isMainFrame) return;
    try {
      const frames = mainWindow.webContents.mainFrame.framesInSubtree;
      for (const frame of frames) {
        if (frame.url && frame.url.includes('widgets.mail.ru')) {
          frame.executeJavaScript(WIDGET_DISMISSER_IFRAME).catch(() => {});
        }
      }
    } catch (e) {}
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, menuBarVisible: false } };
  });

  mainWindow.webContents.on('did-create-window', (win) => {
    win.setMenuBarVisibility(false);
  });

  // Custom styled context menu (Copy / Paste / etc.)
  mainWindow.webContents.on('context-menu', (e, params) => {
    const { x, y, selectionText, isEditable } = params;
    const hasSel = !!selectionText;
    if (!hasSel && !isEditable) return;

    const items = [];
    if (isEditable && hasSel) items.push({ id: 'cut',       label: 'Вырезать',     icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="20" r="2"/><circle cx="6" cy="4" r="2"/><line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="14" y2="10"/><line x1="18" y1="4" x2="10" y2="12"/></svg>` });
    if (hasSel)              items.push({ id: 'copy',      label: 'Копировать',   icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>` });
    if (isEditable)          items.push({ id: 'paste',     label: 'Вставить',     icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg>` });
    if (isEditable)          items.push({ id: 'selectAll', label: 'Выделить всё', icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h6v6H3z"/><path d="M15 3h6v6h-6z"/><path d="M3 15h6v6H3z"/><path d="M15 15h6v6h-6z"/></svg>` });

    if (!items.length) return;

    const script = `
      (function() {
        const prev = document.getElementById('__mailapp_ctx__');
        if (prev) prev.remove();

        const menu = document.createElement('div');
        menu.id = '__mailapp_ctx__';
        menu.style.cssText = [
          'position:fixed', 'z-index:2147483647',
          'left:${x}px', 'top:${y}px',
          'background:#fff',
          'border-radius:8px',
          'box-shadow:0 8px 24px rgba(0,0,0,0.16),0 2px 6px rgba(0,0,0,0.08)',
          'padding:4px 0',
          'min-width:200px',
          'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif',
          'font-size:14px',
          'user-select:none',
          'animation:__ma_ctx_in__ 0.1s ease',
          'overflow:hidden',
        ].join(';');

        const style = document.createElement('style');
        style.textContent = '@keyframes __ma_ctx_in__{from{opacity:0;transform:scale(0.97)}to{opacity:1;transform:scale(1)}}';
        menu.appendChild(style);

        const actions = ${JSON.stringify(items.map(i => ({ id: i.id, label: i.label, icon: i.icon })))};

        actions.forEach((item, idx) => {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;align-items:center;gap:12px;padding:11px 16px;cursor:pointer;color:#000;font-weight:400;transition:background 0.08s';
          row.innerHTML = '<span style="color:#666;display:flex;flex-shrink:0">' + item.icon + '</span><span>' + item.label + '</span>';
          row.addEventListener('mouseenter', () => row.style.background = '#f5f5f5');
          row.addEventListener('mouseleave', () => row.style.background = '');
          row.addEventListener('mousedown', e => { e.preventDefault(); });
          row.addEventListener('click', () => {
            menu.remove();
            document.dispatchEvent(new CustomEvent('__mailapp_ctx_action__', { detail: item.id }));
          });
          menu.appendChild(row);
        });

        document.documentElement.appendChild(menu);

        // Reposition if out of viewport
        requestAnimationFrame(() => {
          const r = menu.getBoundingClientRect();
          if (r.right  > window.innerWidth)  menu.style.left = (${x} - r.width)  + 'px';
          if (r.bottom > window.innerHeight) menu.style.top  = (${y} - r.height) + 'px';
        });

        const close = e => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', close); } };
        setTimeout(() => document.addEventListener('mousedown', close), 0);
      })();
    `;

    mainWindow.webContents.executeJavaScript(script).catch(() => {});

    // Listen for action from renderer
    mainWindow.webContents.executeJavaScript(`
      new Promise(resolve => {
        const h = e => { document.removeEventListener('__mailapp_ctx_action__', h); resolve(e.detail); };
        document.addEventListener('__mailapp_ctx_action__', h);
      });
    `).then(action => {
      const wc = mainWindow.webContents;
      if (action === 'cut')       wc.cut();
      if (action === 'copy')      wc.copy();
      if (action === 'paste')     wc.paste();
      if (action === 'selectAll') wc.selectAll();
    }).catch(() => {});
  });

  mainWindow.webContents.on('did-navigate-in-page', () => {
    const currentUrl = mainWindow.webContents.getURL();
    if (/e\.mail\.ru/i.test(currentUrl)) {
      mainWindow.webContents.executeJavaScript(UNREAD_POLLER);
    }
  });
}

// --- Settings window ---

function openSettings(tab) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    if (tab) settingsWindow.webContents.executeJavaScript(`switchTab(${JSON.stringify(tab)})`).catch(() => {});
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
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'), tab ? { hash: tab } : {});
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
    ...readSettings(),   // preserve other keys (diagnostics, windowBounds, ...)
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

// ── Diagnostics ──
ipcMain.handle('settings:getDiagnostics', () => {
  return { logging: loggingEnabled, logDir: LOG_DIR };
});
ipcMain.handle('settings:setLogging', (_, enabled) => {
  loggingEnabled = !!enabled;
  writeSettings({ ...readSettings(), diagnostics: loggingEnabled });
  return { ok: true, logging: loggingEnabled };
});
ipcMain.handle('settings:openLogsFolder', () => {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    // Reveal the nav.log file if it exists, otherwise open the folder.
    if (fs.existsSync(NAV_LOG_PATH)) shell.showItemInFolder(NAV_LOG_PATH);
    else shell.openPath(LOG_DIR);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
// ── Management server ──
ipcMain.handle('settings:serverStatus',     ()      => serverLink.status());
ipcMain.handle('settings:serverConnect',    (_, code) => serverLink.connect(code));
ipcMain.handle('settings:serverDisconnect', ()      => serverLink.disconnect());

ipcMain.on('settings:close',    () => { if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close(); });
ipcMain.on('settings:minimize', () => { if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.minimize(); });;
ipcMain.on('main:openSettings',         () => { openSettings(); });
ipcMain.on('main:openSettingsProfiles', () => { openSettings('profiles'); });

// Unread badge from renderer
ipcMain.on('main:setUnread',    (_, count) => { setUnreadBadge(count); });
ipcMain.on('main:manualLogout', ()         => { writeSettings({ ...readSettings(), manualLogout: true }); });
ipcMain.on('main:openFile',     (_, filePath) => { shell.openPath(filePath); });


// --- Auto-updater ---

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

// Update triggered by a management-server command. The binary still comes from
// the hard-coded GitHub feed — the server only sends a trigger, never a URL.
let managedUpdatePending = false;
autoUpdater.on('update-available', () => {
  if (managedUpdatePending) {
    managedUpdatePending = false;
    autoUpdater.downloadUpdate().catch(() => {});
  }
});
function fallbackUpdate() {
  if (!app.isPackaged) return;
  managedUpdatePending = true;
  autoUpdater.checkForUpdates().catch(() => { managedUpdatePending = false; });
}

// Fetch the latest published version tag from GitHub (e.g. "1.7.8").
function fetchLatestVersion() {
  return new Promise((resolve) => {
    const https = require('https');
    https.get(
      'https://api.github.com/repos/bolgov0zero/MailApp/releases/latest',
      { headers: { 'User-Agent': 'MailApp', 'Accept': 'application/vnd.github+json' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve(String(JSON.parse(data).tag_name || '').replace(/^v/, '')); }
          catch (e) { resolve(null); }
        });
      }
    ).on('error', () => resolve(null));
  });
}

// Numeric semver compare: true if a > b.
function isVersionNewer(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

// Handle an "update" command from the management server. Returns a status that
// the client reports back so the admin sees the result ("up_to_date" when the
// installed version is already current).
async function handleUpdateCommand() {
  try {
    const latest = await fetchLatestVersion();
    if (latest && isVersionNewer(latest, app.getVersion())) {
      triggerManagedUpdate();
      return 'updating';
    }
    return 'up_to_date';
  } catch (e) {
    return 'error';
  }
}
function triggerManagedUpdate() {
  // Preferred path on Windows: run the SYSTEM scheduled task "MailAppUpdater",
  // which installs into Program Files without a UAC prompt. If the task is not
  // present (service not installed), fall back to electron-updater.
  if (process.platform === 'win32') {
    const { execFile } = require('child_process');
    execFile('schtasks', ['/run', '/tn', 'MailAppUpdater'], (err) => {
      if (err) fallbackUpdate();
    });
    return;
  }
  fallbackUpdate();
}

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
  serverLink.init({
    readSettings,
    writeSettings,
    getVersion: () => app.getVersion(),
    getProfile: () => readSettings().authLogin || '',
    onUpdateCommand: handleUpdateCommand,
  });
  serverLink.start();
  if (app.isPackaged) autoUpdater.checkForUpdates().catch(() => {});
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
