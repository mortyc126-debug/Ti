// UI popup'а. Показывает счётчик собранных компаний, кнопку экспорта
// и массовый сбор по списку ИНН.

const $ = id => document.getElementById(id);

function refreshCounter(){
  chrome.storage.local.get(['collected'], data => {
    const collected = data.collected || {};
    const count = Object.keys(collected).length;
    $('counter').textContent = String(count);
    $('export-btn').disabled = count === 0;
    $('clear-btn').disabled = count === 0;
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
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = json;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      $('export-btn').textContent = '✓ Скопировано (fallback)';
      setTimeout(() => { $('export-btn').textContent = '📋 Экспорт в буфер (JSON)'; }, 2000);
    });
  });
}

function clearAll(){
  if(!confirm('Удалить все собранные данные? Отменить нельзя.')) return;
  chrome.storage.local.set({ collected: {} }, refreshCounter);
}

function startBatch(){
  const text = $('inn-list').value.trim();
  if(!text){ alert('Вставь список ИНН (один на строку)'); return; }
  const inns = text.split(/[\s,;]+/).map(s => s.trim()).filter(s => /^\d{10}(\d{2})?$/.test(s));
  if(!inns.length){ alert('Не распознано ни одного валидного ИНН (10 или 12 цифр)'); return; }
  if(!confirm(`Запустить обход ${inns.length} ИНН? Расширение будет поочерёдно открывать вкладки на e-disclosure, собирать раскрытия и закрывать. Браузер можно оставить открытым и заниматься другим, но не закрывать.`)) return;

  $('start-batch-btn').disabled = true;
  $('start-batch-btn').textContent = '⏳ Идёт обход...';
  $('progress').textContent = '0 / ' + inns.length;

  chrome.runtime.sendMessage({ type: 'start-batch', inns });
}

// Слушаем прогресс от background
chrome.runtime.onMessage.addListener((msg) => {
  if(!msg) return;
  if(msg.type === 'batch-progress'){
    $('progress').textContent = `${msg.idx} / ${msg.total} · текущий ИНН ${msg.inn} · ${msg.ok ? '✓' : '✗'}`;
    refreshCounter();
  }
  if(msg.type === 'batch-done'){
    $('progress').textContent = `Готово: обработано ${msg.summary.done}, пропущено ${msg.summary.skipped}, ошибок ${msg.summary.failed}`;
    $('start-batch-btn').disabled = false;
    $('start-batch-btn').textContent = '🚀 Запустить обход';
    refreshCounter();
  }
});

$('export-btn').onclick = exportJson;
$('clear-btn').onclick = clearAll;
$('start-batch-btn').onclick = startBatch;

refreshCounter();
// Автообновление счётчика пока попап открыт
setInterval(refreshCounter, 1500);
