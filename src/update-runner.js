/**
 * Headless update runner.
 *
 * Invoked as `MailApp.exe --run-update`. When launched by the Windows Scheduled
 * Task "MailAppUpdater" (registered to run as SYSTEM during install), it runs
 * elevated and can install into Program Files WITHOUT a UAC prompt.
 *
 * It fetches the latest release installer from GitHub (HTTPS — the trust anchor,
 * as the management server never serves binaries) and runs it silently (/S).
 *
 * Uses only plain Node APIs so it also works under ELECTRON_RUN_AS_NODE.
 */
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = 'bolgov0zero/MailApp';
const LOG_PATH = path.join(
  process.platform === 'win32' ? 'C:\\ProgramData\\MailApp' : os.tmpdir(),
  'update-runner.log'
);

function log(msg) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`);
  } catch (e) {}
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'MailApp-Updater', 'Accept': 'application/vnd.github+json' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(getJson(res.headers.location));
      }
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const go = (u) => https.get(u, { headers: { 'User-Agent': 'MailApp-Updater' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return go(res.headers.location);
      }
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
    }).on('error', (e) => { try { fs.unlinkSync(dest); } catch (_) {} reject(e); });
    go(url);
  });
}

async function run() {
  log('update-runner started');
  try {
    const rel = await getJson(`https://api.github.com/repos/${REPO}/releases/latest`);
    const asset = (rel.assets || []).find((a) => /\.exe$/i.test(a.name) && !/blockmap/i.test(a.name));
    if (!asset) { log('no .exe asset in latest release'); process.exit(1); }

    const dest = path.join(os.tmpdir(), asset.name);
    log('downloading ' + asset.browser_download_url);
    await download(asset.browser_download_url, dest);
    log('downloaded to ' + dest);

    // Silent NSIS install. Running as SYSTEM => no UAC. The installer replaces
    // the app and relaunches it per the build config.
    const child = spawn(dest, ['/S'], { detached: true, stdio: 'ignore' });
    child.unref();
    log('installer launched silently, exiting');
    setTimeout(() => process.exit(0), 1000);
  } catch (e) {
    log('ERROR: ' + (e && e.message));
    process.exit(1);
  }
}

run();
