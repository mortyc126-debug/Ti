// Клик по слову → где оно задано (определение) и где используется, в т. ч. в других файлах.
// Эвристика по имени (не настоящий анализатор): ищем объявления function/class/const/let/var/def и присваивания,
// остальные вхождения — использования. Надстройка над window.codelabSandbox; после tabs.js (нужен переход по вкладкам).
(function(){
  const sb = window.codelabSandbox;
  const box = document.getElementById('sandbox');
  const edsEl = box && box.querySelector('#sbEds');
  if(!sb || !box || !edsEl){ return; }

  // слова, по которым связи искать бессмысленно
  const STOP = new Set(('if else for while do switch case break continue return function def class const let var new this true false null '
    + 'undefined void typeof instanceof in of import export from default try catch finally throw async await yield static get set '
    + 'and or not is none print range len int str float bool list dict self func fn package public private int string').split(/\s+/));

  const files = () => sb.getFiles();
  const esc = w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function edFor(id){ for(const ed of edsEl.children){ if(ed.__f && ed.__f.id === id) return ed; } return null; }
  function taFor(id){ const ed = edFor(id); return ed ? ed.querySelector('textarea') : null; }
  function cmOf(id){ const ta = taFor(id); return ta && ta.__cm ? ta.__cm : null; }

  // ── стили попапа ──
  const st = document.createElement('style');
  st.textContent = `
  .nav-pop{position:fixed;z-index:9999;max-width:360px;max-height:60vh;overflow:auto;background:var(--bg2,#150a2b);color:var(--text,#eee);
    border:1px solid var(--border,#3a2f55);border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.5);font-size:12.5px;padding:8px 10px}
  .nav-pop h4{margin:0 0 6px;font-size:13px}
  .nav-pop h4 code{color:var(--acc,#52F2C9)}
  .nav-pop .grp{font-size:11px;color:var(--muted,#9a93b5);margin:7px 0 3px;text-transform:uppercase;letter-spacing:.04em}
  .nav-pop .ref{display:block;width:100%;text-align:left;background:transparent;border:0;color:var(--text,#eee);
    padding:3px 5px;border-radius:6px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font:12px/1.4 monospace}
  .nav-pop .ref:hover{background:rgba(82,242,201,.14)}
  .nav-pop .ref .fl{color:var(--muted,#9a93b5)}
  .nav-pop .ref.def .fl{color:#ffb454}
  .nav-pop .none{color:var(--muted,#9a93b5);font-style:italic}
  .center.nav-on .CodeMirror,.center.nav-on .sb-code{cursor:alias}
  `;
  document.head.appendChild(st);
  const center = document.querySelector('.center') || box.parentNode;

  let pop = null;
  function hide(){ if(pop){ pop.remove(); pop = null; } }
  document.addEventListener('mousedown', e => { if(pop && !pop.contains(e.target)) hide(); });

  // объявление WORD на строке?
  function isDef(line, W){
    const re = [
      '\\b(?:function|def|func|fn|sub)\\s+' + W + '\\b',
      '\\bclass\\s+' + W + '\\b',
      '\\b(?:const|let|var)\\s+' + W + '\\b',
      '\\b' + W + '\\s*[:=]\\s*(?:function\\b|async\\b|\\(|\\[|\\{)',   // W = функция/стрелка/объект/массив
      '\\b' + W + '\\s*\\([^)]*\\)\\s*\\{',                              // W(...) {  — метод/функция
      '\\b' + W + '\\s*=(?!=)'                                           // W = … (присваивание)
    ];
    return re.some(p => new RegExp(p).test(line));
  }

  // собрать определения и использования слова по всем файлам
  function analyze(word){
    const W = esc(word), occ = new RegExp('(?<![\\w$])' + W + '(?![\\w$])', 'g');
    const defs = [], uses = [];
    files().forEach(f => {
      const lines = String(f.code || '').split('\n'); let base = 0;
      lines.forEach((ln, i) => {
        occ.lastIndex = 0; let m;
        const def = isDef(ln, W);
        while((m = occ.exec(ln))){
          const rec = { id: f.id, name: f.name || '', line: i + 1, off: base + m.index, len: word.length, text: ln.trim().slice(0, 80) };
          (def ? defs : uses).push(rec);
          if(def) break;   // строку-объявление считаем один раз как определение
        }
        base += ln.length + 1;
      });
    });
    return { defs, uses };
  }

  function jump(rec){
    if(window.codelabTabs && window.codelabTabs.setActive) window.codelabTabs.setActive(rec.id, false);
    const ta = taFor(rec.id), cm = ta && ta.__cm;
    if(cm){ const from = cm.posFromIndex(rec.off), to = cm.posFromIndex(rec.off + rec.len); cm.setSelection(from, to); cm.scrollIntoView({ from, to }, 60); cm.focus(); }
    else if(ta){ ta.focus(); try { ta.setSelectionRange(rec.off, rec.off + rec.len); } catch(_){} }
  }

  function refBtn(rec, isDef){
    const b = document.createElement('button'); b.className = 'ref' + (isDef ? ' def' : '');
    const fl = document.createElement('span'); fl.className = 'fl'; fl.textContent = rec.name + ':' + rec.line + '  ';
    b.appendChild(fl); b.appendChild(document.createTextNode(rec.text || ''));
    b.onclick = () => { jump(rec); };
    return b;
  }

  function showRefs(word, ev){
    const { defs, uses } = analyze(word);
    hide();
    pop = document.createElement('div'); pop.className = 'nav-pop';
    const h = document.createElement('h4'); h.innerHTML = '<code></code> — связи'; h.querySelector('code').textContent = word; pop.appendChild(h);

    const g1 = document.createElement('div'); g1.className = 'grp'; g1.textContent = 'Определение' + (defs.length > 1 ? ' (' + defs.length + ')' : ''); pop.appendChild(g1);
    if(defs.length) defs.slice(0, 20).forEach(d => pop.appendChild(refBtn(d, true)));
    else { const n = document.createElement('div'); n.className = 'none'; n.textContent = 'не нашлось явного объявления'; pop.appendChild(n); }

    const g2 = document.createElement('div'); g2.className = 'grp'; g2.textContent = 'Использования (' + uses.length + ')'; pop.appendChild(g2);
    if(uses.length) uses.slice(0, 40).forEach(u => pop.appendChild(refBtn(u, false)));
    else { const n = document.createElement('div'); n.className = 'none'; n.textContent = 'нет других вхождений'; pop.appendChild(n); }
    if(uses.length > 40){ const m = document.createElement('div'); m.className = 'none'; m.textContent = '…и ещё ' + (uses.length - 40); pop.appendChild(m); }

    document.body.appendChild(pop);
    const x = Math.min(ev.clientX, innerWidth - pop.offsetWidth - 12), y = Math.min(ev.clientY + 14, innerHeight - pop.offsetHeight - 12);
    pop.style.left = Math.max(8, x) + 'px'; pop.style.top = Math.max(8, y) + 'px';
  }

  // слово под кликом (CodeMirror или обычная textarea)
  function wordAt(ed, ev){
    const ta = ed.querySelector('textarea'), cm = ta && ta.__cm;
    if(cm){
      const pos = cm.coordsChar({ left: ev.clientX, top: ev.clientY }, 'window');
      const r = cm.findWordAt(pos); const w = cm.getRange(r.anchor, r.head);
      return (w || '').trim();
    }
    if(ta){
      // клик уже поставил каретку — читаем слово вокруг неё
      const v = ta.value, c = ta.selectionStart; let a = c, b = c;
      while(a > 0 && /[\w$]/.test(v[a - 1])) a--; while(b < v.length && /[\w$]/.test(v[b])) b++;
      return v.slice(a, b);
    }
    return '';
  }

  let navOn = false;
  edsEl.addEventListener('click', ev => {
    if(!navOn) return;
    const ed = ev.target.closest && ev.target.closest('.sb-ed'); if(!ed || !ed.__f) return;
    // textarea ставит каретку — дождёмся её, потом читаем слово
    setTimeout(() => {
      const w = wordAt(ed, ev);
      if(!w || !/^[A-Za-z_$][\w$]*$/.test(w) || STOP.has(w.toLowerCase()) || w.length < 2){ hide(); return; }
      showRefs(w, ev);
    }, 0);
  }, true);

  // переключатель в панели песочницы (рядом с «пояснения по клику»)
  const bar = box.querySelector('.sb-bar');
  const lab = document.createElement('label'); lab.className = 'sb-live';
  lab.title = 'клик по имени показывает, где оно задано и где используется (в т. ч. в других файлах)';
  const cb = document.createElement('input'); cb.type = 'checkbox'; cb.id = 'sbNav';
  cb.onchange = () => { navOn = cb.checked; center.classList.toggle('nav-on', navOn); if(!navOn) hide(); };
  lab.appendChild(cb); lab.appendChild(document.createTextNode(' 🔗 связи по клику'));
  const explain = bar && bar.querySelector('#sbExplain'); const explainLab = explain && explain.closest('label');
  if(explainLab){ explainLab.after(lab); } else if(bar){ bar.appendChild(lab); }

  window.codelabNav = { analyze, jump };   // пригодится панели связей
})();
