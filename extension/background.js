// Service worker расширения БондАналитик: сбор раскрытий.
// v1.4.2: реальный API найден из Network-лога пользователя.
//   • POST https://e-disclosure.ru/api/search/companies
//   • Content-Type: application/x-www-form-urlencoded
//   • Тело: textfield=<ИНН>&lastPageSize=10&lastPageNumber=1&…
//   • Антифорджери: cookie .AspNetCore.Antiforgery.* + header
//     RequestVerificationToken (ASP.NET Core double-submit).
//   • Ответ JSON: {foundCompaniesList: [{id, ...}], ...}
//
// Получаем CSRF-токен один раз за сессию service worker:
// GET /poisk-po-kompaniyam/ → вытаскиваем regex'ом value
// <input name="__RequestVerificationToken" value="…"/>. Куку
// .AspNetCore.Antiforgery.* браузер ставит сам.
//
// Если API вернул 400/403 — токен устарел, сбрасываем и повторяем.
// Если всё равно пусто — tab-fallback: открыть /poisk-po-kompaniyam/
// ?query=<ИНН>, content.js заполнит форму и кликнет «Искать», сайт
// сам 302-редиректит на карточку при единственном совпадении.
//
// Прогресс batch пишется в chrome.storage.local.batchProgress, чтобы
// popup мог восстановить UI при переоткрытии.

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

// Ищет компанию по ИНН через реальный POST-API e-disclosure.
// Payload и response подтверждены Network-логом пользователя.
// Antiforgery защита — cookie .AspNetCore.Antiforgery.*, автоматически
// подставляется браузером при credentials:'include'.
//
// ВАЖНО про CORS: из service worker'а fetch идёт с origin
// chrome-extension://<id>, т.е. cross-origin. Запрос должен остаться
// «simple» (без preflight OPTIONS), иначе сервер отдаёт 404 на OPTIONS
// и POST никогда не уходит. Поэтому НЕЛЬЗЯ добавлять X-Requested-With,
// Referer и другие non-safelisted headers — только Accept и Content-Type
// (последний — один из трёх разрешённых: urlencoded/multipart/plain).
//
// Если cookie ещё нет (первый запуск) или она протухла — делаем
// GET /poisk-po-kompaniyam/, сервер ставит cookie, повторяем POST.
async function findCompanyByInn(inn, retry = true){
  const body = new URLSearchParams({
    textfield: String(inn),
    radReg: 'FederalDistricts',
    districtsCheckboxGroup: '-1',
    regionsCheckboxGroup: '-1',
    branchesCheckboxGroup: '-1',
    lastPageSize: '10',
    lastPageNumber: '1',
    query: String(inn),
  });
  try {
    const r = await fetch('https://e-disclosure.ru/api/search/companies', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      body: body.toString(),
    });
    console.log('[bondanalit] api', inn, '→', r.status);
    if((r.status === 400 || r.status === 401 || r.status === 403) && retry){
      // Antiforgery-cookie отсутствует или протухла — подтянем её
      // заходом на поисковую страницу и повторим один раз.
      await fetch('https://e-disclosure.ru/poisk-po-kompaniyam/', { credentials: 'include' }).catch(() => {});
      return findCompanyByInn(inn, false);
    }
    if(!r.ok) return null;
    const data = await r.json();
    const list = (data && data.foundCompaniesList) || [];
    if(list.length){
      const first = list[0];
      console.log('[bondanalit] found id', first.id, first.name, 'for inn', inn);
      return { id: String(first.id), name: first.name || '', inn: String(inn) };
    }
    console.log('[bondanalit] empty list for inn', inn);
  } catch(e){
    console.warn('[bondanalit] api err', inn, e && e.message);
  }
  return null;
}

// Keep-alive для service worker: в MV3 SW засыпает через ~30 сек
// простоя, и batch, крутящийся 20+ минут на 576 ИНН, может умереть.
// Периодический вызов chrome.runtime.getPlatformInfo продлевает его
// жизнь. Таймер храним на верхнем уровне, чтобы runBatch мог
// start/stop.
let _keepAliveTimer = null;
function keepAliveStart(){
  if(_keepAliveTimer) return;
  _keepAliveTimer = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, 20 * 1000);
}
function keepAliveStop(){
  if(_keepAliveTimer){ clearInterval(_keepAliveTimer); _keepAliveTimer = null; }
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
    keepAliveStart();
    runBatch(msg.inns).then(summary => {
      keepAliveStop();
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
      // files.aspx — именно там таблица существенных фактов
      // (events-container). company.aspx — общая карточка с датой
      // регистрации и ссылкой-логотипом «ЦЕНТР РАСКРЫТИЯ…» в header,
      // парсер на ней хватает эти метаданные вместо реальных событий.
      url = `https://www.e-disclosure.ru/portal/files.aspx?id=${company.id}`;
    } else {
      // Fallback: открываем поисковую страницу, content.js сам
      // нажмёт на первую ссылку company.aspx?id=... Это работает,
      // если на поиске есть хотя бы одно совпадение по ИНН.
      url = `https://www.e-disclosure.ru/poisk-po-kompaniyam/?query=${encodeURIComponent(inn)}`;
      console.log('[bondanalit] fallback search tab for inn', inn);
    }

    const tab = await chrome.tabs.create({ url, active: false });
    const edId = (company && company.id) ? String(company.id) : '';
    // Таймаут 40 сек для fallback-пути (надо успеть: загрузить поиск →
    // content.js триггерит поиск → JS сайта делает AJAX → редирект на
    // карточку → парсинг). Для прямого пути (есть id) обычно хватает 10.
    const timeout = (company && company.id) ? 20000 : 40000;
    const ok = await waitForCollect(inn, edId, tab.id, timeout);
    if(ok){
      summary.done++;
    } else {
      summary.failed++;
      if(!company || !company.id) summary.notFound++;
      try { await chrome.tabs.remove(tab.id); } catch(_){}
    }
    // Между ИНН 500мс — достаточно чтобы не задушить сервер и не
    // ловить 429, но не жадно (было 2000мс — 2/3 времени тратилось зря).
    await new Promise(r => setTimeout(r, 500));
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
