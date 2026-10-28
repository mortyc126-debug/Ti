// Вставки для «связи слов словаря с кусками» (по якорям, повторный запуск безопасен, CRLF сохраняется).
//   node tools/apply-dict-usage-patch.mjs            — применить
//   node tools/apply-dict-usage-patch.mjs --check    — только показать, что будет сделано
// Меняет: tools/code-lab-server.mjs, tools/code-lab/public/inventory.js, tools/code-lab/public/component.js
// Требует: tools/code-lab/lib/dict-usage.mjs (лежит рядом в комплекте).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));      // .../tools
const CHECK = process.argv.includes('--check');
const MARK = 'dict-usage';                                       // метка в комментариях вставок — по ней видно, что патч уже применён

async function patch(file, steps) {
  const abs = path.join(HERE, file);
  let txt; try { txt = await fs.readFile(abs, 'utf8'); } catch (_) { console.log('✗ нет файла', file); process.exitCode = 1; return; }
  const crlf = txt.includes('\r\n');
  let src = txt.replace(/\r\n/g, '\n');
  let done = 0;
  for (const st of steps) {
    if (src.includes(st.done)) { console.log('· уже есть:', file, '—', st.name); continue; }
    const i = src.indexOf(st.anchor);
    if (i < 0) { console.log('✗ якорь не найден:', file, '—', st.name); process.exitCode = 1; continue; }
    if (src.indexOf(st.anchor, i + 1) >= 0) { console.log('✗ якорь не уникален:', file, '—', st.name); process.exitCode = 1; continue; }
    src = st.where === 'after' ? src.replace(st.anchor, st.anchor + st.add) : src.replace(st.anchor, st.add + st.anchor);
    console.log('✓', file, '—', st.name); done++;
  }
  if (done && !CHECK) {
    await fs.copyFile(abs, abs + '.bak-dict-usage').catch(() => {});
    await fs.writeFile(abs, crlf ? src.replace(/\n/g, '\r\n') : src, 'utf8');
  }
}

// ───────────────────────── сервер ─────────────────────────
const SERVER_IMPORT = `
import { buildUsage, libraryFingerprint } from './code-lab/lib/dict-usage.mjs';   // ${MARK}: связь «слово словаря ↔ куски»`;

const SERVER_HELPER = `// ── ${MARK}: индекс «слово/конструкция словаря ↔ куски». Не хранится: считается из кода и словаря, кэш сбрасывается сам ──
let _usage = null, _usageKey = '';
async function getUsage(){
  const dict = await kwDict();
  const entries = await store.entries();
  const key = libraryFingerprint(entries);
  if(_usage && _usage.__dict === dict && _usageKey === key) return _usage;
  const u = buildUsage(dict, entries.map(e => ({ id: e.id, lang: String(e.lang || (e.meta && e.meta.lang) || 'txt').toLowerCase(), title: e.title, group: e.group, code: String(e.code || '') })));
  u.__dict = dict; _usage = u; _usageKey = key;
  return u;
}
`;

const SERVER_ROUTES = `    // ── ${MARK}: связь «слово словаря ↔ куски» (только чтение; всё вычисляется из кода и словаря) ──
    // GET /api/dict/usage[?section=lang:js]  → разделы с покрытием и по каждому термину { n, ids[≤8], kind }
    if(u.pathname === '/api/dict/usage' && req.method === 'GET'){
      const us = await getUsage(); const only = u.searchParams.get('section') || '';
      const terms = {};
      for(const [sid, m] of Object.entries(us.terms)){ if(only && sid !== only) continue; const o = {}; for(const [k, r] of Object.entries(m)) o[k] = [r.n, r.kind, ...r.ids.slice(0, 3)]; terms[sid] = o; }
      return json(res, 200, { ok: true, pieces: us.pieceCount, ms: us.ms, sections: us.sections, terms });
    }
    // GET /api/dict/pieces?section=&term=  → все куски, где встречается термин
    if(u.pathname === '/api/dict/pieces' && req.method === 'GET'){
      const us = await getUsage(); const sid = u.searchParams.get('section') || '', term = u.searchParams.get('term') || '';
      const list = us.piecesOf(sid, term).map(id => us.pieceInfo(id)).filter(Boolean);
      return json(res, 200, { ok: true, section: sid, term, count: list.length, pieces: list });
    }
    // GET /api/dict/gaps?section=lang:js[&format=text]  → термины без единого куска («чего не хватает»)
    if(u.pathname === '/api/dict/gaps' && req.method === 'GET'){
      const us = await getUsage(); const sid = u.searchParams.get('section') || '';
      const secs = sid ? [sid] : us.sections.map(s => s.id);
      const items = []; for(const s of secs) for(const g of us.gaps(s)) items.push({ section: s, term: g.term, note: g.note, kind: g.kind });
      const lang = sid.startsWith('lang:') ? sid.slice(5) : (sid === 'html' || sid === 'css' ? sid : '');
      const text = items.map(g => g.term + ': ' + g.note).join('\\n');
      const prompt = 'Язык: ' + (lang || 'разные') + '.\\nНиже — слова и конструкции из моего словаря, для которых в библиотеке ещё нет ни одного куска кода (формат «термин: пояснение»).\\n'
        + 'Для КАЖДОЙ напиши короткий рабочий кусок (3–10 строк), в котором эта конструкция используется. Выдай строго пачкой в таком формате, без лишнего текста:\\n'
        + '=== Название | ' + (lang || 'язык') + ' | Раздел / Подраздел\\nкод\\n\\nИмена переменных в коде выбирай обычные (не «element», «value» и т. п. из пояснений).\\n\\n' + items.slice(0, 80).map(g => g.term + ': ' + g.note).join('\\n');
      return json(res, 200, { ok: true, section: sid, count: items.length, items: items.slice(0, 3000), text, prompt });
    }
    // GET /api/piece/terms?id=  → слова/конструкции словаря в этом куске и где ещё они встречаются
    if(u.pathname === '/api/piece/terms' && req.method === 'GET'){
      const us = await getUsage(); const id = u.searchParams.get('id') || '';
      const rows = us.termsOfPiece(id).map(r => ({ ...r, others: r.others.map(x => us.pieceInfo(x)).filter(Boolean) }));
      return json(res, 200, { ok: true, id, count: rows.length, terms: rows });
    }

`;

await patch('code-lab-server.mjs', [
  { name: 'импорт', done: "from './code-lab/lib/dict-usage.mjs'", anchor: "import { tokenize } from './code-lab/lib/tokenizer.mjs';", where: 'after', add: SERVER_IMPORT },
  { name: 'getUsage()', done: 'async function getUsage()', anchor: '// записать словарь языка в свой файл dict/langs/<lang>.json', where: 'before', add: SERVER_HELPER },
  { name: 'маршруты /api/dict/usage|pieces|gaps, /api/piece/terms', done: "'/api/dict/usage'", anchor: '    // сборщик «непонятных слов»', where: 'before', add: SERVER_ROUTES },
]);

// ───────────────────────── «📚 весь словарь» (Опись) ─────────────────────────
const INV_STATE = `  // ${MARK}: счётчики «в скольких кусках встречается» и фильтр «без кусков»
  let usage = null, useFilter = 'all';   // all | none | some
  const secId = title => title === 'html' ? 'html' : title === 'css' ? 'css' : title === 'Общее / код' ? 'common' : 'lang:' + title.replace('Язык: ', '');
  const loadUsage = () => fetch('/api/dict/usage', { cache: 'no-store' }).then(x => x.json()).then(r => { usage = r && r.ok ? r : null; render(); }).catch(() => {});
  async function showPieces(rowEl, sid, term){
    const nx = rowEl.nextSibling; if(nx && nx.__pieces){ nx.remove(); return; }
    const r = await fetch('/api/dict/pieces?section=' + encodeURIComponent(sid) + '&term=' + encodeURIComponent(term)).then(x => x.json()).catch(() => null);
    const box = document.createElement('div'); box.__pieces = true; box.style.cssText = 'margin:2px 0 6px 14px;font-size:12px;display:flex;flex-wrap:wrap;gap:4px 10px';
    if(!r || !r.ok || !r.pieces.length) box.textContent = 'кусков нет';
    else r.pieces.forEach(p => { const a = document.createElement('a'); a.href = '/component.html?id=' + encodeURIComponent(p.id); a.textContent = p.title || p.id; a.title = p.group || ''; a.target = '_blank'; box.appendChild(a); });
    rowEl.after(box);
  }
  async function copyGaps(sid, btn){
    const r = await fetch('/api/dict/gaps?section=' + encodeURIComponent(sid)).then(x => x.json()).catch(() => null);
    if(!r || !r.ok) { alert('не удалось получить список'); return; }
    if(!r.count) { btn.textContent = 'пробелов нет ✓'; return; }
    copy(r.prompt); btn.textContent = '✓ запрос для ИИ скопирован (' + Math.min(r.count, 80) + ' из ' + r.count + ')'; setTimeout(() => btn.textContent = '🕳 пробелы → запрос для ИИ', 2500);
  }
`;

const INV_UI = `    // ${MARK}: фильтр по наличию кусков
    { const bar = el2('div', ''); bar.style.cssText = 'display:flex;gap:5px;flex-wrap:wrap;align-items:center;margin-bottom:6px;font-size:11.5px';
      bar.appendChild(document.createTextNode('куски: '));
      [['all', 'все'], ['none', '🕳 без кусков'], ['some', 'с кусками']].forEach(([v, t]) => bar.appendChild(chip(t, useFilter === v, () => { useFilter = v; render(); })));
      const note = el2('span', 'muted'); note.textContent = usage ? ' связь считается из кода при каждом открытии (' + usage.pieces + ' кусков, ' + usage.ms + ' мс)' : ' считаю связи…'; bar.appendChild(note);
      chips.after(bar); const old = body.parentNode.querySelector('.dv-usebar'); if(old) old.remove(); bar.className = 'dv-usebar'; }
`;

await patch('code-lab/public/inventory.js', [
  { name: 'состояние и помощники', done: 'let usage = null, useFilter', anchor: "  let activeGroup = null;   // null = показывать все разделы", where: 'before', add: INV_STATE },
  { name: 'панель фильтра', done: 'dv-usebar', anchor: "    let total = 0, shown = 0;\n    groups.forEach(([title, obj]) => {", where: 'before', add: INV_UI },
  { name: 'фильтр строк', done: "useFilter !== 'all'", anchor: "      const rows = Object.entries(obj).filter(([w, t]) => !flt || w.toLowerCase().includes(flt) || String(t).toLowerCase().includes(flt));",
    where: 'after', add: `\n      const ut = usage && usage.terms[secId(title)];   // ${MARK}\n      if(ut && useFilter !== 'all'){ const keep = rows.filter(([w]) => { const u = ut[w]; const n = u ? u[0] : 0; return useFilter === 'none' ? (n === 0 && u && u[1] !== 'prose' && u[1] !== 'weak') : n > 0; }); rows.length = 0; keep.forEach(r => rows.push(r)); }` },
  { name: 'кнопка «пробелы → ИИ» в шапке раздела', done: 'copyGaps(secId(title), gb)', anchor: "      head.appendChild(cp); body.appendChild(head);",
    where: 'before', add: `      { const us = usage && usage.sections.find(s => s.id === secId(title));   // ${MARK}\n        if(us){ const cv = document.createElement('span'); cv.className = 'muted'; cv.style.cssText = 'font-size:11px;font-weight:400'; cv.textContent = 'покрыто ' + us.covered + ' из ' + us.checkable + (us.prose ? ' · не код: ' + us.prose : ''); head.appendChild(cv);\n          const gb = el2('button', 'btn'); gb.textContent = '🕳 пробелы → запрос для ИИ'; gb.title = 'скопировать запрос: «напиши куски для этих конструкций» — ответ вставь в пакетную загрузку'; gb.style.padding = '1px 8px'; gb.onclick = () => copyGaps(secId(title), gb); head.appendChild(gb); } }\n` },
  { name: 'счётчик у строки', done: 'showPieces(d, secId', anchor: "        d.appendChild(ctl); body.appendChild(d);",
    where: 'before', add: `        { const u = usage && usage.terms[secId(title)] && usage.terms[secId(title)][w];   // ${MARK}\n          if(u && u[1] !== 'prose' && u[1] !== 'weak'){ const cnt = el2('button', 'btn'); cnt.style.cssText = 'padding:0 6px;margin-right:4px' + (u[0] ? '' : ';color:#ff9aa8'); cnt.textContent = u[0] ? ('в ' + u[0] + ' ' + (u[0] % 10 === 1 && u[0] % 100 !== 11 ? 'куске' : 'кусках')) : '🕳 нет кусков'; cnt.title = u[0] ? 'показать, где ещё используется' : 'ни один кусок библиотеки этого не использует'; if(u[0]) cnt.onclick = () => showPieces(d, secId(title), w); ctl.prepend(cnt); } }\n` },
  { name: 'загрузка связей', done: 'loadUsage();', anchor: "  q('#dv-q').addEventListener('input', render);\n  render();", where: 'after', add: `\n  loadUsage();   // ${MARK}` },
  { name: 'пересчёт после правок словаря', done: 'reloadDict = () => { dict = null; loadUsage();', anchor: "const reloadDict = () => { dict = null;", where: 'after', add: ' loadUsage();' },
]);

// ───────────────────────── страница куска ─────────────────────────
const COMP_PANEL = `  // ⑥ ${MARK}: какие слова/конструкции словаря есть в этом куске и где ещё они встречаются
  { const s6 = document.createElement('div'); s6.appendChild(el('div', 'muted', 'считаю…'));
    root.appendChild(panel('⑥ Где ещё используется', s6));
    fetch('/api/piece/terms?id=' + encodeURIComponent(t.id)).then(r => r.json()).then(r => {
      s6.innerHTML = '';
      const rows = (r && r.ok ? r.terms : []).filter(x => x.kind !== 'generic');
      if(!rows.length){ s6.appendChild(el('div', 'muted', 'в этом куске не найдено конструкций из словаря')); return; }
      rows.sort((a, b) => (b.kind === 'construct') - (a.kind === 'construct') || a.n - b.n || a.term.localeCompare(b.term));
      s6.appendChild(el('div', 'note-hint', 'Конструкции и слова из словаря, которые есть в этом коде. Справа — другие куски, где они тоже встречаются (редкие — сверху).'));
      rows.slice(0, 60).forEach(x => {
        const row = el('div', 'frag'); row.style.cssText = 'display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;padding:3px 0';
        const nm = el('span', 'fn', x.term); nm.title = x.note || ''; nm.style.flex = 'none'; row.appendChild(nm);
        const rest = el('span', 'ro'); rest.style.cssText = 'flex:1;min-width:140px';
        if(!x.others.length) rest.textContent = 'только здесь';
        else { rest.appendChild(document.createTextNode(x.n - 1 + ': ')); x.others.slice(0, 5).forEach((p, i) => { if(i) rest.appendChild(document.createTextNode(', ')); const a = document.createElement('a'); a.href = '/component.html?id=' + encodeURIComponent(p.id); a.textContent = p.title || p.id; rest.appendChild(a); }); if(x.n - 1 > 5) rest.appendChild(document.createTextNode(' …')); }
        row.appendChild(rest); s6.appendChild(row);
      });
      if(rows.length > 60) s6.appendChild(el('div', 'muted', '…и ещё ' + (rows.length - 60)));
    }).catch(() => { s6.innerHTML = ''; s6.appendChild(el('div', 'muted', 'не удалось посчитать')); }); }

`;
await patch('code-lab/public/component.js', [
  { name: 'панель ⑥', done: "panel('⑥ Где ещё используется'", anchor: "  // проверка результата (если описана)\n", where: 'before', add: COMP_PANEL },
]);

console.log(CHECK ? '\n(проверка: файлы не менялись)' : '\nГотово. Копии до правок: *.bak-dict-usage. Перезапусти сервер: node tools/code-lab-server.mjs');
