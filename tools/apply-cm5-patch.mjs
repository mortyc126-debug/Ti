// Точечная правка существующих файлов под управляемые обновления CodeMirror 5 (в стиле apply-workspace-patch.mjs).
// Ищет места по коротким якорям, а не по номерам строк; повторный запуск ничего не дублирует; перед записью делает
// копию <файл>.bak-cm5; переводы строк сохраняются построчно (CRLF остаётся CRLF, LF остаётся LF, смесь не портится).
//
//   node tools/apply-cm5-patch.mjs                 # применить
//   node tools/apply-cm5-patch.mjs --check         # только показать, что будет сделано
//   node tools/apply-cm5-patch.mjs --no-guard      # не добавлять общую защиту от чужих сайтов (см. MERGE.md)
//
// Меняет четыре файла:
//   code-lab-server.mjs               + import, объект vendor, маршруты /api/vendor/* и /vendor/cm/*, ссылка в «Настройках», защита /api/*
//   code-lab/public/app.js            + редактор в формах «добавить» и «правка» (если CodeMirror включён)
//   code-lab/public/library.html      + <script src="/cm-bridge.js">
// Новые файлы (vendor.mjs, cm-bridge.js, vendor.html …) просто кладутся рядом, ничего не сливая.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, 'code-lab');
const check = process.argv.includes('--check');
const noGuard = process.argv.includes('--no-guard');
let failed = 0;

const strip = l => l.replace(/\r?\n$/, '');
const eolOf = l => (l.endsWith('\r\n') ? '\r\n' : '\n');
const indentOf = l => /^[ \t]*/.exec(l)[0];
const find = (lines, re, from = 0) => { for (let i = from; i < lines.length; i++) if (re.test(strip(lines[i]))) return i; return -1; };
function insertAfter(lines, i, texts) {
  const e = eolOf(lines[i]);
  if (!/\n$/.test(lines[i])) lines[i] += e;
  lines.splice(i + 1, 0, ...texts.map(t => t + e));
}
function insertBefore(lines, i, texts) { const e = eolOf(lines[i]); lines.splice(i, 0, ...texts.map(t => t + e)); }

async function patch(file, steps) {
  const base = path.basename(file);
  let raw; try { raw = await fs.readFile(file, 'utf8'); } catch (_) { console.log('✗', path.relative(HERE, file), '— файла нет'); failed++; return; }
  const lines = raw.match(/[^\n]*\n|[^\n]+$/g) || [];
  let changed = false;
  for (const st of steps) {
    if (lines.join('').includes(st.marker)) { console.log('·', base, '—', st.name, '— уже есть'); continue; }
    if (!st.apply(lines)) { console.log('✗', base, '—', st.name, '— НЕ НАШЁЛ место. Вставьте вручную, см. MERGE.md'); failed++; continue; }
    changed = true; console.log(check ? '→' : '✓', base, '—', st.name);
  }
  if (changed && !check) {
    await fs.copyFile(file, file + '.bak-cm5').catch(() => {});
    await fs.writeFile(file, lines.join(''), 'utf8');
  }
}

// ───────────── сервер ─────────────
const VENDOR_LINE = "const vendor = createVendor({ root: path.join(ROOT, 'vendor') });   // CodeMirror лежит в code-lab/vendor/codemirror/<версия>/";
const HOST_LINE = String.raw`const isLocalHost = h => { const m = /^(localhost|127\.0\.0\.1|\[::1\])(?::(\d+))?$/.exec(String(h || '')); return !!m && Number(m[2] || 80) === PORT; };`;
const ORIGIN_LINE = String.raw`const isLocalOrigin = o => { try { const x = new URL(o); return (x.hostname === 'localhost' || x.hostname === '127.0.0.1' || x.hostname === '[::1]') && Number(x.port || (x.protocol === 'https:' ? 443 : 80)) === PORT; } catch { return false; } };`;
const HELPERS_NOTE = '// кто может обращаться к серверу: только своя страница (чужой сайт в браузере не должен уметь писать файлы, запускать код, качать версии)';

const GUARD = String.raw`// ── защита от чужих сайтов и подмены адреса (DNS rebinding): сервер умеет писать файлы и запускать код ──
if(u.pathname.startsWith('/api/') || u.pathname.startsWith('/vendor/')){
  if(!isLocalHost(req.headers.host)) return json(res, 403, { error: 'запрещено: открывайте сервер по адресу http://localhost:' + PORT });
  if(req.headers.origin && !isLocalOrigin(req.headers.origin)) return json(res, 403, { error: 'запрещено: запрос с чужой страницы' });
}`.split('\n');

const ROUTES = String.raw`// ── CodeMirror: проверить → скачать → проверить на библиотеке → включить / откатить. Всё по кнопкам со страницы vendor.html ──
if(u.pathname.startsWith('/vendor/cm/') || u.pathname.startsWith('/api/vendor/')){
  const origin = req.headers.origin;
  if(origin && !isLocalOrigin(origin)) return json(res, 403, { error: 'запрещено: запрос с чужой страницы' });
  if(u.pathname.startsWith('/vendor/cm/') && req.method === 'GET'){
    const mm = /^\/vendor\/cm\/(5\.\d+\.\d+)\/(.+)$/.exec(u.pathname);
    let rel = null; try { rel = mm && decodeURIComponent(mm[2]); } catch(_){}
    const abs = rel && vendor.resolveFile(mm[1], rel);
    const data = abs ? await fs.readFile(abs).catch(() => null) : null;
    if(!data) return json(res, 404, { error: 'not found' });
    // файлы версии не меняются никогда (проверяются по sha256), поэтому кэш вечный
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000, immutable' });
    return res.end(data);
  }
  if(u.pathname === '/api/vendor/active') return json(res, 200, vendor.activeInfo());
  if(u.pathname === '/api/vendor/status'){
    const counts = {};
    for(const en of await store.entries()){ const l = String(en.lang || (en.meta && en.meta.lang) || 'txt').toLowerCase(); counts[l] = (counts[l] || 0) + 1; }
    const langs = Object.entries(counts).map(([lang, count]) => ({ lang, count })).sort((a, b) => b.count - a.count);
    return json(res, 200, { ...(await vendor.status()), langs });
  }
  if(u.pathname === '/api/vendor/sample'){      // куски библиотеки для проверки новой версии подсветки (только чтение)
    const entries = (await store.entries()).map(en => ({ id: en.id, lang: String(en.lang || (en.meta && en.meta.lang) || 'txt').toLowerCase(), code: String(en.code || '').slice(0, 20000) }));
    return json(res, 200, { entries });
  }
  if(req.method === 'POST'){
    if(req.headers['x-code-lab'] !== '1') return json(res, 403, { error: 'запрещено' });
    const b = await readBody(req);
    const wrap = async fn => { try { return json(res, 200, await fn()); } catch(e){ return json(res, e && e.name === 'VendorError' ? 400 : 500, { error: String(e && e.message || e), code: e && e.code }); } };
    if(u.pathname === '/api/vendor/check') return wrap(() => vendor.check());
    if(u.pathname === '/api/vendor/install') return wrap(() => vendor.install(String(b.version || ''), { allowYoung: b.allowYoung === true }));
    if(u.pathname === '/api/vendor/activate') return wrap(() => vendor.activate(String(b.version || '')));
    if(u.pathname === '/api/vendor/rollback') return wrap(() => vendor.rollback());
    if(u.pathname === '/api/vendor/deactivate') return wrap(() => vendor.deactivate());
    if(u.pathname === '/api/vendor/remove') return wrap(() => vendor.remove(String(b.version || '')));
    if(u.pathname === '/api/vendor/verify') return wrap(() => vendor.verify(String(b.version || '')));
    if(u.pathname === '/api/vendor/test-result') return wrap(() => vendor.recordTest(String(b.version || ''), b.result));
  }
  return json(res, 404, { error: 'not found' });
}
`.split('\n');

await patch(path.join(HERE, 'code-lab-server.mjs'), [
  { name: 'import createVendor', marker: 'createVendor } from', apply: L => {
      let last = -1; L.forEach((l, i) => { if (i < 80 && /^import .* from ['"][^'"]+['"];?(\s*\/\/.*)?$/.test(strip(l))) last = i; });
      if (last < 0) return false;
      insertAfter(L, last, ["import { createVendor } from './code-lab/lib/vendor.mjs';   // управляемые обновления CodeMirror (по кнопке)"]); return true; } },
  { name: 'объект vendor', marker: 'const vendor = createVendor', apply: L => {
      let i = find(L, /^const aiGenerate = createAiGenerate\(/); if (i < 0) i = find(L, /^const describeQueue = /);
      if (i >= 0) { insertAfter(L, i, [VENDOR_LINE]); return true; }
      i = find(L, /^const MIME = /); if (i < 0) return false;
      insertBefore(L, i, [VENDOR_LINE]); return true; } },
  { name: 'проверка адреса запроса (isLocalHost / isLocalOrigin)', marker: 'const isLocalHost', apply: L => {
      const have = L.join('').includes('const isLocalOrigin');
      const texts = have ? [HOST_LINE] : [HELPERS_NOTE, HOST_LINE, ORIGIN_LINE];
      const i = find(L, /^const vendor = createVendor/); if (i < 0) return false;
      insertAfter(L, i, texts); return true; } },
  { name: 'await vendor.init()', marker: 'await vendor.init()', apply: L => {
      let i = find(L, /^\s*await search\.init\(\);\s*$/);
      if (i >= 0) { insertAfter(L, i, [indentOf(L[i]) + 'await vendor.init();']); return true; }
      i = find(L, /^server\.listen\(/); if (i < 0) return false;
      insertBefore(L, i, ['await vendor.init();']); return true; } },
  { name: 'маршруты /api/vendor/* и /vendor/cm/*', marker: '// ── CodeMirror: проверить', apply: L => {
      const i = [/^\s*if\(u\.pathname === '\/api\/jobs'/, /^\s*if\(u\.pathname === '\/api\/template'/, /^\s*if\(u\.pathname === '\/api\/list'/].map(re => find(L, re)).find(x => x >= 0);
      if (i === undefined) return false;
      const ind = indentOf(L[i]); insertBefore(L, i, ROUTES.map(t => (t ? ind + t : t))); return true; } },
  { name: 'ссылка «Редактор кода…» в Настройках', marker: 'href="/vendor.html"', apply: L => {
      const old = 'id="lab-mistral-close">Закрыть</button>';
      const i = L.findIndex(l => l.includes(old)); if (i < 0) return false;
      L[i] = L[i].replace(old, old + '<a href="/vendor.html" style="color:#c9a8ff;margin-left:10px;font-size:13px">Редактор кода…</a>'); return true; } },
  { name: 'общая защита /api/* от чужих сайтов', marker: '// ── защита от чужих сайтов', skip: noGuard, apply: L => {
      const i = find(L, /^\s*const u = new URL\(req\.url/); if (i < 0) return false;
      const ind = indentOf(L[i]); insertAfter(L, i, GUARD.map(t => ind + t)); return true; } },
].filter(s => !s.skip));

// ───────────── страницы ─────────────
await patch(path.join(ROOT, 'public', 'app.js'), [
  { name: 'редактор в форме «добавить»', marker: "CMBridge.enhance($('#f-code')", apply: L => {
      const i = find(L, /id="f-err"/); if (i < 0 || strip(L[i + 1] || '').trim() !== 'work.appendChild(f);') return false;
      insertAfter(L, i + 1, [
        '  // CodeMirror (если установлен и включён на странице «Редактор кода»); иначе остаётся обычное поле',
        "  if(window.CMBridge){ CMBridge.enhance($('#f-code'), $('#f-lang').value); $('#f-lang').addEventListener('change', ev => CMBridge.setLang($('#f-code'), ev.target.value)); }"]); return true; } },
  { name: 'язык после загрузки файла', marker: "CMBridge.setLang($('#f-code'), $('#f-lang').value)", apply: L => {
      const i = find(L, /if\(map\[ext\]\) \$\('#f-lang'\)\.value = map\[ext\];/); if (i < 0) return false;
      insertAfter(L, i, ["    if(window.CMBridge) CMBridge.setLang($('#f-code'), $('#f-lang').value);"]); return true; } },
  { name: 'редактор в форме «правка»', marker: "CMBridge.enhance($('#e-code')", apply: L => {
      const i = find(L, /\$\('#e-code'\)\.value = code;/); if (i < 0) return false;
      insertAfter(L, i, ["  if(window.CMBridge){ CMBridge.enhance($('#e-code'), $('#e-lang').value); $('#e-lang').addEventListener('change', ev => CMBridge.setLang($('#e-code'), ev.target.value)); }"]); return true; } },
]);
await patch(path.join(ROOT, 'public', 'library.html'), [
  { name: 'скрипт cm-bridge.js', marker: '/cm-bridge.js', apply: L => {
      const i = find(L, /<script src="\/app\.js"><\/script>/); if (i < 0) return false;
      insertBefore(L, i, [indentOf(L[i]) + '<script src="/cm-bridge.js"></script>']); return true; } },
]);

// ───────────── новые файлы на месте? ─────────────
const need = ['lib/vendor.mjs', 'public/cm-bridge.js', 'public/vendor.html', 'public/vendor.js', 'public/vendor-test.html', 'public/vendor-test.js'];
for (const f of need) { try { await fs.access(path.join(ROOT, ...f.split('/'))); } catch (_) { console.log('✗ нет нового файла code-lab/' + f + ' — положите его на место из набора'); failed++; } }

console.log(failed ? '\nЕсть места, которые не удалось найти — см. MERGE.md.' : (check ? '\nПроверка пройдена.' : '\nГотово.'));
process.exitCode = failed ? 1 : 0;
