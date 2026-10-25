// Переключатель вариантов значения: клик по свойству-конструкции (например position) → список его
// значений (absolute, fixed…) → выбор подставляет значение в код. Варианты задаются в словаре
// (dict/variants.json, окно «🔀 варианты» в описи) и приходят в /keyword-dict.json как d.variants.
// Надстройка над window.codelabSandbox; после tabs.js. Работает с CodeMirror и обычной textarea.
(function(){
  const sb = window.codelabSandbox;
  const box = document.getElementById('sandbox');
  const edsEl = box && box.querySelector('#sbEds');
  if(!sb || !box || !edsEl){ return; }

  let VARS = {};   // {property(lower): [значение, …]}
  fetch('/keyword-dict.json', { cache: 'no-store' }).then(r => r.json()).then(d => { if(d && d.variants) VARS = d.variants; }).catch(() => {});

  const edFor = id => { for(const ed of edsEl.children){ if(ed.__f && ed.__f.id === id) return ed; } return null; };
  const taOf = ed => ed && ed.querySelector('textarea');

  const st = document.createElement('style');
  st.textContent = `
  .var-pop{position:fixed;z-index:9999;max-width:320px;max-height:60vh;overflow:auto;background:var(--bg2,#150a2b);color:var(--text,#eee);
    border:1px solid var(--border,#3a2f55);border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.5);font-size:12.5px;padding:8px 10px}
  .var-pop h4{margin:0 0 6px;font-size:13px} .var-pop h4 code{color:var(--acc,#52F2C9)}
  .var-pop .v{display:block;width:100%;text-align:left;background:transparent;border:0;color:var(--text,#eee);padding:4px 7px;border-radius:6px;cursor:pointer;font:12px/1.4 monospace}
  .var-pop .v:hover{background:rgba(82,242,201,.14)}
  .var-pop .v.cur{color:var(--acc,#52F2C9)} .var-pop .v.cur::before{content:"● "}
  .var-pop .none{color:var(--muted,#9a93b5);font-style:italic}
  .center.var-on .CodeMirror,.center.var-on .sb-code{cursor:cell}
  `;
  document.head.appendChild(st);
  const center = document.querySelector('.center') || box.parentNode;

  let pop = null;
  const hide = () => { if(pop){ pop.remove(); pop = null; } };
  document.addEventListener('mousedown', e => { if(pop && !pop.contains(e.target)) hide(); });

  // найти на строке свойство с вариантами и границы его значения (после «:»). Возвращает {prop, vStart, vEnd, value} или null.
  function findProp(lineText){
    let m, re = /([A-Za-z_$][\w$-]*)\s*:/g;
    const found = [];
    while((m = re.exec(lineText))){ const p = m[1].toLowerCase(); if(VARS[p] && VARS[p].length){
      const after = m.index + m[0].length;
      let i = after; while(i < lineText.length && lineText[i] === ' ') i++;   // пропустить пробелы после :
      let j = i; while(j < lineText.length && !';}{!'.includes(lineText[j])) j++;   // значение до ; } { ! или конца
      found.push({ prop: p, vStart: i, vEnd: j, value: lineText.slice(i, j).trim() });
    } }
    return found;
  }
  // позиция клика → {line, ch, text} в CM, либо смещение в textarea
  function locAt(ed, ev){
    const ta = taOf(ed), cm = ta && ta.__cm;
    if(cm){ const pos = cm.coordsChar({ left: ev.clientX, top: ev.clientY }, 'window'); return { cm, ta, line: pos.line, ch: pos.ch, text: cm.getLine(pos.line) || '' }; }
    if(ta){ const v = ta.value, c = ta.selectionStart, nl = v.lastIndexOf('\n', c - 1) + 1, end = v.indexOf('\n', c); return { ta, lineStart: nl, ch: c - nl, text: v.slice(nl, end < 0 ? v.length : end) }; }
    return null;
  }
  // заменить значение на строке новым вариантом
  function replaceValue(ed, loc, prop, val){
    const ta = taOf(ed), cm = ta && ta.__cm;
    if(cm){ cm.replaceRange(val, { line: loc.line, ch: prop.vStart }, { line: loc.line, ch: prop.vEnd }); cm.focus(); }
    else if(ta){ const a = loc.lineStart + prop.vStart, b = loc.lineStart + prop.vEnd; ta.value = ta.value.slice(0, a) + val + ta.value.slice(b); ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus(); }
    hide();
  }

  let varOn = false;
  edsEl.addEventListener('click', ev => {
    if(!varOn) return;
    const ed = ev.target.closest && ev.target.closest('.sb-ed'); if(!ed || !ed.__f) return;
    setTimeout(() => {
      const loc = locAt(ed, ev); if(!loc){ hide(); return; }
      const props = findProp(loc.text); if(!props.length){ hide(); return; }
      // ближайшее к курсору свойство
      const p = props.sort((a, b) => Math.abs(a.vStart - loc.ch) - Math.abs(b.vStart - loc.ch))[0];
      const list = VARS[p.prop] || [];
      hide();
      pop = document.createElement('div'); pop.className = 'var-pop';
      pop.innerHTML = '<h4><code>' + p.prop.replace(/[<>&]/g, '') + '</code> — варианты</h4>';
      if(!list.length){ const n = document.createElement('div'); n.className = 'none'; n.textContent = 'нет вариантов'; pop.appendChild(n); }
      list.forEach(v => { const b = document.createElement('button'); b.className = 'v' + (v.toLowerCase() === (p.value || '').toLowerCase() ? ' cur' : ''); b.textContent = v; b.onclick = () => replaceValue(ed, loc, p, v); pop.appendChild(b); });
      document.body.appendChild(pop);
      const x = Math.min(ev.clientX, innerWidth - pop.offsetWidth - 12), y = Math.min(ev.clientY + 14, innerHeight - pop.offsetHeight - 12);
      pop.style.left = Math.max(8, x) + 'px'; pop.style.top = Math.max(8, y) + 'px';
    }, 0);
  }, true);

  // тумблер в панели песочницы
  const bar = box.querySelector('.sb-bar');
  if(bar){
    const lab = document.createElement('label'); lab.className = 'sb-live';
    lab.title = 'клик по свойству (например position) показывает его значения — выбери, чтобы подставить в код';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.id = 'sbVar';
    cb.onchange = () => { varOn = cb.checked; center.classList.toggle('var-on', varOn); if(!varOn) hide(); };
    lab.appendChild(cb); lab.appendChild(document.createTextNode(' 🔀 варианты'));
    const legend = bar.querySelector('#sbLegend'); if(legend) legend.after(lab); else bar.appendChild(lab);
  }
})();
