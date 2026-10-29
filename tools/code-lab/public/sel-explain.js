// «что это?»: выделяешь код — рядом кнопка; по ней (или Alt+Q) — схемка: над каждым узнанным куском скобка
// с короткой подписью («внешний отступ», «найти элемент»), ниже — расшифровка. Подписи — из синонимов и словаря,
// у разновидности — путь к смыслу («внешний отступ › margin-trim»). Надстройка песочницы; после sandbox.js.
(function(){
  const box = document.getElementById('sandbox');
  const edsEl = box && box.querySelector('#sbEds');
  if(!edsEl || !window.codelabExplain) return;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const MAX_CHARS = 2000, MAX_LINES = 30;

  const st = document.createElement('style');
  st.textContent = `
  .sx-btn{position:fixed;z-index:9995;background:var(--bg2,#150a2b);color:var(--text,#eee);border:1px solid var(--name,#3dd9ff);border-radius:7px;
    font:12px system-ui,sans-serif;padding:4px 8px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.45)}
  .se{position:fixed;z-index:9996;width:min(760px,94vw);max-height:70vh;display:flex;flex-direction:column;background:var(--bg2,#150a2b);
    border:1px solid var(--border,#3a2f55);border-radius:12px;box-shadow:0 12px 34px rgba(0,0,0,.55);overflow:hidden}
  .se-h{display:flex;align-items:center;gap:8px;padding:7px 10px;border-bottom:1px solid var(--border,#3a2f55);font-size:12.5px;color:var(--text2,#cbc2ea)}
  .se-h b{flex:1}
  .se-h button{background:none;border:0;color:var(--text2,#cbc2ea);font-size:15px;cursor:pointer}
  .se-b{overflow:auto;padding:10px 12px}
  /* подписи не раздвигают код: стоят над ним абсолютно, в два ряда по очереди — соседние не налезают */
  .se-line{font:14px/1.3 ui-monospace,monospace;color:var(--text2,#cbc2ea);white-space:pre;padding-top:40px;margin-bottom:4px;position:relative}
  .se-seg{position:relative;display:inline}
  .se-lbl{position:absolute;left:0;bottom:calc(100% + 8px);font:11px/1.2 system-ui,sans-serif;color:var(--text,#f6f4ff);white-space:nowrap;max-width:260px;overflow:hidden;text-overflow:ellipsis}
  .se-seg.up .se-lbl{bottom:calc(100% + 23px)}
  .se-br{position:absolute;left:0;right:0;bottom:calc(100% + 1px);height:6px;border:1.5px solid var(--name,#3dd9ff);border-bottom:0;border-radius:4px 4px 0 0}
  .se-seg.up .se-br::before{content:'';position:absolute;left:3px;bottom:100%;height:16px;border-left:1px dashed var(--text3,#9c90c4)}
  .se-code{color:var(--text,#f6f4ff)}
  .se-seg.k2 .se-br{border-color:var(--str,#52F2C9)} .se-seg.k3 .se-br{border-color:var(--kw,#b45cff)} .se-seg.k4 .se-br{border-color:var(--fn,#ff2fae)}
  .se-list{margin-top:10px;border-top:1px solid var(--border,#3a2f55);padding-top:8px;display:flex;flex-direction:column;gap:5px}
  .se-it{font-size:12.5px;line-height:1.45;color:var(--text3,#9c90c4)}
  .se-it code{font:12.5px ui-monospace,monospace;color:var(--name,#3dd9ff);margin-right:6px}
  .se-it .p{color:var(--text2,#cbc2ea)}
  .se-none{color:var(--text3,#9c90c4);font-size:12.5px}
  `;
  document.head.appendChild(st);

  let DICT = null;
  const dict = async () => DICT || (DICT = await (window.codelabKwDict ? window.codelabKwDict() : fetch('/keyword-dict.json').then(r => r.json())).catch(() => ({})));
  const activeCM = () => { const ed = [...edsEl.children].find(e => e.__f && e.__f.id === (localStorage.getItem('codelab_sb_active') || '')) || edsEl.firstElementChild; const ta = ed && ed.querySelector('textarea'); return { cm: ta && ta.__cm, ta, lang: (ed && ed.__f && ed.__f.lang) || '' }; };

  // короткая подпись над скобкой: синоним («внешний отступ»), иначе первые слова пояснения
  const shortOf = t => { const s = String(t || '').replace(/^[^—]{1,40}—\s*/, '').replace(/^[^:а-яё]{1,40}:\s+/i, ''); const w = s.split(/\s+/).slice(0, 4).join(' '); return w.length < s.length ? w + '…' : w; };
  function meaning(term, lang, d){
    const syn = d.synonyms || {}; const lt = term.toLowerCase();
    const label = Array.isArray(syn[lt]) && syn[lt][0] ? syn[lt][0] : '';
    // разновидность: margin-trim → смысл предка margin («внешний отступ»)
    let path = '';
    if(!label && lt.includes('-')) for(let p = lt.lastIndexOf('-'); p > 0; p = lt.lastIndexOf('-', p - 1)){ const pre = lt.slice(0, p); if(Array.isArray(syn[pre]) && syn[pre][0]){ path = syn[pre][0] + ' › ' + term; break; } }
    const note = window.codelabExplain(term, lang) || '';
    return { label: label || (path ? path.split(' › ')[0] : '') || shortOf(note), path, note };
  }

  // разбить строку на узнанные куски: конструкции словаря (длинные) и слова
  function segments(line, lang, d){
    const out = []; const re = lang === 'css' || lang === 'html' ? /[#.]?[\w-]+(?:\([^)]*\))?/g : /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g;
    let m; const taken = [];
    // конструкции: пробуем в начале каждого слова, берём, если накрывают 2+ слова
    if(window.codelabExplainAt) for(const w of line.matchAll(/[A-Za-z_$#.@][\w$-]*/g)){
      if(taken.some(([a, b]) => w.index >= a && w.index < b)) continue;
      const hit = window.codelabExplainAt(line, w.index + 1, lang);
      if(hit && hit.term && hit.to - hit.from > w[0].length + 1){ taken.push([hit.from, hit.to]); out.push({ from: hit.from, to: hit.to, text: line.slice(hit.from, hit.to), label: shortOf(hit.text), note: hit.text, path: '' }); }
    }
    while((m = re.exec(line))){
      const from = m.index, to = from + m[0].length; if(taken.some(([a, b]) => from < b && to > a)) continue;
      // внутри строки короткое слово — скорее данные ('on', 'id'), чем термин: не толкуем
      const before = line.slice(0, from); const inStr = ((before.match(/'/g) || []).length % 2) || ((before.match(/"/g) || []).length % 2);
      if(inStr && m[0].length < 4) continue;
      // цепочка obj.method — пробуем целиком, потом последнее звено (document.querySelector → querySelector)
      let term = m[0].replace(/\(.*$/, ''), info = meaning(term, lang, d);
      if(!info.note && !info.path && term.includes('.')){ const last = term.split('.').pop(); const i2 = meaning(last, lang, d); if(i2.note || i2.path) info = i2; }
      if(!info.note && !info.path) continue;
      out.push({ from, to, text: m[0], ...info });
    }
    return out.sort((a, b) => a.from - b.from);
  }

  let btn = null, panel = null;
  const hideBtn = () => { if(btn){ btn.remove(); btn = null; } };
  function showBtn(x, y){
    hideBtn(); btn = document.createElement('button'); btn.className = 'sx-btn'; btn.textContent = 'что это?'; btn.title = 'разобрать выделенный код (Alt+Q)';
    btn.style.left = Math.min(x + 8, innerWidth - 120) + 'px'; btn.style.top = Math.min(y + 6, innerHeight - 40) + 'px';
    btn.onmousedown = e => e.preventDefault(); btn.onclick = open; document.body.appendChild(btn);
  }
  async function open(){
    hideBtn();
    const { cm, ta, lang } = activeCM();
    let text = cm ? cm.getSelection() : (ta ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : '');
    if(!text.trim() && cm){ const c = cm.getCursor(); text = cm.getLine(c.line); }   // без выделения — текущая строка
    text = text.slice(0, MAX_CHARS);
    const d = await dict();
    if(panel) panel.remove();
    panel = document.createElement('div'); panel.className = 'se';
    const lines = text.split('\n').slice(0, MAX_LINES);
    let k = 0; const all = [];
    const body = lines.map(line => {
      const segs = segments(line, lang, d); let pos = 0, h = '';
      for(const s of segs){ if(s.from < pos) continue; h += esc(line.slice(pos, s.from));
        h += '<span class="se-seg k' + (1 + (k % 4)) + (k % 2 ? ' up' : '') + '" title="' + esc(s.note) + '"><span class="se-lbl">' + esc(s.label || '…') + '</span><span class="se-br"></span><span class="se-code">' + esc(s.text) + '</span></span>';
        k++;
        pos = s.to; all.push(s); }
      return '<div class="se-line">' + h + esc(line.slice(pos)) + '</div>';
    }).join('');
    const seen = new Set();
    const list = all.filter(s => { const key = s.text.toLowerCase(); if(seen.has(key)) return false; seen.add(key); return true; })
      .map(s => '<div class="se-it"><code>' + esc(s.text) + '</code>' + (s.path ? '<span class="p">' + esc(s.path) + '</span> — ' : '') + esc(s.note || s.label) + '</div>').join('');
    panel.innerHTML = '<div class="se-h"><b>что здесь</b><span>' + esc(lang.toUpperCase()) + '</span><button title="закрыть (Esc)">×</button></div>'
      + '<div class="se-b">' + (all.length ? body + '<div class="se-list">' + list + '</div>' : '<div class="se-none">в выделенном нет слов из словаря — выдели кусок побольше или добавь пояснения в словарь</div>') + '</div>';
    document.body.appendChild(panel);
    panel.querySelector('.se-h button').onclick = () => { panel.remove(); panel = null; };
    if(window.codelabWindow) window.codelabWindow.make(panel, { handle: panel.querySelector('.se-h'), key: 'codelab_win_se', defaultGeo: { w: 640, h: 380 }, minW: 320, minH: 180 });
  }

  // выделение в CodeMirror → кнопка у конца выделения; снял выделение — кнопка ушла
  let t = null;
  edsEl.addEventListener('mouseup', () => { clearTimeout(t); t = setTimeout(() => {
    const { cm } = activeCM(); if(!cm || !cm.somethingSelected() || !cm.getSelection().trim()){ hideBtn(); return; }
    const c = cm.cursorCoords(cm.getCursor('to'), 'window'); showBtn(c.left, c.bottom);
  }, 120); }, true);
  edsEl.addEventListener('keydown', e => { if(e.altKey && (e.code === 'KeyQ')){ e.preventDefault(); open(); } else if(e.key === 'Escape' && panel){ panel.remove(); panel = null; } else hideBtn(); }, true);
  document.addEventListener('mousedown', e => { if(btn && e.target !== btn) hideBtn(); });
  window.codelabSelExplain = { open };
})();
