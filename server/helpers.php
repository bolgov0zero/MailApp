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
    $payload = json_encode(['u' => cfg('server_url'), 't' => $pairToken]);
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
