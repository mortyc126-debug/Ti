// Страница компонента: 4 уровня раскрытия по схеме пользователя.
// Данные — из template.component (если есть), иначе мягкий fallback на код/описание.
const ID = decodeURIComponent((location.search.match(/[?&]id=([^&]+)/) || [])[1] || (location.hash || '').replace(/^#/, ''));
const root = document.getElementById('root');
let NOTES = {};   // пояснения к словам, хранятся на компоненте (component.notes)
let LNOTES = {};  // пояснения к строкам, ключ — текст строки без пробелов по краям (component.lineNotes)
let DICT = {};    // общий словарь пояснений + варианты значений (тот же, что в разборе кода)
let CUR_LANG = '', CODE = '';   // язык и текущий код куска (для переключения вариантов)
(window.codelabKwDict ? window.codelabKwDict() : fetch('/keyword-dict.json', { cache: 'no-store' }).then(r => r.json())).then(d => { DICT = d || {}; _pool = null; markVariants(); }).catch(() => {});

// пояснение слова из словаря (сначала язык куска, потом общий/HTML/CSS/любой язык)
function dictExplain(word){
  const lw = String(word).toLowerCase(), l = (CUR_LANG || '').toLowerCase();
  if(l && DICT.langs && DICT.langs[l] && DICT.langs[l][lw]) return DICT.langs[l][lw];
  if(DICT.words && DICT.words[lw]) return DICT.words[lw];
  for(const s of ['cssProps','cssVals','htmlTags','htmlAttrs']) if(DICT[s] && DICT[s][lw]) return DICT[s][lw];
  if(DICT.langs) for(const k of Object.keys(DICT.langs)) if(DICT.langs[k][lw]) return DICT.langs[k][lw];
  return '';
}
// подчеркнуть слова, у которых в словаре есть похожие (тот же корень) — видно, что можно менять
function markVariants(){
  document.querySelectorAll('.cln .w').forEach(s => { if(siblingWords(s.textContent).length){ s.classList.add('has-var'); if(!s.title) s.title = 'клик — похожие варианты из словаря'; } });
}
// перерисовать блок кода (② «Что меняешь») после правки
function rerenderCode(){ const host = document.querySelector('.code-host'); if(host){ host.innerHTML = ''; host.appendChild(noteCode(CODE)); markVariants(); } }

// словарь-пул под язык куска: {ключ: пояснение} — из него выводим похожие слова (кэш, т.к. зовётся на каждый токен)
let _pool = null, _poolLang = null;
function poolKeys(){
  const l = (CUR_LANG || '').toLowerCase();
  if(_pool && _poolLang === l) return _pool;
  const out = {}; const put = o => { if(o) for(const k of Object.keys(o)) if(typeof o[k] === 'string') out[k.toLowerCase()] = o[k]; };
  if(DICT.langs && DICT.langs[l]) put(DICT.langs[l]);
  if(l === 'css' || l === 'html' || l === 'htm'){ ['cssProps','cssVals','htmlTags','htmlAttrs'].forEach(s => put(DICT[s])); }
  put(DICT.words);
  _pool = out; _poolLang = l; return out;
}
const stemOf = w => String(w).split(/[-.:_]/)[0].toLowerCase();
// похожие слова из словаря — с общим «корнем» (padding → padding-top/left…, Object → Object.assign…)
function siblingWords(word){
  const pool = poolKeys(), stem = stemOf(word), lw = String(word).toLowerCase(), out = [];
  if(stem.length < 3) return out;
  for(const k of Object.keys(pool)){ if(k === lw) continue;
    if(k === stem || k.startsWith(stem + '-') || k.startsWith(stem + '.') || k.startsWith(stem + '_')) out.push({ value: k, expl: pool[k] }); }
  return out.sort((a, b) => a.value.localeCompare(b.value)).slice(0, 16);
}
// заменить само слово под кликом новым (родственным) — правит код куска и сохраняет
function setWord(span, newWord){
  span.textContent = newWord;
  const rows = document.querySelectorAll('.code-host .crow');
  CODE = [...rows].map(r => { const c = r.querySelector('.cln'); return c ? c.textContent.replace(/​/g, '') : ''; }).join('\n');
  closeNotePop(); rerenderCode();
  fetch('/api/edit', { method:'POST', body: JSON.stringify({ id: ID, code: CODE }) }).catch(() => {});
}
// строка выбора: яркая кнопка + пояснение из словаря рядом
function choiceRow(label, expl, onPick, isCur){
  const row = el('div', 'np-choice');
  const b = el('button', 'np-var' + (isCur ? ' cur' : ''), label); b.onclick = onPick; row.appendChild(b);
  if(expl){ const e = el('span', 'np-ce'); e.textContent = expl; row.appendChild(e); }
  return row;
}

(async function(){
  if(!ID){ root.innerHTML = '<div class="muted pad">не указан компонент</div>'; return; }
  let t;
  try { t = await fetch('/api/template?id=' + encodeURIComponent(ID)).then(r => r.json()); }
  catch(_){ root.innerHTML = '<div class="muted pad">не загрузился</div>'; return; }
  render(t);
})();

// секция с номером и заголовком — страница куска идёт сверху вниз в этом порядке
function panel(title, node, ai){
  const d = el('div', 'cpanel');
  const h = el('h3', 'cpanel-h'); h.appendChild(el('span', '', title));
  const slot = el('div', 'ai-slot');
  (ai || []).forEach(sec => h.appendChild(aiButton(sec, slot)));
  d.appendChild(h); d.appendChild(slot); if(node) d.appendChild(node); return d;
}
function elHtml(tag, cls, html){ const e = document.createElement(tag); if(cls) e.className = cls; if(html != null) e.innerHTML = html; return e; }
// чипы имён с типом («имя: тип» → имя + цветной тег)
let LABELS = {};   // подписи к именам «даёт/нужно» с сервера (/api/template → labels)
function nameChips(arr){
  if(!arr || !arr.length) return '<span class="muted">— не указано</span>';
  if(window.contractLabeledChips) return window.contractLabeledChips(arr, LABELS);
  return arr.map(s => {
    const it = window.contractParseItem ? window.contractParseItem(s) : { name: s, type: '' };
    const ty = it.type ? ' <span class="ct-ty" style="color:' + window.contractTypeColor(it.type) + ';border-color:' + window.contractTypeColor(it.type) + '55">' + esc(it.type) + '</span>' : '';
    return '<span class="ct-item">' + esc(it.name) + ty + '</span>';
  }).join(' ');
}

function render(t){
  const c = t.component || null;
  NOTES = (c && c.notes && typeof c.notes === 'object') ? c.notes : {};
  LNOTES = (c && c.lineNotes && typeof c.lineNotes === 'object') ? c.lineNotes : {};
  const codeText = c && c.views && c.views.use && c.views.use.code ? c.views.use.code.content
                 : (t.lines || []).map(l => (l || []).map(k => k.v != null ? k.v : '').join('')).join('\n');
  // если в файле контракта нет — берём вычисленный по коду (сервер отдаёт его в t.contract)
  const provides = (c && c.provides && c.provides.length ? c.provides : (t.contract && t.contract.provides)) || [];
  const requires = (c && c.requires && c.requires.length ? c.requires : (t.contract && t.contract.requires)) || [];
  LABELS = t.labels || {};
  const summary = (c && c.summary) || {}, check = (c && c.views && c.views.check) || {};
  root.innerHTML = '';

  // ── шапка ──
  const head = el('div', 'chead');
  const h1 = document.createElement('h1'); h1.textContent = t.title || t.id; head.appendChild(h1);
  const badges = el('div', 'badges');
  const tags = (c && c.tags) || {};
  if(t.group) badges.appendChild(badge('purpose', t.group));
  (tags.runtime || []).forEach(x => badges.appendChild(badge('runtime', x)));
  badges.appendChild(badge('tech', (t.lang || 'js').toUpperCase()));
  head.appendChild(badges);
  root.appendChild(head);

  const runnable = (t.lang === 'js') || (c && c.tags && (c.tags.technology || []).some(x => /javascript|js/i.test(x)));

  // ① Что делает — функция куска одним-двумя предложениями
  root.appendChild(panel('① Что делает', elHtml('div', 'func', descFmt(t.desc || (c && c.description) || '<span class="muted">не описано — допиши в Описи</span>')
    + (summary.output ? '<div class="func-out">Отдаёт: ' + esc(summary.output) + '</div>' : '')), ['desc']));

  // ② Что меняешь (код) + запуск
  CUR_LANG = t.lang || ''; CODE = codeText;
  const codeWrap = document.createElement('div');
  codeWrap.appendChild(el('div', 'note-hint', 'Клик по слову — пояснение из словаря и своя заметка. Свойства с вариантами подчёркнуты — клик меняет значение сразу. Клик по точке слева — пояснение к строке.'));
  const codeHost = el('div', 'code-host'); codeHost.appendChild(noteCode(CODE)); codeWrap.appendChild(codeHost);
  setTimeout(markVariants, 0);   // подчеркнуть изменяемые свойства (если словарь уже загружен)
  if(runnable){
    const rb = btn('▶ запустить', 'primary'); rb.style.marginTop = '6px';
    const box = el('div', 'preview'); rb.onclick = () => runDemo(box, c, codeText);
    const h = document.createElement('div'); h.append(rb, box); codeWrap.appendChild(h);
  }
  root.appendChild(panel('② Что меняешь', codeWrap, ['notes']));

  // ③ Имена и требования — что даёт/берёт (с типами) + требования к значениям
  const s3 = document.createElement('div');
  s3.appendChild(elHtml('div', 'nm-row', '<span class="nm-lbl give">имена-выходы (даёт):</span> ' + nameChips(provides)));
  s3.appendChild(elHtml('div', 'nm-row', '<span class="nm-lbl need">имена-входы (нужно):</span> ' + nameChips(requires)));
  const reqs = summary.requirements;
  const reqTxt = Array.isArray(reqs) ? reqs.map(esc).join('<br>') : (reqs ? esc(reqs) : '');
  s3.appendChild(elHtml('div', 'nm-req', '<b>Требования к значениям:</b> ' + (reqTxt || '<span class="muted">не описаны</span>')
    + (summary.input ? '<br><b>Что подать на вход:</b> ' + esc(summary.input) : '')));
  root.appendChild(panel('③ Имена и требования', s3, ['requirements']));

  // ④ Можно / нельзя — ограничения, края, что сломается
  root.appendChild(panel('④ Можно / нельзя', elHtml('div', 'cando', check.errors
    ? esc(check.errors)
    : '<span class="muted">ограничения не описаны. Проверь на краях: пустой вход, не те типы, спецсимволы.</span>'), ['limits', 'errors']));

  // ⑤ Связи — к чему подключается (редактируется; влияет на авто-разводку)
  const s5 = document.createElement('div');
  s5.appendChild(elHtml('div', 'link-expl',
    (requires.length ? 'Подключи сюда кусок, который <b>даёт</b>: ' + nameChips(requires) : 'Входов нет — куску ничего не нужно извне.')
    + (provides.length ? '<br>Дальше этот кусок <b>отдаёт</b>: ' + nameChips(provides) + ' — их можно подать в следующий.' : '')));
  s5.appendChild(contractEditor(t));
  root.appendChild(panel('⑤ Связи', s5));

  // ⑥ dict-usage: какие слова/конструкции словаря есть в этом куске и где ещё они встречаются
  { const s6 = document.createElement('div'); s6.appendChild(el('div', 'muted', 'считаю…'));
    root.appendChild(panel('⑥ Где ещё используется', s6));
    fetch('/api/piece/terms?id=' + encodeURIComponent(t.id)).then(r => r.json()).then(r => {
      s6.innerHTML = '';
      const rows = (r && r.ok ? r.terms : []).filter(x => x.kind !== 'generic');
      if(!rows.length){ s6.appendChild(el('div', 'muted', 'в этом куске не найдено конструкций из словаря')); return; }
      rows.sort((a, b) => (b.kind === 'construct') - (a.kind === 'construct') || a.n - b.n || a.term.localeCompare(b.term));
      s6.appendChild(el('div', 'note-hint', 'Конструкции и слова из словаря, которые есть в этом коде. Справа — другие куски, где они тоже встречаются (редкие — сверху).'));
      rows.slice(0, 60).forEach(x => {
        const row = el('div', 'frag'); row.style.cssText = 'display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;padding:3px 0';
        const nm = el('span', 'fn', x.term); nm.title = x.note || ''; nm.style.flex = 'none'; row.appendChild(nm);
        const rest = el('span', 'ro'); rest.style.cssText = 'flex:1;min-width:140px';
        if(!x.others.length) rest.textContent = 'только здесь';
        else { rest.appendChild(document.createTextNode(x.n - 1 + ': ')); x.others.slice(0, 5).forEach((p, i) => { if(i) rest.appendChild(document.createTextNode(', ')); const a = document.createElement('a'); a.href = '/component.html?id=' + encodeURIComponent(p.id); a.textContent = p.title || p.id; rest.appendChild(a); }); if(x.n - 1 > 5) rest.appendChild(document.createTextNode(' …')); }
        row.appendChild(rest); s6.appendChild(row);
      });
      if(rows.length > 60) s6.appendChild(el('div', 'muted', '…и ещё ' + (rows.length - 60)));
    }).catch(() => { s6.innerHTML = ''; s6.appendChild(el('div', 'muted', 'не удалось посчитать')); }); }

  // проверка результата (если описана)
  if(check.expected_result || (check.common_errors && check.common_errors.length) || check.tests){
    root.appendChild(panel('Проверка результата', viewCheck(c)));
  }

  // ── действия ──
  const actions = el('div', 'actions');
  const useBtn = btn('→ в конструктор', 'primary'); useBtn.onclick = () => toConstructor(t, codeText); actions.appendChild(useBtn);
  const copyBtn = btn('⧉ копировать код'); copyBtn.onclick = () => { navigator.clipboard.writeText(codeText); flash(copyBtn, '✓ скопировано'); }; actions.appendChild(copyBtn);
  root.appendChild(actions);
}

// ── Применение ──
function viewUse(c, codeText, runnable, t){
  const wrap = document.createElement('div'); wrap.className = 'view on';
  const use = c && c.views && c.views.use;
  let n = 1;
  if(use && use.html){ wrap.appendChild(step(n++, 'Подготовь HTML', codeBlock(use.html, 'html'))); }
  const mainCode = document.createElement('div');
  mainCode.appendChild(el('div', 'note-hint', 'Клик по слову — пояснение к слову · клик по точке слева от строки — пояснение ко всей строке. Всё сохраняется на компоненте.'));
  mainCode.appendChild(noteCode(codeText));
  wrap.appendChild(step(n++, use ? 'Добавь JavaScript' : 'Код', mainCode));
  if(use && use.example_input){
    const ex = document.createElement('div');
    ex.appendChild(codeBlock('const colors = ' + JSON.stringify(use.example_input, null, 2) + ';' + (use.demo ? '\n' + use.demo : ''), 'js'));
    wrap.appendChild(step(n++, 'Пример данных и вызов', ex));
  }
  if(runnable){
    const rb = btn('▶ запустить пример', 'primary'); rb.style.marginTop = '4px';
    const box = document.createElement('div'); box.className = 'preview';
    rb.onclick = () => runDemo(box, c, codeText);
    const holder = document.createElement('div'); holder.append(rb, box);
    wrap.appendChild(step(n++, 'Проверь результат', holder));
  }
  if(c && c.views && c.views.check && c.views.check.expected_result){
    const er = el('div', 'note'); er.textContent = 'Ожидаемый результат: ' + c.views.check.expected_result; wrap.appendChild(er);
  }
  return wrap;
}

// ── Проверка ──
function viewCheck(c){
  const wrap = document.createElement('div'); wrap.className = 'view on';
  const ch = c && c.views && c.views.check;
  if(!ch){ wrap.innerHTML = '<div class="muted">проверка пока не описана</div>'; return wrap; }
  if(ch.expected_result){ const e = el('div', 'about-row'); e.innerHTML = '<h4>Ожидаемый результат</h4>'; const p = document.createElement('div'); p.style.fontSize = '13px'; p.textContent = ch.expected_result; e.appendChild(p); wrap.appendChild(e); }
  if(ch.common_errors && ch.common_errors.length){
    const r = el('div', 'about-row'); r.innerHTML = '<h4>Не работает? Типичные ошибки</h4>';
    const g = el('div', 'err');
    g.innerHTML = '<div class="h">симптом</div><div class="h">причина</div><div class="h">решение</div>';
    ch.common_errors.forEach(e => {
      g.innerHTML += '<div class="cell sym">' + esc(e.symptom) + '</div><div class="cell">' + esc(e.cause) + '</div><div class="cell">' + esc(e.solution) + '</div>';
    });
    r.appendChild(g); wrap.appendChild(r);
  }
  if(ch.tests){
    const r = el('div', 'about-row'); r.innerHTML = '<h4>Тесты и статус</h4>';
    const st = STATUS[ch.tests.status] || ch.tests.status;
    const sl = el('div', 'statusline'); sl.innerHTML = 'статус: <span class="st bad">' + esc(st) + '</span>';
    r.appendChild(sl);
    if(ch.tests.cases && ch.tests.cases.length){
      const cs = el('div', 'cases'); ch.tests.cases.forEach(x => { const c = el('span', 'case', x); cs.appendChild(c); }); r.appendChild(cs);
      const note = el('div', 'note', 'Тесты для демонстрационного примера не запускались — это предложенные проверки.'); r.appendChild(note);
    }
    wrap.appendChild(r);
  }
  return wrap;
}

// ── Устройство ──
function viewAbout(c){
  const wrap = document.createElement('div'); wrap.className = 'view on';
  const ab = c && c.views && c.views.about;
  if(!ab){ wrap.innerHTML = '<div class="muted">устройство пока не описано</div>'; return wrap; }
  if(ab.fragments && ab.fragments.length){
    const r = el('div', 'about-row'); r.innerHTML = '<h4>Из чего состоит</h4>';
    const fr = el('div', 'frags'); ab.fragments.forEach(f => { const d = el('div', 'frag'); d.innerHTML = '<span class="fn">' + esc(f.name) + '</span><span class="ro">' + esc(f.role) + '</span>'; fr.appendChild(d); }); r.appendChild(fr); wrap.appendChild(r);
  }
  if(ab.effects && ab.effects.length){ const r = el('div', 'about-row'); r.innerHTML = '<h4>Что делает со средой</h4>'; const cs = el('div', 'chips'); ab.effects.forEach(x => cs.appendChild(el('span', 'chip', x))); cs.appendChild(el('span', 'chip', ab.network ? 'ходит в сеть' : 'без сети')); r.appendChild(cs); wrap.appendChild(r); }
  if(ab.connections && ab.connections.length){ const r = el('div', 'about-row'); r.innerHTML = '<h4>Связи</h4>'; const fr = el('div', 'frags'); ab.connections.forEach(f => { const d = el('div', 'frag'); d.innerHTML = '<span class="fn">' + esc(f.name) + '</span><span class="ro">' + esc(f.role || '') + '</span>'; fr.appendChild(d); }); r.appendChild(fr); wrap.appendChild(r); }
  if(c.verification){ const r = el('div', 'about-row'); r.innerHTML = '<h4>Статус проверки</h4>'; const cs = el('div', 'chips');
    Object.entries(c.verification).forEach(([k, v]) => cs.appendChild(el('span', 'chip', (VER[k] || k) + ': ' + (STATUS[v] || v)))); r.appendChild(cs); wrap.appendChild(r); }
  const ver = el('div', 'note', 'версия ' + ((c && c.version) || '—')); wrap.appendChild(ver);
  return wrap;
}

// ── запуск демо в песочнице ──
function runDemo(box, c, codeText){
  const use = c && c.views && c.views.use;
  const html = (use && use.html) || '';
  const example = use && use.example_input ? ('const colors = ' + JSON.stringify(use.example_input) + ';\n') : '';
  const demo = (use && use.demo) || '';
  const js = codeText + '\n' + example + demo;
  let frame = box.querySelector('iframe'); if(!frame){ frame = document.createElement('iframe'); box.appendChild(frame); }
  frame.srcdoc = '<!doctype html><meta charset="utf-8"><body style="margin:8px;font:13px system-ui">' + html
    + '<pre id="__err" style="color:#c00;white-space:pre-wrap"></pre>'
    + '<script>try{\n' + js + '\n}catch(e){document.getElementById("__err").textContent="⛔ "+e.message;}<\/script></body>';
}

// ── «в конструктор» ──
function toConstructor(t, codeText){
  const name = (t.title || 'компонент').slice(0, 40);
  const LS = 'codelab_graph';
  let g = { nodes: [], edges: [] };
  try { const s = JSON.parse(localStorage.getItem(LS) || 'null'); if(s && Array.isArray(s.nodes)) g = s; } catch(_){}
  const uid = () => Math.random().toString(36).slice(2, 8);
  const n = g.nodes.length;
  const comp = t.component || {};
  // узел приходит полным: код + связь с источником + типизированный контракт (чтобы в конструкторе ничего не терялось)
  g.nodes.push({ id: uid(), blockId: 'raw', fields: { code: codeText }, x: 60 + (n % 6) * 30, y: 60 + (n % 6) * 30,
    title: name, desc: t.desc || '', descAt: t.descAt || 0,
    src: { id: t.id, title: name, desc: t.desc || '', code: codeText, lang: t.lang || 'js',
           contract: { provides: Array.isArray(comp.provides) ? comp.provides : [], requires: Array.isArray(comp.requires) ? comp.requires : [] } } });
  try { localStorage.setItem(LS, JSON.stringify(g)); } catch(_){}
  location.href = '/constructor.html';
}

// ── утилиты ──
const STATUS = { not_run:'не запускались', not_verified:'не проверялось', passed:'пройдены', failed:'провалены', verified:'проверено' };
const VER = { code_review:'ревью кода', tests:'тесты', compatibility:'совместимость' };
function step(n, title, node){ const d = el('div', 'step'); d.appendChild(el('div', 'step-n', n + '. ' + title)); d.appendChild(node); return d; }
function codeBlock(text, lang){
  const w = el('div', 'codewrap');
  const pre = document.createElement('pre'); pre.className = 'code'; pre.innerHTML = hl(text, lang);
  const cp = el('button', 'copy', '⧉'); cp.onclick = () => { navigator.clipboard.writeText(text); cp.textContent = '✓'; setTimeout(() => cp.textContent = '⧉', 1000); };
  w.append(pre, cp); return w;
}
const KW = new Set(['const','let','var','function','return','if','else','for','of','while','new','=>','throw','await','async','document']);
function hl(code, lang){
  if(lang === 'html') return esc(code).replace(/(&lt;\/?[\w-]+)/g, '<span class="f">$1</span>');
  const lines = esc(code).split('\n').map(line => {
    let out = '', i = 0, n = line.length;
    while(i < n){
      const rest = line.slice(i);
      if(rest.startsWith('//')){ out += '<span class="c">' + rest + '</span>'; break; }
      const str = /^(&quot;|&#039;|'|"|`)(?:\\.|(?!\1).)*\1?/.exec(rest) || /^'[^']*'/.exec(rest);
      if(rest[0] === "'" || rest.startsWith('&quot;') || rest.startsWith('&#039;')){ const m = /^('[^']*'|&quot;.*?&quot;|&#039;.*?&#039;)/.exec(rest); if(m){ out += '<span class="s">' + m[0] + '</span>'; i += m[0].length; continue; } }
      const num = /^\d[\d.]*/.exec(rest); if(num){ out += '<span class="n">' + num[0] + '</span>'; i += num[0].length; continue; }
      const w = /^[A-Za-zА-Яа-я_$][\wА-Яа-я$]*/.exec(rest);
      if(w){ const word = w[0]; let k = i + word.length; while(line[k] === ' ') k++; out += KW.has(word) ? '<span class="k">' + word + '</span>' : (line[k] === '(' ? '<span class="f">' + word + '</span>' : word); i += word.length; continue; }
      out += line[i]; i++;
    }
    return out;
  });
  return lines.join('\n');
}
// код с кликабельными словами и строками — пояснения хранятся на компоненте
function noteCode(text){
  const wrap = el('div', 'codewrap');
  const pre = document.createElement('pre'); pre.className = 'code noted';
  String(text).split('\n').forEach((line, _i) => {
    const row = el('div', 'crow'); row.dataset.i = _i;
    const lkey = line.trim();
    // клик по номеру строки слева — пояснение ко всей строке
    const g = el('span', 'lng', '•'); g.title = 'пояснение к строке';
    if(lkey && LNOTES[lkey]){ g.classList.add('has-lnote'); row.classList.add('has-lnote'); g.title = LNOTES[lkey]; }
    g.addEventListener('click', e => { e.stopPropagation(); if(lkey) openLineNote(lkey, g, row); });
    row.appendChild(g);
    const div = el('span', 'cln'); let i = 0; const n = line.length;
    const add = (cls, v, word) => {
      const s = document.createElement('span'); if(cls) s.className = cls; s.textContent = v;
      if(word){ s.classList.add('w'); if(NOTES[word]){ s.classList.add('has-note'); s.title = NOTES[word]; }
        s.addEventListener('click', e => { e.stopPropagation(); openNote(word, s); }); }
      div.appendChild(s);
    };
    while(i < n){
      const rest = line.slice(i), c = line[i];
      if(rest.startsWith('//')){ add('u', line.slice(i)); break; }
      if(c === '"' || c === "'" || c === '`'){ let j = i + 1; while(j < n && line[j] !== c) j++; j++; add('s', line.slice(i, j)); i = j; continue; }
      if(/[0-9]/.test(c)){ const m = /^\d[\d.]*/.exec(rest); add('n', m[0]); i += m[0].length; continue; }
      const m = /^[A-Za-zА-Яа-яЁё_$][\wА-Яа-яЁё$]*/.exec(rest);
      if(m){ const w = m[0]; let k = i + w.length; while(line[k] === ' ') k++; add(KW.has(w) ? 'k' : (line[k] === '(' ? 'f' : ''), w, w); i += w.length; continue; }
      add('', line[i]); i++;
    }
    if(!line.length) div.appendChild(document.createTextNode('​'));
    row.appendChild(div); pre.appendChild(row);
  });
  const cp = el('button', 'copy', '⧉'); cp.onclick = () => { navigator.clipboard.writeText(text); cp.textContent = '✓'; setTimeout(() => cp.textContent = '⧉', 1000); };
  wrap.append(pre, cp); return wrap;
}
function openNote(word, span){
  closeNotePop();
  const pop = el('div', 'note-pop'); pop.id = '_notepop';
  pop.appendChild(el('div', 'np-h', '«' + word + '»'));
  // пояснение из словаря (то же, что в разборе кода) — только показываем
  const dx = dictExplain(word);
  if(dx){ const e = el('div', 'np-expl'); e.textContent = dx; pop.appendChild(e); }
  // похожие слова из словаря (общий корень) — клик заменяет само слово; с пояснениями, чтобы понимать выбор
  const sibs = siblingWords(word);
  if(sibs.length){
    pop.appendChild(el('div', 'np-sub', 'похожее — заменить слово:'));
    const sb = el('div', 'np-choices');
    sibs.forEach(s => sb.appendChild(choiceRow(s.value, s.expl, () => setWord(span, s.value), s.value === String(word).toLowerCase())));
    pop.appendChild(sb);
  }
  pop.appendChild(el('div', 'np-sub', 'своя заметка:'));
  const ta = document.createElement('textarea'); ta.value = NOTES[word] || ''; ta.placeholder = 'что это значит, своими словами';
  const btns = el('div', 'np-btns');
  const sv = el('button', 'np-ok', 'сохранить'); const del = el('button', '', 'убрать');
  sv.onclick = async () => { const v = ta.value.trim(); if(v) NOTES[word] = v; else delete NOTES[word]; await saveNotes(); applyNote(word); closeNotePop(); };
  del.onclick = async () => { delete NOTES[word]; await saveNotes(); applyNote(word); closeNotePop(); };
  btns.append(sv, del); pop.append(ta, btns); document.body.appendChild(pop);
  const r = span.getBoundingClientRect();
  pop.style.left = Math.min(r.left + window.scrollX, window.scrollX + window.innerWidth - 290) + 'px';
  pop.style.top = (r.bottom + window.scrollY + 5) + 'px';
  ta.focus();
  setTimeout(() => document.addEventListener('mousedown', noteOutside), 0);
}
function applyNote(word){ document.querySelectorAll('.w').forEach(s => { if(s.textContent === word){ if(NOTES[word]){ s.classList.add('has-note'); s.title = NOTES[word]; } else { s.classList.remove('has-note'); s.removeAttribute('title'); } } }); }
function openLineNote(key, gutter, row){
  closeNotePop();
  const pop = el('div', 'note-pop'); pop.id = '_notepop';
  pop.appendChild(el('div', 'np-h', 'пояснение к строке'));
  const ta = document.createElement('textarea'); ta.value = LNOTES[key] || ''; ta.placeholder = 'что делает эта строка';
  const btns = el('div', 'np-btns');
  const sv = el('button', 'np-ok', 'сохранить'); const del = el('button', '', 'убрать');
  sv.onclick = async () => { const v = ta.value.trim(); if(v) LNOTES[key] = v; else delete LNOTES[key]; await saveNotes(); applyLineNote(); closeNotePop(); };
  del.onclick = async () => { delete LNOTES[key]; await saveNotes(); applyLineNote(); closeNotePop(); };
  btns.append(sv, del); pop.append(ta, btns); document.body.appendChild(pop);
  const r = gutter.getBoundingClientRect();
  pop.style.left = Math.min(r.left + window.scrollX, window.scrollX + window.innerWidth - 290) + 'px';
  pop.style.top = (r.bottom + window.scrollY + 5) + 'px';
  ta.focus();
  setTimeout(() => document.addEventListener('mousedown', noteOutside), 0);
}
function applyLineNote(){ document.querySelectorAll('.crow').forEach(row => { const g = row.querySelector('.lng'); const cln = row.querySelector('.cln'); if(!g || !cln) return; const key = cln.textContent.trim(); if(LNOTES[key]){ g.classList.add('has-lnote'); row.classList.add('has-lnote'); g.title = LNOTES[key]; } else { g.classList.remove('has-lnote'); row.classList.remove('has-lnote'); g.title = 'пояснение к строке'; } }); }
function noteOutside(e){ const p = document.getElementById('_notepop'); if(p && !p.contains(e.target)) closeNotePop(); }
function closeNotePop(){ const p = document.getElementById('_notepop'); if(p) p.remove(); document.removeEventListener('mousedown', noteOutside); }
async function saveNotes(){ await fetch('/api/edit', { method:'POST', body: JSON.stringify({ id: ID, notes: NOTES, lineNotes: LNOTES }) }).catch(() => {}); }

// редактор контракта «даёт/нужно» — имена-связи, сохраняются на компоненте
function contractEditor(t){
  const c = t.component || {};
  const box = el('div', 'contract-ed');
  box.appendChild(el('div', 'ce-h', 'Связи этого куска'));
  box.appendChild(el('div', 'ce-hint', 'Имена, которые кусок выдаёт («даёт») и которые берёт со стороны («нужно»). По ним конструктор авто-соединяет куски. Меняется вручную, сохраняется.'));
  const mkRow = (label, field, cls) => {
    const row = el('div', 'ce-row');
    row.appendChild(el('span', 'ce-lbl ' + cls, label));
    const inp = document.createElement('input'); inp.className = 'ce-in'; inp.value = (c[field] || []).join(', '); inp.placeholder = 'имена через запятую';
    const save = async () => {
      const vals = inp.value.split(',').map(s => s.trim()).filter(Boolean);
      inp.disabled = true;
      const r = await fetch('/api/edit', { method:'POST', body: JSON.stringify({ id: t.id, [field]: vals }) }).then(r => r.json()).catch(() => ({}));
      inp.disabled = false;
      c[field] = vals; flashDot(row, r && r.ok);
    };
    inp.addEventListener('change', save);
    inp.addEventListener('keydown', e => { if(e.key === 'Enter') inp.blur(); });
    row.appendChild(inp); return row;
  };
  box.appendChild(mkRow('даёт', 'provides', 'give'));
  box.appendChild(mkRow('нужно', 'requires', 'need'));
  return box;
}
function flashDot(row, ok){ let d = row.querySelector('.ce-ok'); if(!d){ d = el('span', 'ce-ok'); row.appendChild(d); } d.textContent = ok ? '✓' : '✕'; d.style.color = ok ? 'var(--str)' : '#FF6B6B'; setTimeout(() => { if(d) d.textContent = ''; }, 1200); }
function badge(cls, text){ return el('span', 'b ' + cls, text); }
function btn(text, extra){ const b = document.createElement('button'); b.className = 'btn' + (extra ? ' ' + extra : ''); b.textContent = text; return b; }
function flash(b, t){ const o = b.textContent; b.textContent = t; setTimeout(() => b.textContent = o, 1100); }
function el(tag, cls, text){ const e = document.createElement(tag); if(cls) e.className = cls; if(text != null) e.textContent = text; return e; }
function esc(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c])); }
// описание с кодом: `код` → цветная плашка, ```блок``` → цветной блок
function descFmt(s){
  s = String(s == null ? '' : s);
  const blocks = [];
  s = s.replace(/```([\s\S]*?)```/g, (m, c) => { blocks.push(c.replace(/^\n+|\n+$/g, '')); return '\u0001' + (blocks.length - 1) + '\u0001'; });
  let html = esc(s).replace(/`([^`\n]+)`/g, (m, c) => '<code class="desc-chip">' + c + '</code>').replace(/\n/g, '<br>');
  return html.replace(/\u0001(\d+)\u0001/g, (m, i) => '<pre class="desc-code">' + esc(blocks[+i]) + '</pre>');
}


// ═══ ИИ-дополнение раздела (Mistral) ═══════════════════════════════════════
// Порядок: «✨ дополнить» → (пожелание) → «предложить» → правишь текст → «применить».
// Пока не нажал «применить», в кусок ничего не пишется. Код куска ИИ не меняет.
const AI_KEY_LS = 'codeLab.mistralApiKey';
const AI_LABEL = { desc: 'описание', notes: 'пояснения', requirements: 'требования', limits: 'можно/нельзя', errors: 'ошибки' };
function aiKey(){ try { return localStorage.getItem(AI_KEY_LS) || ''; } catch(_){ return ''; } }

function aiButton(section, slot){
  const b = el('button', 'ai-btn', '✨ ' + AI_LABEL[section]);
  b.type = 'button'; b.title = 'Дополнить этот раздел через Mistral (сначала покажет предложение, ничего не запишет без твоего «применить»)';
  b.onclick = () => { slot.innerHTML = ''; slot.appendChild(aiBox(section, () => { slot.innerHTML = ''; })); };
  return b;
}

async function aiPost(url, body){
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-mistral-api-key': aiKey() }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if(!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}

function aiBox(section, close){
  const box = el('div', 'ai-box');
  const head = el('div', 'ai-h', 'ИИ дополнит раздел «' + AI_LABEL[section] + '». То, что уже написано тобой, сохраняется.');
  box.appendChild(head);

  // ключ: если его нет — спросим здесь же (тот же ключ, что в «Настройках» каталога)
  if(!aiKey()){
    const kr = el('div', 'ai-row');
    const ki = document.createElement('input'); ki.type = 'password'; ki.className = 'ai-in'; ki.placeholder = 'ключ Mistral (сохранится в этом браузере)';
    const kb = el('button', 'ai-go', 'сохранить ключ'); kb.type = 'button';
    kb.onclick = () => { const v = ki.value.trim(); if(!v) return; try { localStorage.setItem(AI_KEY_LS, v); } catch(_){ } box.replaceWith(aiBox(section, close)); };
    kr.append(ki, kb); box.appendChild(kr);
    const cancel = el('button', 'ai-cancel', 'закрыть'); cancel.type = 'button'; cancel.onclick = close; box.appendChild(cancel);
    return box;
  }

  const row = el('div', 'ai-row');
  const instr = document.createElement('input'); instr.className = 'ai-in'; instr.placeholder = 'пожелание (необязательно): «проще», «добавь пример», «объясни для новичка»';
  const go = el('button', 'ai-go', 'предложить'); go.type = 'button';
  const cancel = el('button', 'ai-cancel', 'закрыть'); cancel.type = 'button'; cancel.onclick = close;
  row.append(instr, go, cancel); box.appendChild(row);
  const out = el('div', 'ai-out'); box.appendChild(out);

  const run = async () => {
    go.disabled = true; go.textContent = 'думаю…'; out.innerHTML = '';
    try {
      const r = await aiPost('/api/ai-complete', { id: ID, section, instruction: instr.value });
      renderSuggestion(section, r, out, close);
    } catch(e){ out.appendChild(el('div', 'ai-err', '⛔ ' + e.message)); }
    go.disabled = false; go.textContent = 'ещё вариант';
  };
  go.onclick = run;
  instr.addEventListener('keydown', e => { if(e.key === 'Enter') run(); });
  setTimeout(() => instr.focus(), 0);
  return box;
}

function aiField(label, value, multi){
  const w = el('label', 'ai-f'); w.appendChild(el('span', 'ai-fl', label));
  const f = document.createElement(multi ? 'textarea' : 'input'); f.className = 'ai-fi'; f.value = value || '';
  if(multi) f.rows = Math.min(8, Math.max(2, String(value || '').split('\n').length + 1));
  w.appendChild(f); w.value = () => f.value; return w;
}

function renderSuggestion(section, r, out, close){
  out.innerHTML = '';
  const s = r.suggestion || {}, cur = r.current || {};
  let getValue;
  out.appendChild(el('div', 'ai-note', 'Это предложение. Поправь текст как нужно и нажми «применить».'));

  if(section === 'desc'){
    const a = aiField('Что делает', s.desc, true), b = aiField('Что на выходе', s.output, false);
    out.append(a, b); getValue = () => ({ desc: a.value(), output: b.value() });
  } else if(section === 'requirements'){
    const a = aiField('Что подать на вход', s.input, false), b = aiField('Требования (по одному на строку)', (s.requirements || []).join('\n'), true);
    out.append(a, b); getValue = () => ({ input: a.value(), requirements: b.value().split('\n').map(x => x.trim()).filter(Boolean) });
  } else if(section === 'limits'){
    const a = aiField('Можно / нельзя', s.errors, true); out.appendChild(a); getValue = () => ({ errors: a.value() });
  } else if(section === 'errors'){
    const rows = [];
    (s.common_errors || []).forEach(e => {
      const line = el('div', 'ai-err-row');
      const f1 = aiField('симптом', e.symptom), f2 = aiField('причина', e.cause), f3 = aiField('решение', e.solution);
      const keep = document.createElement('input'); keep.type = 'checkbox'; keep.checked = true; keep.title = 'взять эту строку';
      line.append(keep, f1, f2, f3); out.appendChild(line); rows.push({ keep, f1, f2, f3 });
    });
    getValue = () => ({ common_errors: rows.filter(x => x.keep.checked).map(x => ({ symptom: x.f1.value(), cause: x.f2.value(), solution: x.f3.value() })) });
    if(!rows.length) out.appendChild(el('div', 'ai-err', 'ИИ не предложил ошибок. Попробуй добавить пожелание.'));
  } else if(section === 'notes'){
    const items = [];
    const add = (kind, map, existing) => Object.entries(map || {}).forEach(([k, v]) => {
      if(existing && existing[k]) return;                      // то, что человек уже написал, не трогаем
      const line = el('div', 'ai-note-row');
      const keep = document.createElement('input'); keep.type = 'checkbox'; keep.checked = true;
      const key = el('code', 'ai-key', k.length > 70 ? k.slice(0, 70) + '…' : k); key.title = k;
      const f = aiField('', v, true);
      line.append(keep, el('span', 'ai-kind', kind === 'line' ? 'строка' : 'слово'), key, f); out.appendChild(line); items.push({ kind, k, keep, f });
    });
    add('line', s.lineNotes, cur.lineNotes); add('word', s.words, cur.words);
    if(!items.length) out.appendChild(el('div', 'ai-err', 'Новых пояснений нет — всё важное уже подписано. Попробуй добавить пожелание.'));
    getValue = () => {
      const v = { lineNotes: {}, words: {} };
      items.filter(x => x.keep.checked && x.f.value().trim()).forEach(x => { (x.kind === 'line' ? v.lineNotes : v.words)[x.k] = x.f.value(); });
      return v;
    };
  }

  const ok = el('button', 'ai-go ai-apply', 'применить'); ok.type = 'button';
  ok.onclick = async () => {
    ok.disabled = true; ok.textContent = 'сохраняю…';
    try {
      await aiPost('/api/ai-apply', { id: ID, section, value: getValue() });
      location.reload();
    } catch(e){ out.appendChild(el('div', 'ai-err', '⛔ не сохранилось: ' + e.message)); ok.disabled = false; ok.textContent = 'применить'; }
  };
  out.appendChild(ok);
}
