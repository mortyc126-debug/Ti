// UI popup'а — счётчики собранных и новых, кнопки экспорта и
// массового сбора. Чтение ИНН из буфера обмена.

const $ = id => document.getElementById(id);

function refreshCounter(){
  chrome.storage.local.get(['collected'], data => {
    const collected = data.collected || {};
    const count = Object.keys(collected).length;
    let newTotal = 0;
    for(const k of Object.keys(collected)){
      const e = collected[k];
      if(e && Array.isArray(e.newSinceLastSeen)) newTotal += e.newSinceLastSeen.length;
    }
    $('counter').textContent = String(count);
    $('new-counter').textContent = String(newTotal);
    $('export-btn').disabled = count === 0;
    $('clear-btn').disabled = count === 0;
    $('mark-seen-btn').disabled = newTotal === 0;
  });
}

function exportJson(){
  chrome.storage.local.get(['collected'], data => {
    const collected = data.collected || {};
    const arr = Object.values(collected).map(e => e.payload).filter(Boolean);
    const json = JSON.stringify({
      source: 'e-disclosure-batch',
      exportedAt: new Date().toISOString(),
      count: arr.length,
      items: arr
    });
    navigator.clipboard.writeText(json).then(() => {
      $('export-btn').textContent = '✓ Скопировано';
      setTimeout(() => { $('export-btn').textContent = '📋 Экспорт в буфер (JSON)'; }, 2000);
    }).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = json; document.body.appendChild(ta);
      ta.select(); document.execCommand('copy'); ta.remove();
      $('export-btn').textContent = '✓ Скопировано (fallback)';
      setTimeout(() => { $('export-btn').textContent = '📋 Экспорт в буфер (JSON)'; }, 2000);
    });
  });
}

function markAllSeen(){
  chrome.runtime.sendMessage({ type: 'mark-all-seen' });
  setTimeout(refreshCounter, 200);
}

function clearAll(){
  if(!confirm('Удалить все собранные данные? Отменить нельзя.')) return;
  chrome.storage.local.set({ collected: {} }, refreshCounter);
}

async function pasteFromClipboard(){
  try {
    const text = await navigator.clipboard.readText();
    if(text){
      $('inn-list').value = text.trim();
      const inns = text.split(/[\s,;]+/).map(s => s.trim()).filter(s => /^\d{10}(\d{2})?$/.test(s));
      $('progress').textContent = `Распознано ${inns.length} валидных ИНН в буфере`;
    } else {
      alert('Буфер пуст');
    }
  } catch(e) {
    alert('Не получилось прочитать буфер: ' + (e.message || e) + '\n\nВставь вручную в текстовое поле (Ctrl+V).');
  }
}

function startBatch(){
  const text = $('inn-list').value.trim();
  if(!text){ alert('Вставь список ИНН (один на строку)'); return; }
  const inns = text.split(/[\s,;]+/).map(s => s.trim()).filter(s => /^\d{10}(\d{2})?$/.test(s));
  if(!inns.length){ alert('Не распознано ни одного валидного ИНН (10 или 12 цифр)'); return; }
  if(!confirm(`Запустить обход ${inns.length} ИНН?\n\nРасширение будет открывать вкладки, собирать раскрытия и закрывать. Браузер можно оставить открытым и заниматься другим. Уже собранные за 24ч — пропускаются.`)) return;
  $('start-batch-btn').disabled = true;
  $('start-batch-btn').textContent = '⏳ Идёт обход...';
  $('progress').textContent = '0 / ' + inns.length;
  chrome.runtime.sendMessage({ type: 'start-batch', inns });
}

chrome.runtime.onMessage.addListener((msg) => {
  if(!msg) return;
  if(msg.type === 'batch-progress'){
    const tag = msg.skipped ? '⏭ скип' : (msg.ok ? '✓' : '✗');
    $('progress').textContent = `${msg.idx} / ${msg.total} · ${msg.inn} · ${tag}`;
    refreshCounter();
  }
  if(msg.type === 'batch-done'){
    $('progress').textContent = `Готово: новых ${msg.summary.done}, пропущено ${msg.summary.skipped}, ошибок ${msg.summary.failed}`;
    $('start-batch-btn').disabled = false;
    $('start-batch-btn').textContent = '🚀 Запустить обход';
    refreshCounter();
  }
});

// Восстанавливает UI batch'а если popup открыли во время обхода
// или уже после его завершения — без этого счётчик «X / N» терялся
// при каждом закрытии popup'а (messaging ловил только открытый popup).
function restoreBatchState(){
  chrome.storage.local.get(['batchProgress'], data => {
    const bp = data.batchProgress;
    if(!bp) return;
    if(bp.running){
      $('start-batch-btn').disabled = true;
      $('start-batch-btn').textContent = '⏳ Идёт обход...';
      const s = bp.summary || {};
      const tag = bp.skipped ? '⏭' : (bp.ok ? '✓' : '✗');
      const idx = bp.idx || (s.done + s.failed + s.skipped) || 0;
      $('progress').textContent = `${idx} / ${bp.total} · ${bp.inn || '…'} · ${tag} (done ${s.done||0}, skip ${s.skipped||0}, fail ${s.failed||0}, 404 ${s.notFound||0})`;
    } else if(bp.summary){
      const s = bp.summary;
      $('progress').textContent = `Готово: новых ${s.done}, пропущено ${s.skipped}, ошибок ${s.failed}, не найдено ${s.notFound || 0}`;
    }
  });
}

$('export-btn').onclick = exportJson;
$('mark-seen-btn').onclick = markAllSeen;
$('clear-btn').onclick = clearAll;
$('paste-clipboard-btn').onclick = pasteFromClipboard;
$('start-batch-btn').onclick = startBatch;

refreshCounter();
restoreBatchState();
setInterval(refreshCounter, 1500);
setInterval(restoreBatchState, 1500);
