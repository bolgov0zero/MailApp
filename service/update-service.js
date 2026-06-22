/**
 * MailApp update service (runs as LocalSystem under WinSW).
 *
 * Launched by WinSW as `MailApp.exe <this script>` with ELECTRON_RUN_AS_NODE=1,
 * so it runs as a plain Node process. It stays resident and watches a flag file
 * that the (unprivileged) client drops when an update is requested. Because the
 * service already runs as SYSTEM, it installs the update into Program Files
 * WITHOUT any UAC prompt, and the client never needs permission to "start" it —
 * it just writes the flag.
 *
 * Self-update note: replacing MailApp.exe / the service files while this process
 * runs would lock them, so the actual install is launched from a detached helper
 * batch that first stops the service (freeing the locks), then runs the silent
 * installer (which reinstalls + restarts the service in its NSIS customInstall).
 *
 * Uses only Node built-ins.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { exec } = require('child_process');

const REPO = 'bolgov0zero/MailApp';
const SERVICE_ID = 'MailAppUpdater';
const DATA_DIR = 'C:\\ProgramData\\MailApp';
const FLAG_PATH = path.join(DATA_DIR, 'update.flag');
const LOG_PATH = path.join(DATA_DIR, 'update-service.log');

let busy = false;

function log(msg) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`);
  } catch (e) {}
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'MailApp-Service', 'Accept': 'application/vnd.github+json' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); return resolve(getJson(res.headers.location));
      }
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const go = (u) => https.get(u, { headers: { 'User-Agent': 'MailApp-Service' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return go(res.headers.location); }
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
    }).on('error', (e) => { try { fs.unlinkSync(dest); } catch (_) {} reject(e); });
    go(url);
  });
}

async function doUpdate() {
  if (busy) { log('update already in progress, ignoring'); return; }
  busy = true;
  try {
    log('update requested');
    const rel = await getJson(`https://api.github.com/repos/${REPO}/releases/latest`);
    const asset = (rel.assets || []).find((a) => /\.exe$/i.test(a.name) && !/blockmap/i.test(a.name));
    if (!asset) { log('no .exe asset in latest release'); busy = false; return; }

    const installer = path.join(os.tmpdir(), asset.name);
    log('downloading ' + asset.browser_download_url);
    await download(asset.browser_download_url, installer);
    log('downloaded to ' + installer);

    // Helper batch: stop this service (frees the file locks), then run the
    // silent installer, which reinstalls + restarts the service via NSIS.
    const bat = path.join(os.tmpdir(), 'mailapp-apply-update.bat');
    fs.writeFileSync(bat, [
      '@echo off',
      `net stop ${SERVICE_ID}`,
      'ping 127.0.0.1 -n 4 >nul',
      `"${installer}" /S`,
      'schtasks /delete /tn "MailAppApply" /f',
    ].join('\r\n'));

    // Run the helper via a one-off SYSTEM scheduled task so it lives OUTSIDE
    // this service's process tree — otherwise "net stop" would kill it before
    // the installer runs (that was the bug). The Task Scheduler hosts it.
    const TASK = 'MailAppApply';
    const createCmd =
      `schtasks /create /tn "${TASK}" /tr "${bat}" /sc ONCE /st 00:00 /ru SYSTEM /rl HIGHEST /f`;
    log('creating apply task: ' + createCmd);
    exec(createCmd, (e1) => {
      log('schtasks create: ' + (e1 ? 'ERR ' + e1.message : 'ok'));
      exec(`schtasks /run /tn "${TASK}"`, (e2) => {
        log('schtasks run: ' + (e2 ? 'ERR ' + e2.message : 'ok'));
      });
    });
  } catch (e) {
    log('ERROR: ' + (e && e.message));
    busy = false;
  }
}

function consumeFlagIfPresent() {
  if (!fs.existsSync(FLAG_PATH)) return;
  try { fs.unlinkSync(FLAG_PATH); } catch (e) {}
  doUpdate();
}

// ── main ───────────────────────────────────────────────────────────
log('service started, watching ' + FLAG_PATH);
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
consumeFlagIfPresent(); // handle a flag dropped while the service was down

try {
  fs.watch(DATA_DIR, (evt, file) => {
    if (file && String(file).toLowerCase() === 'update.flag') consumeFlagIfPresent();
  });
} catch (e) {
  log('fs.watch failed, falling back to polling: ' + (e && e.message));
  setInterval(consumeFlagIfPresent, 15000);
}

// Keep the process alive.
setInterval(() => {}, 1 << 30);
