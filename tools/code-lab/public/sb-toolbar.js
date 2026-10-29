// Панель песочницы одной строкой: главные кнопки одинакового размера, остальное — в меню по смыслу.
// Кнопки надстроек не переписываются, а переносятся в меню вместе с обработчиками; всё незнакомое
// (новые надстройки) само уходит в «⋯ ещё», чтобы строка снова не разрасталась. Подключать ПОСЛЕДНИМ.
(function(){
  const bar = document.querySelector('#sandbox .sb-bar');
  if(!bar || bar.classList.contains('sbt')) return;

  const st = document.createElement('style');
  st.textContent = `
  .sb-bar.sbt{flex-wrap:wrap;gap:6px;overflow:visible;position:relative}
  .sb-bar.sbt>.btn,.sbt-dd>.btn{height:28px;padding:0 10px;font:12.5px/1 system-ui,sans-serif;display:inline-flex;align-items:center;gap:5px;white-space:nowrap;border-radius:7px}
  .sbt-dd{position:relative;display:inline-flex}
  .sbt-pop{position:absolute;top:calc(100% + 5px);left:0;z-index:70;display:none;flex-direction:column;min-width:230px;padding:5px;
    background:var(--bg2,#150a2b);border:1px solid var(--border,#3a2f55);border-radius:10px;box-shadow:0 10px 28px rgba(0,0,0,.5)}
  .sbt-dd.right .sbt-pop{left:auto;right:0}
  .sbt-dd.flip .sbt-pop{left:auto;right:0}
  .sbt-dd.on .sbt-pop{display:flex}
  .sbt-pop>*{display:flex!important;align-items:center;gap:8px;width:100%;box-sizing:border-box;text-align:left;margin:0!important;
    background:none!important;border:0!important;border-radius:6px!important;padding:7px 9px!important;height:auto!important;
    font:12.5px/1.3 system-ui,sans-serif!important;color:var(--text2,#cbc2ea)!important;cursor:pointer;white-space:nowrap}
  .sbt-pop>*:hover{background:var(--s2,#1a1030)!important;color:var(--text,#eee)!important}
  .sbt-pop .sbt-sep{height:1px;padding:0!important;margin:4px 2px!important;background:var(--border,#3a2f55)!important;cursor:default}
  .sbt-pop .sbt-h{font-size:10.5px!important;text-transform:uppercase;letter-spacing:.04em;color:var(--text3,#9c90c4)!important;cursor:default;padding:6px 9px 2px!important}
  .sbt-pop .sbt-h:hover{background:none!important}
  `;
  document.head.appendChild(st);

  const kids = [...bar.children];
  const txt = el => (el.textContent || '').replace(/\s+/g, ' ').trim();
  const take = test => { const i = kids.findIndex(el => !el.__sbt && test(el)); if(i < 0) return null; kids[i].__sbt = true; return kids[i]; };
  const byId = id => take(el => el.id === id || (el.querySelector && el.querySelector('#' + id)));
  const byText = s => take(el => txt(el).toLowerCase().includes(s.toLowerCase()));
  const rename = (el, label) => { if(!el) return el; if(el.tagName === 'BUTTON') el.textContent = label; return el; };

  // на виду — только запуск; остальное — в трёх меню по смыслу
  const run = byId('sbRun');
  const find = rename(byId('sbFindBtn'), 'найти в файле (Ctrl+F)'), ask = rename(byId('sbAskBtn'), 'спросить ИИ про код');
  // файл: «на диск…» помнит файл и сохраняет туда же — второй «на диск» (всегда спрашивает место) лишний
  const add = rename(byId('sbAdd'), '＋ новый файл'), open = rename(byText('открыть…'), 'открыть с диска…'), save = rename(byText('на диск…'), 'сохранить на диск');
  const saveDup = byId('sbSaveDisk'); if(saveDup) saveDup.style.display = 'none';
  const project = rename(byId('sbProject'), 'папка проекта…'), upload = rename(byText('файлы'), 'загрузить файлы…');
  const copyAll = rename(byId('sbCopyAll'), '⧉ скопировать итог (HTML+CSS+JS)'), clear = rename(byText('очистить'), 'очистить всё');
  // вид
  const outline = rename(byId('sbOutlineBtn'), 'структура файла'), preview = byText('превью'), consoleClr = rename(byId('sbClr'), '× очистить консоль');
  const legend = rename(byId('sbLegend'), 'что значат цвета в коде');
  // подсказки — галочки
  const live = byId('sbLive'), explain = byId('sbExplain'), links = byText('связи по клику'), ac = byId('sbAc');
  const spacer = take(el => el.tagName === 'SPAN' && !txt(el));
  const hidden = kids.filter(el => !el.__sbt && (el.tagName === 'INPUT' || getComputedStyle(el).display === 'none'));
  hidden.forEach(el => el.__sbt = true);
  const rest = kids.filter(el => !el.__sbt);   // незнакомое — в «⋯ ещё»

  const sep = () => { const d = document.createElement('div'); d.className = 'sbt-sep'; return d; };
  const head = t => { const d = document.createElement('div'); d.className = 'sbt-h'; d.textContent = t; return d; };
  const dd = (label, items, right) => {
    const list = items.filter(Boolean); if(!list.length) return null;
    const w = document.createElement('div'); w.className = 'sbt-dd' + (right ? ' right' : '');
    const b = document.createElement('button'); b.className = 'btn'; b.textContent = label + ' ▾'; w.appendChild(b);
    const pop = document.createElement('div'); pop.className = 'sbt-pop'; list.forEach(x => pop.appendChild(x)); w.appendChild(pop);
    b.onclick = e => { e.stopPropagation(); const on = !w.classList.contains('on'); document.querySelectorAll('.sbt-dd.on').forEach(x => x.classList.remove('on')); w.classList.toggle('on', on);
      // меню не должно уходить за край экрана: если не влезает вправо — открываем влево
      if(on){ w.classList.remove('flip'); const r = pop.getBoundingClientRect(); if(r.right > innerWidth - 8) w.classList.add('flip'); } };
    // кнопка в меню делает своё и закрывает меню; галочка — оставляет открытым, чтобы переключить несколько
    pop.addEventListener('click', e => { if(e.target.closest('label') || e.target.closest('.sbt-h,.sbt-sep')) return; w.classList.remove('on'); });
    return w;
  };
  document.addEventListener('click', e => { if(!e.target.closest('.sbt-dd')) document.querySelectorAll('.sbt-dd.on').forEach(x => x.classList.remove('on')); });

  const row = [
    run,
    dd('Файл', [add, open, save, sep(), project, upload, sep(), copyAll, clear]),
    dd('Вид', [find, outline, preview, consoleClr, sep(), legend]),
    dd('Подсказки', [head('в коде'), ac, explain && explain.closest('label') || explain, links, sep(), head('превью'), live && live.closest('label') || live, sep(), ask], true),
    rest.length ? dd('⋯ ещё', rest, true) : null
  ].filter(Boolean);
  bar.innerHTML = '';
  row.forEach(el => bar.appendChild(el));
  if(spacer) spacer.remove();
  hidden.forEach(el => bar.appendChild(el));   // скрытые input[type=file] нужны кнопкам «открыть»/«загрузить»
  bar.classList.add('sbt');
})();
