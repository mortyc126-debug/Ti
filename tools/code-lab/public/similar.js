// «На что похоже / сходные фрагменты»: сравнивает открытый файл с кусками библиотеки (сервер, /api/similar)
// и показывает похожие — чтобы увидеть, на что похоже то, что у тебя есть, и открыть образец.
// Надстройка над window.codelabSandbox; после tabs.js. Открытие куска — через window.codelabOpenInEditor.
(function(){
  const sb = window.codelabSandbox;
  const box = document.getElementById('sandbox');
  const bar = box && box.querySelector('.sb-bar');
  if(!sb || !box || !bar){ return; }

  const activeId = () => { try { return localStorage.getItem('codelab_sb_active'); } catch(_){ return null; } };
  const activeFile = () => { const fs = sb.getFiles(); return fs.find(f => f.id === activeId()) || fs[0] || null; };

  const st = document.createElement('style');
  st.textContent = `
  .sim-panel{position:fixed;z-index:9998;right:16px;bottom:16px;width:300px;max-height:56vh;display:none;flex-direction:column;
    background:var(--bg2,#150a2b);border:1px solid var(--border,#3a2f55);border-radius:12px;box-shadow:0 10px 32px rgba(0,0,0,.5);overflow:hidden}
  .sim-panel.on{display:flex}
  .sim-h{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid var(--border,#3a2f55);font-size:12.5px}
  .sim-h b{flex:1}
  .sim-h button{background:none;border:0;color:var(--text2,#cbc2ea);cursor:pointer;font-size:14px;padding:2px 5px;border-radius:5px}
  .sim-h button:hover{background:rgba(255,255,255,.08)}
  .sim-list{overflow:auto;padding:6px}
  .sim-it{display:block;width:100%;text-align:left;background:transparent;border:0;color:var(--text,#eee);padding:6px 8px;border-radius:8px;cursor:pointer}
  .sim-it:hover{background:rgba(82,242,201,.12)}
  .sim-it .t{font-size:12.5px;display:flex;align-items:baseline;gap:6px}
  .sim-it .pct{margin-left:auto;font-family:ui-monospace,monospace;color:var(--acc,#52F2C9);font-size:11px}
  .sim-it .sh{font-size:10.5px;color:var(--muted,#9a93b5);font-family:ui-monospace,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px}
  .sim-none{color:var(--muted,#9a93b5);font-size:12px;padding:10px;font-style:italic}
  `;
  document.head.appendChild(st);

  const panel = document.createElement('div'); panel.className = 'sim-panel';
  panel.innerHTML = '<div class="sim-h"><b>🫧 На что похоже</b><button id="simRef" title="обновить">⟳</button><button id="simX" title="закрыть">×</button></div><div class="sim-list" id="simList"></div>';
  document.body.appendChild(panel);
  const listEl = panel.querySelector('#simList'), nameEl = panel.querySelector('b');

  let open = false, busy = false;
  async function refresh(){
    const f = activeFile();
    nameEl.textContent = '🫧 Похоже на: ' + (f ? (f.name || 'файл') : '—');
    if(!f || !(f.code || '').trim()){ listEl.innerHTML = '<div class="sim-none">нет кода в активном файле</div>'; return; }
    if(busy) return; busy = true;
    listEl.innerHTML = '<div class="sim-none">ищу похожее…</div>';
    try {
      const r = await fetch('/api/similar', { method: 'POST', body: JSON.stringify({ code: f.code, lang: f.lang || '', exclude: f.srcId || '' }) }).then(x => x.json());
      listEl.innerHTML = '';
      const hits = (r && r.hits) || [];
      if(!hits.length){ listEl.innerHTML = '<div class="sim-none">похожих кусков не нашлось</div>'; busy = false; return; }
      hits.forEach(h => {
        const it = document.createElement('button'); it.className = 'sim-it';
        const t = document.createElement('div'); t.className = 't';
        const nm = document.createElement('span'); nm.textContent = h.title; nm.style.overflow = 'hidden'; nm.style.textOverflow = 'ellipsis'; nm.style.whiteSpace = 'nowrap';
        const pct = document.createElement('span'); pct.className = 'pct'; pct.textContent = h.score + '%';
        t.append(nm, pct); it.appendChild(t);
        if(h.lang){ const lg = document.createElement('span'); lg.style.cssText = 'font-size:9px;color:var(--muted,#9a93b5)'; lg.textContent = String(h.lang).toUpperCase(); t.insertBefore(lg, pct); }
        if(h.shared && h.shared.length){ const sh = document.createElement('div'); sh.className = 'sh'; sh.textContent = 'общее: ' + h.shared.join(', '); it.appendChild(sh); }
        it.onclick = () => openPiece(h);
        listEl.appendChild(it);
      });
    } catch(_){ listEl.innerHTML = '<div class="sim-none">сервер недоступен</div>'; }
    busy = false;
  }
  async function openPiece(h){
    try { const t = await fetch('/api/template?id=' + encodeURIComponent(h.id)).then(r => r.json());
      const code = t.code != null ? t.code : (Array.isArray(t.lines) ? t.lines.map(l => (l || []).map(k => k.v != null ? k.v : '').join('')).join('\n') : '');
      if(window.codelabOpenInEditor) window.codelabOpenInEditor(t.title || h.title || 'кусок', t.lang || 'txt', code);
    } catch(_){}
  }
  panel.querySelector('#simRef').onclick = refresh;
  panel.querySelector('#simX').onclick = () => { open = false; panel.classList.remove('on'); };

  const b = document.createElement('button'); b.className = 'btn'; b.id = 'sbSimBtn'; b.textContent = '🫧 на что похоже';
  b.title = 'сравнить открытый файл с кусками библиотеки — на что он похож, какие есть образцы';
  b.onclick = () => { open = !open; panel.classList.toggle('on', open); if(open) refresh(); };
  const legend = bar.querySelector('#sbLegend'); if(legend) legend.after(b); else bar.appendChild(b);
})();
