// Service worker расширения БондАналитик: сбор раскрытий.
// Функции:
//  1) Сохранение в chrome.storage.local результатов сбора. Кэш по
//     ключу edId или ИНН: { payload, savedAt, newSinceLastSeen }.
//  2) DIFF: при повторном сборе сравнивает события с предыдущим
//     снимком. Новые события (отсутствовавшие раньше) кладёт в
//     newSinceLastSeen массив до тех пор пока пользовательница не
//     откроет popup или экспорт (тогда чистится).
//  3) NOTIFICATIONS: если среди новых событий есть КРИТИЧНЫЕ
//     (определяем по regex-категориям), показываем chrome.notifications.
//  4) BATCH: получает из popup список ИНН → поочерёдно открывает
//     поисковые URL → content.js перенаправляет на компанию →
//     автосбор → закрытие вкладки → следующий ИНН.
//
// Категории событий — те же что в приложении (8 шт). При категоризации
// тут опустим — приложение делает категоризацию при импорте, нам нужны
// только СИЛЬНЫЕ regex'ы для выбора «критичных» событий для уведомления.

const CRITICAL_PATTERNS = [
  { key: 'default', re: /неисполнени[еяю].*обязательств|просрочк|техническ\w* дефолт|\bдефолт|невыплат/i,
    label: 'Дефолт/просрочка' },
  { key: 'audit',   re: /смена\s+аудитор|новый аудитор|расторжени.*аудит/i, label: 'Смена аудитора' },
  { key: 'mgmt',    re: /прекращени\w+ полномочи.*директор|избрани\w+.*директор|смен\w+ ген\w*/i, label: 'Смена руководства' },
  { key: 'lawsuit', re: /судебн\w* иск|обращени\w+ в суд|существенн\w+ судебн/i, label: 'Судебный иск' },
];

function detectCritical(title){
  if(!title) return null;
  for(const c of CRITICAL_PATTERNS){
    if(c.re.test(title)) return c;
  }
  return null;
}

function eventKey(e){ return (e.date || '') + '|' + (e.title || '').slice(0, 80); }

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
      // Первый сбор — все события считаем новыми (но без spam-уведомлений
      // на старые: уведомление только если есть КРИТИЧНЫЕ среди свежих
      // < 60 дней)
      newEvents = (payload.events || []).filter(e => {
        const m = String(e.date || '').match(/(\d{2})\.(\d{2})\.(\d{4})/);
        if(!m) return false;
        const ts = new Date(+m[3], +m[2]-1, +m[1]).getTime();
        return Date.now() - ts < 60 * 86400000;
      });
    }

    const accumulated = (prev && prev.newSinceLastSeen ? prev.newSinceLastSeen : []).concat(newEvents);
    collected[key] = {
      payload,
      savedAt: Date.now(),
      newSinceLastSeen: accumulated,
    };
    chrome.storage.local.set({ collected }, () => {
      // Уведомление, если среди новых есть критичное
      const criticalNew = newEvents.map(e => ({ e, c: detectCritical(e.title) })).filter(x => x.c);
      if(criticalNew.length){
        const top = criticalNew[0];
        const more = criticalNew.length > 1 ? ` (и ещё ${criticalNew.length - 1})` : '';
        try {
          chrome.notifications.create({
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icon.png'),  // optional, fallback OK
            title: '⚠ ' + (payload.companyName || 'Эмитент') + ' — ' + top.c.label,
            message: top.e.title.slice(0, 120) + more,
            priority: 2,
          });
        } catch(_){
          // icon optional, без него тоже работает в большинстве версий
        }
      }
    });
  });
}

async function runBatch(inns){
  const summary = { total: inns.length, done: 0, failed: 0, skipped: 0 };
  for(let i = 0; i < inns.length; i++){
    const inn = String(inns[i] || '').trim();
    if(!inn || !/^\d{10}(\d{2})?$/.test(inn)){ summary.skipped++; continue; }

    // Если есть свежий снимок (<24ч) — пропуск чтобы не дёргать сайт
    const stored = await new Promise(r => chrome.storage.local.get(['collected'], d => r(d.collected || {})));
    const existing = Object.values(stored).find(e => e.payload && e.payload.inn === inn);
    if(existing && (Date.now() - (existing.savedAt || 0)) < 24 * 3600 * 1000){
      summary.skipped++;
      try { chrome.runtime.sendMessage({ type: 'batch-progress', idx: i + 1, total: inns.length, inn, ok: true, skipped: true, summary }).catch(() => {}); } catch(_){}
      continue;
    }

    const url = 'https://www.e-disclosure.ru/portal/companyfind.aspx?query=' + encodeURIComponent(inn);
    const tab = await chrome.tabs.create({ url, active: false });
    const ok = await waitForCollect(inn, tab.id, 25000);
    if(ok) summary.done++;
    else {
      summary.failed++;
      try { await chrome.tabs.remove(tab.id); } catch(_){}
    }
    await new Promise(r => setTimeout(r, 2000));
    try { chrome.runtime.sendMessage({ type: 'batch-progress', idx: i + 1, total: inns.length, inn, ok, summary }).catch(() => {}); } catch(_){}
  }
  return summary;
}

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
