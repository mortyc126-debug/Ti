// «🩺 решить»: вводишь краткое описание проблемы → пути решения. Простое (синтаксис, мелочи) — списком из
// словаря/синонимов и готовых кусков; сложное — диагноз от ИИ (вероятные причины + что делать) по коду файла.
// Надстройка песочницы; после tabs.js. ИИ — через /api/ai-ask (ключ из Настроек), как «🤖 спросить ИИ».
(function(){
  const sb = window.codelabSandbox;
  const box = document.getElementById('sandbox');
  const edsEl = box && box.querySelector('#sbEds');
  const bar = box && box.querySelector('.sb-bar');
  if(!sb || !box || !edsEl || !bar){ return; }

  const activeId = () => { try { return localStorage.getItem('codelab_sb_active'); } catch(_){ return null; } };
  const edFor = id => { for(const ed of edsEl.children){ if(ed.__f && ed.__f.id === id) return ed; } return null; };
  const activeFile = () => { const fs = sb.getFiles(); return fs.find(f => f.id === activeId()) || fs[0] || null; };
  const apiKey = () => { try { return (localStorage.getItem('codeLab.mistralApiKey') || '').trim(); } catch(_){ return ''; } };
  let DICT = null, PIECES = null;
  const loadDict = () => DICT ? Promise.resolve(DICT) : fetch('/keyword-dict.json', { cache: 'no-store' }).then(r => r.json()).then(d => (DICT = d || {})).catch(() => (DICT = {}));
  const loadPieces = () => PIECES ? Promise.resolve(PIECES) : fetch('/api/list').then(r => r.json()).then(l => (PIECES = l || [])).catch(() => (PIECES = []));

  const st = document.createElement('style');
  st.textContent = `
  .dg{position:fixed;z-index:9998;right:16px;bottom:16px;width:360px;height:min(74vh,580px);display:none;flex-direction:column;
    background:var(--bg2,#150a2b);border:1px solid var(--border,#3a2f55);border-radius:12px;box-shadow:0 10px 32px rgba(0,0,0,.5);overflow:hidden}
  .dg.on{display:flex}
  .dg .dh{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid var(--border,#3a2f55);font-size:12.5px}
  .dg .dh b{flex:1}
  .dg .dh button{background:none;border:0;color:var(--text2,#cbc2ea);cursor:pointer;font-size:14px;padding:2px 5px;border-radius:5px}
  .dg .db{padding:9px 10px;overflow:auto;flex:1;min-height:0}
  .dg textarea{width:100%;box-sizing:border-box;background:var(--bg,#0e0720);color:var(--text,#eee);border:1px solid var(--border,#3a2f55);border-radius:8px;padding:7px 9px;font:13px system-ui,sans-serif;min-height:48px;resize:vertical}
  .dg .row{display:flex;gap:6px;margin:7px 0}
  .dg .grp{font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted,#9a93b5);margin:9px 0 3px}
  .dg .it{padding:5px 7px;border-radius:7px;cursor:pointer}
  .dg .it:hover{background:rgba(82,242,201,.12)}
  .dg .it .t{font-size:12.5px}
  .dg .it .d{font-size:11px;color:var(--muted,#9a93b5);line-height:1.4}
  .dg .none{color:var(--muted,#9a93b5);font-size:12px;font-style:italic;padding:4px 2px}
  .dg .ans{white-space:pre-wrap;font-size:12.5px;line-height:1.55;color:var(--text,#eee);background:var(--bg,#0e0720);border:1px solid var(--border,#3a2f55);border-radius:8px;padding:9px 10px;margin-top:4px}
  .dg .note{font-size:11px;color:var(--muted,#9a93b5);margin-top:4px}
  .dg .note.err{color:#ff6b6b}
  `;
  document.head.appendChild(st);

  const panel = document.createElement('div'); panel.className = 'dg';
  panel.innerHTML = '<div class="dh"><b>🩺 Решить проблему</b><button id="dgX" title="закрыть">×</button></div>'
    + '<div class="db">'
    + '<textarea id="dgQ" placeholder="опиши проблему: что не так, что ожидала, текст ошибки…"></textarea>'
    + '<div class="row"><button class="btn ok" id="dgAi" style="flex:1">✨ диагноз (ИИ)</button></div>'
    + '<div class="note" id="dgNote"></div>'
    + '<div id="dgOut"></div></div>';
  document.body.appendChild(panel);
  const q = s => panel.querySelector(s);
  q('#dgX').onclick = () => panel.classList.remove('on');

  // вставить код в активный редактор (на место курсора)
  function insertCode(code){
    const ed = edFor(activeId()) || edsEl.firstElementChild; const ta = ed && ed.querySelector('textarea'); const cm = ta && ta.__cm;
    if(cm){ cm.replaceRange('\n' + code + '\n', cm.getCursor()); cm.focus(); }
    else if(ta){ const p = ta.selectionStart; ta.value = ta.value.slice(0, p) + '\n' + code + '\n' + ta.value.slice(p); ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus(); }
  }

  // простое: словарь/синонимы + готовые куски
  let timer = null, seq = 0;
  async function quick(){
    const query = q('#dgQ').value.toLowerCase().trim(); const out = q('#dgOut');
    // не трогаем блок ответа ИИ, если он есть; обновляем только списки
    let lists = out.querySelector('#dgLists'); if(!lists){ lists = document.createElement('div'); lists.id = 'dgLists'; out.appendChild(lists); }
    if(query.length < 2){ lists.innerHTML = ''; return; }
    const my = ++seq; const d = await loadDict(); if(my !== seq) return;
    lists.innerHTML = '';
    // словарь: термины и синонимы по смыслу
    const terms = []; const seen = new Set();
    const addT = (term, text) => { const k = term.toLowerCase(); if(seen.has(k)) return; seen.add(k); terms.push({ term, text: text || '' }); };
    const scan = o => { if(o) for(const [k, v] of Object.entries(o)){ if(typeof v === 'string' && (k.toLowerCase().includes(query) || v.toLowerCase().includes(query))) addT(k, v); } };
    scan(d.words); ['cssProps','cssVals','htmlTags','htmlAttrs'].forEach(s => scan(d[s]));
    if(d.langs) for(const l of Object.keys(d.langs)) scan(d.langs[l]);
    if(d.synonyms){ const explOf = t => { const lt = t.toLowerCase(); if(d.words && d.words[lt]) return d.words[lt]; if(d.langs) for(const l of Object.keys(d.langs)) if(d.langs[l][lt]) return d.langs[l][lt]; return ''; };
      for(const [term, syns] of Object.entries(d.synonyms)){ if(Array.isArray(syns) && syns.some(x => String(x).toLowerCase().includes(query))) addT(term, explOf(term)); } }
    if(terms.length){ lists.appendChild(grp('В словаре — что это')); terms.slice(0, 6).forEach(t => lists.appendChild(item(t.term, t.text, null))); }
    // куски-решения
    try { const r = await fetch('/api/search?q=' + encodeURIComponent(q('#dgQ').value) + '&limit=6').then(x => x.json()); if(my !== seq) return;
      const list = await loadPieces(); const byId = {}; list.forEach(p => byId[p.id] = p);
      const hits = ((r && r.hits) || []).slice(0, 5).map(h => byId[h.id]).filter(Boolean);
      if(hits.length){ lists.appendChild(grp('Готовые куски — вставить')); hits.forEach(p => lists.appendChild(item(p.title, (p.lang || '').toUpperCase() + (p.desc ? ' · ' + p.desc : ''), () => openPieceInsert(p.id)))); }
    } catch(_){}
    if(!lists.children.length) lists.appendChild(el('div', 'none', 'в словаре и кусках ничего похожего — нажми «диагноз (ИИ)»'));
  }
  async function openPieceInsert(id){ try { const t = await fetch('/api/template?id=' + encodeURIComponent(id)).then(r => r.json()); const code = t.code != null ? t.code : (Array.isArray(t.lines) ? t.lines.map(l => (l || []).map(k => k.v != null ? k.v : '').join('')).join('\n') : ''); insertCode(code); } catch(_){} }

  function el(tag, cls, txt){ const e = document.createElement(tag); if(cls) e.className = cls; if(txt != null) e.textContent = txt; return e; }
  function grp(t){ return el('div', 'grp', t); }
  function item(title, desc, onClick){ const d = el('div', 'it'); d.appendChild(el('div', 't', title)); if(desc){ const x = el('div', 'd', desc); d.appendChild(x); } if(onClick) d.onclick = onClick; else d.style.cursor = 'default'; return d; }

  // сложное: диагноз от ИИ по описанию + коду файла
  let busy = false;
  async function diagnose(){
    if(busy) return; const problem = q('#dgQ').value.trim(); const key = apiKey();
    if(!problem){ note('Опиши проблему.', true); return; }
    if(!key){ note('Нет ключа ИИ. Открой «⚙ Настройки» и сохрани API-ключ.', true); return; }
    const f = activeFile();
    busy = true; q('#dgAi').disabled = true; note('думаю…');
    let ansBox = q('#dgAns'); if(!ansBox){ ansBox = el('div', 'ans'); ansBox.id = 'dgAns'; q('#dgOut').insertBefore(ansBox, q('#dgOut').firstChild); }
    ansBox.textContent = '';
    const question = 'Проблема/симптом: ' + problem + '\nНазови вероятные ПРИЧИНЫ (по коду, если он приложен) и дай КОНКРЕТНЫЕ шаги — что делать, по пунктам. Если уместно, покажи исправленный фрагмент. Коротко и по делу, по-русски.';
    try {
      const r = await fetch('/api/ai-ask', { method: 'POST', headers: { 'x-mistral-api-key': key }, body: JSON.stringify({ code: f ? f.code : '', lang: f ? f.lang : '', question }) }).then(x => x.json());
      if(r && r.answer){ ansBox.textContent = r.answer; note(''); }
      else { note(r && r.error ? r.error : 'не получилось', true); }
    } catch(e){ note('ошибка сети: ' + String(e && e.message || e), true); }
    busy = false; q('#dgAi').disabled = false;
  }
  function note(t, err){ const n = q('#dgNote'); n.textContent = t || ''; n.className = 'note' + (err ? ' err' : ''); }

  let qt = null;
  q('#dgQ').addEventListener('input', () => { clearTimeout(qt); qt = setTimeout(quick, 250); });
  q('#dgAi').onclick = diagnose;

  const b = document.createElement('button'); b.className = 'btn'; b.id = 'sbDgBtn'; b.textContent = '🩺 решить';
  b.title = 'опиши проблему — подскажу пути решения: словарь, готовые куски и диагноз от ИИ';
  b.onclick = () => { const on = !panel.classList.contains('on'); panel.classList.toggle('on', on); if(on){ const sel = (function(){ const ed = edFor(activeId()); const ta = ed && ed.querySelector('textarea'); const cm = ta && ta.__cm; try { return cm ? cm.getSelection() : (ta ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : ''); } catch(_){ return ''; } })(); if(sel && !q('#dgQ').value) q('#dgQ').value = sel; q('#dgQ').focus(); quick(); } };
  const legend = bar.querySelector('#sbLegend'); if(legend) legend.after(b); else bar.appendChild(b);
})();
