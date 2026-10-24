// Рабочая папка проекта: открыть и править СВОИ файлы на диске прямо из лаборатории.
// Сервер слушает только 127.0.0.1, поэтому доступ к папке есть только у вас, но всё равно:
//   • ничего за пределами выбранной папки (проверяются «..», абсолютные пути и символические ссылки);
//   • .git не трогаем; удаление — в корзину .codelab-trash внутри папки, не насовсем;
//   • переводы строк (CRLF) и BOM сохраняются, чтобы правка не превращалась в «изменились все строки»;
//   • запись отказывается, если файл изменили снаружи после того, как вы его открыли (409), пока не скажете force.
//
// Подключение в сервер — одна строка (см. WORKSPACE-PATCHES.md):
//   if(await handleWorkspace(req, res, u, { readBody, json, root: ROOT })) return;

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { langForExt } from './lang.mjs';

const MAX_FILE = 2 * 1024 * 1024;      // больше — не открываем в редакторе
const MAX_ENTRIES = 4000;
const MAX_DEPTH = 10;
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.codelab-trash', '.venv', 'dist', 'build']);
const TEXT_EXT = /\.(js|mjs|cjs|jsx|ts|tsx|css|scss|html?|svg|json|md|txt|py|rb|php|go|lua|sh|bash|ps1|r|sql|xml|yml|yaml|toml|ini|csv|vue|svelte)$/i;

const states = new Map();   // root приложения → { cfgPath, cfg }

async function state(appRoot){
  let s = states.get(appRoot);
  if(s) return s;
  const cfgPath = path.join(appRoot, 'workspace.json');
  let cfg = {};
  try { cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8')); } catch(_){}
  s = { cfgPath, cfg: { root: cfg.root || path.join(appRoot, 'workspace'), recent: Array.isArray(cfg.recent) ? cfg.recent : [] }, defaultRoot: path.join(appRoot, 'workspace') };
  states.set(appRoot, s);
  return s;
}
const persist = s => fs.writeFile(s.cfgPath, JSON.stringify(s.cfg, null, 2) + '\n', 'utf8').catch(() => {});

class HttpError extends Error { constructor(code, msg, extra){ super(msg); this.code = code; this.extra = extra || {}; } }

// относительный путь (с «/») → абсолютный внутри корня; бросает HttpError, если выходит наружу
async function resolveIn(root, rel, { mustExist = false } = {}){
  const r = String(rel == null ? '' : rel).replace(/\\/g, '/').replace(/^\/+/, '');
  if(/(^|\/)\.\.(\/|$)/.test(r) || /^[a-zA-Z]:/.test(r) || r.includes('\0')) throw new HttpError(400, 'недопустимый путь');
  const abs = path.resolve(root, r);
  if(abs !== root && !abs.startsWith(root + path.sep)) throw new HttpError(400, 'путь вне рабочей папки');
  const parts = path.relative(root, abs).split(path.sep);
  if(parts[0] === '.git' || parts.includes('.git')) throw new HttpError(403, 'в .git писать нельзя');
  // символические ссылки: ближайший существующий предок должен остаться внутри корня
  let probe = abs;
  for(;;){
    try { const real = await fs.realpath(probe); const realRoot = await fs.realpath(root); if(real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new HttpError(403, 'ссылка выводит за пределы рабочей папки'); break; }
    catch(e){ if(e instanceof HttpError) throw e; if(probe === root) break; probe = path.dirname(probe); }
  }
  if(mustExist){ try { await fs.access(abs); } catch(_){ throw new HttpError(404, 'нет такого файла'); } }
  return abs;
}

const toRel = (root, abs) => path.relative(root, abs).split(path.sep).join('/');

async function walk(root){
  const out = []; let truncated = false;
  async function rec(dir, depth){
    let names; try { names = await fs.readdir(dir, { withFileTypes: true }); } catch(_){ return; }
    names.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name, 'ru'));
    for(const d of names){
      if(out.length >= MAX_ENTRIES){ truncated = true; return; }
      if(d.name === '.DS_Store' || d.name === 'Thumbs.db') continue;
      const abs = path.join(dir, d.name);
      if(d.isDirectory()){
        if(SKIP_DIRS.has(d.name)) continue;
        out.push({ path: toRel(root, abs), type: 'dir' });
        if(depth < MAX_DEPTH) await rec(abs, depth + 1);
      } else if(d.isFile()){
        let st; try { st = await fs.stat(abs); } catch(_){ continue; }
        out.push({ path: toRel(root, abs), type: 'file', size: st.size, text: TEXT_EXT.test(d.name) && st.size <= MAX_FILE });
      }
    }
  }
  await rec(root, 0);
  return { entries: out, truncated };
}

function decode(buf){
  if(buf.includes(0)) throw new HttpError(415, 'похоже на двоичный файл — в редакторе не открывается');
  let text = buf.toString('utf8'), bom = false;
  if(text.charCodeAt(0) === 0xFEFF){ bom = true; text = text.slice(1); }
  const crlf = (text.match(/\r\n/g) || []).length, lf = (text.match(/(^|[^\r])\n/g) || []).length;
  const eol = crlf > 0 && crlf >= lf ? 'crlf' : 'lf';
  if(eol === 'crlf') text = text.replace(/\r\n/g, '\n');
  return { text, bom, eol };
}
const encode = (text, eol, bom) => {
  let t = String(text).replace(/\r\n/g, '\n');
  if(eol === 'crlf') t = t.replace(/\n/g, '\r\n');
  return (bom ? '\uFEFF' : '') + t;
};

async function writeAtomic(abs, data){
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = abs + '.' + process.pid + '.tmp';
  await fs.writeFile(tmp, data, 'utf8');
  await fs.rename(tmp, abs);
}

const langOf = name => langForExt(path.extname(name)) || 'txt';

export async function handleWorkspace(req, res, u, { readBody, json, root: appRoot }){
  if(!u.pathname.startsWith('/api/ws/')) return false;
  const s = await state(appRoot);
  const send = (code, obj) => { json(res, code, obj); return true; };
  try {
    const route = u.pathname.slice('/api/ws/'.length);

    if(route === 'info' && req.method === 'GET'){
      let exists = true; try { await fs.access(s.cfg.root); } catch(_){ exists = false; }
      return send(200, { root: s.cfg.root, exists, defaultRoot: s.defaultRoot, recent: s.cfg.recent });
    }

    if(route === 'root' && req.method === 'POST'){
      const b = await readBody(req);
      const p = path.resolve(String(b.path || '').trim().replace(/^"(.*)"$/, '$1'));
      if(!b.path || !path.isAbsolute(String(b.path).trim().replace(/^"(.*)"$/, '$1'))) throw new HttpError(400, 'нужен полный путь к папке, например C:\\проекты\\сайт или /home/me/site');
      let st; try { st = await fs.stat(p); } catch(_){
        if(b.create){ await fs.mkdir(p, { recursive: true }); st = await fs.stat(p); } else throw new HttpError(404, 'такой папки нет');
      }
      if(!st.isDirectory()) throw new HttpError(400, 'это файл, а не папка');
      s.cfg.root = p;
      s.cfg.recent = [p, ...s.cfg.recent.filter(x => x !== p)].slice(0, 8);
      await persist(s);
      return send(200, { ok: true, root: p });
    }

    const root = path.resolve(s.cfg.root);
    if(route !== 'info' && route !== 'root'){
      try { await fs.access(root); } catch(_){
        if(root === path.resolve(s.defaultRoot)) await fs.mkdir(root, { recursive: true });
        else throw new HttpError(404, 'рабочая папка не найдена: ' + root);
      }
    }

    if(route === 'tree' && req.method === 'GET'){
      const { entries, truncated } = await walk(root);
      return send(200, { root, entries, truncated });
    }

    if(route === 'file' && req.method === 'GET'){
      const abs = await resolveIn(root, u.searchParams.get('path'), { mustExist: true });
      const st = await fs.stat(abs);
      if(!st.isFile()) throw new HttpError(400, 'это папка');
      if(st.size > MAX_FILE) throw new HttpError(413, 'файл больше 2 МБ — в редакторе не открываем');
      const d = decode(await fs.readFile(abs));
      return send(200, { path: toRel(root, abs), name: path.basename(abs), lang: langOf(abs), text: d.text, eol: d.eol, bom: d.bom, mtime: st.mtimeMs, size: st.size });
    }

    if(route === 'save' && req.method === 'POST'){
      const b = await readBody(req);
      const abs = await resolveIn(root, b.path);
      if(abs === root) throw new HttpError(400, 'не указан файл');
      let st = null; try { st = await fs.stat(abs); } catch(_){}
      if(st && st.isDirectory()) throw new HttpError(400, 'это папка');
      if(st && b.mtime != null && !b.force && st.mtimeMs > Number(b.mtime) + 1)
        throw new HttpError(409, 'файл изменили снаружи после открытия', { conflict: true, mtime: st.mtimeMs });
      if(Buffer.byteLength(String(b.text || '')) > MAX_FILE * 2) throw new HttpError(413, 'слишком большой текст');
      let eol = b.eol, bom = !!b.bom;
      if(!st && !eol) eol = 'lf';
      if(st && !b.eol){ try { const d = decode(await fs.readFile(abs)); eol = d.eol; bom = d.bom; } catch(_){ eol = 'lf'; } }
      await writeAtomic(abs, encode(b.text || '', eol, bom));
      const ns = await fs.stat(abs);
      return send(200, { ok: true, path: toRel(root, abs), mtime: ns.mtimeMs, size: ns.size, created: !st });
    }

    if(route === 'create' && req.method === 'POST'){
      const b = await readBody(req);
      const abs = await resolveIn(root, b.path);
      if(abs === root) throw new HttpError(400, 'не указано имя');
      try { await fs.access(abs); throw new HttpError(409, 'такой файл или папка уже есть'); } catch(e){ if(e instanceof HttpError) throw e; }
      if(b.dir) await fs.mkdir(abs, { recursive: true }); else await writeAtomic(abs, b.text || '');
      return send(200, { ok: true, path: toRel(root, abs) });
    }

    if(route === 'rename' && req.method === 'POST'){
      const b = await readBody(req);
      const from = await resolveIn(root, b.from, { mustExist: true }), to = await resolveIn(root, b.to);
      if(from === root || to === root) throw new HttpError(400, 'нельзя');
      try { await fs.access(to); throw new HttpError(409, 'такое имя уже занято'); } catch(e){ if(e instanceof HttpError) throw e; }
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.rename(from, to);
      return send(200, { ok: true, path: toRel(root, to) });
    }

    if(route === 'delete' && req.method === 'POST'){
      const b = await readBody(req);
      const abs = await resolveIn(root, b.path, { mustExist: true });
      if(abs === root) throw new HttpError(400, 'нельзя удалить рабочую папку');
      const trash = path.join(root, '.codelab-trash');
      await fs.mkdir(trash, { recursive: true });
      const dest = path.join(trash, Date.now().toString(36) + '-' + path.basename(abs));
      await fs.rename(abs, dest);
      return send(200, { ok: true, trash: toRel(root, dest) });
    }

    return send(404, { error: 'нет такого маршрута: ' + u.pathname });
  } catch(e){
    if(e instanceof HttpError) return send(e.code, { error: e.message, ...e.extra });
    return send(500, { error: 'ошибка рабочей папки: ' + (e && e.message || e) });
  }
}
