// Страница компонента: 4 уровня раскрытия по схеме пользователя.
// Данные — из template.component (если есть), иначе мягкий fallback на код/описание.
const ID = decodeURIComponent((location.search.match(/[?&]id=([^&]+)/) || [])[1] || (location.hash || '').replace(/^#/, ''));
const root = document.getElementById('root');

(async function(){
  if(!ID){ root.innerHTML = '<div class="muted pad">не указан компонент</div>'; return; }
  let t;
  try { t = await fetch('/api/template?id=' + encodeURIComponent(ID)).then(r => r.json()); }
  catch(_){ root.innerHTML = '<div class="muted pad">не загрузился</div>'; return; }
  render(t);
})();

function render(t){
  const c = t.component || null;
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
  const desc = el('div', 'cdesc'); desc.textContent = (c && c.description) || t.desc || ''; head.appendChild(desc);
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
  wrap.appendChild(step(n++, use ? 'Добавь JavaScript' : 'Код', codeBlock(codeText, 'js')));
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
function badge(cls, text){ return el('span', 'b ' + cls, text); }
function btn(text, extra){ const b = document.createElement('button'); b.className = 'btn' + (extra ? ' ' + extra : ''); b.textContent = text; return b; }
function flash(b, t){ const o = b.textContent; b.textContent = t; setTimeout(() => b.textContent = o, 1100); }
function el(tag, cls, text){ const e = document.createElement(tag); if(cls) e.className = cls; if(text != null) e.textContent = text; return e; }
function esc(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c])); }
