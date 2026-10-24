// Редактор CodeMirror в песочнице Конструктора («как в среде разработки»).
//
//   node apply-ide-patch.mjs --check    проверить, что вставки возможны (ничего не меняет)
//   node apply-ide-patch.mjs            применить (копия: sandbox.js.bak-<время>)
//
// Правится только code-lab/public/sandbox.js (constructor.html не трогаем). Вставки идут по якорям,
// повторный запуск безопасен; если хоть один якорь не найден, не меняется ничего.
// Нужно, чтобы рабочая папка (apply-workspace-patch) и CodeMirror (apply-cm5-patch) уже были применены.
//
// Что получается:
//  - если CodeMirror установлен и включён (vendor.html): номера строк, подсветка по языку файла, автозакрытие
//    скобок и тегов, Ctrl+/ (комментарий), Ctrl+Space (подсказка слов), подсветка текущей строки, Tab/Shift+Tab;
//  - если нет: всё работает как раньше (прежний редактор), ничего не ломается;
//  - редакторы больше не пересоздаются при сохранении и при открытии нового файла: курсор, прокрутка
//    и история отмены (Ctrl+Z) сохраняются;
//  - «🔍 пояснения по клику» продолжают работать.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGET = path.join(HERE, 'code-lab/public/sandbox.js');
const check = process.argv.includes('--check');

const HELPERS = String.raw`  // ── редактор CodeMirror поверх прежнего поля (если CodeMirror установлен; иначе всё как раньше) ──
  const CM_ADDONS = ['fold/xml-fold', 'edit/closetag', 'edit/closebrackets', 'comment/comment', 'selection/active-line', 'hint/show-hint', 'hint/anyword-hint'];
  let cmReady = null;
  function loadCM(){
    if(cmReady) return cmReady;
    const bridge = window.CMBridge ? Promise.resolve() : new Promise(res => { const s = document.createElement('script'); s.src = '/cm-bridge.js'; s.onload = s.onerror = () => res(); document.head.appendChild(s); });
    cmReady = bridge.then(() => window.CMBridge ? window.CMBridge.ready() : false).then(ok => {
      if(!ok || !window.CodeMirror) return false;
      const base = '/vendor/cm/' + window.CMBridge.version() + '/addon/';
      const lk = document.createElement('link'); lk.rel = 'stylesheet'; lk.href = base + 'hint/show-hint.css'; document.head.appendChild(lk);
      const one = p => new Promise(res => { const s = document.createElement('script'); s.src = base + p + '.js'; s.async = false; s.onload = () => res(); s.onerror = () => res(); document.head.appendChild(s); });
      return CM_ADDONS.reduce((chain, a) => chain.then(() => one(a)), Promise.resolve()).then(() => true);
    }).catch(() => false);
    return cmReady;
  }
  function cmOptions(){
    const any = window.CodeMirror && window.CodeMirror.hint && window.CodeMirror.hint.anyword;
    return {
      autoCloseBrackets: true, autoCloseTags: true, styleActiveLine: true,
      hintOptions: { hint: any, completeSingle: false },
      extraKeys: {
        Tab: c => { if(c.somethingSelected()) c.execCommand('indentMore'); else c.execCommand('insertSoftTab'); },
        'Shift-Tab': c => c.execCommand('indentLess'),
        'Ctrl-/': 'toggleComment', 'Cmd-/': 'toggleComment', 'Ctrl-Space': 'autocomplete'
      }
    };
  }
  if(!document.getElementById('sb-cm-css')){
    const st = document.createElement('style'); st.id = 'sb-cm-css';
    st.textContent = [
      '.sb-ed.cm-on .sb-hl{display:none}',
      '.sb-ed.cm-on .sb-ed-wrap{background:var(--code-bg,#0E0720)}',
      '.sb-ed.cm-on .CodeMirror{position:absolute;top:0;right:0;bottom:0;left:0;height:auto;border:0;border-radius:0;background:var(--code-bg,#0E0720);font-size:12.5px}',
      '.sb-ed.cm-on .CodeMirror-scroll{min-height:0;max-height:none}',
      '.sb-ed.cm-on .CodeMirror-activeline-background{background:rgba(255,255,255,.04)}',
      '.CodeMirror-hints{z-index:2147483002}'
    ].join('\n');
    document.head.appendChild(st);
  }
  const rafOnce = fn => { let q = 0; return () => { if(q) return; q = requestAnimationFrame(() => { q = 0; fn(); }); }; };
  // раскрашенная строка прежней подсветки → span на позиции (нужно для «пояснений по клику» поверх CodeMirror)
  function spanAt(pre, line, ch){
    const ld = pre.children[line]; if(!ld) return null;
    let n = 0;
    for(const s of ld.children){ const len = s.textContent.length; if(ch >= n && ch < n + len) return s; n += len; }
    return null;
  }
  function upgradeEditor(ed, ta, pre, wrap, f, paint){
    let wantFocus = false;
    const nativeFocus = HTMLElement.prototype.focus;
    ta.focus = () => { wantFocus = true; nativeFocus.call(ta); };   // фокус, запрошенный до готовности редактора (workspace.js), не теряется
    loadCM().then(ok => ok ? window.CMBridge.enhance(ta, f.lang, cmOptions()) : null).then(cm => {
      if(!cm) return;
      ed.classList.add('cm-on');
      ta.oninput = () => { f.code = ta.value; save(); schedulePreview(); };   // CodeMirror сам сообщает об изменениях событием input
      const refresh = rafOnce(() => { if(wrap.clientHeight) cm.refresh(); });
      const watchCm = () => { const ro = new ResizeObserver(refresh); ro.observe(wrap); ros.push(ro); };
      const prev = ed.__watch; ed.__watch = () => { if(prev) prev(); watchCm(); };
      watchCm();
      cm.getWrapperElement().addEventListener('click', ev => {
        if(!center.classList.contains('explain-on')) return;
        paint();
        const pos = cm.coordsChar({ left: ev.clientX, top: ev.clientY }, 'window');
        const sp = [pos.ch, pos.ch - 1].map(c => c >= 0 ? spanAt(pre, pos.line, c) : null).find(s => s && s.textContent.trim());
        if(sp) explainToken(sp, ev); else hidePop();
      });
      if(wantFocus) cm.focus();
    });
  }
  // имя и язык в заголовках без перерисовки редакторов (после сохранения и переименования)
  function syncHeads(){
    const eds = edsEl.querySelectorAll('.sb-ed');
    if(eds.length !== files.length){ renderEds(); return; }
    files.forEach((f, i) => {
      const nm = eds[i].querySelector('.sb-name'), sl = eds[i].querySelector('.sb-lang');
      if(nm && nm !== document.activeElement && nm.value !== f.name) nm.value = f.name;
      if(sl && sl.value !== f.lang) sl.value = f.lang;
    });
  }

`;

const EDITS = [
  { name: 'вспомогательные функции редактора',
    anchor: '  // ── рендер панелей-редакторов ──\n  function renderEds(){',
    to: HELPERS + '  // ── рендер панелей-редакторов ──\n  function renderEds(){',
    done: t => t.includes('function upgradeEditor(') },
  { name: 'renderEds: готовые редакторы переиспользуются',
    anchor: "    ros.forEach(r => r.disconnect()); ros = [];\n    edsEl.innerHTML = '';\n    files.forEach(f => {\n      const ed = document.createElement('div'); ed.className = 'sb-ed';",
    to: "    ros.forEach(r => r.disconnect()); ros = [];\n" +
        "    const keepScroll = edsEl.scrollTop;\n" +
        "    const keep = new Map(); [...edsEl.children].forEach(e => { if(e.__f) keep.set(e.__f, e); });\n" +
        "    edsEl.textContent = '';\n" +
        "    files.forEach(f => {\n" +
        "      const old = keep.get(f), oldTa = old && old.querySelector('textarea');\n" +
        "      if(old && old.__lang === f.lang && oldTa && oldTa.value === f.code){ edsEl.appendChild(old); if(old.__watch) old.__watch(); return; }   // редактор уже построен: курсор, прокрутка и история правок остаются\n" +
        "      const ed = document.createElement('div'); ed.className = 'sb-ed';",
    done: t => t.includes('const keepScroll = edsEl.scrollTop;') },
  { name: 'renderEds: подключение CodeMirror к каждой панели',
    anchor: "      const ro = new ResizeObserver(() => { const h = wrap.clientHeight; if(h) ta.style.height = h + 'px'; });\n      ro.observe(wrap); ros.push(ro);\n      ed.appendChild(head); ed.appendChild(wrap); edsEl.appendChild(ed);\n    });\n  }",
    to: "      const watch = () => { const ro = new ResizeObserver(() => { const h = wrap.clientHeight; if(h) ta.style.height = h + 'px'; }); ro.observe(wrap); ros.push(ro); };\n" +
        "      watch(); ed.__watch = watch; ed.__f = f; ed.__lang = f.lang;\n" +
        "      ed.appendChild(head); ed.appendChild(wrap); edsEl.appendChild(ed);\n" +
        "      upgradeEditor(ed, ta, pre, wrap, f, paint);\n" +
        "    });\n" +
        "    edsEl.scrollTop = keepScroll;\n" +
        "  }",
    done: t => t.includes('ed.__watch = watch;') },
  { name: 'codelabSandbox.refresh без перерисовки редакторов',
    anchor: '    refresh: () => { save(); renderEds(); schedulePreview(); }',
    to: '    refresh: () => { save(); syncHeads(); schedulePreview(); }',
    done: t => t.includes('refresh: () => { save(); syncHeads(); schedulePreview(); }') },
];

const raw = await fs.readFile(TARGET, 'utf8').catch(() => { console.error('Нет файла code-lab/public/sandbox.js рядом с патчером.'); process.exit(1); });
const crlf = raw.includes('\r\n');
let text = raw.replace(/\r\n/g, '\n');
const failed = []; let changed = 0;
for (const e of EDITS) {
  if (e.done(text)) { console.log('  уже есть  — ' + e.name); continue; }
  const i = text.indexOf(e.anchor);
  if (i < 0) { failed.push(e.name); console.log('  НЕ НАЙДЕН — ' + e.name); continue; }
  if (text.indexOf(e.anchor, i + 1) >= 0) { failed.push(e.name + ' (якорь дважды)'); console.log('  ДВА МЕСТА — ' + e.name); continue; }
  text = text.slice(0, i) + e.to + text.slice(i + e.anchor.length);
  changed++; console.log('  → ' + e.name);
}
if (!/window\.codelabSandbox\s*=/.test(text)) failed.push('window.codelabSandbox (сначала примените apply-workspace-patch.mjs)');
if (failed.length) { console.error('\nПатч не применён, ничего не изменено. Проблемы: ' + failed.join('; ')); process.exit(1); }
if (check) { console.log('\nПроверка пройдена.' + (changed ? '' : ' Всё уже применено.')); process.exit(0); }
if (!changed) { console.log('\nНичего менять не нужно.'); process.exit(0); }
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
await fs.writeFile(TARGET + '.bak-' + stamp, raw);
await fs.writeFile(TARGET, crlf ? text.replace(/\n/g, '\r\n') : text);
console.log(`\nГотово. Копия: sandbox.js.bak-${stamp}. Обновите страницу (Ctrl+F5); перезапуск сервера не нужен.`);
