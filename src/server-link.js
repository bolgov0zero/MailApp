/**
 * Management-server link: pairing, heartbeat, and update-command handling.
 *
 * The connection code is an AES-256-CBC blob (base64url of iv+ciphertext) that
 * decodes to { u: serverUrl, t: pairingToken }. The server (server/helpers.php)
 * produces it with the exact same scheme. The embedded server URL is therefore
 * not readable by eye. CONNECT_SECRET below MUST match `connect_secret` in the
 * server's config.php.
 *
 * After pairing the client stores a per-device token and authenticates with it;
 * regenerating the connection code on the server does NOT disconnect it.
 *
 * Update commands are triggers only — they never carry a URL. The binary is
 * always fetched from the hard-coded GitHub feed via electron-updater.
 */
const crypto = require('crypto');
const os = require('os');
const http = require('http');
const https = require('https');
const { URL } = require('url');

// MUST be identical to `connect_secret` in the server's config.php.
const CONNECT_SECRET = 'CHANGE-ME-to-a-long-random-shared-secret';

const HEARTBEAT_MS = 60 * 1000;

let deps = null;        // { readSettings, writeSettings, getVersion, getProfile, onUpdateCommand }
let timer = null;
let lastError = null;
let lastBeat = null;

function init(d) { deps = d; }

// ── crypto: decode the connection code ─────────────────────────────
function decodeConnectCode(code) {
  const key = crypto.createHash('sha256').update(CONNECT_SECRET).digest(); // 32 bytes
  let b64 = String(code).trim().replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const buf = Buffer.from(b64, 'base64');
  if (buf.length <= 16) throw new Error('bad code');
  const iv = buf.subarray(0, 16);
  const ct = buf.subarray(16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const dec = Buffer.concat([decipher.update(ct), decipher.final()]);
  const obj = JSON.parse(dec.toString('utf8'));
  if (!obj || !obj.u || !obj.t) throw new Error('bad code payload');
  return { url: String(obj.u).replace(/\/+$/, ''), pairToken: String(obj.t) };
}

// ── helpers ────────────────────────────────────────────────────────
function localIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return '';
}

function inventory() {
  return {
    hostname: os.hostname(),
    local_ip: localIp(),
    version: deps.getVersion(),
    profile: deps.getProfile() || '',
  };
}

function postJson(serverUrl, body) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(serverUrl.replace(/\/+$/, '') + '/api.php'); }
    catch (e) { return reject(e); }
    const lib = u.protocol === 'https:' ? https : http;
    const payload = Buffer.from(JSON.stringify(body));
    const req = lib.request(
      u,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
        timeout: 15000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('bad response')); }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function getServer() {
  const s = deps.readSettings();
  return s.server || null;   // { url, deviceToken }
}

function setServer(server) {
  deps.writeSettings({ ...deps.readSettings(), server });
}

// ── pairing (called from settings UI) ──────────────────────────────
async function connect(code) {
  let decoded;
  try { decoded = decodeConnectCode(code); }
  catch (e) { return { ok: false, error: 'Неверный код подключения' }; }

  try {
    const res = await postJson(decoded.url, {
      action: 'pair',
      pair_token: decoded.pairToken,
      ...inventory(),
    });
    if (!res || !res.ok || !res.device_token) {
      return { ok: false, error: res && res.error === 'invalid_code' ? 'Код не найден на сервере' : 'Сервер отклонил подключение' };
    }
    setServer({ url: decoded.url, deviceToken: res.device_token });
    lastError = null;
    start();           // (re)start heartbeat
    beat();            // immediate first beat
    return { ok: true, url: decoded.url };
  } catch (e) {
    return { ok: false, error: 'Не удалось связаться с сервером' };
  }
}

function disconnect() {
  setServer(null);
  stop();
  return { ok: true };
}

function status() {
  const srv = getServer();
  return {
    connected: !!(srv && srv.deviceToken),
    url: srv ? srv.url : '',
    lastError,
    lastBeat,
    profile: deps.getProfile() || '',
    version: deps.getVersion(),
  };
}

// ── heartbeat loop ─────────────────────────────────────────────────
async function beat() {
  const srv = getServer();
  if (!srv || !srv.deviceToken) return;
  try {
    const res = await postJson(srv.url, {
      action: 'heartbeat',
      device_token: srv.deviceToken,
      ...inventory(),
    });
    lastBeat = new Date().toISOString();
    lastError = null;
    if (res && res.ok && res.command === 'update') {
      try { deps.onUpdateCommand(); } catch (e) {}
    }
  } catch (e) {
    lastError = 'Нет связи с сервером';
  }
}

function start() {
  stop();
  const srv = getServer();
  if (!srv || !srv.deviceToken) return;
  timer = setInterval(beat, HEARTBEAT_MS);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = {
  init, connect, disconnect, status, start, beat,
  decodeConnectCode, // exported for tests
  CONNECT_SECRET,
};
