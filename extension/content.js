// Расширение «БондАналитик: сбор раскрытий»
// Работает на e-disclosure.ru. Добавляет плавающую кнопку справа
// сверху, которая собирает таблицу существенных фактов и копирует
// структурированный JSON в буфер обмена. Пользовательница потом
// вставляет этот JSON в приложение БондАналитик через кнопку
// «📢 факты → Импортировать».

(function(){
  // Кнопку показываем только на страницах карточек компаний или списка
  // раскрытий — это portal/company.aspx или portal/files.aspx. На главной
  // поиска (poisk-po-kompaniyam) и в других местах таблицы нет, смысла
  // в кнопке нет.
  const path = location.pathname.toLowerCase();
  const onRelevantPage = /\/portal\/(files|company)\.aspx/i.test(path);

  // Создаём кнопку в любом случае, но если страница нерелевантна —
  // текст мягче и кнопка помощи.
  const btn = document.createElement('button');
  btn.id = 'bondan-collect-btn';
  btn.style.cssText = [
    'position:fixed',
    'top:20px',
    'right:20px',
    'z-index:2147483647',  // максимальный, чтобы не затенили элементы сайта
    'background:#0a84ff',
    'color:#fff',
    'border:none',
    'padding:10px 16px',
    'font:600 13px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    'border-radius:6px',
    'cursor:pointer',
    'box-shadow:0 4px 12px rgba(0,0,0,.3)',
    'max-width:300px'
  ].join(';');

  if(!onRelevantPage){
    btn.textContent = 'ℹ Открой карточку компании';
    btn.style.background = '#8e8e93';
    btn.title = 'БондАналитик: сбор раскрытий работает на страницах /portal/files.aspx или /portal/company.aspx. Найди компанию через поиск и открой её карточку.';
    btn.onclick = () => alert('Найди компанию через поиск, открой её карточку — там кнопка соберёт таблицу существенных фактов.');
    document.body.appendChild(btn);
    return;
  }

  const reset = () => {
    btn.textContent = '📋 Собрать раскрытия → БондАналитик';
    btn.style.background = '#0a84ff';
    btn.disabled = false;
  };
  reset();

  btn.onclick = () => {
    try {
      // Парсим все <tr> — в первом столбце дата, где-то ссылка на документ
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

      // Имя компании и ИНН — ищем по вариантам
      const titleEl = document.querySelector('h1, h2, .companyName') || document.querySelector('title');
      const companyName = titleEl ? titleEl.textContent.trim().replace(/\s+/g, ' ') : '';
      const idMatch = location.href.match(/id=(\d+)/);
      const innMatch = document.body.textContent.match(/ИНН[^0-9]{0,20}(\d{10}(?:\d{2})?)/);

      const payload = {
        source: 'e-disclosure',
        edId: idMatch ? idMatch[1] : null,
        companyName,
        inn: innMatch ? innMatch[1] : null,
        capturedAt: new Date().toISOString(),
        events
      };
      const json = JSON.stringify(payload);

      navigator.clipboard.writeText(json).then(() => {
        btn.textContent = `✓ ${events.length} событий скопировано`;
        btn.style.background = '#34c759';
        btn.disabled = true;
        setTimeout(reset, 3500);
      }).catch(err => {
        // Fallback — показываем в prompt, откуда пользовательница
        // может скопировать руками
        prompt('Автокопирование не сработало. Скопируй вручную (Ctrl+A, Ctrl+C):', json);
        reset();
      });
    } catch(e) {
      alert('Ошибка сбора: ' + (e.message || e));
      reset();
    }
  };

  document.body.appendChild(btn);
})();
