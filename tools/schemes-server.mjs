// Локальный сервер с той же ленивой логикой, что и раздел «Схемы отраслей»:
// при старте НИЧЕГО не читает; список отраслей/файлов и содержимое отдаёт
// только по запросу. Данные берёт из папки references/schemes на диске —
// без GitHub, без токена, офлайн. Пригодится, чтобы смотреть схемы и шаблоны
// локально и быстро, не ходя в сеть.
//
// Запуск:  node tools/schemes-server.mjs           (порт 8787)
//          node tools/schemes-server.mjs 9000 .    (порт и корень репо)
// Потом открыть http://localhost:8787/
//
// Только стандартная библиотека Node (http/fs/path), без зависимостей —
// как dashboard.py в invest-bot на stdlib http.server.

import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.argv[2]) || 8787;
const ROOT = path.resolve(process.argv[3] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const BASE = path.join(ROOT, 'references', 'schemes');

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(obj)); };

// Защита от выхода за пределы BASE (../../etc/passwd и т.п.): любой путь из
// запроса приводим к абсолютному и проверяем, что он внутри BASE.
function safe(rel){
  const p = path.resolve(BASE, '.' + path.sep + (rel || '').replace(/^\/+/, ''));
  if(p !== BASE && !p.startsWith(BASE + path.sep)) return null;
  return p;
}

// Лёгкий индекс: какие отрасли вообще содержат схемы (имена подпапок). Один
// проход по верхней папке, в файлы не заходим — как listIndustriesWithSchemes.
async function listIndustries(){
  try {
    const ents = await fs.readdir(BASE, { withFileTypes: true });
    return ents.filter(e => e.isDirectory()).map(e => e.name).sort();
  } catch(_){ return []; }
}

// Список html-файлов отрасли (лениво, при раскрытии) — как listSchemes.
async function listFiles(industry){
  const dir = safe(industry); if(!dir) return [];
  try {
    const ents = await fs.readdir(dir, { withFileTypes: true });
    const out = [];
    for(const e of ents){
      if(e.isFile() && /\.html?$/i.test(e.name)){
        const st = await fs.stat(path.join(dir, e.name));
        out.push({ name: e.name, path: `${industry}/${e.name}`, size: st.size });
      }
    }
    return out.sort((a, b) => a.name < b.name ? -1 : 1);
  } catch(_){ return []; }
}

const PAGE = `<!doctype html><html lang="ru"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Схемы (локально)</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;background:#140A24;color:#F6F4FF;font:14px/1.5 ui-monospace,Menlo,Consolas,monospace}
  header{padding:14px 18px;border-bottom:1px solid #241638}
  h1{font-size:16px;margin:0}
  .sub{color:#9C90C4;font-size:12px;margin-top:4px}
  main{display:flex;min-height:calc(100vh - 56px)}
  nav{width:280px;border-right:1px solid #241638;padding:10px;overflow:auto}
  .ind{padding:8px 10px;border-radius:6px;cursor:pointer;color:#CBC2EA}
  .ind:hover{background:#1A1030}
  .file{padding:6px 10px 6px 26px;border-radius:6px;cursor:pointer;color:#9C90C4;font-size:13px}
  .file:hover{background:#1A1030;color:#52F2C9}
  iframe{flex:1;border:0;background:#fff}
  .empty{color:#9C90C4;padding:20px}
  .err{color:#FF8800}
</style>
<header><h1>Схемы отраслей — локально</h1>
<div class="sub">офлайн, из references/schemes · ленивая загрузка (список при раскрытии, файл при клике)</div></header>
<main>
  <nav id="nav"><div class="empty">загрузка…</div></nav>
  <iframe id="view" sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-downloads"></iframe>
</main>
<script>
const nav = document.getElementById('nav'), view = document.getElementById('view');
const api = p => fetch(p).then(r => r.json());
async function init(){
  const inds = await api('/api/industries');
  if(!inds.length){ nav.innerHTML = '<div class="empty">папка references/schemes пуста</div>'; return; }
  nav.innerHTML = '';
  for(const name of inds){
    const d = document.createElement('div'); d.className = 'ind'; d.textContent = '▸ ' + name;
    const box = document.createElement('div'); box.style.display = 'none';
    let loaded = false;
    d.onclick = async () => {
      const open = box.style.display === 'none';
      box.style.display = open ? 'block' : 'none';
      d.textContent = (open ? '▾ ' : '▸ ') + name;
      if(open && !loaded){
        loaded = true;
        const files = await api('/api/files?i=' + encodeURIComponent(name));
        box.innerHTML = files.length ? '' : '<div class="file">пусто</div>';
        for(const f of files){
          const fe = document.createElement('div'); fe.className = 'file';
          fe.textContent = f.name + '  (' + Math.round(f.size/1024) + ' КБ)';
          fe.onclick = e => { e.stopPropagation(); view.src = '/file/' + f.path; };
          box.appendChild(fe);
        }
      }
    };
    nav.appendChild(d); nav.appendChild(box);
  }
}
init().catch(e => nav.innerHTML = '<div class="err">ошибка: ' + e + '</div>');
</script></html>`;

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    if(u.pathname === '/'){ res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE); return; }
    if(u.pathname === '/api/industries'){ return json(res, 200, await listIndustries()); }
    if(u.pathname === '/api/files'){ return json(res, 200, await listFiles(u.searchParams.get('i') || '')); }
    if(u.pathname.startsWith('/file/')){
      const rel = decodeURIComponent(u.pathname.slice('/file/'.length));
      const abs = safe(rel);
      if(!abs || !/\.html?$/i.test(abs)) return json(res, 400, { error: 'bad path' });
      const html = await fs.readFile(abs, 'utf8').catch(() => null);
      if(html == null) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); return;
    }
    json(res, 404, { error: 'not found' });
  } catch(e){ json(res, 500, { error: String(e && e.message || e) }); }
});

server.listen(PORT, () => {
  console.log(`Схемы (локально): http://localhost:${PORT}/`);
  console.log(`Корень: ${BASE}`);
});
