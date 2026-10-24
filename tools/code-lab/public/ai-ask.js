// «🤖 Спросить ИИ»: выдели кусок кода (или весь файл) и спроси — объяснить, найти баги, улучшить, тесты,
// или свой вопрос. Ходит на /api/ai-ask через подключённого провайдера (ключ из Настроек). Ответ — текстом.
// Надстройка над window.codelabSandbox; ключ ИИ берётся из localStorage['codeLab.mistralApiKey'].
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
  .ai-ask{position:fixed;right:16px;bottom:16px;width:380px;max-width:92vw;max-height:76vh;z-index:9998;display:none;flex-direction:column;
    background:var(--bg2,#150a2b);border:1px solid var(--border,#3a2f55);border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.5);overflow:hidden;font-size:13px}
  .ai-ask.on{display:flex}
  .ai-ask .aa-h{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--border,#3a2f55);background:var(--s2,#241038)}
  .ai-ask .aa-h b{flex:1;font-size:13px}
  .ai-ask .aa-h button{background:none;border:0;color:var(--text2,#cbc2ea);cursor:pointer;font-size:15px;padding:2px 6px;border-radius:6px}
  .ai-ask .aa-h button:hover{background:rgba(255,255,255,.08);color:var(--text,#eee)}
  .ai-ask .aa-body{padding:10px 12px;overflow:auto;display:flex;flex-direction:column;gap:8px;min-height:0}
  .ai-ask .aa-src{font-size:11.5px;color:var(--muted,#9a93b5)}
  .ai-ask .aa-acts{display:flex;flex-wrap:wrap;gap:6px}
  .ai-ask .aa-act{background:var(--s2,#241038);border:1px solid var(--border,#3a2f55);color:var(--text,#eee);border-radius:14px;padding:4px 11px;cursor:pointer;font-size:12px}
  .ai-ask .aa-act:hover{border-color:var(--acc,#52F2C9);color:var(--acc,#52F2C9)}
  .ai-ask .aa-row{display:flex;gap:6px}
  .ai-ask .aa-q{flex:1;background:var(--bg,#0e0720);color:var(--text,#eee);border:1px solid var(--border,#3a2f55);border-radius:8px;padding:6px 9px;font:12.5px system-ui,sans-serif}
  .ai-ask .aa-send{background:var(--acc,#52F2C9);color:#06231c;border:0;border-radius:8px;padding:0 12px;cursor:pointer;font-weight:600;font-size:12.5px}
  .ai-ask .aa-send:disabled{opacity:.6;cursor:default}
  .ai-ask .aa-ans{white-space:pre-wrap;word-break:break-word;line-height:1.5;font-size:12.5px;background:var(--bg,#0e0720);border:1px solid var(--border,#3a2f55);border-radius:8px;padding:9px 11px;min-height:40px}
  .ai-ask .aa-ans:empty{display:none}
  .ai-ask .aa-note{font-size:11.5px;color:var(--muted,#9a93b5)}
  .ai-ask .aa-note.err{color:#ff8a8a}
  .ai-ask .aa-copy{align-self:flex-start;background:var(--s2,#241038);border:1px solid var(--border,#3a2f55);color:var(--text,#eee);border-radius:7px;padding:3px 9px;cursor:pointer;font-size:12px}
  `;
  document.head.appendChild(st);

  const panel = document.createElement('div'); panel.className = 'ai-ask';
  panel.innerHTML = '<div class="aa-h"><b>🤖 Спросить ИИ</b><button id="aa-min" title="свернуть">×</button></div>'
    + '<div class="aa-body">'
    + '<div class="aa-src" id="aa-src"></div>'
    + '<div class="aa-acts">'
    + '<button class="aa-act" data-a="explain">объяснить</button>'
    + '<button class="aa-act" data-a="bugs">найти баги</button>'
    + '<button class="aa-act" data-a="improve">улучшить</button>'
    + '<button class="aa-act" data-a="tests">что проверить</button>'
    + '</div>'
    + '<div class="aa-row"><input class="aa-q" id="aa-q" placeholder="свой вопрос про выделенное…"><button class="aa-send" id="aa-send">спросить</button></div>'
    + '<div class="aa-note" id="aa-note"></div>'
    + '<div class="aa-ans" id="aa-ans"></div>'
    + '<button class="aa-copy" id="aa-copy" style="display:none">⧉ копировать ответ</button>'
    + '</div>';
  document.body.appendChild(panel);
  const q = s => panel.querySelector(s);

  function refreshSrc(){
    const g = grab();
    const n = (g.code || '').length;
    q('#aa-src').textContent = n ? (g.whole ? ('весь файл «' + (g.name || '?') + '» · ' + n + ' симв.') : ('выделение · ' + n + ' симв.')) + (g.lang ? ' · ' + g.lang : '') : 'нет кода — открой файл или выдели фрагмент';
  }

  let busy = false;
  async function ask(action){
    if(busy) return;
    const g = grab(); const key = apiKey();
    const question = q('#aa-q').value.trim();
    if(!key){ note('Нет ключа ИИ. Открой «⚙ Настройки» (внизу) и сохрани API-ключ.', true); return; }
    if(!g.code.trim() && !question){ note('Выдели код или впиши вопрос.', true); return; }
    busy = true; q('#aa-send').disabled = true; note('думаю…'); q('#aa-ans').textContent = ''; q('#aa-copy').style.display = 'none';
    try {
      const r = await fetch('/api/ai-ask', { method: 'POST', headers: { 'x-mistral-api-key': key },
        body: JSON.stringify({ code: g.code, lang: g.lang, action: action || undefined, question: action ? '' : question }) }).then(x => x.json());
      if(r && r.answer){ q('#aa-ans').textContent = r.answer; q('#aa-copy').style.display = ''; note(''); }
      else note(r && r.error ? r.error : 'не получилось', true);
    } catch(e){ note('ошибка сети: ' + String(e && e.message || e), true); }
    busy = false; q('#aa-send').disabled = false;
  }
  function note(t, err){ const n = q('#aa-note'); n.textContent = t || ''; n.className = 'aa-note' + (err ? ' err' : ''); }

  panel.querySelectorAll('.aa-act').forEach(b => b.onclick = () => { refreshSrc(); ask(b.dataset.a); });
  q('#aa-send').onclick = () => { refreshSrc(); ask(null); };
  q('#aa-q').addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); refreshSrc(); ask(null); } });
  q('#aa-min').onclick = () => panel.classList.remove('on');
  q('#aa-copy').onclick = () => { const t = q('#aa-ans').textContent; try { navigator.clipboard.writeText(t); } catch(_){} q('#aa-copy').textContent = '✓ скопировано'; setTimeout(() => q('#aa-copy').textContent = '⧉ копировать ответ', 1200); };

  // кнопка в панели песочницы
  const b = document.createElement('button'); b.className = 'btn'; b.id = 'sbAskBtn'; b.textContent = '🤖 спросить ИИ';
  b.title = 'выдели код и спроси ИИ: объяснить, найти баги, улучшить';
  b.onclick = () => { const on = !panel.classList.contains('on'); panel.classList.toggle('on', on); if(on) refreshSrc(); };
  const legend = bar.querySelector('#sbLegend'); if(legend) legend.after(b); else bar.appendChild(b);
})();
