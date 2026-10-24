// Точечная правка существующих файлов под рабочую папку проекта. Безопасна для вашей параллельной версии:
// ищет места по коротким якорям, а не по номерам строк; повторный запуск ничего не дублирует;
// перед записью делает копию <файл>.bak-workspace; переводы строк (CRLF/LF) сохраняет.
//
//   node tools/apply-workspace-patch.mjs            # применить
//   node tools/apply-workspace-patch.mjs --check    # только показать, что будет сделано
//
// Меняет ровно три файла, по одному месту в каждом:
//   code-lab-server.mjs        + import и одна строка-маршрут
//   code-lab/public/sandbox.js + window.codelabSandbox = {…}
//   code-lab/public/constructor.html + <script src="/workspace.js">
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, 'code-lab');
const check = process.argv.includes('--check');
let failed = 0;

async function patch(file, steps){
  let raw; try { raw = await fs.readFile(file, 'utf8'); } catch(_){ console.log('✗', path.relative(HERE, file), '— файла нет'); failed++; return; }
  const crlf = raw.includes('\r\n'); let s = raw.replace(/\r\n/g, '\n'); let changed = false;
  for(const st of steps){
    if(s.includes(st.marker)){ console.log('·', path.basename(file), '—', st.name, '— уже есть'); continue; }
    const r = st.apply(s);
    if(!r){ console.log('✗', path.basename(file), '—', st.name, '— НЕ НАШЁЛ место. Сделайте вручную, см. WORKSPACE-PATCHES.md'); failed++; continue; }
    s = r; changed = true; console.log(check ? '→' : '✓', path.basename(file), '—', st.name);
  }
  if(changed && !check){
    await fs.copyFile(file, file + '.bak-workspace').catch(() => {});
    await fs.writeFile(file, crlf ? s.replace(/\n/g, '\r\n') : s, 'utf8');
  }
}

// ── сервер ──
await patch(path.join(HERE, 'code-lab-server.mjs'), [
  { name: 'import handleWorkspace', marker: "handleWorkspace } from", apply: s => {
      const lines = s.split('\n'); let last = -1;
      lines.forEach((l, i) => { if(i < 80 && /^import .* from ['"].*['"];?\s*$/.test(l)) last = i; });
      if(last < 0) return null;
      lines.splice(last + 1, 0, "import { handleWorkspace } from './code-lab/lib/workspace.mjs';");
      return lines.join('\n'); } },
  { name: 'маршрут /api/ws/*', marker: 'handleWorkspace(req', apply: s => {
      const m = /^([ \t]*)if\(u\.pathname === '\/api\/template'/m.exec(s)
             || /^([ \t]*)if\(u\.pathname === '\/api\/list'/m.exec(s);
      if(!m) return null;
      const ins = m[1] + "if(await handleWorkspace(req, res, u, { readBody, json, root: ROOT })) return;   // рабочая папка проекта (/api/ws/*)\n";
      return s.slice(0, m.index) + ins + s.slice(m.index); } }
]);

// ── песочница: отдать наружу доступ к файлам панелей ──
await patch(path.join(ROOT, 'public', 'sandbox.js'), [
  { name: 'window.codelabSandbox', marker: 'window.codelabSandbox', apply: s => {
      const m = /^([ \t]*)renderEds\(\);[ \t]*\n(?=\s*\n?[ \t]*\/\/ ── переключение режимов)/m.exec(s)
             || /^([ \t]*)renderEds\(\);[ \t]*$/m.exec(s.slice(s.lastIndexOf('const gut')));
      if(!m) return null;
      const at = m.index + (m[0].length), i = m[1];
      const block = '\n' + i + '// доступ к файлам панелей для workspace.js (открыть/сохранить файлы проекта)\n' +
        i + 'window.codelabSandbox = {\n' +
        i + '  getFiles: () => files,\n' +
        i + '  setFiles: arr => { files = arr; save(); renderEds(); schedulePreview(); },\n' +
        i + '  refresh: () => { save(); renderEds(); schedulePreview(); }\n' +
        i + '};\n';
      return s.slice(0, at) + block + s.slice(at); } }
]);

// ── страница конструктора: подключить скрипт ──
await patch(path.join(ROOT, 'public', 'constructor.html'), [
  { name: 'скрипт workspace.js', marker: '/workspace.js', apply: s => {
      const m = /^([ \t]*)<script src="\/sandbox\.js"><\/script>[ \t]*$/m.exec(s);
      if(!m) return null;
      const at = m.index + m[0].length;
      return s.slice(0, at) + '\n' + m[1] + '<script src="/workspace.js"></script>' + s.slice(at); } }
]);

console.log(failed ? '\nЕсть места, которые не удалось найти — см. WORKSPACE-PATCHES.md (ручная правка по 1–2 строки).' : (check ? '\nПроверка пройдена.' : '\nГотово.'));
process.exitCode = failed ? 1 : 0;
