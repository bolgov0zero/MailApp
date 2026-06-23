<?php
/**
 * MailApp Management Server — configuration template.
 *
 * On first deploy: copy this file to "config.php" (in the same folder) and edit
 * the values below. config.php lives in the server root and is NEVER included in
 * MailAppServer.zip, so updating the server (extracting the zip over the files)
 * will not overwrite it.
 */

return [
    // NOTE: the server address is now set in the admin panel (Настройки → Адрес
    // сервера) and stored in the DB — no longer configured here.

    // Shared secret used to encrypt/decrypt connection codes.
    // MUST be identical to CONNECT_SECRET baked into the client
    // (src/server-link.js). Pre-filled to match the shipped client build.
    // Changing it invalidates existing codes (paired clients keep working —
    // they use their device token) and requires rebuilding the client.
    'connect_secret' => '_jXnGmq1caEZ_mr7vh4mpFKh5HMgcYr4K-A0QH7JHamxom7C',

    // Initial password for the admin web panel. After you set a password in the
    // panel (Настройки → Пароль), that one (stored hashed in the DB) is used and
    // this value is ignored.
    'admin_password' => 'CHANGE-ME',

    // A client is shown "online" if its last heartbeat is within this many
    // seconds. Should be a few times the client heartbeat interval (10s).
    'offline_after' => 30,
];
