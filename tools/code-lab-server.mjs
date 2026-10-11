// Локальный сервер «Лаборатории кода» — отдельная от сайта штука, чтобы могла
// расти без риска для основного приложения. Каждый шаблон — отдельный JSON-файл
// в templates/. Добавить шаблон = положить файл, перезагрузить страницу. Ничего
// не пересобирается, сайт не трогается.
//
// Сделан на скелете прежнего schemes-server (stdlib node: http/fs/path, без
// зависимостей; ленивое чтение папки; защита от выхода за пределы).
//
// Запуск:  node tools/code-lab-server.mjs            (порт 8788)
//          node tools/code-lab-server.mjs 9001       (свой порт)
// Открыть: http://localhost:8788/
//
// Ленивость: список шаблонов (только мета) читается при запросе /api/list;
// полный шаблон — только когда его выбрали (/api/template?id=...).

import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, 'code-lab');          // tools/code-lab
const PUBLIC = path.join(ROOT, 'public');
const TEMPLATES = path.join(ROOT, 'templates');
const PORT = Number(process.argv[2]) || 8788;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(obj)); };

// Любой путь из запроса держим внутри базовой папки (защита от ../../).
function within(base, rel){
  const p = path.resolve(base, '.' + path.sep + (rel || '').replace(/^\/+/, ''));
  if(p !== base && !p.startsWith(base + path.sep)) return null;
  return p;
}

// Лёгкий список: читаем все templates/*.json, но отдаём только мета
// (id/lang/group/title/desc) — содержимое кода не гоняем, пока не выбрали.
async function listTemplates(){
  let names = [];
  try { names = (await fs.readdir(TEMPLATES)).filter(n => n.endsWith('.json')); } catch(_){ return []; }
  const out = [];
  for(const n of names.sort()){
    try {
      const j = JSON.parse(await fs.readFile(path.join(TEMPLATES, n), 'utf8'));
      out.push({ id: j.id || n.replace(/\.json$/, ''), lang: j.lang || '', group: j.group || 'Разное', title: j.title || n, desc: j.desc || '', file: n });
    } catch(_){ /* битый json пропускаем, чтобы один файл не ронял список */ }
  }
  return out;
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    if(u.pathname === '/api/list'){ return json(res, 200, await listTemplates()); }
    if(u.pathname === '/api/template'){
      const list = await listTemplates();
      const meta = list.find(x => x.id === u.searchParams.get('id'));
      if(!meta) return json(res, 404, { error: 'нет такого шаблона' });
      const j = JSON.parse(await fs.readFile(path.join(TEMPLATES, meta.file), 'utf8'));
      return json(res, 200, j);
    }
    // статика из public/ ( / → index.html )
    const rel = u.pathname === '/' ? 'index.html' : u.pathname;
    const abs = within(PUBLIC, rel);
    if(!abs) return json(res, 400, { error: 'bad path' });
    const data = await fs.readFile(abs).catch(() => null);
    if(data == null) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
    res.end(data);
  } catch(e){ json(res, 500, { error: String(e && e.message || e) }); }
});

server.listen(PORT, () => {
  console.log(`Лаборатория кода: http://localhost:${PORT}/`);
  console.log(`Шаблоны: ${TEMPLATES}  (добавляй .json — появятся после F5)`);
});
