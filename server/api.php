<?php
/**
 * Client-facing endpoint (called by the MailApp client over HTTP).
 *
 *   POST { "action":"pair", "pair_token":"...", hostname, local_ip, version, profile }
 *     -> { ok:true, device_token:"..." }            (one-time pairing)
 *
 *   POST { "action":"heartbeat", "device_token":"...", hostname, local_ip, version, profile }
 *     -> { ok:true, command:"update"|null }          (periodic)
 *
 * Notes:
 *  - Commands are triggers only; they never carry a download URL. The client
 *    always fetches the binary from its hard-coded GitHub feed.
 *  - Regenerating/deleting a connection code does NOT affect already-paired
 *    clients: they authenticate with their own device_token.
 */
require __DIR__ . '/helpers.php';
require __DIR__ . '/db.php';

$in = read_json_body();
$action = isset($in['action']) ? $in['action'] : '';
$pdo = db();

if ($action === 'pair') {
    $pairToken = clean_str(isset($in['pair_token']) ? $in['pair_token'] : '', 80);
    if ($pairToken === '') json_out(['ok' => false, 'error' => 'no_code'], 400);

    $st = $pdo->prepare('SELECT id FROM connect_codes WHERE token = ? AND active = 1');
    $st->execute([$pairToken]);
    if (!$st->fetch()) json_out(['ok' => false, 'error' => 'invalid_code'], 403);

    $deviceToken = random_token(24);
    $st = $pdo->prepare(
        'INSERT INTO clients (device_token, hostname, local_ip, version, profile, created_at, last_seen)
         VALUES (?,?,?,?,?,?,?)'
    );
    $st->execute([
        $deviceToken,
        clean_str($in['hostname'] ?? ''),
        clean_str($in['local_ip'] ?? '', 64),
        clean_str($in['version'] ?? '', 32),
        clean_str($in['profile'] ?? ''),
        now(),
        now(),
    ]);
    json_out(['ok' => true, 'device_token' => $deviceToken]);
}

if ($action === 'heartbeat') {
    $deviceToken = clean_str(isset($in['device_token']) ? $in['device_token'] : '', 80);
    if ($deviceToken === '') json_out(['ok' => false, 'error' => 'no_token'], 400);

    $st = $pdo->prepare('SELECT id, pending_update FROM clients WHERE device_token = ?');
    $st->execute([$deviceToken]);
    $client = $st->fetch();
    if (!$client) json_out(['ok' => false, 'error' => 'unknown_device'], 403);

    $up = $pdo->prepare(
        'UPDATE clients SET hostname=?, local_ip=?, version=?, profile=?, last_seen=? WHERE id=?'
    );
    $up->execute([
        clean_str($in['hostname'] ?? ''),
        clean_str($in['local_ip'] ?? '', 64),
        clean_str($in['version'] ?? '', 32),
        clean_str($in['profile'] ?? ''),
        now(),
        $client['id'],
    ]);

    // Optional status report from a previous update command.
    if (isset($in['report']) && $in['report'] !== '') {
        $messages = [
            'up_to_date' => 'Уже актуальная версия',
            'updating'   => 'Обновление запущено',
            'error'      => 'Ошибка обновления',
        ];
        $code = clean_str($in['report'], 32);
        $msg = isset($messages[$code]) ? $messages[$code] : $code;
        $pdo->prepare('UPDATE clients SET last_message=?, last_message_at=? WHERE id=?')
            ->execute([$msg, now(), $client['id']]);
    }

    $command = null;
    if (!empty($client['pending_update'])) {
        $command = 'update';
        // One-shot: clear the flag so it fires once. Admin can press again.
        $pdo->prepare('UPDATE clients SET pending_update = 0 WHERE id = ?')->execute([$client['id']]);
    }
    json_out(['ok' => true, 'command' => $command]);
}

json_out(['ok' => false, 'error' => 'bad_action'], 400);
