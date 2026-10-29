// «Спросить ИИ»: выдели кусок кода (или весь файл) и спроси — объяснить, найти баги, улучшить, тесты,
// или свой вопрос. Ходит на /api/ai-ask через подключённого провайдера (ключ из Настроек). Ответ — текстом.
// Окно плавающее: перетаскивается за шапку, тянется за угол, разворачивается на весь экран; позиция и
// размер запоминаются (localStorage). Код берётся из редактора — в поле вопроса его вставлять НЕ надо.
(function(){
  const sb = window.codelabSandbox;
  const box = document.getElementById('sandbox');
  const edsEl = box && box.querySelector('#sbEds');
  const bar = box && box.querySelector('.sb-bar');
  if(!sb || !box || !edsEl || !bar){ return; }

  const activeId = () => { try { return localStorage.getItem('codelab_sb_active'); } catch(_){ return null; } };
  const activeFile = () => { const fs = sb.getFiles(); return fs.find(f => f.id === activeId()) || fs[0] || null; };
  const edFor = id => { for(const ed of edsEl.children){ if(ed.__f && ed.__f.id === id) return ed; } return null; };
  const apiKey = () => { try { return (localStorage.getItem('codeLab.mistralApiKey') || '').trim(); } catch(_){ return ''; } };

  // текущее выделение в активном редакторе, иначе весь код файла
  function grab(){
    const f = activeFile(); if(!f) return { code: '', lang: '', whole: false, name: '' };
    const ed = edFor(f.id), ta = ed && ed.querySelector('textarea'), cm = ta && ta.__cm;
    let sel = '';
    if(cm){ try { sel = cm.getSelection() || ''; } catch(_){} }
    else if(ta){ try { sel = ta.value.slice(ta.selectionStart, ta.selectionEnd) || ''; } catch(_){} }
    if(sel.trim()) return { code: sel, lang: f.lang, whole: false, name: f.name || '' };
    return { code: f.code || '', lang: f.lang, whole: true, name: f.name || '' };
  }

  // ── стили ──
  const st = document.createElement('style');
  st.textContent = `
  .ai-ask{position:fixed;z-index:9998;display:none;flex-direction:column;min-width:320px;min-height:240px;
    background:var(--bg2,#150a2b);border:1px solid var(--border,#3a2f55);border-radius:14px;box-shadow:0 14px 48px rgba(0,0,0,.55);overflow:hidden;font-size:13px}
  .ai-ask.on{display:flex}
  .ai-ask.max{left:12px!important;top:60px!important;width:auto!important;height:auto!important;right:12px!important;bottom:12px!important}
  .ai-ask .aa-h{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--border,#3a2f55);background:var(--s2,#241038);cursor:move;user-select:none;flex:none}
  .ai-ask .aa-h b{flex:1;font-size:13px}
  .ai-ask .aa-h button{background:none;border:0;color:var(--text2,#cbc2ea);cursor:pointer;font-size:15px;padding:2px 7px;border-radius:6px;line-height:1}
  .ai-ask .aa-h button:hover{background:rgba(255,255,255,.08);color:var(--text,#eee)}
  .ai-ask .aa-body{padding:10px 12px;overflow:auto;display:flex;flex-direction:column;gap:9px;min-height:0;flex:1}
  .ai-ask .aa-src{font-size:11.5px;color:var(--muted,#9a93b5)}
  .ai-ask .aa-acts{display:flex;flex-wrap:wrap;gap:6px}
  .ai-ask .aa-act{background:var(--s2,#241038);border:1px solid var(--border,#3a2f55);color:var(--text,#eee);border-radius:14px;padding:5px 12px;cursor:pointer;font-size:12.5px}
  .ai-ask .aa-act:hover{border-color:var(--acc,#52F2C9);color:var(--acc,#52F2C9)}
  .ai-ask .aa-q{width:100%;box-sizing:border-box;min-height:56px;resize:vertical;background:var(--bg,#0e0720);color:var(--text,#eee);border:1px solid var(--border,#3a2f55);border-radius:9px;padding:8px 10px;font:13px/1.45 system-ui,sans-serif}
  .ai-ask .aa-row{display:flex;gap:8px;align-items:center}
  .ai-ask .aa-send{background:var(--acc,#52F2C9);color:#06231c;border:0;border-radius:9px;padding:7px 16px;cursor:pointer;font-weight:600;font-size:13px}
  .ai-ask .aa-send:disabled{opacity:.6;cursor:default}
  .ai-ask .aa-ans{white-space:pre-wrap;word-break:break-word;line-height:1.55;font-size:13px;background:var(--bg,#0e0720);border:1px solid var(--border,#3a2f55);border-radius:9px;padding:10px 12px;flex:1;min-height:60px;overflow:auto}
  .ai-ask .aa-ans:empty{display:none}
  .ai-ask .aa-note{font-size:11.5px;color:var(--muted,#9a93b5)}
  .ai-ask .aa-note.err{color:#ff8a8a}
  .ai-ask .aa-copy{align-self:flex-start;background:var(--s2,#241038);border:1px solid var(--border,#3a2f55);color:var(--text,#eee);border-radius:7px;padding:4px 10px;cursor:pointer;font-size:12px}
  .ai-ask .aa-grip{position:absolute;right:2px;bottom:2px;width:16px;height:16px;cursor:nwse-resize;opacity:.6}
  .ai-ask .aa-grip:before{content:'';position:absolute;right:3px;bottom:3px;width:8px;height:8px;border-right:2px solid var(--text3,#6b6090);border-bottom:2px solid var(--text3,#6b6090)}
  `;
  document.head.appendChild(st);

  const panel = document.createElement('div'); panel.className = 'ai-ask';
  panel.innerHTML = '<div class="aa-h" id="aa-head"><b>Спросить</b><button id="aa-max" title="на весь экран">⤢</button><button id="aa-min" title="закрыть">×</button></div>'
    + '<div class="aa-body">'
    + '<div class="aa-src" id="aa-src"></div>'
    + '<div class="aa-acts">'
    + '<button class="aa-act" data-a="explain">объяснить</button>'
    + '<button class="aa-act" data-a="bugs">найти баги</button>'
    + '<button class="aa-act" data-a="improve">улучшить</button>'
    + '<button class="aa-act" data-a="tests">что проверить</button>'
    + '</div>'
    + '<textarea class="aa-q" id="aa-q" placeholder="свой вопрос про выделенный код… (код из редактора добавится сам — сюда его вставлять не нужно). Ctrl+Enter — спросить"></textarea>'
    + '<div class="aa-row"><button class="aa-send" id="aa-send">спросить</button><span class="aa-note" id="aa-note"></span></div>'
    + '<div class="aa-ans" id="aa-ans"></div>'
    + '<button class="aa-copy" id="aa-copy" style="display:none">⧉ копировать ответ</button>'
    + '</div><div class="aa-grip" id="aa-grip" title="потяни — изменить размер"></div>';
  document.body.appendChild(panel);
  if(window.codelabWindow && window.codelabWindow.track) window.codelabWindow.track(panel);   // клик — поверх других окон
  const q = s => panel.querySelector(s);

  // ── геометрия: позиция и размер запоминаются ──
  const GEO = 'codelab_aiask_geo';
  function applyGeo(){
    let g = null; try { g = JSON.parse(localStorage.getItem(GEO) || 'null'); } catch(_){}
    if(g && g.w){ panel.style.left = g.x + 'px'; panel.style.top = g.y + 'px'; panel.style.right = 'auto'; panel.style.bottom = 'auto'; panel.style.width = g.w + 'px'; panel.style.height = g.h + 'px'; }
    else { panel.style.right = '16px'; panel.style.top = '64px'; panel.style.width = '560px'; panel.style.height = '560px'; }
  }
  function saveGeo(){
    if(panel.classList.contains('max')) return;
    const r = panel.getBoundingClientRect();
    try { localStorage.setItem(GEO, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) })); } catch(_){}
  }
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // перетаскивание за шапку
  (function(){
    const head = q('#aa-head'); let on = false, sx, sy, ox, oy;
    head.addEventListener('pointerdown', e => {
      if(e.target.closest('button') || panel.classList.contains('max')) return;
      on = true; head.setPointerCapture(e.pointerId);
      const r = panel.getBoundingClientRect(); sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      panel.style.right = 'auto'; panel.style.bottom = 'auto'; panel.style.left = ox + 'px'; panel.style.top = oy + 'px';
    });
    head.addEventListener('pointermove', e => { if(!on) return;
      const w = panel.offsetWidth, h = panel.offsetHeight;
      panel.style.left = clamp(ox + (e.clientX - sx), 0, innerWidth - 60) + 'px';
      panel.style.top = clamp(oy + (e.clientY - sy), 0, innerHeight - 40) + 'px';
    });
    head.addEventListener('pointerup', e => { if(on){ on = false; try { head.releasePointerCapture(e.pointerId); } catch(_){} saveGeo(); } });
  })();

  // ресайз за угол
  (function(){
    const grip = q('#aa-grip'); let on = false, sx, sy, rw, rh;
    grip.addEventListener('pointerdown', e => { e.preventDefault(); if(panel.classList.contains('max')) return;
      on = true; grip.setPointerCapture(e.pointerId); const r = panel.getBoundingClientRect(); sx = e.clientX; sy = e.clientY; rw = r.width; rh = r.height;
      panel.style.right = 'auto'; panel.style.bottom = 'auto'; });
    grip.addEventListener('pointermove', e => { if(!on) return;
      panel.style.width = clamp(rw + (e.clientX - sx), 320, innerWidth - 24) + 'px';
      panel.style.height = clamp(rh + (e.clientY - sy), 240, innerHeight - 24) + 'px'; });
    grip.addEventListener('pointerup', e => { if(on){ on = false; try { grip.releasePointerCapture(e.pointerId); } catch(_){} saveGeo(); } });
  })();

  q('#aa-max').onclick = () => { panel.classList.toggle('max'); if(!panel.classList.contains('max')) applyGeo(); };

  function refreshSrc(){
    const g = grab(); const n = (g.code || '').length;
    q('#aa-src').textContent = n ? ((g.whole ? ('весь файл «' + (g.name || '?') + '»') : 'выделенный фрагмент') + ' · ' + n + ' симв.' + (g.lang ? ' · ' + g.lang : '') + (g.whole && n > 12000 ? ' (отправлю первые ~12000 — лучше выдели нужное)' : '')) : 'нет кода — открой файл или выдели фрагмент';
  }
  function note(t, err){ const n = q('#aa-note'); n.textContent = t || ''; n.className = 'aa-note' + (err ? ' err' : ''); }

  let busy = false;
  async function ask(action){
    if(busy) return;
    const g = grab(); const key = apiKey(); const question = q('#aa-q').value.trim();
    if(!key){ note('Нет ключа ИИ. Открой «Настройки» и сохрани API-ключ.', true); return; }
    if(!g.code.trim() && !question){ note('Выдели код в редакторе или впиши вопрос.', true); return; }
    busy = true; q('#aa-send').disabled = true; note('думаю…'); q('#aa-ans').textContent = ''; q('#aa-copy').style.display = 'none';
    try {
      const r = await fetch('/api/ai-ask', { method: 'POST', headers: { 'x-mistral-api-key': key },
        body: JSON.stringify({ code: g.code, lang: g.lang, action: action || undefined, question: action ? '' : question }) }).then(x => x.json());
      if(r && r.answer){ q('#aa-ans').textContent = r.answer; q('#aa-copy').style.display = ''; note(''); }
      else note(r && r.error ? r.error : 'не получилось', true);
    } catch(e){ note('ошибка сети: ' + String(e && e.message || e), true); }
    busy = false; q('#aa-send').disabled = false;
  }

  panel.querySelectorAll('.aa-act').forEach(b => b.onclick = () => { refreshSrc(); ask(b.dataset.a); });
  q('#aa-send').onclick = () => { refreshSrc(); ask(null); };
  q('#aa-q').addEventListener('keydown', e => { if(e.key === 'Enter' && (e.ctrlKey || e.metaKey)){ e.preventDefault(); refreshSrc(); ask(null); } });
  q('#aa-min').onclick = () => panel.classList.remove('on');
  q('#aa-copy').onclick = () => { try { navigator.clipboard.writeText(q('#aa-ans').textContent); } catch(_){} q('#aa-copy').textContent = '✓ скопировано'; setTimeout(() => q('#aa-copy').textContent = '⧉ копировать ответ', 1200); };

  // кнопка в панели песочницы
  const b = document.createElement('button'); b.className = 'btn'; b.id = 'sbAskBtn'; b.textContent = 'спросить';
  b.title = 'выдели код и спроси ИИ: объяснить, найти баги, улучшить';
  b.onclick = () => { const on = !panel.classList.contains('on'); panel.classList.toggle('on', on); if(on){ applyGeo(); refreshSrc(); } };
  const legend = bar.querySelector('#sbLegend'); if(legend) legend.after(b); else bar.appendChild(b);
})();
