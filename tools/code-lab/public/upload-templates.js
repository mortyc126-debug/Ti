// Блок загрузки кусков + ВИДИМЫЕ образцы форматов под разные языки.
// Переиспользуется и в Библиотеке, и в разделе «Данные». window.renderUploader(el, {onDone}).
(function(){
  const EXT_LANG = { js:'js', mjs:'js', jsx:'js', ts:'ts', tsx:'ts', py:'python', rb:'ruby', php:'php', go:'go', lua:'lua', sh:'bash', bash:'bash', ps1:'powershell', r:'r', sql:'sql', html:'html', htm:'html', css:'css', txt:'txt' };
  const CODE_RE = /\.(json|js|mjs|jsx|ts|tsx|py|rb|php|go|lua|sh|bash|ps1|r|sql|css|html?|txt)$/i;
  // распаковка архивов прямо в загрузчике: zip / gz / обычный файл → список {name,text}
  async function decomp(buf, fmt){ const ds = new DecompressionStream(fmt); return await new Response(new Blob([buf]).stream().pipeThrough(ds)).text(); }
  async function extractFile(f){
    const name = f.name.toLowerCase(); const buf = await f.arrayBuffer(); const b = new Uint8Array(buf);
    if(name.endsWith('.zip') || (b[0] === 0x50 && b[1] === 0x4b)) return await unzip(buf);
    if(name.endsWith('.gz') || (b[0] === 0x1f && b[1] === 0x8b)){ const text = await decomp(buf, 'gzip'); return [{ name: f.name.replace(/\.gz$/i, '') || f.name, text }]; }
    return [{ name: f.name, text: new TextDecoder().decode(buf) }];
  }
  async function unzip(buf){
    const dv = new DataView(buf), bytes = new Uint8Array(buf), dec = new TextDecoder();
    let eocd = -1;
    for(let i = buf.byteLength - 22; i >= 0 && i > buf.byteLength - 22 - 65536; i--){ if(dv.getUint32(i, true) === 0x06054b50){ eocd = i; break; } }
    if(eocd < 0) throw new Error('повреждённый ZIP');
    const count = dv.getUint16(eocd + 10, true); let off = dv.getUint32(eocd + 16, true); const out = [];
    for(let n = 0; n < count; n++){
      if(dv.getUint32(off, true) !== 0x02014b50) break;
      const method = dv.getUint16(off + 10, true), compSize = dv.getUint32(off + 20, true);
      const nameLen = dv.getUint16(off + 28, true), extraLen = dv.getUint16(off + 30, true), commentLen = dv.getUint16(off + 32, true);
      const lho = dv.getUint32(off + 42, true);
      const name = dec.decode(bytes.subarray(off + 46, off + 46 + nameLen));
      off += 46 + nameLen + extraLen + commentLen;
      if(/\/$/.test(name) || !CODE_RE.test(name)) continue;   // папки и не-код тихо пропускаем
      const lnameLen = dv.getUint16(lho + 26, true), lextraLen = dv.getUint16(lho + 28, true);
      const dataStart = lho + 30 + lnameLen + lextraLen, comp = bytes.subarray(dataStart, dataStart + compSize);
      let text;
      if(method === 0) text = dec.decode(comp);
      else if(method === 8) text = await decomp(comp, 'deflate-raw');
      else continue;
      out.push({ name: name.split('/').pop(), text });
    }
    return out;
  }

  // видимые образцы: один кусок на каждый язык + сборник. Это то, что реально принимает загрузчик.
  const EXAMPLES = {
    js: {
      _label: 'Один кусок — JavaScript',
      _desc: 'Один кусок JS. lang — язык, title — название, code — код, words — пояснения к словам (необязательно).',
      lang: 'js', title: 'сумма массива', group: 'Данные: хранить, находить и преобразовывать / Перебирать, фильтровать, сортировать',
      desc: 'Складывает числа массива в одно значение.',
      code: 'const числа = [10, 20, 30];\nconst сумма = числа.reduce((итог, x) => итог + x, 0);\nconsole.log(сумма);',
      output: 'в консоли: 60',
      words: { reduce: 'reduce — сворачивает массив в одно значение (здесь — в сумму).', 'итог': 'итог — накопитель: сюда прибавляется каждый элемент.' }
    },
    python: {
      _label: 'Один кусок — Python',
      _desc: 'Кусок на Python. Запускается на компьютере через локальный сервер (кнопка ▶).',
      lang: 'python', title: 'среднее по списку', group: 'Основы / Python',
      desc: 'Считает среднее арифметическое списка чисел.',
      code: 'числа = [4, 8, 15, 16]\nсреднее = sum(числа) / len(числа)\nprint(среднее)',
      output: 'в консоли: 10.75',
      words: { sum: 'sum — сумма всех элементов списка (Python).', len: 'len — длина: сколько элементов в списке.' }
    },
    html: {
      _label: 'Один кусок — HTML',
      _desc: 'Кусок разметки. В песочнице сразу рисуется в предпросмотре.',
      lang: 'html', title: 'карточка товара', group: 'Интерфейс / Кнопки и размеры',
      desc: 'Простая карточка: заголовок, текст, кнопка.',
      code: '<div class="card">\n  <h3>Товар</h3>\n  <p>Короткое описание.</p>\n  <button>Купить</button>\n</div>',
      words: { div: '<div> — блок-контейнер для группировки.', button: '<button> — кнопка, по клику запускает действие.' }
    },
    css: {
      _label: 'Один кусок — CSS',
      _desc: 'Кусок стилей. Задаёт вид элементов.',
      lang: 'css', title: 'стиль кнопки', group: 'CSS: оформление и адаптивность / Стили и адаптивная вёрстка',
      desc: 'Скруглённая цветная кнопка.',
      code: 'button {\n  padding: 8px 16px;\n  border: 0;\n  border-radius: 8px;\n  background: #FF006E;\n  color: #fff;\n  cursor: pointer;\n}',
      words: { padding: 'padding — внутренний отступ, от края до содержимого.', 'border-radius': 'border-radius — скругление углов.', cursor: 'cursor — вид курсора; pointer — «рука».' }
    },
    sql: {
      _label: 'Один кусок — SQL',
      _desc: 'Запрос к базе данных.',
      lang: 'sql', title: 'топ по сумме', group: 'SQL: запросы и таблицы / Выбрать и сгруппировать данные',
      desc: 'Берёт 5 строк с наибольшей суммой.',
      code: 'SELECT имя, сумма\nFROM сделки\nWHERE сумма > 0\nORDER BY сумма DESC\nLIMIT 5;',
      words: { SELECT: 'SELECT — выбрать данные из таблицы.', WHERE: 'WHERE — условие отбора строк.', ORDER: 'ORDER BY — сортировка результата.' }
    },
    collection: {
      _label: 'Сборник — много кусков + словарь',
      _desc: 'Главный способ грузить пачкой. dict и words учат общий словарь; pieces — список кусков. Всё, чего нет в словаре, добавляется.',
      dict: { words: { ytm: 'YTM — доходность облигации к погашению (% годовых, если держать до конца).' } },
      pieces: [
        { lang: 'js', title: 'доходность (простая)', group: 'Математика, финансы и анализ данных / Статистика и временные ряды', desc: 'Грубая оценка YTM.', code: 'const купон = 80;\nconst цена = 950;\nconst номинал = 1000;\nconst ytm = (купон + (номинал - цена) / 3) / цена;', words: { номинал: 'номинал — сумма, которую вернут в конце (обычно 1000 ₽).' } },
        { lang: 'python', title: 'проценты роста', group: 'Основы / Python', desc: 'На сколько % выросло.', code: 'было = 100\nстало = 125\nрост = (стало - было) / было * 100\nprint(рост)', output: '25.0' }
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
          '<button class="btn ok up-load">📥 загрузить куски</button>' +
          '<input type="file" class="up-file" accept=".zip,.gz,.json,.js,.mjs,.jsx,.ts,.tsx,.py,.rb,.php,.go,.lua,.sh,.bash,.ps1,.r,.sql,.html,.htm,.css,.txt" multiple style="display:none">' +
          '<span class="up-note muted">код-файлы (.js/.py/.css/.html…), архив (.zip/.gz), полный кусок JSON или сборник — можно несколько сразу</span>' +
        '</div>' +
        '<div class="up-nav">' +
          '<div class="up-nav-head">📂 актуальные разделы и подразделы. Клик по строке — скопировать её, чтобы вписать в поле <code>group</code> своего файла. Новый раздел — просто впиши новый путь (через « / » — подраздел), он создастся при загрузке:</div>' +
          '<div class="up-nav-tree">загрузка…</div>' +
          '<div class="up-row">' +
            '<button class="btn up-navcopy">⧉ копировать весь список</button>' +
            '<span class="up-navmsg up-note muted"></span>' +
          '</div>' +
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

    // КОПИРУЕМЫЙ живой список разделов и подразделов (все пути, включая промежуточные)
    const navTree = host.querySelector('.up-nav-tree'), navMsg = host.querySelector('.up-navmsg');
    const escAttr = s => String(s).replace(/"/g, '&quot;');
    let allPaths = [];
    const buildNav = (list) => {
      const root = {}; const paths = new Set();
      (list || []).forEach(t => {
        const parts = String(t.group || 'Разное').split('/').map(s => s.trim()).filter(Boolean);
        let node = root; const acc = [];
        (parts.length ? parts : ['Разное']).forEach(seg => { acc.push(seg); const p = acc.join(' / '); paths.add(p); node[seg] = node[seg] || { c: 0, p, ch: {} }; node[seg].c++; node = node[seg].ch; });
      });
      allPaths = [...paths].sort((a, b) => a.localeCompare(b, 'ru'));
      const render = (node, depth) => Object.keys(node).sort((a, b) => a.localeCompare(b, 'ru')).map(k => {
        const n = node[k];
        return '<div class="up-nav-i" data-path="' + escAttr(n.p) + '" title="клик — скопировать «' + escAttr(n.p) + '»" style="padding-left:' + (depth * 15 + 6) + 'px">' + esc(k) + ' <span class="up-nav-c">' + n.c + '</span></div>' + render(n.ch, depth + 1);
      }).join('');
      navTree.innerHTML = render(root, 0) || '<div class="up-note muted" style="padding:4px 6px">разделов пока нет</div>';
    };
    const refreshNav = () => fetch('/api/list').then(r => r.json()).then(buildNav).catch(() => { navTree.textContent = 'сервер недоступен'; });
    refreshNav();
    // клик по строке — копируем именно этот путь (чтобы вписать в group файла)
    navTree.addEventListener('click', e => {
      const i = e.target.closest('.up-nav-i'); if(!i) return;
      const path = i.dataset.path;
      if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(path).catch(() => {});
      navMsg.textContent = '✓ скопировано: ' + path; setTimeout(() => { navMsg.textContent = ''; }, 2500);
    });
    host.querySelector('.up-navcopy').onclick = e => copyText(allPaths.join('\n'), e.currentTarget);

    const sel = host.querySelector('.up-lang'), descEl = host.querySelector('.up-desc'), codeEl = host.querySelector('.up-code'), whatEl = host.querySelector('.up-what');
    ORDER.forEach(k => { const o = document.createElement('option'); o.value = k; o.textContent = EXAMPLES[k]._label; sel.appendChild(o); });
    const clean = ex => { const c = {}; for(const [k, v] of Object.entries(ex)) if(k[0] !== '_') c[k] = v; return c; };
    let curText = '', curName = '';
    const show = () => {
      const ex = EXAMPLES[sel.value]; const obj = clean(ex);   // образец с полем group — его ты и впишешь сама
      curText = JSON.stringify(obj, null, 2);
      curName = (sel.value === 'collection' ? 'сборник' : 'кусок-' + ex.lang) + '.json';
      descEl.textContent = ex._desc;
      codeEl.textContent = curText;
      whatEl.textContent = 'раздел задаётся полем group внутри файла — скопируй путь из списка выше';
    };
    sel.onchange = show; show();

    host.querySelector('.up-copy').onclick = e => copyText(curText, e.currentTarget);
    host.querySelector('.up-dl').onclick = () => download(curText, curName);

    // загрузчик файлов → /api/import
    const loadBtn = host.querySelector('.up-load'), fileIn = host.querySelector('.up-file');
    loadBtn.onclick = () => fileIn.click();
    fileIn.onchange = async () => {
      const files = [...fileIn.files]; if(!files.length) return;
      const o = loadBtn.textContent; loadBtn.disabled = true; loadBtn.textContent = '…';
      // архивы (zip/gz) распаковываем в записи; обычные файлы — одна запись
      let entries = [];
      for(const f of files){ try { entries = entries.concat(await extractFile(f)); } catch(_){} }
      let created = 0, learned = 0, updated = 0, bad = 0; const warns = [];
      for(const e of entries){
        const ext = (e.name.split('.').pop() || '').toLowerCase(); let payload;
        // раздел берём ИЗ файла (поле group). Код-файлы без group — лягут в «без раздела», разложишь в Описи.
        if(ext === 'json'){ try { payload = JSON.parse(e.text); } catch(_){ bad++; continue; } }
        else payload = { lang: EXT_LANG[ext] || 'txt', title: e.name.replace(/\.[^.]+$/, ''), code: e.text, group: '' };
        let r; try { r = await fetch('/api/import', { method: 'POST', body: JSON.stringify(payload) }).then(x => x.json()); } catch(_){ r = null; }
        if(r && r.ok){ created += r.created || 0; learned += r.learned || 0; updated += r.updated || 0; if(Array.isArray(r.warnings)) warns.push(...r.warnings); } else bad++;
      }
      loadBtn.disabled = false; fileIn.value = '';
      const parts = ['+' + created + ' кусков']; if(updated) parts.push(updated + ' обновл.'); if(learned) parts.push('+' + learned + ' слов'); if(warns.length) parts.push('⚠ ' + warns.length + ' не код'); else if(bad) parts.push(bad + ' пропущено');
      loadBtn.textContent = '✓ ' + parts.join(', ');
      if(warns.length) alert('Пропущены куски, где «код» — это русский текст без кода (похоже на словарь/синонимы):\n\n' + warns.slice(0, 20).map(w => '• ' + w.title).join('\n') + (warns.length > 20 ? '\n…и ещё ' + (warns.length - 20) : '') + '\n\nЕсли это пояснения — грузи их через «Словарь пояснений», а синонимы — через «Синонимы».');
      setTimeout(() => { loadBtn.textContent = o; }, 3500);
      refreshNav();   // список разделов живой: новый раздел из файла виден сразу
      if(typeof opts.onDone === 'function') opts.onDone();
    };
  };
})();
