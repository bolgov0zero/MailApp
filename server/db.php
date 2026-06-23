<?php
/**
 * SQLite connection + schema bootstrap.
 * The DB file (mailapp.db) lives in the server root and is excluded from
 * MailAppServer.zip, so it survives server updates.
 */

function db() {
    static $pdo = null;
    if ($pdo !== null) return $pdo;

    $path = __DIR__ . '/mailapp.db';
    $pdo = new PDO('sqlite:' . $path);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    // WAL: readers don't block the frequent heartbeat writes and vice versa.
    $pdo->exec('PRAGMA journal_mode = WAL');
    $pdo->exec('PRAGMA busy_timeout = 5000');

    $pdo->exec("
        CREATE TABLE IF NOT EXISTS clients (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            device_token   TEXT UNIQUE NOT NULL,
            hostname       TEXT DEFAULT '',
            local_ip       TEXT DEFAULT '',
            version        TEXT DEFAULT '',
            profile        TEXT DEFAULT '',
            pending_update INTEGER NOT NULL DEFAULT 0,
            created_at     TEXT DEFAULT '',
            last_seen      TEXT DEFAULT '',
            last_message   TEXT DEFAULT '',
            last_message_at TEXT DEFAULT '',
            app_version       TEXT DEFAULT '',
            app_last_seen     TEXT DEFAULT '',
            service_version   TEXT DEFAULT '',
            service_last_seen TEXT DEFAULT ''
        )
    ");
    // Migrations for DBs created by earlier versions (ignore if column exists).
    $cols = [
        'last_message TEXT', 'last_message_at TEXT',
        'app_version TEXT', 'app_last_seen TEXT',
        'service_version TEXT', 'service_last_seen TEXT',
    ];
    foreach ($cols as $col) {
        try { $pdo->exec("ALTER TABLE clients ADD COLUMN $col DEFAULT ''"); } catch (Exception $e) {}
    }

    $pdo->exec("
        CREATE TABLE IF NOT EXISTS connect_codes (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            token      TEXT UNIQUE NOT NULL,
            label      TEXT DEFAULT '',
            active     INTEGER NOT NULL DEFAULT 1,
            created_at TEXT DEFAULT ''
        )
    ");

    // Single-row registry of the current update installer hosted on this server.
    $pdo->exec("
        CREATE TABLE IF NOT EXISTS app_update (
            id          INTEGER PRIMARY KEY CHECK (id = 1),
            version     TEXT DEFAULT '',
            filename    TEXT DEFAULT '',
            sha256      TEXT DEFAULT '',
            size        INTEGER DEFAULT 0,
            uploaded_at TEXT DEFAULT ''
        )
    ");
    $pdo->exec("INSERT OR IGNORE INTO app_update (id) VALUES (1)");

    return $pdo;
}
