// Локальный сервер «Лаборатории кода» — отдельная от сайта штука, чтобы могла
// расти без риска для основного приложения. Каждый шаблон — отдельный JSON-файл
// в templates/. Добавлять можно прямо со страницы: вставил/загрузил код — он
// раскрашивается и сохраняется новым файлом; клик по слову → вписываешь, что
// оно значит, и это пишется в тот же файл. Ничего не пересобирается.
//
// stdlib node (http/fs/path), без зависимостей. Ленивость: /api/list отдаёт
// только мету; полный шаблон — при выборе.
//
// Запуск:  node tools/code-lab-server.mjs            (порт 8788)
// Открыть: http://localhost:8788/

import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, 'code-lab');
const PUBLIC = path.join(ROOT, 'public');
const TEMPLATES = path.join(ROOT, 'templates');
const DATA = path.join(ROOT, 'data');     // сохранённые JSON-данные пользователя
const PORT = Number(process.argv[2]) || 8788;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(obj)); };

function within(base, rel){
  const p = path.resolve(base, '.' + path.sep + (rel || '').replace(/^\/+/, ''));
  if(p !== base && !p.startsWith(base + path.sep)) return null;
  return p;
}
function readBody(req){
  return new Promise((resolve, reject) => {
    let d = ''; req.on('data', c => { d += c; if(d.length > 80e6) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch(e){ reject(e); } });
    req.on('error', reject);
  });
}

// ── токенайзер: сырой код → строки токенов {k, v, r?} ───────────────────────
const KW = {
  js: new Set(['const','let','var','function','return','if','else','for','while','of','in','new','await','async','import','export','from','default','class','extends','super','try','catch','finally','throw','typeof','instanceof','null','undefined','true','false','this','break','continue','switch','case','do','yield','delete','void']),
  python: new Set(['def','return','if','elif','else','for','while','in','not','and','or','import','from','as','class','try','except','finally','raise','with','lambda','None','True','False','pass','break','continue','yield','global','nonlocal','del','assert','is','async','await']),
  sql: new Set(['select','from','where','group','by','order','having','join','left','right','inner','outer','full','cross','on','as','and','or','not','in','is','null','insert','into','values','update','set','delete','create','table','view','index','primary','key','foreign','references','distinct','count','sum','avg','min','max','case','when','then','else','end','limit','offset','union','all','with','desc','asc','between','like','exists']),
};
const BUILTIN = {
  js: new Set(['console','log','Math','JSON','Array','Object','String','Number','parseInt','parseFloat','fetch','document','window','map','filter','reduce','forEach','push','length','pow','sqrt','round','floor','random']),
  python: new Set(['print','range','len','int','float','str','list','dict','tuple','set','input','sum','min','max','abs','round','enumerate','zip','sorted','map','filter','open']),
  sql: new Set(),
};
function lineComment(lang){ return lang === 'sql' ? '--' : lang === 'python' ? '#' : '//'; }

function tokenizeLine(line, lang){
  const kws = KW[lang] || KW.js;
  const builtins = BUILTIN[lang] || BUILTIN.js;
  const lc = lineComment(lang);
  const out = [];
  const n = line.length;
  let i = 0;
  while(i < n){
    const rest = line.slice(i);
    const c = line[i];
    if(rest.startsWith(lc)){ out.push({ k: 'com', v: line.slice(i) }); break; }
    if(c === '"' || c === "'" || (lang === 'js' && c === '`')){
      let j = i + 1; while(j < n){ if(line[j] === '\\'){ j += 2; continue; } if(line[j] === c){ j++; break; } j++; }
      out.push({ k: 'str', v: line.slice(i, j) }); i = j; continue;
    }
    if(/[0-9]/.test(c)){ const m = /^(0x[0-9a-fA-F]+|\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?)/.exec(rest); if(m){ out.push({ k: 'num', v: m[0] }); i += m[0].length; continue; } }
    const im = /^[A-Za-z_$][\w$]*/.exec(rest);
    if(im){
      const w = im[0];
      const key = lang === 'sql' ? w.toLowerCase() : w;
      let k = i + w.length; while(k < n && line[k] === ' ') k++;
      if(kws.has(key)) out.push({ k: 'kw', v: w });
      else if(line[k] === '(' || builtins.has(w)) out.push({ k: 'fn', v: w });
      else out.push({ k: 'name', v: w, r: w });   // имя → редактируемое, ref=само слово (переименование синхронно)
      i += w.length; continue;
    }
    const ws = /^\s+/.exec(rest);
    if(ws){ out.push({ k: 'sp', v: ws[0] }); i += ws[0].length; continue; }
    out.push({ k: 'op', v: c }); i++;
  }
  return out;
}
function tokenize(code, lang){ return String(code).replace(/\r\n/g, '\n').split('\n').map(l => tokenizeLine(l, lang)); }

function slug(s){
  const base = String(s || 'tpl').toLowerCase().replace(/[^\wа-яё]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'tpl';
  return base + '-' + Date.now().toString(36);
}

async function listTemplates(){
  let names = [];
  try { names = (await fs.readdir(TEMPLATES)).filter(n => n.endsWith('.json')); } catch(_){ return []; }
  const out = [];
  for(const n of names.sort()){
    try {
      const j = JSON.parse(await fs.readFile(path.join(TEMPLATES, n), 'utf8'));
      out.push({ id: j.id || n.replace(/\.json$/, ''), lang: j.lang || '', group: j.group || 'Разное', title: j.title || n, desc: j.desc || '', file: n });
    } catch(_){}
  }
  return out;
}
async function fileForId(id){ const l = await listTemplates(); const m = l.find(x => x.id === id); return m ? m.file : null; }

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');

    if(u.pathname === '/api/list'){ return json(res, 200, await listTemplates()); }

    if(u.pathname === '/api/template'){
      const file = await fileForId(u.searchParams.get('id'));
      if(!file) return json(res, 404, { error: 'нет такого шаблона' });
      return json(res, 200, JSON.parse(await fs.readFile(path.join(TEMPLATES, file), 'utf8')));
    }

    // создать шаблон из вставленного кода
    if(u.pathname === '/api/add' && req.method === 'POST'){
      const b = await readBody(req);
      const lang = String(b.lang || 'js').toLowerCase();
      const obj = {
        id: slug(b.title || lang),
        lang, group: String(b.group || 'Мои шаблоны').slice(0, 60),
        title: String(b.title || 'Без названия').slice(0, 80),
        desc: String(b.desc || '').slice(0, 400),
        lines: tokenize(b.code || '', lang),
        output: b.output != null ? String(b.output) : '',
      };
      await fs.mkdir(TEMPLATES, { recursive: true });
      await fs.writeFile(path.join(TEMPLATES, obj.id + '.json'), JSON.stringify(obj, null, 2), 'utf8');
      return json(res, 200, { id: obj.id });
    }

    // вписать/изменить пояснение к конкретному слову (сохраняется в файл)
    if(u.pathname === '/api/annotate' && req.method === 'POST'){
      const b = await readBody(req);
      const file = await fileForId(b.id);
      if(!file) return json(res, 404, { error: 'нет такого шаблона' });
      const full = path.join(TEMPLATES, file);
      const j = JSON.parse(await fs.readFile(full, 'utf8'));
      const tok = j.lines && j.lines[b.line] && j.lines[b.line][b.idx];
      if(!tok) return json(res, 400, { error: 'не нашлось слово' });
      tok.e = String(b.e || '').slice(0, 600);
      await fs.writeFile(full, JSON.stringify(j, null, 2), 'utf8');
      return json(res, 200, { ok: true });
    }

    // правка шаблона целиком: новый код → заново токенизируем, перезаписываем файл
    if(u.pathname === '/api/edit' && req.method === 'POST'){
      const b = await readBody(req);
      const file = await fileForId(b.id);
      if(!file) return json(res, 404, { error: 'нет такого шаблона' });
      const full = path.join(TEMPLATES, file);
      const j = JSON.parse(await fs.readFile(full, 'utf8'));
      if(b.lang != null) j.lang = String(b.lang).toLowerCase();
      if(b.title != null) j.title = String(b.title).slice(0, 80) || j.title;
      if(b.group != null) j.group = String(b.group).slice(0, 60) || j.group;
      if(b.desc != null) j.desc = String(b.desc).slice(0, 400);
      if(b.output != null) j.output = String(b.output);
      if(b.code != null) j.lines = tokenize(b.code, j.lang);   // код заново раскрашивается
      await fs.writeFile(full, JSON.stringify(j, null, 2), 'utf8');
      return json(res, 200, { ok: true, id: j.id });
    }

    // ── сохранённые данные (JSON из архивов) ──────────────────────────────
    if(u.pathname === '/api/data/save' && req.method === 'POST'){
      const b = await readBody(req);
      const id = slug(b.name || 'data');
      const obj = { id, name: String(b.name || 'без имени').slice(0, 120), desc: String(b.desc || '').slice(0, 400), savedAt: new Date().toISOString(), data: b.data };
      await fs.mkdir(DATA, { recursive: true });
      await fs.writeFile(path.join(DATA, id + '.json'), JSON.stringify(obj), 'utf8');
      return json(res, 200, { id });
    }
    if(u.pathname === '/api/data/list'){
      let names = [];
      try { names = (await fs.readdir(DATA)).filter(n => n.endsWith('.json')); } catch(_){ return json(res, 200, []); }
      const out = [];
      for(const n of names.sort().reverse()){
        try { const st = await fs.stat(path.join(DATA, n)); const j = JSON.parse(await fs.readFile(path.join(DATA, n), 'utf8'));
          out.push({ id: j.id || n.replace(/\.json$/, ''), name: j.name || n, desc: j.desc || '', savedAt: j.savedAt || '', size: st.size }); } catch(_){}
      }
      return json(res, 200, out);
    }
    if(u.pathname === '/api/data/get'){
      const id = u.searchParams.get('id'); const abs = within(DATA, (id || '') + '.json');
      if(!abs) return json(res, 400, { error: 'bad id' });
      const txt = await fs.readFile(abs, 'utf8').catch(() => null);
      if(txt == null) return json(res, 404, { error: 'нет такого' });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(txt); return;
    }
    if(u.pathname === '/api/data/delete' && req.method === 'POST'){
      const b = await readBody(req); const abs = within(DATA, (b.id || '') + '.json');
      if(!abs) return json(res, 400, { error: 'bad id' });
      await fs.unlink(abs).catch(() => {});
      return json(res, 200, { ok: true });
    }

    // удалить шаблон
    if(u.pathname === '/api/delete' && req.method === 'POST'){
      const b = await readBody(req);
      const file = await fileForId(b.id);
      if(!file) return json(res, 404, { error: 'нет такого шаблона' });
      await fs.unlink(path.join(TEMPLATES, file));
      return json(res, 200, { ok: true });
    }

    const rel = u.pathname === '/' ? 'index.html' : u.pathname;
    const abs = within(PUBLIC, rel);
    if(!abs) return json(res, 400, { error: 'bad path' });
    const data = await fs.readFile(abs).catch(() => null);
    if(data == null) return json(res, 404, { error: 'not found' });
    // no-store: иначе браузер показывает старый app.js/style.css после правок
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch(e){ json(res, 500, { error: String(e && e.message || e) }); }
});

server.listen(PORT, () => {
  console.log(`Лаборатория кода: http://localhost:${PORT}/`);
  console.log(`Шаблоны: ${TEMPLATES}  (можно добавлять со страницы или класть .json руками)`);
});
