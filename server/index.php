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

// ── AJAX: clients JSON (polled every 10s by the dashboard) ─────────
if (isset($_GET['ajax']) && $_GET['ajax'] === 'clients') {
    $offlineAfter = (int) cfg('offline_after');
    $rows = $pdo->query('SELECT * FROM clients ORDER BY hostname COLLATE NOCASE ASC, id ASC')->fetchAll();
    $out = [];
    foreach ($rows as $c) {
        $t = $c['last_seen'] ? strtotime($c['last_seen']) : 0;
        $out[] = [
            'id'              => (int) $c['id'],
            'online'          => ($t && (time() - $t) <= $offlineAfter),
            'hostname'        => $c['hostname'],
            'local_ip'        => $c['local_ip'],
            'version'         => $c['version'],
            'profile'         => $c['profile'],
            'last_seen'       => $c['last_seen'],
            'pending_update'  => (int) $c['pending_update'],
            'last_message'    => $c['last_message'],
            'last_message_at' => $c['last_message_at'],
        ];
    }
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($out);
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
    <h2>Клиенты <span class="count" id="clientCount">…</span> <span class="dim" id="refreshTick" style="margin-left:auto;font-weight:400"></span></h2>
    <div class="table-wrap">
    <table>
      <thead><tr><th>Статус</th><th>Имя ПК</th><th>Локальный IP</th><th>Версия</th><th>Профиль</th><th>Сообщение</th><th>Последний контакт</th><th>Действия</th></tr></thead>
      <tbody id="clientsBody">
        <tr><td colspan="8" class="empty">Загрузка…</td></tr>
      </tbody>
    </table>
    </div>
  </section>

  <section class="card">
    <h2>Коды подключения</h2>
    <form method="post" class="inline-form">
      <input type="hidden" name="csrf" value="<?= h($csrf) ?>">
      <input type="hidden" name="action" value="create_code">
      <input type="text" name="label" placeholder="Метка (например: офис 1)" maxlength="100">
      <button>Создать код</button>
    </form>
    <div class="table-wrap">
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
          <td class="dim ts" data-ts="<?= h($code['created_at']) ?>"><?= h($code['created_at']) ?></td>
          <td class="actions">
            <form method="post"><input type="hidden" name="csrf" value="<?= h($csrf) ?>"><input type="hidden" name="action" value="regen_code"><input type="hidden" name="id" value="<?= (int)$code['id'] ?>"><button class="btn-sm ghost">Пересоздать</button></form>
            <form method="post" onsubmit="return confirm('Удалить код?')"><input type="hidden" name="csrf" value="<?= h($csrf) ?>"><input type="hidden" name="action" value="delete_code"><input type="hidden" name="id" value="<?= (int)$code['id'] ?>"><button class="btn-sm danger">✕</button></form>
          </td>
        </tr>
      <?php endforeach; ?>
      </tbody>
    </table>
    </div>
    <p class="hint">Код содержит зашифрованный адрес сервера. Пересоздание/удаление кода не отключает уже подключённые клиенты — они работают по своему постоянному токену.</p>
  </section>
</main>
<script>
const CSRF = <?= json_encode($csrf) ?>;
function esc(s){ const d=document.createElement('div'); d.textContent=(s==null?'':String(s)); return d.innerHTML; }
function cForm(action,id,inner,confirmJs){
  return '<form method="post"'+(confirmJs?(' onsubmit="'+confirmJs+'"'):'')+'>'
    +'<input type="hidden" name="csrf" value="'+esc(CSRF)+'">'
    +'<input type="hidden" name="action" value="'+action+'">'
    +'<input type="hidden" name="id" value="'+id+'">'+inner+'</form>';
}
// Format a stored UTC timestamp in the browser's local timezone.
function fmtTs(iso){
  if(!iso) return '—';
  const d=new Date(iso);
  if(isNaN(d)) return esc(iso);
  return d.toLocaleString();
}
function msgBadge(text){
  if(!text) return '<span class="dim">—</span>';
  let cls='b-neutral';
  if(/ошибк/i.test(text)) cls='b-danger';
  else if(/актуальн/i.test(text)) cls='b-ok';
  else if(/запущен|обновл/i.test(text)) cls='b-info';
  return '<span class="badge '+cls+'">'+esc(text)+'</span>';
}
function clientRow(c){
  const status=c.online
    ? '<span class="badge b-on"><span class="dot"></span>онлайн</span>'
    : '<span class="badge b-off"><span class="dot"></span>офлайн</span>';
  let act='';
  if(c.pending_update){
    act+='<span class="badge b-warn">в очереди</span>';
    act+=cForm('cancel_update',c.id,'<button class="btn-sm ghost">Отменить</button>');
  }else{
    act+=cForm('update_client',c.id,'<button class="btn-sm">Обновить</button>');
  }
  act+=cForm('delete_client',c.id,'<button class="btn-sm danger">✕</button>',"return confirm('Удалить клиента из списка?')");
  const ver=c.version?'<span class="badge b-ver">'+esc(c.version)+'</span>':'<span class="dim">—</span>';
  return '<tr>'
    +'<td>'+status+'</td>'
    +'<td class="mono trunc" title="'+esc(c.hostname||'')+'">'+esc(c.hostname||'—')+'</td>'
    +'<td class="mono">'+esc(c.local_ip||'—')+'</td>'
    +'<td>'+ver+'</td>'
    +'<td class="trunc" title="'+esc(c.profile||'')+'">'+esc(c.profile||'—')+'</td>'
    +'<td>'+msgBadge(c.last_message)+'</td>'
    +'<td class="dim">'+fmtTs(c.last_seen)+'</td>'
    +'<td class="actions">'+act+'</td>'
    +'</tr>';
}
async function refreshClients(){
  try{
    const r=await fetch('index.php?ajax=clients',{cache:'no-store'});
    const list=await r.json();
    const body=document.getElementById('clientsBody');
    document.getElementById('clientCount').textContent=list.length;
    body.innerHTML=list.length?list.map(clientRow).join(''):'<tr><td colspan="8" class="empty">Пока нет подключённых клиентов</td></tr>';
    document.getElementById('refreshTick').textContent='обновлено '+new Date().toLocaleTimeString();
  }catch(e){}
}
// Convert server-rendered timestamps (codes table) to local time.
function localizeStatic(){
  document.querySelectorAll('.ts[data-ts]').forEach(el=>{ el.textContent=fmtTs(el.dataset.ts); });
}
localizeStatic();
refreshClients();
setInterval(refreshClients,10000);
</script>
</body></html>
