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
        } elseif ($action === 'upload_update') {
            $msg = handle_update_upload($pdo);
        } elseif ($action === 'fetch_github') {
            $msg = fetch_update_from_github($pdo);
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
    $fresh = function ($ts) use ($offlineAfter) {
        $t = $ts ? strtotime($ts) : 0;
        return $t && (time() - $t) <= $offlineAfter;
    };
    foreach ($rows as $c) {
        // Prefer the most recent contact (app or service) for "last seen".
        $lastSeen = $c['last_seen'];
        $out[] = [
            'id'              => (int) $c['id'],
            'app_online'      => $fresh($c['app_last_seen']),
            'service_online'  => $fresh($c['service_last_seen']),
            'hostname'        => $c['hostname'],
            'local_ip'        => $c['local_ip'],
            'app_version'     => $c['app_version'],
            'service_version' => $c['service_version'],
            'profile'         => $c['profile'],
            'last_seen'       => $lastSeen,
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
$update  = $pdo->query('SELECT * FROM app_update WHERE id = 1')->fetch();
$csrf = csrf_token();

function is_online($lastSeen, $offlineAfter) {
    if (!$lastSeen) return false;
    $t = strtotime($lastSeen);
    return $t && (time() - $t) <= $offlineAfter;
}
?><!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MailApp — управление</title><link rel="stylesheet" href="assets/style.css">
</head>
<body>
<header class="top">
  <div class="brand">MailApp <span>Server</span></div>
  <form method="post" class="logout"><input type="hidden" name="action" value="logout"><button>Выйти</button></form>
</header>
<main>
  <?php if ($msg): ?><div class="flash"><?= h($msg) ?></div><?php endif; ?>

  <section class="section">
    <div class="section-head">
      <h2>Клиенты</h2>
      <span class="count" id="clientCount">…</span>
      <span class="tick" id="refreshTick"></span>
    </div>
    <div class="stats">
      <div class="stat"><div class="n" id="statTotal">0</div><div class="l">всего</div></div>
      <div class="stat on"><div class="n" id="statOnline">0</div><div class="l">онлайн</div></div>
    </div>
    <div class="panel"><div class="table-wrap">
      <table>
        <thead><tr><th>Статус</th><th>ПК</th><th>Версия</th><th>Профиль</th><th>Контакт</th><th>Действия</th></tr></thead>
        <tbody id="clientsBody"><tr><td colspan="6" class="empty">Загрузка…</td></tr></tbody>
      </table>
    </div></div>
  </section>

  <section class="section">
    <div class="section-head"><h2>Файл обновления</h2></div>
    <div class="panel" style="padding:18px">
      <?php if ($update && $update['filename']): ?>
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px">
          <span class="badge b-ver">v<?= h($update['version']) ?></span>
          <span class="mono dim"><?= h($update['filename']) ?></span>
          <span class="dim"><?= number_format($update['size'] / 1048576, 1) ?> МБ</span>
          <span class="dim ts" data-ts="<?= h($update['uploaded_at']) ?>"><?= h($update['uploaded_at']) ?></span>
        </div>
      <?php else: ?>
        <div class="dim" style="margin-bottom:14px">Файл обновления ещё не загружен — клиенты обновляться не будут.</div>
      <?php endif; ?>
      <form method="post" style="margin-bottom:14px" onsubmit="this.querySelector('button').disabled=true;this.querySelector('button').textContent='Скачивание с GitHub…';">
        <input type="hidden" name="csrf" value="<?= h($csrf) ?>">
        <input type="hidden" name="action" value="fetch_github">
        <button class="btn" type="submit">⬇ Загрузить последнюю с GitHub</button>
      </form>
      <div style="border-top:1px solid var(--line);margin:0 0 14px"></div>
      <form method="post" enctype="multipart/form-data" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <input type="hidden" name="csrf" value="<?= h($csrf) ?>">
        <input type="hidden" name="action" value="upload_update">
        <input type="file" name="installer" accept=".exe" required style="color:var(--muted)">
        <input type="text" name="version" placeholder="Версия (необязательно)" maxlength="32" style="padding:9px 12px;border:1.5px solid var(--line);border-radius:9px;background:var(--card);color:var(--ink);width:200px">
        <button class="btn" type="submit">Загрузить вручную</button>
      </form>
      <p class="hint">Проще всего — <b>«Загрузить последнюю с GitHub»</b> (сервер сам скачает релиз, без лимитов на размер). Или загрузите <code>MailApp-Setup-X.Y.Z.exe</code> вручную. Клиенты обновляются с этого сервера по HTTPS.</p>
    </div>
  </section>

  <section class="section">
    <div class="section-head"><h2>Коды подключения</h2></div>
    <form method="post" class="create-row">
      <input type="hidden" name="csrf" value="<?= h($csrf) ?>">
      <input type="hidden" name="action" value="create_code">
      <input type="text" name="label" placeholder="Метка (например: офис 1)" maxlength="100">
      <button class="btn" type="submit">Создать код</button>
    </form>
    <div class="panel"><div class="table-wrap">
      <table>
        <thead><tr><th>Метка</th><th>Код подключения</th><th>Создан</th><th>Действия</th></tr></thead>
        <tbody>
        <?php if (!$codes): ?>
          <tr><td colspan="4" class="empty">Нет кодов — создайте первый</td></tr>
        <?php endif; ?>
        <?php foreach ($codes as $i => $code):
          $display = make_connect_code($code['token']); ?>
          <tr>
            <td><?= h($code['label'] ?: 'Без метки') ?></td>
            <td class="code-cell"><span class="code-text mono trunc" id="code<?= $i ?>"><?= h($display) ?></span></td>
            <td class="dim ts" data-ts="<?= h($code['created_at']) ?>"><?= h($code['created_at']) ?></td>
            <td><div class="actions">
              <button class="btn-sm" type="button" onclick="copyText('<?= h($display) ?>')">Копировать</button>
              <button class="btn-sm ghost" type="button" onclick="toggleBox('code<?= $i ?>',this)">Показать</button>
              <form method="post"><input type="hidden" name="csrf" value="<?= h($csrf) ?>"><input type="hidden" name="action" value="regen_code"><input type="hidden" name="id" value="<?= (int)$code['id'] ?>"><button class="btn-sm ghost">Пересоздать</button></form>
              <form method="post" onsubmit="return confirm('Удалить код?')"><input type="hidden" name="csrf" value="<?= h($csrf) ?>"><input type="hidden" name="action" value="delete_code"><input type="hidden" name="id" value="<?= (int)$code['id'] ?>"><button class="btn-sm danger">✕</button></form>
            </div></td>
          </tr>
        <?php endforeach; ?>
        </tbody>
      </table>
    </div></div>
    <p class="hint">Код содержит зашифрованный адрес сервера. Пересоздание/удаление кода не отключает уже подключённые клиенты — они работают по своему постоянному токену.</p>
  </section>
</main>
<div id="toast"></div>
<script>
const CSRF = <?= json_encode($csrf) ?>;
function esc(s){ const d=document.createElement('div'); d.textContent=(s==null?'':String(s)); return d.innerHTML; }

// ── toast ──
let toastT=null;
function toast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove('show'),1500); }

// ── copy (works on plain HTTP, where navigator.clipboard is unavailable) ──
function copyText(text){
  if(navigator.clipboard && window.isSecureContext){
    navigator.clipboard.writeText(text).then(()=>toast('Скопировано')).catch(()=>fallbackCopy(text));
  } else { fallbackCopy(text); }
}
function fallbackCopy(text){
  const ta=document.createElement('textarea');
  ta.value=text; ta.setAttribute('readonly','');
  ta.style.position='fixed'; ta.style.top='-1000px'; ta.style.opacity='0';
  document.body.appendChild(ta); ta.focus(); ta.select();
  try{ ta.setSelectionRange(0,ta.value.length); }catch(e){}
  let ok=false; try{ ok=document.execCommand('copy'); }catch(e){}
  document.body.removeChild(ta);
  toast(ok?'Скопировано':'Не удалось скопировать');
}
function toggleBox(id,btn){ const b=document.getElementById(id); b.classList.toggle('shown'); btn.textContent=b.classList.contains('shown')?'Скрыть':'Показать'; }

function cForm(action,id,inner,confirmJs){
  return '<form method="post"'+(confirmJs?(' onsubmit="'+confirmJs+'"'):'')+'>'
    +'<input type="hidden" name="csrf" value="'+esc(CSRF)+'">'
    +'<input type="hidden" name="action" value="'+action+'">'
    +'<input type="hidden" name="id" value="'+id+'">'+inner+'</form>';
}
function fmtTs(iso){ if(!iso) return '—'; const d=new Date(iso); return isNaN(d)?esc(iso):d.toLocaleString(); }
function msgBadge(text){
  if(!text) return '<span class="dim">—</span>';
  let cls='b-neutral';
  if(/ошибк/i.test(text)) cls='b-danger';
  else if(/актуальн/i.test(text)) cls='b-ok';
  else if(/загрузк|запуск|обновл/i.test(text)) cls='b-info';
  return '<span class="badge '+cls+'">'+esc(text)+'</span>';
}
function stBadge(label,online){
  return '<span class="badge '+(online?'b-on':'b-off')+'"><span class="dot"></span>'+label+'</span>';
}
// The Версия cell doubles as the update-status cell: while an update is in
// progress it shows the status instead of the version; "Актуально" is held for
// 20s after completion, then it reverts to the version number.
function versionCell(c){
  if(c.pending_update) return '<span class="badge b-warn">в очереди</span>';
  const msg=c.last_message||'';
  const at=c.last_message_at?Date.parse(c.last_message_at):0;
  const elapsed=at?(Date.now()-at)/1000:1e9;
  if(/ошибк/i.test(msg) && elapsed<120) return msgBadge(msg);
  if(/загрузк|обновл|запуск/i.test(msg) && elapsed<300) return msgBadge(msg);
  if(/актуальн/i.test(msg) && elapsed<20) return msgBadge(msg);   // hold 20s
  return c.service_version?'<span class="badge b-ver">'+esc(c.service_version)+'</span>':'<span class="dim">—</span>';
}
function clientRow(c){
  const status='<div class="st">'+stBadge('Служба',c.service_online)+stBadge('Приложение',c.app_online)+'</div>';
  let act='';
  if(c.pending_update){
    act+=cForm('cancel_update',c.id,'<button class="btn-sm ghost">Отменить</button>');
  }else{
    act+=cForm('update_client',c.id,'<button class="btn-sm">Обновить</button>');
  }
  act+=cForm('delete_client',c.id,'<button class="btn-sm danger">✕</button>',"return confirm('Удалить клиента из списка?')");
  const pc='<div class="pc"><div class="pc-name trunc" title="'+esc(c.hostname||'')+'">'+esc(c.hostname||'—')+'</div>'
          +'<div class="pc-ip mono">'+esc(c.local_ip||'—')+'</div></div>';
  return '<tr>'
    +'<td>'+status+'</td>'
    +'<td>'+pc+'</td>'
    +'<td>'+versionCell(c)+'</td>'
    +'<td class="t-prof trunc" title="'+esc(c.profile||'')+'">'+esc(c.profile||'—')+'</td>'
    +'<td class="dim">'+fmtTs(c.last_seen)+'</td>'
    +'<td><div class="actions">'+act+'</div></td>'
    +'</tr>';
}
async function refreshClients(){
  try{
    const r=await fetch('index.php?ajax=clients',{cache:'no-store'});
    const list=await r.json();
    document.getElementById('clientCount').textContent=list.length;
    document.getElementById('statTotal').textContent=list.length;
    document.getElementById('statOnline').textContent=list.filter(c=>c.app_online||c.service_online).length;
    document.getElementById('clientsBody').innerHTML=list.length?list.map(clientRow).join(''):'<tr><td colspan="6" class="empty">Пока нет подключённых клиентов</td></tr>';
    document.getElementById('refreshTick').textContent='обновлено '+new Date().toLocaleTimeString();
  }catch(e){}
}
function localizeStatic(){ document.querySelectorAll('.ts[data-ts]').forEach(el=>{ el.textContent=fmtTs(el.dataset.ts); }); }
// Auto-hide the flash message after a few seconds.
(function(){
  const fl=document.querySelector('.flash');
  if(!fl) return;
  setTimeout(()=>{ fl.style.transition='opacity .4s'; fl.style.opacity='0'; setTimeout(()=>fl.remove(),400); },3000);
})();
localizeStatic();
refreshClients();
setInterval(refreshClients,5000);
</script>
</body></html>
