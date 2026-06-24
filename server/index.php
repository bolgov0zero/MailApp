<?php
/**
 * Admin web panel — tabs: Клиенты / Коды / Файлы / Настройки.
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
        if (admin_check_password($_POST['password'] ?? '')) {
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
        admin_require();
        csrf_check();
        $id = (int) ($_POST['id'] ?? 0);
        if ($action === 'create_code') {
            $pdo->prepare('INSERT INTO connect_codes (token, label, active, created_at) VALUES (?,?,1,?)')
                ->execute([random_token(16), clean_str($_POST['label'] ?? ''), now()]);
            $msg = 'Код создан';
        } elseif ($action === 'regen_code') {
            $pdo->prepare('UPDATE connect_codes SET token = ? WHERE id = ?')->execute([random_token(16), $id]);
            $msg = 'Код пересоздан (уже подключённые клиенты не отключаются)';
        } elseif ($action === 'revoke_code') {
            $pdo->prepare('UPDATE connect_codes SET active = 0 WHERE id = ?')->execute([$id]);
            $msg = 'Код отозван';
        } elseif ($action === 'restore_code') {
            $pdo->prepare('UPDATE connect_codes SET active = 1 WHERE id = ?')->execute([$id]);
            $msg = 'Код снова активен';
        } elseif ($action === 'delete_code') {
            $pdo->prepare('DELETE FROM connect_codes WHERE id = ?')->execute([$id]);
            $msg = 'Код удалён';
        } elseif ($action === 'update_client') {
            $pdo->prepare('UPDATE clients SET pending_update = 1 WHERE id = ?')->execute([$id]);
            $msg = 'Команда обновления поставлена в очередь';
        } elseif ($action === 'cancel_update') {
            $pdo->prepare('UPDATE clients SET pending_update = 0 WHERE id = ?')->execute([$id]);
            $msg = 'Команда обновления отменена';
        } elseif ($action === 'delete_client') {
            $pdo->prepare('DELETE FROM clients WHERE id = ?')->execute([$id]);
            $msg = 'Клиент удалён';
        } elseif ($action === 'fetch_github') {
            $msg = fetch_update_from_github($pdo);
        } elseif ($action === 'scan_update') {
            $msg = scan_update_folder($pdo);
        } elseif ($action === 'save_server_url') {
            setting_set('server_url', rtrim(clean_str($_POST['server_url'] ?? '', 200), '/'));
            $msg = 'Адрес сервера сохранён';
        } elseif ($action === 'save_admin_password') {
            $p = (string) ($_POST['password'] ?? '');
            if (strlen($p) < 4) { $msg = 'Пароль слишком короткий'; }
            else { setting_set('admin_password_hash', password_hash($p, PASSWORD_DEFAULT)); $msg = 'Пароль администратора изменён'; }
        }
        // AJAX actions (client buttons): return JSON, no page reload/redirect.
        if (($_POST['ajax'] ?? '') === '1') {
            json_out(['ok' => true, 'msg' => $msg]);
        }
        $tabMap = [
            'create_code' => 'codes', 'regen_code' => 'codes', 'revoke_code' => 'codes',
            'restore_code' => 'codes', 'delete_code' => 'codes',
            'fetch_github' => 'files', 'scan_update' => 'files',
            'save_server_url' => 'settings', 'save_admin_password' => 'settings',
        ];
        $tab = $tabMap[$action] ?? 'clients';
        admin_start_session();
        $_SESSION['flash'] = $msg;
        header('Location: index.php#' . $tab);
        exit;
    }
}

admin_start_session();
if (!empty($_SESSION['flash'])) { $msg = $_SESSION['flash']; unset($_SESSION['flash']); }

// ── Login ──────────────────────────────────────────────────────────
if (!admin_logged_in()) {
    ?><!doctype html><html lang="ru"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>MailApp — вход</title><link rel="stylesheet" href="assets/style.css"></head>
    <body class="login-body">
      <form class="login-card" method="post">
        <h1>MailApp <span>Server</span></h1>
        <input type="hidden" name="action" value="login">
        <input class="inp" type="password" name="password" placeholder="Пароль администратора" autofocus>
        <button class="btn" type="submit">Войти</button>
        <?php if ($msg): ?><div class="err"><?= h($msg) ?></div><?php endif; ?>
      </form>
    </body></html><?php
    exit;
}

// ── AJAX: clients JSON ─────────────────────────────────────────────
if (isset($_GET['ajax']) && $_GET['ajax'] === 'clients') {
    $offlineAfter = (int) cfg('offline_after');
    $rows = $pdo->query('SELECT * FROM clients ORDER BY hostname COLLATE NOCASE ASC, id ASC')->fetchAll();
    $fresh = function ($ts) use ($offlineAfter) { $t = $ts ? strtotime($ts) : 0; return $t && (time() - $t) <= $offlineAfter; };
    $out = [];
    foreach ($rows as $c) {
        $out[] = [
            'id' => (int) $c['id'],
            'app_online' => $fresh($c['app_last_seen']),
            'service_online' => $fresh($c['service_last_seen']),
            'hostname' => $c['hostname'], 'local_ip' => $c['local_ip'],
            'app_version' => $c['app_version'], 'service_version' => $c['service_version'],
            'profile' => $c['profile'], 'last_seen' => $c['last_seen'],
            'pending_update' => (int) $c['pending_update'],
            'last_message' => $c['last_message'], 'last_message_at' => $c['last_message_at'],
        ];
    }
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($out);
    exit;
}

// ── Dashboard data ─────────────────────────────────────────────────
$codes   = $pdo->query('SELECT * FROM connect_codes ORDER BY id DESC')->fetchAll();
$update  = $pdo->query('SELECT * FROM app_update WHERE id = 1')->fetch();
$history = $pdo->query('SELECT * FROM update_history ORDER BY id DESC LIMIT 50')->fetchAll();
$srvUrl  = server_url();
$pwdCustom = setting_get('admin_password_hash', '') !== '';
$csrf = csrf_token();
function csrfField($csrf, $action) {
    return '<input type="hidden" name="csrf" value="' . h($csrf) . '"><input type="hidden" name="action" value="' . h($action) . '">';
}
?><!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MailApp — управление</title><link rel="stylesheet" href="assets/style.css">
</head>
<body>
<header class="top">
  <div class="brand">MailApp <span>Server</span></div>
  <nav class="tabs">
    <button class="tab" data-tab="clients">Клиенты</button>
    <button class="tab" data-tab="codes">Коды</button>
    <button class="tab" data-tab="files">Файлы</button>
    <button class="tab" data-tab="settings">Настройки</button>
  </nav>
  <form method="post" class="logout"><?= csrfField($csrf, 'logout') ?><button>Выйти</button></form>
</header>
<main>
  <?php if ($msg): ?><div class="flash"><?= h($msg) ?></div><?php endif; ?>

  <!-- ── Клиенты ── -->
  <section class="tabpane" id="pane-clients">
    <div class="stats">
      <div class="stat"><div class="n" id="statTotal">0</div><div class="l">всего</div></div>
      <div class="stat on"><div class="n" id="statOnline">0</div><div class="l">онлайн</div></div>
      <div class="stat"><div class="n">v<?= $update && $update['version'] ? h($update['version']) : '—' ?></div><div class="l">на сервере</div></div>
      <div class="cd-wrap" title="до обновления списка">
        <div class="countdown">
          <svg viewBox="0 0 36 36"><circle class="cd-track" cx="18" cy="18" r="15"/><circle class="cd-prog" id="cdRing" cx="18" cy="18" r="15"/></svg>
          <span id="cdNum">5</span>
        </div>
      </div>
    </div>
    <div class="panel"><div class="table-wrap">
      <table>
        <thead><tr><th>Статус</th><th>ПК</th><th class="col-ver">Версия</th><th>Профиль</th><th>Контакт</th><th>Действия</th></tr></thead>
        <tbody id="clientsBody"><tr><td colspan="6" class="empty">Загрузка…</td></tr></tbody>
      </table>
    </div></div>
  </section>

  <!-- ── Коды ── -->
  <section class="tabpane" id="pane-codes">
    <form method="post" class="create-row"><?= csrfField($csrf, 'create_code') ?>
      <input class="inp" type="text" name="label" placeholder="Метка (например: офис 1)" maxlength="100">
      <button class="btn" type="submit">Создать код</button>
    </form>
    <div class="panel"><div class="table-wrap">
      <table>
        <thead><tr><th>Метка</th><th>Статус</th><th>Создан</th><th>Действия</th></tr></thead>
        <tbody>
        <?php if (!$codes): ?>
          <tr><td colspan="4" class="empty">Нет кодов — создайте первый</td></tr>
        <?php endif; ?>
        <?php foreach ($codes as $code):
          $display = make_connect_code($code['token']);
          $revoked = !$code['active']; ?>
          <tr class="<?= $revoked ? 'revoked' : '' ?>">
            <td><?= h($code['label'] ?: 'Без метки') ?></td>
            <td><?= $revoked ? '<span class="badge b-off">отозван</span>' : '<span class="badge b-on"><span class="dot"></span>активен</span>' ?></td>
            <td class="dim ts" data-ts="<?= h($code['created_at']) ?>"><?= h($code['created_at']) ?></td>
            <td><div class="actions">
              <button class="btn-sm ghost" type="button" onclick="showCode('<?= h($display) ?>')">Показать</button>
              <?php if ($revoked): ?>
                <form method="post"><?= csrfField($csrf, 'restore_code') ?><input type="hidden" name="id" value="<?= (int)$code['id'] ?>"><button class="btn-sm">Включить</button></form>
              <?php else: ?>
                <form method="post"><?= csrfField($csrf, 'revoke_code') ?><input type="hidden" name="id" value="<?= (int)$code['id'] ?>"><button class="btn-sm ghost">Отозвать</button></form>
              <?php endif; ?>
              <form method="post"><?= csrfField($csrf, 'regen_code') ?><input type="hidden" name="id" value="<?= (int)$code['id'] ?>"><button class="btn-sm ghost">Пересоздать</button></form>
              <form method="post" onsubmit="return confirm('Удалить код?')"><?= csrfField($csrf, 'delete_code') ?><input type="hidden" name="id" value="<?= (int)$code['id'] ?>"><button class="btn-sm danger">✕</button></form>
            </div></td>
          </tr>
        <?php endforeach; ?>
        </tbody>
      </table>
    </div></div>
    <p class="hint">Код содержит зашифрованный адрес сервера. «Отозвать» делает код непригодным для новых подключений (его всё ещё можно посмотреть). Уже подключённые клиенты не отключаются.</p>
  </section>

  <!-- ── Файлы ── -->
  <section class="tabpane" id="pane-files">
    <div class="panel" style="padding:18px">
      <div class="card-label">Текущий файл обновления</div>
      <?php if ($update && $update['filename']): ?>
        <div class="fileinfo">
          <span class="badge b-ver">v<?= h($update['version']) ?></span>
          <span class="mono dim trunc"><?= h($update['filename']) ?></span>
          <span class="dim"><?= number_format($update['size'] / 1048576, 1) ?> МБ</span>
          <span class="dim ts" data-ts="<?= h($update['uploaded_at']) ?>"><?= h($update['uploaded_at']) ?></span>
        </div>
      <?php else: ?>
        <div class="dim" style="margin:6px 0 14px">Файл обновления ещё не загружен — клиенты обновляться не будут.</div>
      <?php endif; ?>
      <div class="btn-row">
        <form method="post" onsubmit="this.querySelector('button').disabled=true;this.querySelector('button').textContent='Скачивание…';">
          <?= csrfField($csrf, 'fetch_github') ?>
          <button class="btn" type="submit">⬇ Загрузить последнюю с GitHub</button>
        </form>
        <form method="post">
          <?= csrfField($csrf, 'scan_update') ?>
          <button class="btn ghost" type="submit">Сканировать папку</button>
        </form>
      </div>
      <p class="hint">«Загрузить с GitHub» — сервер сам скачает релиз. «Сканировать папку» — если вы положили <code>MailApp-Setup-X.Y.Z.exe</code> в <code>updates/</code> вручную (через SFTP). Клиенты обновляются с этого сервера по HTTPS.</p>
    </div>

    <div class="panel" style="margin-top:18px"><div class="table-wrap">
      <div style="padding:14px 16px 4px"><div class="card-label">История версий</div></div>
      <table>
        <thead><tr><th>Версия</th><th>Источник</th><th>Дата</th></tr></thead>
        <tbody>
        <?php if (!$history): ?><tr><td colspan="3" class="empty">Пока пусто</td></tr><?php endif; ?>
        <?php foreach ($history as $hh): ?>
          <tr>
            <td><span class="badge b-ver">v<?= h($hh['version']) ?></span></td>
            <td class="dim"><?= $hh['source'] === 'github' ? 'GitHub' : ($hh['source'] === 'scan' ? 'Папка' : 'Загрузка') ?></td>
            <td class="dim ts" data-ts="<?= h($hh['at']) ?>"><?= h($hh['at']) ?></td>
          </tr>
        <?php endforeach; ?>
        </tbody>
      </table>
    </div></div>
  </section>

  <!-- ── Настройки ── -->
  <section class="tabpane" id="pane-settings">
    <div class="panel" style="padding:18px;max-width:560px">
      <div class="card-label">Адрес сервера</div>
      <p class="hint" style="margin:4px 0 12px">Используется в кодах подключения и для скачивания обновлений. Например <code>https://mailapp.local</code> (без слэша на конце).</p>
      <form method="post" class="settings-row">
        <?= csrfField($csrf, 'save_server_url') ?>
        <input class="inp" type="text" name="server_url" value="<?= h($srvUrl) ?>" placeholder="https://…" style="flex:1">
        <button class="btn" type="submit">Сохранить</button>
      </form>
      <?php if ($srvUrl === ''): ?><div class="warn-line">⚠ Адрес не задан — коды подключения и обновления работать не будут.</div><?php endif; ?>
    </div>

    <div class="panel" style="padding:18px;max-width:560px;margin-top:18px">
      <div class="card-label">Пароль администратора</div>
      <p class="hint" style="margin:4px 0 12px"><?= $pwdCustom ? 'Используется пароль, заданный здесь.' : 'Сейчас используется пароль из config.php. Задайте новый, чтобы хранить его в базе.' ?></p>
      <form method="post" class="settings-row">
        <?= csrfField($csrf, 'save_admin_password') ?>
        <input class="inp" type="password" name="password" placeholder="Новый пароль" style="flex:1">
        <button class="btn" type="submit">Изменить</button>
      </form>
    </div>
  </section>
</main>

<div id="toast"></div>
<div id="modal" class="modal-overlay" onclick="if(event.target===this)closeModal()">
  <div class="modal">
    <div class="modal-head"><b>Код подключения</b><button class="modal-x" type="button" onclick="closeModal()">✕</button></div>
    <div class="modal-body mono" id="modalBody"></div>
    <div class="modal-foot"><button class="btn" type="button" onclick="copyText(window.__modalCode)">Копировать</button></div>
  </div>
</div>

<script>
const CSRF = <?= json_encode($csrf) ?>;
const SRV_VER = <?= json_encode($update && $update['version'] ? $update['version'] : '') ?>;
function esc(s){ const d=document.createElement('div'); d.textContent=(s==null?'':String(s)); return d.innerHTML; }

// Compare a client version to the version uploaded on the server.
// eq → up to date (green), one → behind by one patch (orange), far → further behind (red).
function verState(client){
  if(!SRV_VER || !client) return 'plain';
  const a=String(client).split('.').map(n=>parseInt(n,10)||0);
  const b=String(SRV_VER).split('.').map(n=>parseInt(n,10)||0);
  for(let i=0;i<3;i++){ a[i]=a[i]||0; b[i]=b[i]||0; }
  if(a[0]===b[0]&&a[1]===b[1]&&a[2]===b[2]) return 'eq';
  const clientNewer = a[0]>b[0] || (a[0]===b[0]&&a[1]>b[1]) || (a[0]===b[0]&&a[1]===b[1]&&a[2]>b[2]);
  if(clientNewer) return 'eq';
  if(a[0]===b[0] && a[1]===b[1] && (b[2]-a[2])===1) return 'one';
  return 'far';
}
function verBadge(ver){
  const cls={eq:'b-ok',one:'b-warn',far:'b-danger',plain:'b-ver'}[verState(ver)];
  return '<span class="badge '+cls+'">'+esc(ver)+'</span>';
}

// ── tabs ──
function switchTab(name){
  if(!name) name='clients';
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===name));
  document.querySelectorAll('.tabpane').forEach(p=>p.classList.toggle('active',p.id==='pane-'+name));
  if(location.hash.slice(1)!==name) history.replaceState(null,'','#'+name);
}
document.querySelectorAll('.tab').forEach(t=>t.addEventListener('click',()=>switchTab(t.dataset.tab)));
switchTab((location.hash.slice(1))||'clients');

// ── toast ──
let toastT=null;
function toast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove('show'),1500); }

// ── modal ──
function showCode(code){ window.__modalCode=code; document.getElementById('modalBody').textContent=code; document.getElementById('modal').classList.add('show'); }
function closeModal(){ document.getElementById('modal').classList.remove('show'); }
document.addEventListener('keydown',e=>{ if(e.key==='Escape')closeModal(); });

// ── copy (works on plain HTTP) ──
function copyText(text){
  if(navigator.clipboard && window.isSecureContext){ navigator.clipboard.writeText(text).then(()=>toast('Скопировано')).catch(()=>fallbackCopy(text)); }
  else { fallbackCopy(text); }
}
function fallbackCopy(text){
  const ta=document.createElement('textarea'); ta.value=text; ta.setAttribute('readonly','');
  ta.style.position='fixed'; ta.style.top='-1000px'; ta.style.opacity='0';
  document.body.appendChild(ta); ta.focus(); ta.select();
  let ok=false; try{ ok=document.execCommand('copy'); }catch(e){}
  document.body.removeChild(ta); toast(ok?'Скопировано':'Не удалось скопировать');
}

function cForm(action,id,inner,confirmJs){
  return '<form method="post"'+(confirmJs?(' onsubmit="'+confirmJs+'"'):'')+'>'
    +'<input type="hidden" name="csrf" value="'+esc(CSRF)+'">'
    +'<input type="hidden" name="action" value="'+action+'">'
    +'<input type="hidden" name="id" value="'+id+'">'+inner+'</form>';
}
// Per-client action without page reload (keeps scroll position).
async function postAction(action,id,confirmMsg){
  if(confirmMsg && !confirm(confirmMsg)) return;
  try{
    const body=new URLSearchParams({csrf:CSRF,action:action,id:String(id),ajax:'1'});
    const r=await fetch('index.php',{method:'POST',body});
    const j=await r.json().catch(()=>({ok:false}));
    if(j.ok){ if(j.msg)toast(j.msg); refreshClients(); }
    else { toast('Ошибка'); }
  }catch(e){ toast('Ошибка сети'); }
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
function stBadge(label,online){ return '<span class="badge '+(online?'b-on':'b-off')+'"><span class="dot"></span>'+label+'</span>'; }
function versionCell(c){
  if(c.pending_update) return '<span class="badge b-warn">в очереди</span>';
  const msg=c.last_message||''; const at=c.last_message_at?Date.parse(c.last_message_at):0;
  const elapsed=at?(Date.now()-at)/1000:1e9;
  if(/ошибк/i.test(msg) && elapsed<120) return msgBadge(msg);
  if(/загрузк|обновл|запуск/i.test(msg) && elapsed<300) return msgBadge(msg);
  if(/актуальн/i.test(msg) && elapsed<20) return msgBadge(msg);
  return c.service_version?verBadge(c.service_version):'<span class="dim">—</span>';
}
function clientRow(c){
  const status='<div class="st">'+stBadge('Служба',c.service_online)+stBadge('Приложение',c.app_online)+'</div>';
  let act='';
  if(c.pending_update){ act+='<button class="btn-sm ghost" onclick="postAction(\'cancel_update\','+c.id+')">Отменить</button>'; }
  else { act+='<button class="btn-sm" onclick="postAction(\'update_client\','+c.id+')">Обновить</button>'; }
  act+='<button class="btn-sm del" onclick="postAction(\'delete_client\','+c.id+',\'Удалить клиента из списка?\')">✕</button>';
  const host=c.hostname?esc(c.hostname.toUpperCase()):'—';
  const pc='<div class="pc"><div class="pc-name trunc" title="'+esc((c.hostname||'').toUpperCase())+'">'+host+'</div><div class="pc-ip mono">'+esc(c.local_ip||'—')+'</div></div>';
  const prof=c.profile?('<span title="'+esc(c.profile)+'">'+esc(c.profile)+'</span>'):'<span class="dim">Не настроен</span>';
  return '<tr><td>'+status+'</td><td>'+pc+'</td><td class="col-ver">'+versionCell(c)+'</td>'
    +'<td class="t-prof trunc">'+prof+'</td>'
    +'<td class="dim">'+fmtTs(c.last_seen)+'</td><td><div class="actions">'+act+'</div></td></tr>';
}

// ── countdown ring (driven by real time, synced to the actual refresh) ──
const CD_TOTAL=5, CD_C=94.25;   // 5s, circumference for r=15
let cdNext=Date.now()+CD_TOTAL*1000;
function resetCd(){ cdNext=Date.now()+CD_TOTAL*1000; }
setInterval(()=>{
  const rem=Math.max(0,(cdNext-Date.now())/1000);
  const n=document.getElementById('cdNum'); if(n)n.textContent=Math.max(1,Math.ceil(rem));
  const ring=document.getElementById('cdRing'); if(ring)ring.style.strokeDashoffset=(CD_C*(1-rem/CD_TOTAL)).toFixed(1);
},100);

async function refreshClients(){
  try{
    const r=await fetch('index.php?ajax=clients',{cache:'no-store'});
    const list=await r.json();
    document.getElementById('statTotal').textContent=list.length;
    document.getElementById('statOnline').textContent=list.filter(c=>c.app_online||c.service_online).length;
    document.getElementById('clientsBody').innerHTML=list.length?list.map(clientRow).join(''):'<tr><td colspan="6" class="empty">Пока нет подключённых клиентов</td></tr>';
  }catch(e){}
  resetCd();
}
function localizeStatic(){ document.querySelectorAll('.ts[data-ts]').forEach(el=>{ el.textContent=fmtTs(el.dataset.ts); }); }
(function(){
  const fl=document.querySelector('.flash'); if(!fl) return;
  requestAnimationFrame(()=>requestAnimationFrame(()=>fl.classList.add('show'))); // slide/fade in
  setTimeout(()=>{ fl.classList.remove('show'); setTimeout(()=>fl.remove(),350); },3000); // fade out
})();
localizeStatic();
refreshClients();
setInterval(refreshClients,5000);
</script>
</body></html>
