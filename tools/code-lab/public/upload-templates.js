// Блок загрузки кусков + ВИДИМЫЕ образцы форматов под разные языки.
// Переиспользуется и в Библиотеке, и в разделе «Данные». window.renderUploader(el, {onDone}).
(function(){
  const EXT_LANG = { js:'js', mjs:'js', jsx:'js', ts:'ts', tsx:'ts', py:'python', rb:'ruby', php:'php', go:'go', lua:'lua', sh:'bash', bash:'bash', ps1:'powershell', r:'r', sql:'sql', html:'html', htm:'html', css:'css', txt:'txt' };

  // видимые образцы: один кусок на каждый язык + сборник. Это то, что реально принимает загрузчик.
  const EXAMPLES = {
    js: {
      _label: 'Один кусок — JavaScript',
      _desc: 'Один кусок JS. lang — язык, title — название, code — код, words — пояснения к словам (необязательно).',
      lang: 'js', title: 'сумма массива', group: 'Мои куски / Массивы',
      desc: 'Складывает числа массива в одно значение.',
      code: 'const числа = [10, 20, 30];\nconst сумма = числа.reduce((итог, x) => итог + x, 0);\nconsole.log(сумма);',
      output: 'в консоли: 60',
      words: { reduce: 'reduce — сворачивает массив в одно значение (здесь — в сумму).', 'итог': 'итог — накопитель: сюда прибавляется каждый элемент.' }
    },
    python: {
      _label: 'Один кусок — Python',
      _desc: 'Кусок на Python. Запускается на компьютере через локальный сервер (кнопка ▶).',
      lang: 'python', title: 'среднее по списку', group: 'Мои куски / Python',
      desc: 'Считает среднее арифметическое списка чисел.',
      code: 'числа = [4, 8, 15, 16]\nсреднее = sum(числа) / len(числа)\nprint(среднее)',
      output: 'в консоли: 10.75',
      words: { sum: 'sum — сумма всех элементов списка (Python).', len: 'len — длина: сколько элементов в списке.' }
    },
    html: {
      _label: 'Один кусок — HTML',
      _desc: 'Кусок разметки. В песочнице сразу рисуется в предпросмотре.',
      lang: 'html', title: 'карточка товара', group: 'Мои куски / Интерфейс',
      desc: 'Простая карточка: заголовок, текст, кнопка.',
      code: '<div class="card">\n  <h3>Товар</h3>\n  <p>Короткое описание.</p>\n  <button>Купить</button>\n</div>',
      words: { div: '<div> — блок-контейнер для группировки.', button: '<button> — кнопка, по клику запускает действие.' }
    },
    css: {
      _label: 'Один кусок — CSS',
      _desc: 'Кусок стилей. Задаёт вид элементов.',
      lang: 'css', title: 'стиль кнопки', group: 'Мои куски / Интерфейс',
      desc: 'Скруглённая цветная кнопка.',
      code: 'button {\n  padding: 8px 16px;\n  border: 0;\n  border-radius: 8px;\n  background: #FF006E;\n  color: #fff;\n  cursor: pointer;\n}',
      words: { padding: 'padding — внутренний отступ, от края до содержимого.', 'border-radius': 'border-radius — скругление углов.', cursor: 'cursor — вид курсора; pointer — «рука».' }
    },
    sql: {
      _label: 'Один кусок — SQL',
      _desc: 'Запрос к базе данных.',
      lang: 'sql', title: 'топ по сумме', group: 'Мои куски / Данные',
      desc: 'Берёт 5 строк с наибольшей суммой.',
      code: 'SELECT имя, сумма\nFROM сделки\nWHERE сумма > 0\nORDER BY сумма DESC\nLIMIT 5;',
      words: { SELECT: 'SELECT — выбрать данные из таблицы.', WHERE: 'WHERE — условие отбора строк.', ORDER: 'ORDER BY — сортировка результата.' }
    },
    collection: {
      _label: 'Сборник — много кусков + словарь',
      _desc: 'Главный способ грузить пачкой. dict и words учат общий словарь; pieces — список кусков. Всё, чего нет в словаре, добавляется.',
      dict: { words: { ytm: 'YTM — доходность облигации к погашению (% годовых, если держать до конца).' } },
      pieces: [
        { lang: 'js', title: 'доходность (простая)', group: 'Мои куски / Облигации', desc: 'Грубая оценка YTM.', code: 'const купон = 80;\nconst цена = 950;\nconst номинал = 1000;\nconst ytm = (купон + (номинал - цена) / 3) / цена;', words: { номинал: 'номинал — сумма, которую вернут в конце (обычно 1000 ₽).' } },
        { lang: 'python', title: 'проценты роста', group: 'Мои куски / Python', desc: 'На сколько % выросло.', code: 'было = 100\nстало = 125\nрост = (стало - было) / было * 100\nprint(рост)', output: '25.0' }
      ]
    }
  };
  const ORDER = ['js', 'python', 'html', 'css', 'sql', 'collection'];

  function copyText(text, btn){
    const o = btn.textContent, done = () => { btn.textContent = '✓ скопировано'; setTimeout(() => { btn.textContent = o; }, 1200); };
    const fb = () => { const t = document.createElement('textarea'); t.value = text; t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); } catch(_){} t.remove(); done(); };
    if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fb); else fb();
  }
  function download(text, name){
    const blob = new Blob([text], { type: 'application/json' }); const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;' }[c]));

  window.renderUploader = function(host, opts){
    opts = opts || {};
    host.innerHTML =
      '<div class="up-box">' +
        '<div class="up-row">' +
          '<label class="up-note">положить в раздел:</label>' +
          '<select class="up-group"><option value="">— как в файле / без раздела —</option></select>' +
          '<input class="up-newgroup" placeholder="новый раздел (можно «Группа / Подгруппа»)" style="display:none">' +
        '</div>' +
        '<div class="up-row">' +
          '<button class="btn ok up-load">📥 загрузить куски</button>' +
          '<input type="file" class="up-file" accept=".json,.js,.mjs,.jsx,.ts,.tsx,.py,.rb,.php,.go,.lua,.sh,.bash,.ps1,.r,.sql,.html,.htm,.css,.txt" multiple style="display:none">' +
          '<span class="up-note muted">код-файлы (.js/.py/.css/.html…), полный кусок JSON или сборник — можно несколько сразу</span>' +
        '</div>' +
        '<div class="up-tpl">' +
          '<div class="up-tpl-head">Образец формата <select class="up-lang"></select></div>' +
          '<div class="up-desc"></div>' +
          '<pre class="up-code"></pre>' +
          '<div class="up-row">' +
            '<button class="btn up-copy">⧉ копировать образец</button>' +
            '<button class="btn up-dl">⬇ скачать образец</button>' +
            '<span class="up-what muted"></span>' +
          '</div>' +
        '</div>' +
      '</div>';

    // выбор раздела для загружаемых кусков: существующие разделы + «создать новый»
    const grpSel = host.querySelector('.up-group'), newGrp = host.querySelector('.up-newgroup');
    fetch('/api/list').then(r => r.json()).then(list => {
      const groups = [...new Set((list || []).map(t => String(t.group || '').split('/')[0].trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
      groups.forEach(g => { const o = document.createElement('option'); o.value = g; o.textContent = g; grpSel.appendChild(o); });
      const nw = document.createElement('option'); nw.value = '__new__'; nw.textContent = '➕ создать новый раздел…'; grpSel.appendChild(nw);
    }).catch(() => {});
    grpSel.onchange = () => { newGrp.style.display = grpSel.value === '__new__' ? '' : 'none'; if(grpSel.value === '__new__') newGrp.focus(); };
    const targetGroup = () => (grpSel.value === '__new__' ? newGrp.value.trim() : grpSel.value);
    const applyGroup = (payload, g) => {
      if(!g) return payload;
      if(Array.isArray(payload)) payload.forEach(p => { if(p && typeof p === 'object') p.group = g; });
      else if(payload && Array.isArray(payload.pieces)) payload.pieces.forEach(p => { if(p && typeof p === 'object') p.group = g; });
      else if(payload && typeof payload === 'object') payload.group = g;
      return payload;
    };

    const sel = host.querySelector('.up-lang'), descEl = host.querySelector('.up-desc'), codeEl = host.querySelector('.up-code'), whatEl = host.querySelector('.up-what');
    ORDER.forEach(k => { const o = document.createElement('option'); o.value = k; o.textContent = EXAMPLES[k]._label; sel.appendChild(o); });
    const clean = ex => { const c = {}; for(const [k, v] of Object.entries(ex)) if(k[0] !== '_') c[k] = v; return c; };
    let curText = '', curName = '';
    const show = () => {
      const ex = EXAMPLES[sel.value]; const obj = clean(ex);
      curText = JSON.stringify(obj, null, 2);
      curName = (sel.value === 'collection' ? 'сборник' : 'кусок-' + ex.lang) + '.json';
      descEl.textContent = ex._desc;
      codeEl.textContent = curText;
      whatEl.textContent = sel.value === 'collection' ? 'грузи этот файл — добавит все куски и пополнит словарь' : 'заполни по образцу и загрузи';
    };
    sel.onchange = show; show();

    host.querySelector('.up-copy').onclick = e => copyText(curText, e.currentTarget);
    host.querySelector('.up-dl').onclick = () => download(curText, curName);

    // загрузчик файлов → /api/import
    const loadBtn = host.querySelector('.up-load'), fileIn = host.querySelector('.up-file');
    loadBtn.onclick = () => fileIn.click();
    fileIn.onchange = async () => {
      const files = [...fileIn.files]; if(!files.length) return;
      const g = targetGroup();   // выбранный раздел — применится ко всем загружаемым
      const o = loadBtn.textContent; loadBtn.disabled = true; loadBtn.textContent = '…';
      let created = 0, learned = 0, updated = 0, bad = 0;
      for(const f of files){
        const ext = (f.name.split('.').pop() || '').toLowerCase(); const text = await f.text(); let payload;
        if(ext === 'json'){ try { payload = JSON.parse(text); } catch(_){ bad++; continue; } }
        else payload = { lang: EXT_LANG[ext] || 'txt', title: f.name.replace(/\.[^.]+$/, ''), code: text, group: g || '' };   // без выбора — без раздела (попадёт в «⚠ без раздела»)
        applyGroup(payload, g);   // выбран раздел → кладём туда всё из файла
        let r; try { r = await fetch('/api/import', { method: 'POST', body: JSON.stringify(payload) }).then(x => x.json()); } catch(_){ r = null; }
        if(r && r.ok){ created += r.created || 0; learned += r.learned || 0; updated += r.updated || 0; } else bad++;
      }
      loadBtn.disabled = false; fileIn.value = '';
      const parts = ['+' + created + ' кусков']; if(updated) parts.push(updated + ' обновл.'); if(learned) parts.push('+' + learned + ' слов'); if(bad) parts.push(bad + ' пропущено');
      loadBtn.textContent = '✓ ' + parts.join(', ');
      setTimeout(() => { loadBtn.textContent = o; }, 3500);
      if(typeof opts.onDone === 'function') opts.onDone();
    };
  };
})();
