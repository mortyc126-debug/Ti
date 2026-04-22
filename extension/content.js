// Content-скрипт расширения БондАналитик: сбор раскрытий.
// v1.3: переписан под реальную структуру e-disclosure.ru (interfax).
// Работает на /portal/company.aspx?id=XXX — карточка компании.
// События подгружаются AJAX'ом в .js-events-container после загрузки
// страницы, поэтому используем MutationObserver чтобы дождаться их.
//
// ИНН и имя — вытаскиваем из структурированной таблицы компании, а не
// regex'ом по всему body. Это надёжно.

(function(){
  const path = location.pathname.toLowerCase();
  const isCompanyPage = /\/portal\/company\.aspx/i.test(path);
  const isFilesPage   = /\/portal\/files\.aspx/i.test(path);
  const isSearchPage  = /\/portal\/companyfind\.aspx/i.test(path) ||
                        /\/poisk-po-kompaniyam/i.test(path);

  // На поисковой SPA-странице — редиректить на первую найденную компанию.
  // Ищем любую ссылку company.aspx в DOM (или data-attributes).
  if(isSearchPage){
    waitFor(() => {
      const firstLink = document.querySelector('a[href*="company.aspx?id="]');
      if(firstLink && firstLink.href){
        location.href = firstLink.href;
        return true;
      }
      return false;
    }, 8000);
    return;
  }

  if(!isCompanyPage && !isFilesPage) return;

  // === Скрап имени компании из carded layout ===
  const extractName = () => {
    const h2 = document.querySelector('.infoblock h2, .title_basic + div h2, h1');
    if(h2) return h2.textContent.trim().replace(/\s+/g, ' ').replace(/"/g, '"');
    const t = document.querySelector('title');
    if(t){
      const m = t.textContent.match(/информации о компании\s+(.+?)(?:\s*$)/i);
      return m ? m[1].trim().replace(/"/g, '"') : t.textContent.trim();
    }
    return '';
  };

  // === ИНН из таблицы .company-table ===
  const extractInn = () => {
    // Вариант 1: <td class="field-name">ИНН</td><td><strong>XXX</strong></td>
    const rows = document.querySelectorAll('.company-table tr, tr');
    for(const tr of rows){
      const fn = tr.querySelector('.field-name, td:first-child');
      if(fn && /^ИНН\s*$/i.test(fn.textContent.trim())){
        const v = tr.querySelector('strong, td:nth-child(2)');
        if(v){
          const m = v.textContent.match(/(\d{10}(?:\d{2})?)/);
          if(m) return m[1];
        }
      }
    }
    // Fallback: regex по всему тексту (старый подход)
    const m2 = document.body.textContent.match(/ИНН[^0-9]{0,20}(\d{10}(?:\d{2})?)/);
    return m2 ? m2[1] : null;
  };

  // === Id компании из hidden input или URL ===
  const extractEdId = () => {
    const hid = document.getElementById('hCompanyId');
    if(hid && hid.value) return hid.value;
    const m = location.href.match(/[?&]id=(\d+)/);
    return m ? m[1] : null;
  };

  // === Скрап событий из js-events-container (или таблицы на /files.aspx) ===
  const scrapeEvents = () => {
    const events = [];
    // Вариант A: events-container (на карточке company.aspx)
    const container = document.querySelector('.js-events-container');
    if(container){
      const rows = container.querySelectorAll('tr, .event-item, .event');
      rows.forEach(el => {
        const text = el.textContent || '';
        const dateM = text.match(/(\d{2}\.\d{2}\.\d{4})/);
        if(!dateM) return;
        const linkEl = el.querySelector('a[href*=".pdf"], a[href*=".html"], a[href*=".rtf"], a[href*=".doc"], a[href*="event.aspx"], a[href*="EventId"]')
                    || el.querySelector('a');
        const title = linkEl ? linkEl.textContent.trim() : text.replace(dateM[1], '').trim().slice(0, 200);
        if(!title || title.length < 8) return;
        const url = linkEl && linkEl.href ? linkEl.href : null;
        events.push({ date: dateM[1], title, url });
      });
    }
    // Вариант B: обычные tr в body (на /files.aspx и fallback)
    if(!events.length){
      const rows = document.querySelectorAll('tr');
      rows.forEach(tr => {
        const text = tr.textContent || '';
        const dateM = text.match(/(\d{2}\.\d{2}\.\d{4})/);
        if(!dateM) return;
        const linkEl = tr.querySelector('a[href*=".pdf"], a[href*=".html"], a[href*=".rtf"], a[href*=".doc"], a[href*="event.aspx"], a[href*="EventId"]')
                    || tr.querySelector('a');
        const title = linkEl ? linkEl.textContent.trim() : '';
        if(!title || title.length < 8) return;
        const url = linkEl && linkEl.href ? linkEl.href : null;
        events.push({ date: dateM[1], title, url });
      });
    }
    return events;
  };

  const buildPayload = () => ({
    source: 'e-disclosure',
    edId: extractEdId(),
    companyName: extractName(),
    inn: extractInn(),
    capturedAt: new Date().toISOString(),
    events: scrapeEvents()
  });

  // === Ожидание AJAX-загрузки событий ===
  // На company.aspx .js-events-container сначала пустой, потом наполняется.
  // Даём ему до 10 сек на заполнение, потом скрапим.
  let saved = false;
  const tryCollectAndSave = () => {
    if(saved) return;
    const payload = buildPayload();
    // Сохраняем даже если events пустые (мертвая компания) — чтобы знать
    // что мы её проверили и batch-режим не висел
    if(payload.edId || payload.inn){
      saved = true;
      try { chrome.runtime.sendMessage({ type: 'save-disclosure', payload }); } catch(_){}
      // Через секунду после save — проверим не нужно ли закрыть вкладку (batch)
      setTimeout(() => {
        chrome.storage.local.get(['pendingBatchClose'], data => {
          if(data.pendingBatchClose === location.href || data.pendingBatchMode){
            try { chrome.runtime.sendMessage({ type: 'close-tab' }); } catch(_){}
          }
        });
      }, 1000);
    }
  };

  // Пытаемся сразу — вдруг данные уже есть
  const initial = buildPayload();
  if(initial.events.length > 0 || initial.edId){
    tryCollectAndSave();
  }

  // Если events-container есть но пустой — ждём AJAX
  const container = document.querySelector('.js-events-container');
  if(container){
    const observer = new MutationObserver(() => {
      const payload = buildPayload();
      if(payload.events.length > 0){
        observer.disconnect();
        tryCollectAndSave();
      }
    });
    observer.observe(container, { childList: true, subtree: true });
    // Fallback: через 8 сек сохраняем что есть, даже если events пустой
    setTimeout(() => {
      observer.disconnect();
      tryCollectAndSave();
    }, 8000);
  }

  // === Кнопка для ручного копирования ===
  const btn = document.createElement('button');
  btn.id = 'bondan-collect-btn';
  btn.style.cssText = [
    'position:fixed','top:20px','right:20px','z-index:2147483647',
    'background:#0a84ff','color:#fff','border:none','padding:10px 16px',
    'font:600 13px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    'border-radius:6px','cursor:pointer','box-shadow:0 4px 12px rgba(0,0,0,.3)',
    'max-width:300px'
  ].join(';');
  btn.textContent = '📋 Собрать → БА';
  btn.onclick = () => {
    const payload = buildPayload();
    if(!payload.events.length && !payload.inn){
      alert('На странице нет ни событий ни ИНН. Возможно AJAX ещё не загрузился — попробуй через пару секунд.');
      return;
    }
    const json = JSON.stringify(payload);
    navigator.clipboard.writeText(json).then(() => {
      btn.textContent = `✓ ${payload.events.length} событий · ИНН ${payload.inn || '—'}`;
      btn.style.background = '#34c759';
      setTimeout(() => { btn.textContent = '📋 Собрать → БА'; btn.style.background = '#0a84ff'; }, 3500);
    }).catch(() => prompt('Скопируй вручную:', json));
  };
  document.body.appendChild(btn);

  function waitFor(fn, timeoutMs){
    const start = Date.now();
    const tick = () => {
      if(fn()) return;
      if(Date.now() - start > timeoutMs) return;
      setTimeout(tick, 400);
    };
    tick();
  }
})();
