// Content-скрипт расширения «БондАналитик: сбор раскрытий».
// Работает на страницах e-disclosure.ru. Два режима:
//   1) Ручной: на странице карточки компании кнопка «📋 Собрать → БА» —
//      клик собирает и копирует JSON в буфер.
//   2) Авто: при открытии карточки компании автоматически собирает и
//      отправляет данные в background service worker, который сохраняет
//      их в chrome.storage. Массовый обход работает на этом.
// Плюс: если страница — поисковая выдача (companyfind.aspx?query=ИНН),
// и есть ровно один кандидат — автоматически переходит на его карточку.
// Это нужно для batch-режима: из popup → search URL → сразу на нужную
// компанию без ручного клика.

(function(){
  const path = location.pathname.toLowerCase();
  const isCompanyPage = /\/portal\/(files|company)\.aspx/i.test(path);
  const isSearchPage  = /\/portal\/companyfind\.aspx/i.test(path);

  // Общая функция сбора — возвращает payload или null
  const scrapePage = () => {
    try {
      const rows = document.querySelectorAll('tr');
      const events = [];
      rows.forEach(tr => {
        const text = tr.textContent || '';
        const dateM = text.match(/(\d{2}\.\d{2}\.\d{4})/);
        if(!dateM) return;
        const linkEl = tr.querySelector('a[href*=".pdf"], a[href*=".html"], a[href*=".rtf"], a[href*=".doc"]')
                    || tr.querySelector('a');
        const title = linkEl ? linkEl.textContent.trim() : '';
        if(!title || title.length < 8) return;
        const url = linkEl && linkEl.href ? linkEl.href : null;
        events.push({ date: dateM[1], title, url });
      });
      if(!events.length) return null;
      const titleEl = document.querySelector('h1, h2, .companyName') || document.querySelector('title');
      const companyName = titleEl ? titleEl.textContent.trim().replace(/\s+/g, ' ') : '';
      const idMatch = location.href.match(/id=(\d+)/);
      const innMatch = document.body.textContent.match(/ИНН[^0-9]{0,20}(\d{10}(?:\d{2})?)/);
      return {
        source: 'e-disclosure',
        edId: idMatch ? idMatch[1] : null,
        companyName,
        inn: innMatch ? innMatch[1] : null,
        capturedAt: new Date().toISOString(),
        events
      };
    } catch(e){
      console.warn('[БондАналитик] ошибка сбора:', e);
      return null;
    }
  };

  // Авто-редирект с поисковой выдачи — нужен для batch-режима.
  // Когда popup открывает companyfind.aspx?query=ИНН и в результатах
  // есть ссылки company.aspx?id=... — автоматически жмём первую.
  if(isSearchPage){
    const firstLink = document.querySelector('a[href*="company.aspx?id="]');
    if(firstLink && firstLink.href){
      // Отложенный переход — чтобы anti-bot сервер-page успел отреагировать
      setTimeout(() => { location.href = firstLink.href; }, 1200);
    }
    return;
  }

  if(!isCompanyPage) return;

  // На карточке компании — автосбор (для batch) + кнопка (для ручного)
  const payload = scrapePage();
  if(payload){
    // Отправляем в background для сохранения в chrome.storage
    try {
      chrome.runtime.sendMessage({ type: 'save-disclosure', payload });
    } catch(e){
      console.warn('[БондАналитик] sendMessage err:', e);
    }
  }

  // Кнопка для ручного копирования в буфер (если расширение используется
  // без popup-пайплайна).
  const btn = document.createElement('button');
  btn.id = 'bondan-collect-btn';
  btn.style.cssText = [
    'position:fixed','top:20px','right:20px','z-index:2147483647',
    'background:#0a84ff','color:#fff','border:none','padding:10px 16px',
    'font:600 13px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    'border-radius:6px','cursor:pointer','box-shadow:0 4px 12px rgba(0,0,0,.3)',
    'max-width:300px'
  ].join(';');

  const updateBtn = (text, color, disabled) => {
    btn.textContent = text;
    btn.style.background = color;
    btn.disabled = !!disabled;
  };
  const reset = () => updateBtn(
    payload ? `📋 Скопировать (${payload.events.length} событий) → БА` : '📋 Нет событий на странице',
    payload ? '#0a84ff' : '#8e8e93',
    !payload
  );
  reset();

  btn.onclick = () => {
    if(!payload){ alert('На странице нет таблицы существенных фактов. Найди карточку компании через поиск.'); return; }
    const json = JSON.stringify(payload);
    navigator.clipboard.writeText(json).then(() => {
      updateBtn(`✓ ${payload.events.length} событий скопировано`, '#34c759', true);
      setTimeout(reset, 3500);
    }).catch(() => {
      prompt('Автокопирование не сработало. Скопируй вручную (Ctrl+A, Ctrl+C):', json);
    });
  };

  document.body.appendChild(btn);

  // Если страница открыта batch-режимом (есть метка в session storage)
  // — закрываем вкладку после сбора. Флаг ставит background при открытии.
  try {
    chrome.storage.local.get(['pendingBatchClose'], data => {
      if(data.pendingBatchClose === location.href){
        chrome.storage.local.set({ pendingBatchClose: null });
        setTimeout(() => {
          chrome.runtime.sendMessage({ type: 'close-tab' });
        }, 800);
      }
    });
  } catch(_){}
})();
