// Service worker расширения. Две функции:
//  1. Принимает сообщения от content-скрипта и сохраняет собранные
//     раскрытия в chrome.storage.local под ключом 'collected'.
//     Структура: { [edIdOrInn]: {payload, savedAt} }.
//  2. Batch-режим: получает из popup список ИНН, последовательно
//     открывает поисковые URL на e-disclosure, ждёт пока content.js
//     сам переведёт на карточку и автособерёт, потом закрывает вкладку
//     и переходит к следующей.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if(!msg || typeof msg !== 'object') return;

  if(msg.type === 'save-disclosure' && msg.payload){
    const p = msg.payload;
    const key = p.edId || p.inn || (p.companyName || ('entry_' + Date.now()));
    chrome.storage.local.get(['collected'], data => {
      const collected = data.collected || {};
      collected[key] = { payload: p, savedAt: Date.now() };
      chrome.storage.local.set({ collected });
    });
    return;
  }

  if(msg.type === 'close-tab' && sender.tab && sender.tab.id){
    chrome.tabs.remove(sender.tab.id);
    return;
  }

  if(msg.type === 'start-batch' && Array.isArray(msg.inns)){
    runBatch(msg.inns).then(summary => {
      chrome.runtime.sendMessage({ type: 'batch-done', summary }).catch(() => {});
    });
    sendResponse({ ok: true });
    return true;
  }
});

async function runBatch(inns){
  const summary = { total: inns.length, done: 0, failed: 0, skipped: 0 };
  for(let i = 0; i < inns.length; i++){
    const inn = String(inns[i] || '').trim();
    if(!inn || !/^\d{10}(\d{2})?$/.test(inn)){ summary.skipped++; continue; }

    // Проверяем — вдруг уже собрано не давно (в пределах 24ч), пропускаем
    const stored = await new Promise(r => chrome.storage.local.get(['collected'], d => r(d.collected || {})));
    const existing = Object.values(stored).find(e => e.payload && e.payload.inn === inn);
    const tooRecent = existing && (Date.now() - (existing.savedAt || 0)) < 24 * 3600 * 1000;
    if(tooRecent){ summary.skipped++; continue; }

    // Открываем search URL — content.js сам переведёт на карточку компании
    const url = 'https://www.e-disclosure.ru/portal/companyfind.aspx?query=' + encodeURIComponent(inn);
    const tab = await chrome.tabs.create({ url, active: false });
    // Ждём цикл: search → redirect на company.aspx → scrape + save → close
    const ok = await waitForCollect(inn, tab.id, 20000);
    if(ok) summary.done++;
    else {
      summary.failed++;
      try { await chrome.tabs.remove(tab.id); } catch(_){}
    }
    // Небольшая пауза между запросами, чтобы не душить e-disclosure
    await new Promise(r => setTimeout(r, 2000));

    // Отправляем промежуточный прогресс (если popup открыт)
    try {
      chrome.runtime.sendMessage({ type: 'batch-progress', idx: i + 1, total: inns.length, inn, ok, summary });
    } catch(_){}
  }
  return summary;
}

// Ждёт максимум timeout мс пока в collected появится запись с этим ИНН.
function waitForCollect(inn, tabId, timeoutMs){
  return new Promise(resolve => {
    const start = Date.now();
    const check = () => {
      chrome.storage.local.get(['collected'], data => {
        const collected = data.collected || {};
        const hit = Object.values(collected).some(e => {
          if(!e.payload) return false;
          if(e.payload.inn === inn) return true;
          return (e.savedAt || 0) > start;
        });
        if(hit){ resolve(true); return; }
        if(Date.now() - start > timeoutMs){ resolve(false); return; }
        setTimeout(check, 600);
      });
    };
    check();
  });
}
