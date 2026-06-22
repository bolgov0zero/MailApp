<?php
/**
 * Admin web panel: login, client list (sorted by hostname), connection-code
 * management, and per-client "update" command.
 */
require __DIR__ . '/helpers.php';
require __DIR__ . '/db.php';

$pdo = db();
$msg = '';

// ── POST actions ───────────────────────────────────────────────────
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $action = isset($_POST['action']) ? $_POST['action'] : '';

    if ($action === 'login') {
        admin_start_session();
        if (hash_equals((string) cfg('admin_password'), (string) ($_POST['password'] ?? ''))) {
            $_SESSION['admin'] = true;
            header('Location: index.php');
            exit;
        }
        $msg = 'Неверный пароль';
    } elseif ($action === 'logout') {
        admin_start_session();
        $_SESSION = [];
        session_destroy();
        header('Location: index.php');
        exit;
    } else {
        // All other actions require auth + CSRF.
        admin_require();
        csrf_check();
        if ($action === 'create_code') {
            $st = $pdo->prepare('INSERT INTO connect_codes (token, label, active, created_at) VALUES (?,?,1,?)');
            $st->execute([random_token(16), clean_str($_POST['label'] ?? ''), now()]);
            $msg = 'Код создан';
        } elseif ($action === 'regen_code') {
            $st = $pdo->prepare('UPDATE connect_codes SET token = ? WHERE id = ?');
            $st->execute([random_token(16), (int) ($_POST['id'] ?? 0)]);
            $msg = 'Код пересоздан (уже подключённые клиенты не отключаются)';
        } elseif ($action === 'delete_code') {
            $pdo->prepare('DELETE FROM connect_codes WHERE id = ?')->execute([(int) ($_POST['id'] ?? 0)]);
            $msg = 'Код удалён';
        } elseif ($action === 'update_client') {
            $pdo->prepare('UPDATE clients SET pending_update = 1 WHERE id = ?')->execute([(int) ($_POST['id'] ?? 0)]);
            $msg = 'Команда обновления поставлена в очередь';
        } elseif ($action === 'cancel_update') {
            $pdo->prepare('UPDATE clients SET pending_update = 0 WHERE id = ?')->execute([(int) ($_POST['id'] ?? 0)]);
            $msg = 'Команда обновления отменена';
        } elseif ($action === 'delete_client') {
            $pdo->prepare('DELETE FROM clients WHERE id = ?')->execute([(int) ($_POST['id'] ?? 0)]);
            $msg = 'Клиент удалён';
        }
        // PRG: avoid resubmits
        admin_start_session();
        $_SESSION['flash'] = $msg;
        header('Location: index.php');
        exit;
    }
}

admin_start_session();
if (!empty($_SESSION['flash'])) { $msg = $_SESSION['flash']; unset($_SESSION['flash']); }

// ── Login screen ───────────────────────────────────────────────────
if (!admin_logged_in()) {
    ?><!doctype html><html lang="ru"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>MailApp — вход</title><link rel="stylesheet" href="assets/style.css"></head>
    <body class="login-body">
      <form class="login-card" method="post">
        <h1>MailApp Server</h1>
        <input type="hidden" name="action" value="login">
        <input type="password" name="password" placeholder="Пароль администратора" autofocus>
        <button type="submit">Войти</button>
        <?php if ($msg): ?><div class="err"><?= h($msg) ?></div><?php endif; ?>
      </form>
    </body></html><?php
    exit;
}

// ── Dashboard ──────────────────────────────────────────────────────
$offlineAfter = (int) cfg('offline_after');
$clients = $pdo->query('SELECT * FROM clients ORDER BY hostname COLLATE NOCASE ASC, id ASC')->fetchAll();
$codes   = $pdo->query('SELECT * FROM connect_codes ORDER BY id DESC')->fetchAll();
$csrf = csrf_token();

function is_online($lastSeen, $offlineAfter) {
    if (!$lastSeen) return false;
    $t = strtotime($lastSeen);
    return $t && (time() - $t) <= $offlineAfter;
}
?><!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MailApp — управление</title><link rel="stylesheet" href="assets/style.css">
<script>
function copyCode(el){ navigator.clipboard.writeText(el.dataset.code).then(()=>{el.textContent='Скопировано';setTimeout(()=>el.textContent='Копировать',1200);}); }
function toggleCode(el){ const s=el.previousElementSibling; s.classList.toggle('shown'); el.textContent=s.classList.contains('shown')?'Скрыть':'Показать'; }
</script></head>
<body>
<header class="top">
  <div class="brand">MailApp <span>Server</span></div>
  <form method="post" class="logout"><input type="hidden" name="action" value="logout"><button>Выйти</button></form>
</header>
<main>
  <?php if ($msg): ?><div class="flash"><?= h($msg) ?></div><?php endif; ?>

  <section class="card">
    <h2>Клиенты <span class="count"><?= count($clients) ?></span></h2>
    <table>
      <thead><tr><th>Статус</th><th>Имя ПК</th><th>Локальный IP</th><th>Версия</th><th>Профиль</th><th>Последний контакт</th><th>Действия</th></tr></thead>
      <tbody>
      <?php if (!$clients): ?>
        <tr><td colspan="7" class="empty">Пока нет подключённых клиентов</td></tr>
      <?php endif; ?>
      <?php foreach ($clients as $c):
        $online = is_online($c['last_seen'], $offlineAfter); ?>
        <tr>
          <td><span class="dot <?= $online ? 'on' : 'off' ?>"></span><?= $online ? 'онлайн' : 'офлайн' ?></td>
          <td class="mono"><?= h($c['hostname'] ?: '—') ?></td>
          <td class="mono"><?= h($c['local_ip'] ?: '—') ?></td>
          <td><?= h($c['version'] ?: '—') ?></td>
          <td><?= h($c['profile'] ?: '—') ?></td>
          <td class="dim"><?= h($c['last_seen'] ?: '—') ?></td>
          <td class="actions">
            <?php if ($c['pending_update']): ?>
              <span class="badge">обновление в очереди</span>
              <form method="post"><input type="hidden" name="csrf" value="<?= h($csrf) ?>"><input type="hidden" name="action" value="cancel_update"><input type="hidden" name="id" value="<?= (int)$c['id'] ?>"><button class="btn-sm ghost">Отменить</button></form>
            <?php else: ?>
              <form method="post"><input type="hidden" name="csrf" value="<?= h($csrf) ?>"><input type="hidden" name="action" value="update_client"><input type="hidden" name="id" value="<?= (int)$c['id'] ?>"><button class="btn-sm">Обновить</button></form>
            <?php endif; ?>
            <form method="post" onsubmit="return confirm('Удалить клиента из списка?')"><input type="hidden" name="csrf" value="<?= h($csrf) ?>"><input type="hidden" name="action" value="delete_client"><input type="hidden" name="id" value="<?= (int)$c['id'] ?>"><button class="btn-sm danger">✕</button></form>
          </td>
        </tr>
      <?php endforeach; ?>
      </tbody>
    </table>
  </section>

  <section class="card">
    <h2>Коды подключения</h2>
    <form method="post" class="inline-form">
      <input type="hidden" name="csrf" value="<?= h($csrf) ?>">
      <input type="hidden" name="action" value="create_code">
      <input type="text" name="label" placeholder="Метка (например: офис 1)" maxlength="100">
      <button>Создать код</button>
    </form>
    <table>
      <thead><tr><th>Метка</th><th>Код подключения</th><th>Создан</th><th>Действия</th></tr></thead>
      <tbody>
      <?php if (!$codes): ?>
        <tr><td colspan="4" class="empty">Нет кодов — создайте первый</td></tr>
      <?php endif; ?>
      <?php foreach ($codes as $code):
        $display = make_connect_code($code['token']); ?>
        <tr>
          <td><?= h($code['label'] ?: '—') ?></td>
          <td>
            <span class="code-val mono"><?= h($display) ?></span>
            <a class="link" onclick="toggleCode(this)">Показать</a>
            <a class="link" data-code="<?= h($display) ?>" onclick="copyCode(this)">Копировать</a>
          </td>
          <td class="dim"><?= h($code['created_at']) ?></td>
          <td class="actions">
            <form method="post"><input type="hidden" name="csrf" value="<?= h($csrf) ?>"><input type="hidden" name="action" value="regen_code"><input type="hidden" name="id" value="<?= (int)$code['id'] ?>"><button class="btn-sm ghost">Пересоздать</button></form>
            <form method="post" onsubmit="return confirm('Удалить код?')"><input type="hidden" name="csrf" value="<?= h($csrf) ?>"><input type="hidden" name="action" value="delete_code"><input type="hidden" name="id" value="<?= (int)$code['id'] ?>"><button class="btn-sm danger">✕</button></form>
          </td>
        </tr>
      <?php endforeach; ?>
      </tbody>
    </table>
    <p class="hint">Код содержит зашифрованный адрес сервера. Пересоздание/удаление кода не отключает уже подключённые клиенты — они работают по своему постоянному токену.</p>
  </section>
</main>
</body></html>
