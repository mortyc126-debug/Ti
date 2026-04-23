// Service worker расширения БондАналитик: сбор раскрытий.
// v1.4.1: подтверждено двумя HTML-дампами с живого сайта:
//   • /api/search/companies?query=... возвращает 404 (мёртвый API);
//   • /poisk-po-kompaniyam/ отдаёт пустую форму, результаты рендерит
//     JS через AJAX — fetch в background ничего полезного не даст
//     (+ антибот ServicePipe требует выполнения JS для получения куки);
//   • зато при ОДНОМ совпадении сайт сам 302-редиректит на карточку
//     company.aspx?id=<N> — это и используем.
//
// Стратегия: не угадываем API, а всегда открываем поисковую страницу
// /poisk-po-kompaniyam/?query=<ИНН> во вкладке. content.js на этой
// странице заполнит форму, нажмёт «Искать», а при одном совпадении
// сайт сам перекинет на карточку (дальше уже известный flow).
// Это стабильно работает в браузере пользователя — там уже есть
// куки ServicePipe, пройденные капчей при первом заходе.
//
// Прогресс batch пишется в chrome.storage.local.batchProgress, чтобы
// popup мог восстановить UI при переоткрытии (раньше сообщения
// chrome.runtime.sendMessage терялись когда popup закрыт).

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

// Быстрый путь: пытаемся найти id через fetch поисковой страницы с
// куками браузера. В большинстве случаев вернёт anti-bot ServicePipe
// (пустой HTML с редиректом на /exhkqyad), но если у пользователя
// уже есть куки ServicePipe от живых посещений сайта — страница
// отрендерится на сервере (SSR) и id можно достать regex'ом.
// Если не получилось — вернёт null, и runBatch упадёт на tab-fallback.
async function findCompanyByInn(inn){
  const url = `https://www.e-disclosure.ru/poisk-po-kompaniyam/?query=${encodeURIComponent(inn)}`;
  try {
    const r = await fetch(url, {
      credentials: 'include',
      headers: { 'Accept': 'text/html,application/xhtml+xml' },
    });
    console.log('[bondanalit] search', inn, '→ status', r.status);
    if(!r.ok) return null;
    const html = await r.text();
    // Маркёр anti-bot: ServicePipe показывает страницу-заглушку со
    // ссылкой /exhkqyad. Никаких company.aspx?id там нет — не тратим
    // время на regex, сразу fallback.
    if(/exhkqyad|<div class="load">/i.test(html)){
      console.log('[bondanalit] antibot stub for', inn, '— tab fallback');
      return null;
    }
    const re = /company\.aspx\?id=(\d+)/gi;
    let match, picked = null;
    while((match = re.exec(html)) !== null){
      const ctx = html.slice(Math.max(0, match.index - 400), match.index + 400);
      if(ctx.includes(inn)){ picked = match[1]; break; }
      if(!picked) picked = match[1];
    }
    if(picked){
      console.log('[bondanalit] fast-path id', picked, 'for inn', inn);
      return { id: picked, name: '', inn: String(inn) };
    }
    console.log('[bondanalit] no id in html for', inn, '— tab fallback');
  } catch(e){
    console.warn('[bondanalit] search err', e && e.message);
  }
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
    chrome.storage.local.set({ pendingBatchMode: true });
    runBatch(msg.inns).then(summary => {
      chrome.storage.local.set({
        pendingBatchMode: false,
        batchProgress: { running: false, summary, total: msg.inns.length, finishedAt: Date.now() }
      });
      chrome.runtime.sendMessage({ type: 'batch-done', summary }).catch(() => {});
    });
    sendResponse({ ok: true });
    return true;
  }
});

// Пишет текущий прогресс в storage — чтобы popup восстановил UI
// если его закрыли и снова открыли во время обхода.
function persistProgress(state){
  try { chrome.storage.local.set({ batchProgress: state }); } catch(_){}
}

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
  const emit = (extra) => {
    persistProgress({ running: true, total: inns.length, summary, ...extra });
    try { chrome.runtime.sendMessage({ type: 'batch-progress', total: inns.length, summary, ...extra }); } catch(_){}
  };
  for(let i = 0; i < inns.length; i++){
    const inn = String(inns[i] || '').trim();
    if(!inn || !/^\d{10}(\d{2})?$/.test(inn)){
      summary.skipped++;
      emit({ idx: i + 1, inn, ok: false, skipped: true });
      continue;
    }

    // Пропуск если собрано за 24ч
    const stored = await new Promise(r => chrome.storage.local.get(['collected'], d => r(d.collected || {})));
    const existing = Object.values(stored).find(e => e.payload && e.payload.inn === inn);
    if(existing && (Date.now() - (existing.savedAt || 0)) < 24 * 3600 * 1000){
      summary.skipped++;
      emit({ idx: i + 1, inn, ok: true, skipped: true });
      continue;
    }

    // Шаг 1: HTML-поиск по ИНН → company.id
    const company = await findCompanyByInn(inn);

    let url;
    if(company && company.id){
      url = `https://www.e-disclosure.ru/portal/company.aspx?id=${company.id}`;
    } else {
      // Fallback: открываем поисковую страницу, content.js сам
      // нажмёт на первую ссылку company.aspx?id=... Это работает,
      // если на поиске есть хотя бы одно совпадение по ИНН.
      url = `https://www.e-disclosure.ru/poisk-po-kompaniyam/?query=${encodeURIComponent(inn)}`;
      console.log('[bondanalit] fallback search tab for inn', inn);
    }

    const tab = await chrome.tabs.create({ url, active: false });
    const edId = (company && company.id) ? String(company.id) : '';
    const ok = await waitForCollect(inn, edId, tab.id, 30000);
    if(ok){
      summary.done++;
    } else {
      summary.failed++;
      if(!company || !company.id) summary.notFound++;
      try { await chrome.tabs.remove(tab.id); } catch(_){}
    }
    await new Promise(r => setTimeout(r, 2000));
    emit({ idx: i + 1, inn, ok });
  }
  return summary;
}

function waitForCollect(inn, edId, tabId, timeoutMs){
  return new Promise(resolve => {
    const start = Date.now();
    const check = () => {
      chrome.storage.local.get(['collected'], data => {
        const collected = data.collected || {};
        // Засчитываем если запись появилась после старта И относится
        // к нашему ИНН (по полю inn или по совпадению edId, когда
        // известен). Без этой строгости старые записи могли давать
        // ложное «нашли».
        const hit = Object.values(collected).some(e => {
          if(!e.payload) return false;
          const fresh = (e.savedAt || 0) > start;
          if(e.payload.inn === inn) return true;
          if(edId && String(e.payload.edId || '') === String(edId)) return true;
          return fresh && !e.payload.inn && !edId;
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
