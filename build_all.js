// build_all.js — сборщик всех модулей в один app.html
// Использование: node build_all.js [--all]
// --all: включить все модули независимо от поля enabled

const fs   = require('fs');
const path = require('path');

const ROOT     = __dirname;
const OUT_FILE = path.join(ROOT, 'app.html');
const CFG_FILE = path.join(ROOT, 'modules.json');

const includeAll = process.argv.includes('--all');

// ── Читаем конфиг ────────────────────────────────────────────────
const allMods = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
const mods    = allMods.filter(m => includeAll || m.enabled !== false);

console.log(`Сборка: ${mods.length} модулей`);

// ── Вспомогательные функции ──────────────────────────────────────

// Все <style>…</style> в head (не в body)
function extractHeadCss(src) {
  const headMatch = src.match(/<head[\s\S]*?<\/head>/i);
  if (!headMatch) return '';
  return (headMatch[0].match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || [])
    .map(s => s.replace(/<style[^>]*>|<\/style>/gi, ''))
    .join('\n');
}

// Все <script src="…"> — возвращает массив src-строк
function extractExtScripts(src) {
  const results = [];
  const re = /<script\s[^>]*src=["']([^"']+)["'][^>]*><\/script>/gi;
  let m;
  while ((m = re.exec(src)) !== null) results.push(m[1]);
  return results;
}

// Все inline <script> (без src)
function extractInlineScripts(src) {
  const results = [];
  const re = /<script(?![^>]*\bsrc\b)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    const code = m[1].trim();
    if (code) results.push(code);
  }
  return results;
}

// Содержимое <body>
function extractBody(src) {
  const m = src.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return m ? m[1] : src; // если нет body — берём весь файл
}

// Найти все имена функций вызываемых из on* атрибутов в HTML
// onclick="foo()" → ['foo']
// oninput="bar(x); baz()" → ['bar', 'baz']
function extractOnHandlerFunctions(html) {
  const names = new Set();
  const attrRe = /\bon(?:click|change|input|submit|keyup|keydown|keypress|focus|blur|mousedown|mouseup|mouseover|mouseout|dblclick|contextmenu|load|scroll|resize|touchstart|touchend|touchmove|pointerdown|pointerup)="([^"]+)"/gi;
  const fnRe   = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
  let attrMatch;
  while ((attrMatch = attrRe.exec(html)) !== null) {
    const val = attrMatch[1];
    let fnMatch;
    while ((fnMatch = fnRe.exec(val)) !== null) {
      // Исключить JS-встроенные
      const skip = new Set(['if','for','while','switch','function','return',
        'typeof','instanceof','new','delete','void','throw','catch','var','let','const',
        'parseInt','parseFloat','isNaN','isFinite','JSON','Math','Object',
        'Array','String','Number','Boolean','console','alert','confirm',
        'setTimeout','clearTimeout','setInterval','fetch','Promise',
        'document','window','event','this','null','undefined','true','false',
        'remove','add','split','join','replace','slice','indexOf','includes',
        'push','pop','shift','unshift','map','filter','forEach','find','some','every',
        'toString','valueOf','hasOwnProperty','call','apply','bind']);
      if (!skip.has(fnMatch[1])) names.add(fnMatch[1]);
    }
  }
  return Array.from(names);
}

// Удалить override showPage в конце скрипта (характерно для standalone-модулей)
function stripShowPageOverride(code) {
  return code.replace(/\bshowPage\s*=\s*function[^}]+\{[^}]*\}\s*;?/g, '');
}

// Предупреждение о конфликтах между модулями
function checkConflicts(modScripts) {
  const fnRe   = /^function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/mg;
  const varRe  = /^(?:let|var|const)\s+([A-Za-z_$][A-Za-z0-9_$]*)/mg;
  const byName = {};
  modScripts.forEach(({ id, code }) => {
    const names = new Set();
    let m;
    while ((m = fnRe.exec(code))  !== null) names.add(m[1]);
    while ((m = varRe.exec(code)) !== null) names.add(m[1]);
    names.forEach(n => {
      if (!byName[n]) byName[n] = [];
      byName[n].push(id);
    });
  });
  const conflicts = Object.entries(byName)
    .filter(([, ids]) => ids.length > 1)
    .map(([n, ids]) => `  ${n}: ${ids.join(', ')}`);
  if (conflicts.length) {
    console.warn(`\n⚠ Возможные конфликты (${conflicts.length} имён):`);
    conflicts.slice(0, 20).forEach(c => console.warn(c));
    if (conflicts.length > 20) console.warn(`  ... и ещё ${conflicts.length - 20}`);
    console.warn('');
  }
}

// ── Обрабатываем каждый модуль ───────────────────────────────────
const extScriptsSeen = new Set();
const extScriptsAll  = []; // в порядке первого появления
const cssAll         = [];
const bodyAll        = [];
const scriptAll      = [];
const modScriptsRaw  = []; // для проверки конфликтов

for (const mod of mods) {
  const filePath = path.join(ROOT, mod.file);
  if (!fs.existsSync(filePath)) {
    console.error(`Файл не найден: ${mod.file} — пропускаем`);
    continue;
  }
  const src = fs.readFileSync(filePath, 'utf8');
  console.log(`  [${mod.id}] ${mod.file} (${Math.round(src.length/1024)}KB)`);

  // CSS
  const css = extractHeadCss(src);
  if (css.trim()) cssAll.push(`/* ── ${mod.label} ── */\n${css}`);

  // Внешние скрипты (дедупликация по URL)
  extractExtScripts(src).forEach(url => {
    if (!extScriptsSeen.has(url)) {
      extScriptsSeen.add(url);
      extScriptsAll.push(url);
    }
  });

  // HTML тела
  const body = extractBody(src);
  bodyAll.push(
    `\n<!-- ════ ${mod.label} ════ -->\n` +
    `<div class="page" id="page-${mod.id}" style="display:none">\n${body}\n</div>`
  );

  // Скрипты: объединяем, оборачиваем в IIFE
  const scripts = extractInlineScripts(src).map(stripShowPageOverride);
  const combined = scripts.join('\n;\n');
  modScriptsRaw.push({ id: mod.id, code: combined });

  // Имена функций из onclick-атрибутов — экспортируем на window
  const handlers = extractOnHandlerFunctions(body);
  const expose   = handlers.length
    ? '\n// Экспорт для onclick-атрибутов:\n' +
      handlers.map(n =>
        `try{ if(typeof ${n}!=='undefined') window.${n}=${n}; }catch(_){}`
      ).join('\n')
    : '';

  scriptAll.push(
    `\n/* ════ ${mod.label} [${mod.id}] ════ */\n` +
    `;(function(){\n${combined}\n${expose}\n})();`
  );
}

// Проверка конфликтов
checkConflicts(modScriptsRaw);

// ── Шаблон шелла (навигация + layout manager) ────────────────────
const firstId  = mods[0]?.id || '';
const navBtns  = mods.map(m =>
  `<button class="app-nav-btn" id="nav-btn-${m.id}" onclick="appShowPage('${m.id}')">${m.icon || ''} ${m.label}</button>`
).join('\n    ');

const layoutItems = allMods.map(m => {
  const inBuild = mods.some(x => x.id === m.id);
  return `<div class="lm-row">
      <span class="lm-icon">${m.icon || '•'}</span>
      <span class="lm-label">${m.label}</span>
      <span class="lm-file" title="${m.file}">${m.file}</span>
      ${inBuild
        ? '<span class="lm-badge ok">в сборке</span>'
        : '<span class="lm-badge off">выключен</span>'}
    </div>`;
}).join('\n    ');

const shellCss = `
/* ══ App shell ══ */
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden;background:#0B0613;color:#F2F0FF;
  font-family:'Inter',ui-sans-serif,system-ui,sans-serif;font-size:16px}

#app-nav{
  position:fixed;top:0;left:0;right:0;height:44px;z-index:9000;
  background:rgba(11,6,19,.96);border-bottom:1px solid rgba(255,0,128,.18);
  display:flex;align-items:center;gap:2px;padding:0 8px;
  overflow-x:auto;overflow-y:hidden;
  scrollbar-width:thin;scrollbar-color:rgba(255,0,128,.2) transparent}
#app-nav::-webkit-scrollbar{height:3px}
#app-nav::-webkit-scrollbar-thumb{background:rgba(255,0,128,.25)}

.app-nav-btn{
  flex-shrink:0;padding:5px 14px;background:transparent;
  border:1px solid transparent;color:#6F648F;cursor:pointer;
  font-size:13px;font-family:inherit;white-space:nowrap;
  transition:all .12s;border-radius:3px}
.app-nav-btn:hover{color:#A79BC9;border-color:rgba(255,0,128,.2)}
.app-nav-btn.active{color:#F2F0FF;border-color:rgba(255,0,128,.4);
  background:rgba(255,0,128,.07)}

#nav-layout-btn{
  margin-left:auto;flex-shrink:0;padding:5px 10px;background:transparent;
  border:1px solid rgba(255,255,255,.08);color:#6F648F;cursor:pointer;
  font-size:12px;font-family:inherit;border-radius:3px}
#nav-layout-btn:hover{color:#A79BC9;border-color:rgba(170,90,255,.3)}

#app-body{
  position:fixed;top:44px;left:0;right:0;bottom:0;overflow:hidden}

.page{
  display:none;width:100%;height:100%;overflow-y:auto;overflow-x:hidden}
.page.active{display:block}

/* Layout manager modal */
#lm-overlay{
  position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:10000;
  display:none;align-items:center;justify-content:center}
#lm-overlay.open{display:flex}
#lm-box{
  background:#140A24;border:1px solid rgba(255,0,128,.25);
  width:580px;max-width:96vw;max-height:88vh;overflow-y:auto;
  box-shadow:0 20px 60px rgba(0,0,0,.8)}
.lm-hdr{
  padding:18px 24px;border-bottom:1px solid rgba(255,255,255,.06);
  display:flex;align-items:center;justify-content:space-between;
  font-size:15px;font-weight:700;color:#F2F0FF}
.lm-close{background:none;border:none;color:#6F648F;cursor:pointer;font-size:20px}
.lm-body{padding:20px 24px}
.lm-section{font-size:11px;letter-spacing:.1em;text-transform:uppercase;
  color:#6F648F;margin:0 0 12px}
.lm-row{
  display:flex;align-items:center;gap:10px;padding:10px 0;
  border-bottom:1px solid rgba(255,255,255,.04)}
.lm-icon{font-size:18px;width:28px;text-align:center;flex-shrink:0}
.lm-label{font-size:14px;color:#F2F0FF;min-width:140px;flex-shrink:0}
.lm-file{font-size:11px;color:#6F648F;font-family:monospace;
  flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lm-badge{font-size:10px;padding:2px 8px;border-radius:2px;
  font-weight:600;white-space:nowrap;flex-shrink:0}
.lm-badge.ok{background:rgba(82,242,201,.1);color:#52F2C9;
  border:1px solid rgba(82,242,201,.3)}
.lm-badge.off{background:rgba(255,255,255,.04);color:#6F648F;
  border:1px solid rgba(255,255,255,.08)}
.lm-note{font-size:13px;color:#6F648F;margin-top:20px;line-height:1.6;
  padding:12px 16px;border:1px solid rgba(255,255,255,.06);
  background:rgba(255,255,255,.02)}
.lm-note code{color:#AA5AFF;font-family:monospace;font-size:12px}
.lm-ftr{padding:16px 24px;border-top:1px solid rgba(255,255,255,.06);
  display:flex;gap:8px;justify-content:flex-end}
.lm-btn{padding:8px 18px;background:rgba(255,255,255,.04);
  border:1px solid rgba(255,255,255,.1);color:#A79BC9;cursor:pointer;
  font-size:13px;font-family:inherit}
.lm-btn:hover{background:rgba(255,255,255,.07);color:#F2F0FF}
`;

const shellScript = `
// ── App layout manager ─────────────────────────────────────────
var _appActivePage = '';

function appShowPage(id){
  document.querySelectorAll('.page').forEach(function(el){
    el.classList.remove('active');
    el.style.display = 'none';
  });
  document.querySelectorAll('.app-nav-btn').forEach(function(b){
    b.classList.remove('active');
  });
  var page = document.getElementById('page-' + id);
  var btn  = document.getElementById('nav-btn-' + id);
  if(page){ page.style.display = ''; page.classList.add('active'); }
  if(btn)  btn.classList.add('active');
  _appActivePage = id;
  try{ localStorage.setItem('ba_app_active', id); }catch(e){}
}

function appLayoutOpen(){
  var el = document.getElementById('lm-overlay');
  if(el) el.classList.add('open');
}
function appLayoutClose(){
  var el = document.getElementById('lm-overlay');
  if(el) el.classList.remove('open');
}

// Инициализация: восстановить активную вкладку
(function(){
  var saved = '';
  try{ saved = localStorage.getItem('ba_app_active') || ''; }catch(e){}
  var first = '${firstId}';
  appShowPage(saved || first);
})();
`;

// ── Собираем финальный HTML ──────────────────────────────────────
const out = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>БондАналитик</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400&display=swap" rel="stylesheet">
${extScriptsAll.map(u => `<script src="${u}"></script>`).join('\n')}
<style>
${shellCss}
${cssAll.join('\n\n')}
</style>
</head>
<body>

<!-- ── Навигация ── -->
<nav id="app-nav">
  ${navBtns}
  <button id="nav-layout-btn" onclick="appLayoutOpen()" title="Управление модулями">⚙ Модули</button>
</nav>

<!-- ── Страницы ── -->
<div id="app-body">
${bodyAll.join('\n')}
</div>

<!-- ── Layout manager ── -->
<div id="lm-overlay">
  <div id="lm-box">
    <div class="lm-hdr">
      <span>⚙ Управление модулями</span>
      <button class="lm-close" onclick="appLayoutClose()">✕</button>
    </div>
    <div class="lm-body">
      <div class="lm-section">Модули в текущей сборке</div>
      ${layoutItems}
      <div class="lm-note">
        Чтобы включить или выключить модуль — отредактируй
        <code>modules.json</code> и пересобери:<br>
        <code>node build_all.js</code><br><br>
        Чтобы включить все модули: <code>node build_all.js --all</code>
      </div>
    </div>
    <div class="lm-ftr">
      <button class="lm-btn" onclick="appLayoutClose()">Закрыть</button>
    </div>
  </div>
</div>

<!-- ── Скрипты модулей ── -->
<script>
${shellScript}
${scriptAll.join('\n\n')}
</script>
</body>
</html>`;

// ── Запись результата ────────────────────────────────────────────
fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, out, 'utf8');

const sizeKb  = Math.round(out.length / 1024);
const sizeStr = sizeKb > 1024 ? (sizeKb/1024).toFixed(1)+'MB' : sizeKb+'KB';
console.log(`\n✓ Готово: app.html (${sizeStr})`);
console.log(`  Модулей: ${mods.length}`);
console.log(`  Внешних библиотек: ${extScriptsAll.length} (дедупликация)`);
