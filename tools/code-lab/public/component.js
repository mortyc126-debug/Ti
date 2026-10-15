// Страница компонента: 4 уровня раскрытия по схеме пользователя.
// Данные — из template.component (если есть), иначе мягкий fallback на код/описание.
const ID = decodeURIComponent((location.search.match(/[?&]id=([^&]+)/) || [])[1] || (location.hash || '').replace(/^#/, ''));
const root = document.getElementById('root');
let NOTES = {};   // пояснения к словам, хранятся на компоненте (component.notes)
let LNOTES = {};  // пояснения к строкам, ключ — текст строки без пробелов по краям (component.lineNotes)

(async function(){
  if(!ID){ root.innerHTML = '<div class="muted pad">не указан компонент</div>'; return; }
  let t;
  try { t = await fetch('/api/template?id=' + encodeURIComponent(ID)).then(r => r.json()); }
  catch(_){ root.innerHTML = '<div class="muted pad">не загрузился</div>'; return; }
  render(t);
})();

function render(t){
  const c = t.component || null;
  NOTES = (c && c.notes && typeof c.notes === 'object') ? c.notes : {};
  LNOTES = (c && c.lineNotes && typeof c.lineNotes === 'object') ? c.lineNotes : {};
  const codeText = c && c.views && c.views.use && c.views.use.code ? c.views.use.code.content
                 : (t.lines || []).map(l => (l || []).map(k => k.v != null ? k.v : '').join('')).join('\n');
  root.innerHTML = '';

  // ── шапка ──
  const head = el('div', 'chead');
  const h1 = document.createElement('h1'); h1.textContent = t.title || t.id; head.appendChild(h1);
  const badges = el('div', 'badges');
  const type = (c && c.type) || 'фрагмент';
  const typeRu = { fragment:'фрагмент', component:'компонент', recipe:'рецепт', module:'модуль' }[type] || type;
  badges.appendChild(badge('type', typeRu));
  const tags = (c && c.tags) || {};
  (tags.purpose || []).forEach(x => badges.appendChild(badge('purpose', x)));
  (tags.runtime || []).forEach(x => badges.appendChild(badge('runtime', x)));
  (tags.technology || [ (t.lang || '').toUpperCase() ]).forEach(x => x && badges.appendChild(badge('tech', x)));
  const safety = c && c.safety;
  if(safety && safety.level && safety.level !== 'ok') badges.appendChild(badge('warn', '⚠ ' + (safety.notes && safety.notes[0] ? safety.notes[0] : safety.level)));
  head.appendChild(badges);
  const desc = el('div', 'cdesc'); desc.innerHTML = descFmt(t.desc || (c && c.description) || ''); head.appendChild(desc);
  root.appendChild(head);

  // ── L2: контракт + необходимое ──
  if(c && c.summary){
    const brief = el('div', 'brief');
    const p1 = el('div', 'panel'); p1.innerHTML = '<h3>Контракт</h3>';
    const io = el('div', 'io');
    io.innerHTML = '<span class="in">' + esc(c.summary.input || '—') + '</span><span class="arrow">→</span><span class="out">' + esc(c.summary.output || '—') + '</span>';
    p1.appendChild(io); brief.appendChild(p1);
    const p2 = el('div', 'panel'); p2.innerHTML = '<h3>Необходимое</h3>';
    const req = el('div', 'req');
    const reqs = (c.summary.requirements || []); const deps = (c.summary.dependencies || []);
    req.innerHTML = (reqs.length ? reqs.map(esc).join('<br>') : 'ничего особенного')
      + '<div class="dep">' + (deps.length ? ('зависимости: ' + deps.map(esc).join(', ')) : 'библиотеки и сеть не нужны') + '</div>';
    p2.appendChild(req); brief.appendChild(p2);
    root.appendChild(brief);
  }

  // ── действия ──
  const actions = el('div', 'actions');
  const runnable = (t.lang === 'js') || (c && c.tags && (c.tags.technology || []).some(x => /javascript|js/i.test(x)));
  const useBtn = btn('→ в конструктор', 'primary'); useBtn.onclick = () => toConstructor(t, codeText); actions.appendChild(useBtn);
  const copyBtn = btn('⧉ копировать код'); copyBtn.onclick = () => { navigator.clipboard.writeText(codeText); flash(copyBtn, '✓ скопировано'); }; actions.appendChild(copyBtn);
  if(c && c.views && c.views.about){ const linkBtn = btn('связи'); linkBtn.onclick = () => showTab('about'); actions.appendChild(linkBtn); }
  root.appendChild(actions);

  // ── табы ──
  const haveC = !!(c && c.views);
  const tabs = el('div', 'tabs2');
  const defs = haveC ? [['use','Применение'],['check','Проверка'],['about','Устройство']] : [['use','Код']];
  defs.forEach(([k, label], i) => { const b = document.createElement('button'); b.dataset.k = k; b.textContent = label; if(i===0) b.classList.add('on'); b.onclick = () => showTab(k); tabs.appendChild(b); });
  root.appendChild(tabs);

  const body = el('div', ''); body.id = 'tabbody'; root.appendChild(body);

  function showTab(k){
    tabs.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.k === k));
    body.innerHTML = '';
    if(k === 'use') body.appendChild(viewUse(c, codeText, runnable, t));
    else if(k === 'check') body.appendChild(viewCheck(c));
    else body.appendChild(viewAbout(c));
  }
  window.showTab = showTab;
  showTab('use');
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
  g.nodes.push({ id: uid(), blockId: 'raw', fields: { code: codeText }, x: 60 + (n % 6) * 30, y: 60 + (n % 6) * 30, title: name });
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
  String(text).split('\n').forEach(line => {
    const row = el('div', 'crow');
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
  pop.appendChild(el('div', 'np-h', 'пояснение к «' + word + '»'));
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
