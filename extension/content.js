// Content-скрипт расширения БондАналитик: сбор раскрытий.
// v1.4: поддержка сбора аффилированных лиц С in-memory распаковкой ZIP.
// Никакие PDF на диск не сохраняются — только извлечённый PDF как
// base64 передаётся в буфер обмена, приложение парсит и сохраняет
// только структурированный список юрлиц (ИНН + доли).

(function(){
  const path = location.pathname.toLowerCase();
  const query = location.search.toLowerCase();
  const isCompanyPage = /\/portal\/company\.aspx/i.test(path);
  const isFilesPage   = /\/portal\/files\.aspx/i.test(path);
  const isAffiliatedPage = isFilesPage && /type=6/.test(query);
  const isSearchPage  = /\/portal\/companyfind\.aspx/i.test(path) ||
                        /\/poisk-po-kompaniyam/i.test(path);

  if(isSearchPage){
    waitFor(() => {
      const firstLink = document.querySelector('a[href*="company.aspx?id="]');
      if(firstLink && firstLink.href){ location.href = firstLink.href; return true; }
      return false;
    }, 8000);
    return;
  }

  // Общие скрап-функции (используются везде)
  const extractName = () => {
    const h2 = document.querySelector('.infoblock h2, h1');
    if(h2) return h2.textContent.trim().replace(/\s+/g, ' ').replace(/"/g, '"');
    const t = document.querySelector('title');
    return t ? t.textContent.trim() : '';
  };
  const extractInn = () => {
    const rows = document.querySelectorAll('.company-table tr, tr');
    for(const tr of rows){
      const fn = tr.querySelector('.field-name, td:first-child');
      if(fn && /^ИНН\s*$/i.test(fn.textContent.trim())){
        const v = tr.querySelector('strong, td:nth-child(2)');
        if(v){ const m = v.textContent.match(/(\d{10}(?:\d{2})?)/); if(m) return m[1]; }
      }
    }
    const m2 = document.body.textContent.match(/ИНН[^0-9]{0,20}(\d{10}(?:\d{2})?)/);
    return m2 ? m2[1] : null;
  };
  const extractEdId = () => {
    const hid = document.getElementById('hCompanyId');
    if(hid && hid.value) return hid.value;
    const m = location.href.match(/[?&]id=(\d+)/);
    return m ? m[1] : null;
  };

  // ════════ АФФИЛИРОВАННЫЕ ════════
  if(isAffiliatedPage){
    setupAffiliatedButton();
    return;
  }

  if(!isCompanyPage && !isFilesPage) return;

  // Сбор раскрытий с карточки компании (как раньше)
  const scrapeEvents = () => {
    const events = [];
    const container = document.querySelector('.js-events-container');
    const rowsA = container ? container.querySelectorAll('tr, .event-item, .event') : [];
    const rowsB = rowsA.length ? [] : document.querySelectorAll('tr');
    [...rowsA, ...rowsB].forEach(el => {
      const text = el.textContent || '';
      const dateM = text.match(/(\d{2}\.\d{2}\.\d{4})/);
      if(!dateM) return;
      const linkEl = el.querySelector('a[href*=".pdf"], a[href*=".html"], a[href*=".rtf"], a[href*=".doc"], a[href*="event.aspx"], a[href*="EventId"]')
                  || el.querySelector('a');
      const title = linkEl ? linkEl.textContent.trim() : text.replace(dateM[1], '').trim().slice(0, 200);
      if(!title || title.length < 8) return;
      events.push({ date: dateM[1], title, url: linkEl && linkEl.href ? linkEl.href : null });
    });
    return events;
  };
  const buildPayload = () => ({
    source: 'e-disclosure',
    edId: extractEdId(), companyName: extractName(),
    inn: extractInn(), capturedAt: new Date().toISOString(),
    events: scrapeEvents()
  });

  let saved = false;
  const tryCollectAndSave = () => {
    if(saved) return;
    const payload = buildPayload();
    if(payload.edId || payload.inn){
      saved = true;
      try { chrome.runtime.sendMessage({ type: 'save-disclosure', payload }); } catch(_){}
      setTimeout(() => {
        chrome.storage.local.get(['pendingBatchMode'], data => {
          if(data.pendingBatchMode){ try { chrome.runtime.sendMessage({ type: 'close-tab' }); } catch(_){} }
        });
      }, 1000);
    }
  };
  const initial = buildPayload();
  if(initial.events.length || initial.edId) tryCollectAndSave();
  const container = document.querySelector('.js-events-container');
  if(container){
    const observer = new MutationObserver(() => {
      const p = buildPayload();
      if(p.events.length){ observer.disconnect(); tryCollectAndSave(); }
    });
    observer.observe(container, { childList: true, subtree: true });
    setTimeout(() => { observer.disconnect(); tryCollectAndSave(); }, 8000);
  }

  const btn = document.createElement('button');
  btn.style.cssText = 'position:fixed;top:20px;right:20px;z-index:2147483647;background:#0a84ff;color:#fff;border:none;padding:10px 16px;font:600 13px/1.2 -apple-system,sans-serif;border-radius:6px;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.3);max-width:300px';
  btn.textContent = '📋 Собрать → БА';
  btn.onclick = () => {
    const payload = buildPayload();
    if(!payload.events.length && !payload.inn){ alert('На странице нет данных. Возможно AJAX ещё не загрузился.'); return; }
    const json = JSON.stringify(payload);
    navigator.clipboard.writeText(json).then(() => {
      btn.textContent = `✓ ${payload.events.length} событий · ИНН ${payload.inn || '—'}`;
      btn.style.background = '#34c759';
      setTimeout(() => { btn.textContent = '📋 Собрать → БА'; btn.style.background = '#0a84ff'; }, 3500);
    }).catch(() => prompt('Скопируй вручную:', json));
  };
  document.body.appendChild(btn);

  // ════════ UI для страницы аффилированных ════════
  function setupAffiliatedButton(){
    // Находит последний «Список аффилированных лиц» в таблице документов
    const findLatest = () => {
      const rows = [...document.querySelectorAll('tr')];
      const candidates = [];
      for(const tr of rows){
        const text = tr.textContent || '';
        const dateM = text.match(/(\d{2}\.\d{2}\.\d{4})/);
        if(!dateM) continue;
        const linkEl = tr.querySelector('a[href*=".zip"], a[href*=".pdf"], a[href*=".rar"], a[href*="GetDocument"], a[href*="LoadFile"], a[href*="document.aspx"]');
        if(!linkEl) continue;
        if(!/аффилир|связанн|зависим/i.test(text)) continue;
        const [d, m, y] = dateM[1].split('.');
        candidates.push({ date: dateM[1], ts: new Date(+y, +m-1, +d).getTime(), url: linkEl.href });
      }
      candidates.sort((a, b) => b.ts - a.ts);
      return candidates[0] || null;
    };

    const btn = document.createElement('button');
    btn.style.cssText = 'position:fixed;top:20px;right:20px;z-index:2147483647;background:#ff9500;color:#fff;border:none;padding:10px 16px;font:600 13px/1.2 -apple-system,sans-serif;border-radius:6px;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.3);max-width:360px';

    const refresh = () => {
      const latest = findLatest();
      if(!latest){
        btn.textContent = 'ℹ Список аффилированных не найден';
        btn.disabled = true;
        btn.style.background = '#8e8e93';
        return;
      }
      btn.textContent = `📦 Распаковать список аффилированных (${latest.date})`;
      btn.disabled = false;
      btn.style.background = '#ff9500';
      btn.onclick = async () => {
        btn.disabled = true;
        btn.textContent = '⏳ Качаю архив…';
        try {
          const r = await fetch(latest.url, { credentials: 'include' });
          if(!r.ok) throw new Error('HTTP ' + r.status);
          const blob = await r.blob();
          const ct = (r.headers.get('content-type') || '').toLowerCase();
          let pdfBytes, pdfName;
          if(/zip|octet-stream|x-zip/.test(ct) || /\.zip$/i.test(latest.url)){
            btn.textContent = '⏳ Распаковываю ZIP…';
            const found = await extractFirstPdfFromZip(blob);
            if(!found) throw new Error('PDF не найден в архиве');
            pdfBytes = found.bytes;
            pdfName  = found.name;
          } else if(/\.pdf$/i.test(latest.url) || ct.includes('pdf')){
            pdfBytes = new Uint8Array(await blob.arrayBuffer());
            pdfName  = latest.url.split('/').pop();
          } else {
            throw new Error('Неподдерживаемый формат: ' + ct);
          }
          btn.textContent = '⏳ Кодирую в base64…';
          const base64 = uint8ToBase64(pdfBytes);
          const payload = {
            source: 'affiliated-pdf',
            inn: extractInn(),
            companyName: extractName(),
            edId: extractEdId(),
            date: latest.date,
            pdfName,
            pdfSize: pdfBytes.length,
            pdfBase64: base64,
            capturedAt: new Date().toISOString(),
          };
          const json = JSON.stringify(payload);
          await navigator.clipboard.writeText(json);
          btn.textContent = `✓ ${Math.round(pdfBytes.length/1024)}КБ в буфер → БондАналитик → «📇 Импорт аффилированных»`;
          btn.style.background = '#34c759';
          setTimeout(refresh, 6000);
        } catch(e){
          btn.textContent = '✗ ' + (e.message || String(e)).slice(0, 60);
          btn.style.background = '#d32f2f';
          setTimeout(refresh, 5000);
        }
      };
    };

    refresh();
    setTimeout(refresh, 2000);
    document.body.appendChild(btn);
  }

  // ════════ Minimal ZIP reader ════════
  // Поддерживает store (0) и deflate (8). Один или несколько файлов.
  // Не поддерживает шифрование, ZIP64, data descriptor (bit 3 of flags).
  async function extractFirstPdfFromZip(blob){
    const buf = await blob.arrayBuffer();
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);
    let offset = 0;
    while(offset < buf.byteLength - 4){
      const sig = view.getUint32(offset, true);
      if(sig !== 0x04034b50) break; // Local file header signature
      const flags = view.getUint16(offset + 6, true);
      const compression = view.getUint16(offset + 8, true);
      let compSize = view.getUint32(offset + 18, true);
      const uncompSize = view.getUint32(offset + 22, true);
      const fnLen = view.getUint16(offset + 26, true);
      const extraLen = view.getUint16(offset + 28, true);
      // Имя файла: если флаг бит 11 установлен — UTF-8, иначе CP866 (русский DOS)
      const fnBytes = bytes.subarray(offset + 30, offset + 30 + fnLen);
      let filename;
      try {
        filename = (flags & 0x0800)
          ? new TextDecoder('utf-8').decode(fnBytes)
          : new TextDecoder('ibm866', { fatal: false }).decode(fnBytes);
      } catch(_){ filename = new TextDecoder('latin1').decode(fnBytes); }
      const dataStart = offset + 30 + fnLen + extraLen;
      // Data descriptor: если флаг бит 3 установлен, compSize == 0 в header,
      // реальный размер после данных — не поддерживаем
      if(flags & 0x08){
        // Не реализовано — пропустить файл если не PDF; если PDF — ругаемся
        if(/\.pdf$/i.test(filename)) throw new Error('ZIP использует data descriptor — парсер не поддерживает');
      }
      if(/\.pdf$/i.test(filename)){
        const dataBytes = bytes.subarray(dataStart, dataStart + compSize);
        let pdfBytes;
        if(compression === 0){
          pdfBytes = dataBytes;
        } else if(compression === 8){
          const stream = new Response(dataBytes).body.pipeThrough(new DecompressionStream('deflate-raw'));
          const decompBlob = await new Response(stream).blob();
          pdfBytes = new Uint8Array(await decompBlob.arrayBuffer());
        } else {
          throw new Error('Неподдерживаемое сжатие ZIP: ' + compression);
        }
        return { name: filename, bytes: pdfBytes };
      }
      offset = dataStart + compSize;
    }
    return null;
  }

  // Преобразует Uint8Array в base64 (работает для больших массивов)
  function uint8ToBase64(bytes){
    let binary = '';
    const chunkSize = 0x8000;
    for(let i = 0; i < bytes.length; i += chunkSize){
      binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
    }
    return btoa(binary);
  }

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
