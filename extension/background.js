// Service worker расширения БондАналитик: сбор раскрытий.
// v1.3: использует открытый JSON-API e-disclosure.ru для поиска
// компаний по ИНН, минуя SPA-интерфейс и ServicePipe anti-bot на
// поисковой странице. API: /api/search/companies?query=<ИНН>
// возвращает {foundCompaniesList: [{id, name, ...}]}.
//
// Flow batch-режима:
//   1. Для каждого ИНН: fetch API → получаем company.id
//   2. Открываем вкладку /portal/files.aspx?id=<id> — именно там
//      живёт таблица существенных фактов. company.aspx — только
//      общая карточка, events-container там пустой, поэтому batch
//      раньше сохранял payload без events.
//   3. Content.js скрапит таблицу, отправляет данные в background
//   4. Вкладка закрывается, переходим к следующему ИНН

const CRITICAL_PATTERNS = [
  { key: 'default', re: /неисполнени[еяю].*обязательств|просрочк|техническ\w* дефолт|\bдефолт|невыплат/i, label: 'Дефолт/просрочка' },
  { key: 'audit',   re: /смена\s+аудитор|новый аудитор|расторжени.*аудит/i, label: 'Смена аудитора' },
  { key: 'mgmt',    re: /прекращени\w+ полномочи.*директор|избрани\w+.*директор|смен\w+ ген\w*/i, label: 'Смена руководства' },
  { key: 'lawsuit', re: /судебн\w* иск|обращени\w+ в суд|существенн\w+ судебн/i, label: 'Судебный иск' },
];

function detectCritical(title){
  if(!title) return null;
  for(const c of CRITICAL_PATTERNS){ if(c.re.test(title)) return c; }
  return null;
}
function eventKey(e){ return (e.date || '') + '|' + (e.title || '').slice(0, 80); }

// Ищет компанию на e-disclosure по ИНН через их JSON-API.
// Возвращает {id, name, inn} или null.
async function findCompanyByInn(inn){
  try {
    // Пробуем несколько вариантов endpoint'а — у них API может быть
    // с разными параметрами. Сначала канонический вариант.
    const urls = [
      `https://www.e-disclosure.ru/api/search/companies?query=${encodeURIComponent(inn)}&page=1&itemsPerPage=5`,
      `https://www.e-disclosure.ru/api/search/companies?query=${encodeURIComponent(inn)}`,
    ];
    for(const url of urls){
      try {
        const r = await fetch(url, {
          headers: { 'Accept': 'application/json, text/plain, */*' },
          credentials: 'include',
        });
        if(!r.ok) continue;
        const data = await r.json();
        const list = data?.foundCompaniesList || data?.items || [];
        if(list.length){
          const first = list[0];
          return { id: first.id, name: first.name || first.companyName || '', inn: String(inn) };
        }
      } catch(_){}
    }
  } catch(_){}
  return null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if(!msg || typeof msg !== 'object') return;

  if(msg.type === 'save-disclosure' && msg.payload){
    saveAndDiff(msg.payload);
    return;
  }

  if(msg.type === 'close-tab' && sender.tab && sender.tab.id){
    chrome.tabs.remove(sender.tab.id);
    return;
  }

  if(msg.type === 'mark-all-seen'){
    chrome.storage.local.get(['collected'], data => {
      const collected = data.collected || {};
      for(const k of Object.keys(collected)){
        if(collected[k]) collected[k].newSinceLastSeen = [];
      }
      chrome.storage.local.set({ collected });
    });
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

function saveAndDiff(payload){
  const key = payload.edId || payload.inn || payload.companyName || ('entry_' + Date.now());
  chrome.storage.local.get(['collected'], data => {
    const collected = data.collected || {};
    const prev = collected[key];
    let newEvents = [];
    if(prev && prev.payload && Array.isArray(prev.payload.events)){
      const prevKeys = new Set(prev.payload.events.map(eventKey));
      newEvents = (payload.events || []).filter(e => !prevKeys.has(eventKey(e)));
    } else {
      newEvents = (payload.events || []).filter(e => {
        const m = String(e.date || '').match(/(\d{2})\.(\d{2})\.(\d{4})/);
        if(!m) return false;
        const ts = new Date(+m[3], +m[2]-1, +m[1]).getTime();
        return Date.now() - ts < 60 * 86400000;
      });
    }
    const accumulated = (prev && prev.newSinceLastSeen ? prev.newSinceLastSeen : []).concat(newEvents);
    collected[key] = { payload, savedAt: Date.now(), newSinceLastSeen: accumulated };
    chrome.storage.local.set({ collected }, () => {
      const criticalNew = newEvents.map(e => ({ e, c: detectCritical(e.title) })).filter(x => x.c);
      if(criticalNew.length){
        const top = criticalNew[0];
        const more = criticalNew.length > 1 ? ` (и ещё ${criticalNew.length - 1})` : '';
        try {
          chrome.notifications.create({
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icon.png'),
            title: '⚠ ' + (payload.companyName || 'Эмитент') + ' — ' + top.c.label,
            message: top.e.title.slice(0, 120) + more,
            priority: 2,
          });
        } catch(_){}
      }
    });
  });
}

async function runBatch(inns){
  const summary = { total: inns.length, done: 0, failed: 0, skipped: 0, notFound: 0 };
  // Помечаем что обход начался — popup.js при открытии прочитает.
  await chrome.storage.local.set({ batchProgress: { running: true, idx: 0, total: inns.length, summary, startedAt: Date.now() } });
  for(let i = 0; i < inns.length; i++){
    const inn = String(inns[i] || '').trim();
    if(!inn || !/^\d{10}(\d{2})?$/.test(inn)){ summary.skipped++; continue; }

    // Пропуск если собрано за 24ч
    const stored = await new Promise(r => chrome.storage.local.get(['collected'], d => r(d.collected || {})));
    const existing = Object.values(stored).find(e => e.payload && e.payload.inn === inn);
    if(existing && (Date.now() - (existing.savedAt || 0)) < 24 * 3600 * 1000){
      summary.skipped++;
      const progress = { running: true, idx: i + 1, total: inns.length, inn, ok: true, skipped: true, summary };
      await chrome.storage.local.set({ batchProgress: progress });
      try { chrome.runtime.sendMessage({ type: 'batch-progress', ...progress }); } catch(_){}
      continue;
    }

    // Шаг 1: API-поиск по ИНН → получаем company.id
    const company = await findCompanyByInn(inn);
    if(!company || !company.id){
      summary.notFound++;
      summary.failed++;
      const progress = { running: true, idx: i + 1, total: inns.length, inn, ok: false, notFound: true, summary };
      await chrome.storage.local.set({ batchProgress: progress });
      try { chrome.runtime.sendMessage({ type: 'batch-progress', ...progress }); } catch(_){}
      await new Promise(r => setTimeout(r, 800));
      continue;
    }

    // Шаг 2: открываем страницу раскрытий (именно files.aspx, не company.aspx)
    const url = `https://www.e-disclosure.ru/portal/files.aspx?id=${company.id}`;
    const tab = await chrome.tabs.create({ url, active: false });
    const ok = await waitForCollect(inn, company.id, tab.id, 25000);
    if(ok) summary.done++;
    else {
      summary.failed++;
      try { await chrome.tabs.remove(tab.id); } catch(_){}
    }
    await new Promise(r => setTimeout(r, 2000));
    const progress = { running: true, idx: i + 1, total: inns.length, inn, ok, summary };
    await chrome.storage.local.set({ batchProgress: progress });
    try { chrome.runtime.sendMessage({ type: 'batch-progress', ...progress }); } catch(_){}
  }
  // Финальное состояние — обход завершён.
  await chrome.storage.local.set({ batchProgress: { running: false, idx: inns.length, total: inns.length, summary, finishedAt: Date.now() } });
  return summary;
}

function waitForCollect(inn, edId, tabId, timeoutMs){
  return new Promise(resolve => {
    const start = Date.now();
    const check = () => {
      chrome.storage.local.get(['collected'], data => {
        const collected = data.collected || {};
        // Ищем запись либо с правильным ИНН, либо с правильным edId,
        // либо появившуюся после старта. ВАЖНО: засчитываем только
        // если payload.events непустой — иначе «мёртвые» страницы
        // (company.aspx без таблицы фактов, редирект ServicePipe и
        // т.п.) дают пустой payload и батч считает обход успешным.
        const hit = Object.values(collected).some(e => {
          if(!e.payload) return false;
          const hasEvents = Array.isArray(e.payload.events) && e.payload.events.length > 0;
          if(!hasEvents) return false;
          if(e.payload.inn === inn) return true;
          if(String(e.payload.edId || '') === String(edId)) return true;
          return (e.savedAt || 0) > start;
        });
        if(hit){
          // Обогащаем запись ИНН если его нет (пришло из API search)
          chrome.storage.local.get(['collected'], d2 => {
            const cl = d2.collected || {};
            for(const k of Object.keys(cl)){
              const rec = cl[k];
              if(rec && rec.payload && String(rec.payload.edId || '') === String(edId)){
                if(!rec.payload.inn) rec.payload.inn = inn;
              }
            }
            chrome.storage.local.set({ collected: cl });
          });
          resolve(true); return;
        }
        if(Date.now() - start > timeoutMs){ resolve(false); return; }
        setTimeout(check, 600);
      });
    };
    check();
  });
}
