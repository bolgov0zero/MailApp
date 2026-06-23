<?php
/**
 * Shared helpers: config loading, connection-code crypto, misc utilities.
 *
 * Connection code = base64url( iv(16) . AES-256-CBC( json{u,t} ) ), where the
 * key is sha256(connect_secret). The client (src/main.js) implements the exact
 * same scheme to decode it. The IP is therefore not readable by eye.
 */

function cfg($key = null) {
    static $config = null;
    if ($config === null) {
        $path = __DIR__ . '/config.php';
        if (!file_exists($path)) {
            http_response_code(500);
            die('config.php not found. Copy config.example.php to config.php and edit it.');
        }
        $config = require $path;
    }
    if ($key === null) return $config;
    return isset($config[$key]) ? $config[$key] : null;
}

function code_key() {
    return hash('sha256', (string) cfg('connect_secret'), true); // raw 32 bytes
}

/** Encrypt {server_url, pairing token} into an opaque connection code. */
function make_connect_code($pairToken) {
    $payload = json_encode(['u' => server_url(), 't' => $pairToken]);
    $iv = random_bytes(16);
    $ct = openssl_encrypt($payload, 'aes-256-cbc', code_key(), OPENSSL_RAW_DATA, $iv);
    return rtrim(strtr(base64_encode($iv . $ct), '+/', '-_'), '=');
}

function random_token($bytes = 16) {
    return bin2hex(random_bytes($bytes));
}

function now() {
    return gmdate('Y-m-d\TH:i:s\Z');
}

function json_out($data, $status = 200) {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data);
    exit;
}

function read_json_body() {
    $raw = file_get_contents('php://input');
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

/** Sanitize free-form client strings before storing/displaying. */
function clean_str($s, $max = 200) {
    $s = is_string($s) ? $s : '';
    $s = preg_replace('/[\x00-\x1F\x7F]/u', '', $s);
    return mb_substr(trim($s), 0, $max);
}

function h($s) {
    return htmlspecialchars((string) $s, ENT_QUOTES, 'UTF-8');
}

// ── App settings stored in the DB ──────────────────────────────────
function setting_get($key, $default = '') {
    $st = db()->prepare('SELECT v FROM app_settings WHERE k = ?');
    $st->execute([$key]);
    $row = $st->fetch();
    return ($row && $row['v'] !== '') ? $row['v'] : $default;
}
function setting_set($key, $value) {
    db()->prepare('INSERT INTO app_settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
        ->execute([$key, $value]);
}

/** Server address used in connection codes / update URLs. DB first, config fallback. */
function server_url() {
    $v = setting_get('server_url', '');
    if ($v === '') $v = (string) cfg('server_url');
    return rtrim($v, '/');
}

/** Verify the admin password: DB-stored hash if set, otherwise config plaintext. */
function admin_check_password($pwd) {
    $hash = setting_get('admin_password_hash', '');
    if ($hash !== '') return password_verify((string) $pwd, $hash);
    return hash_equals((string) cfg('admin_password'), (string) $pwd);
}

/** Register a freshly stored installer as the current update (+ history). */
function register_update($pdo, $dir, $safe, $version, $source = '') {
    $size = filesize("$dir/$safe");
    $pdo->prepare('UPDATE app_update SET version=?, filename=?, sha256=?, size=?, uploaded_at=? WHERE id=1')
        ->execute([$version, $safe, hash_file('sha256', "$dir/$safe"), $size, now()]);
    $pdo->prepare('INSERT INTO update_history (version, filename, size, source, at) VALUES (?,?,?,?,?)')
        ->execute([$version, $safe, $size, $source, now()]);
}

/** Register a .exe that was placed into updates/ manually (e.g. via SFTP). */
function scan_update_folder($pdo) {
    $dir = __DIR__ . '/updates';
    if (!is_dir($dir)) return 'Папка updates не найдена';
    $files = glob($dir . '/*.exe');
    if (!$files) return 'В папке updates нет файла .exe';
    // newest by mtime
    usort($files, function ($a, $b) { return filemtime($b) - filemtime($a); });
    $path = $files[0];
    $safe = basename($path);
    $version = '';
    if (preg_match('/(\d+\.\d+\.\d+)/', $safe, $m)) $version = $m[1];
    if ($version === '') return 'Не удалось определить версию из имени файла ' . $safe;

    // If it's the same file already registered — do nothing (no history spam).
    $sha = hash_file('sha256', $path);
    $cur = $pdo->query('SELECT sha256 FROM app_update WHERE id = 1')->fetch();
    if ($cur && $cur['sha256'] !== '' && strtolower($cur['sha256']) === strtolower($sha)) {
        return "Файл уже добавлен (версия $version)";
    }
    @file_put_contents($dir . '/.htaccess', "Options -Indexes\n");
    register_update($pdo, $dir, $safe, $version, 'scan');
    return "Зарегистрирован файл из папки: $version";
}

function github_get_json($url) {
    if (!function_exists('curl_init')) return null;
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_TIMEOUT => 30,
        CURLOPT_HTTPHEADER => ['User-Agent: MailApp-Server', 'Accept: application/vnd.github+json'],
    ]);
    $body = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($body === false || $code >= 400) return null;
    $j = json_decode($body, true);
    return is_array($j) ? $j : null;
}

/** Pull the latest release installer from GitHub directly to the server. */
function fetch_update_from_github($pdo) {
    if (!function_exists('curl_init')) return 'На сервере нет PHP cURL (php-curl) — включите расширение.';
    $rel = github_get_json('https://api.github.com/repos/bolgov0zero/MailApp/releases/latest');
    if (!$rel) return 'Не удалось получить данные релиза с GitHub (нет исходящего доступа?).';

    $version = preg_replace('/^v/', '', (string) ($rel['tag_name'] ?? ''));
    $asset = null;
    foreach (($rel['assets'] ?? []) as $a) {
        if (preg_match('/\.exe$/i', $a['name']) && !preg_match('/blockmap/i', $a['name'])) { $asset = $a; break; }
    }
    if (!$asset) return 'В последнем релизе GitHub нет файла .exe';
    if ($version === '' && preg_match('/(\d+\.\d+\.\d+)/', $asset['name'], $m)) $version = $m[1];

    $dir = __DIR__ . '/updates';
    if (!is_dir($dir) && !@mkdir($dir, 0775, true)) return 'Не удалось создать папку updates (права на запись?)';
    @file_put_contents($dir . '/.htaccess', "Options -Indexes\n");

    $safe = preg_replace('/[^A-Za-z0-9._-]/', '_', basename($asset['name']));
    $tmp = $dir . '/.download.tmp';
    @set_time_limit(0);
    $fh = @fopen($tmp, 'wb');
    if (!$fh) return 'Не удалось открыть файл для записи';
    $ch = curl_init($asset['browser_download_url']);
    curl_setopt_array($ch, [
        CURLOPT_FILE => $fh,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_TIMEOUT => 1800,
        CURLOPT_HTTPHEADER => ['User-Agent: MailApp-Server'],
        CURLOPT_FAILONERROR => true,
    ]);
    $ok = curl_exec($ch);
    $err = curl_error($ch);
    curl_close($ch);
    fclose($fh);
    if (!$ok) { @unlink($tmp); return 'Ошибка скачивания с GitHub: ' . $err; }

    foreach (glob($dir . '/*.exe') as $old) { @unlink($old); }
    if (!@rename($tmp, "$dir/$safe")) { @unlink($tmp); return 'Не удалось сохранить файл'; }
    register_update($pdo, $dir, $safe, $version, 'github');
    return "Загружено с GitHub: $version";
}

/** Store an uploaded installer (.exe) as the current update and record its meta. */
function handle_update_upload($pdo) {
    if (empty($_FILES['installer']) || ($_FILES['installer']['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
        $code = $_FILES['installer']['error'] ?? 'нет файла';
        return "Ошибка загрузки (код $code). Проверьте upload_max_filesize / post_max_size на хостинге.";
    }
    $f = $_FILES['installer'];
    $name = basename($f['name']);
    if (!preg_match('/\.exe$/i', $name)) return 'Нужен файл .exe';

    $version = clean_str($_POST['version'] ?? '', 32);
    if ($version === '' && preg_match('/(\d+\.\d+\.\d+(?:\.\d+)?)/', $name, $m)) $version = $m[1];
    if ($version === '') return 'Не удалось определить версию из имени файла — укажите её вручную';

    $dir = __DIR__ . '/updates';
    if (!is_dir($dir) && !@mkdir($dir, 0775, true)) return 'Не удалось создать папку updates (права на запись?)';
    @file_put_contents($dir . '/.htaccess', "Options -Indexes\n");

    $safe = preg_replace('/[^A-Za-z0-9._-]/', '_', $name);
    foreach (glob($dir . '/*.exe') as $old) { @unlink($old); } // keep only the latest
    if (!move_uploaded_file($f['tmp_name'], $dir . '/' . $safe)) return 'Не удалось сохранить файл';

    register_update($pdo, $dir, $safe, $version, 'upload');
    return "Загружено обновление $version";
}

// ── Admin session auth ─────────────────────────────────────────────
function admin_start_session() {
    if (session_status() !== PHP_SESSION_ACTIVE) {
        session_name('mailapp_admin');
        session_start();
    }
}

function admin_logged_in() {
    admin_start_session();
    return !empty($_SESSION['admin']);
}

function admin_require() {
    if (!admin_logged_in()) {
        header('Location: index.php');
        exit;
    }
}

function csrf_token() {
    admin_start_session();
    if (empty($_SESSION['csrf'])) $_SESSION['csrf'] = random_token(16);
    return $_SESSION['csrf'];
}

function csrf_check() {
    admin_start_session();
    $t = isset($_POST['csrf']) ? $_POST['csrf'] : '';
    if (empty($_SESSION['csrf']) || !hash_equals($_SESSION['csrf'], $t)) {
        http_response_code(400);
        die('Bad CSRF token. Go back and retry.');
    }
}
