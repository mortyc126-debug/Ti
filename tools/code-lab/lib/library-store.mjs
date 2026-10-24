// Файловое хранилище библиотеки «Лаборатории кода».
//
//   library/<язык>/<id>.<расширение>          — код, обычный текст: открывается чем угодно
//   library/<язык>/<id>.<расширение>.meta.json — описание, раздел, теги, пояснения слов
//
// Код — источник правды. Подсветка и пояснения слов строятся из текста при каждой загрузке,
// поэтому правка файла в любом редакторе сразу видна в лаборатории. Пояснения слов хранятся
// с позицией (строка, смещение) и после правки кода пытаются встать на то же слово;
// если слово исчезло, пояснение не теряется, а откладывается в orphanNotes.
//
// Положили файл кода в library/ руками, без .meta.json — он тоже появится в списке
// (описание пустое, статус needs_description); метафайл создастся при первом сохранении.
//
// Объект, который отдаёт get(), совместим со старым форматом шаблона (id, lang, group, title,
// desc, lines, output, descAt, component), поэтому интерфейс менять не нужно.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tokenize } from './tokenizer.mjs';
import { annotateLines, makeLook } from './annotate.mjs';
import { extFor, langForExt, CODE_EXTS, safeName } from './lang.mjs';
import { tokText, codeFromLines, migrateTemplates } from './migrate.mjs';

const META_SUFFIX = '.meta.json';
const normCode = s => String(s == null ? '' : s).replace(/\r\n?/g, '\n').trim();

// смещения токенов в строке
function colsOf(line){ const cols = []; let c = 0; for(const t of line){ cols.push(c); c += tokText(t).length; } return cols; }

// Привязать пояснения к токенам. onlyEmpty — не трогать токены, у которых e уже есть.
// Возвращает пояснения, которым не нашлось места.
function placeNotes(lines, notes, look, { onlyEmpty = true } = {}){
  const unplaced = [];
  const cols = lines.map(colsOf);
  for(const n of (notes || [])){
    if(!n || typeof n.text !== 'string' || typeof n.note !== 'string') continue;
    const note = n.note;   // показываем сохранённое как есть; словарь подставляется только там, где пояснения нет
    let tok = null;
    const tryLine = li => {
      const line = lines[li]; if(!line) return null;
      let best = -1, bd = Infinity;
      for(let i = 0; i < line.length; i++){
        if(tokText(line[i]) !== n.text) continue;
        if(onlyEmpty && line[i].e !== undefined) continue;
        const d = Math.abs(cols[li][i] - (n.col || 0)); if(d < bd){ bd = d; best = i; }
      }
      return best >= 0 ? line[best] : null;
    };
    tok = tryLine(n.line);
    // составной токен прежней разметки («>=», «++», «@media») теперь режется иначе: ставим на его первую часть
    if(!tok && lines[n.line]){
      const li = n.line, line = lines[li];
      for(let i = 0; i < line.length && !tok; i++){
        const tx = tokText(line[i]);
        if(cols[li][i] === (n.col || 0) && tx && tx !== n.text && n.text.startsWith(tx) && !(onlyEmpty && line[i].e !== undefined)) tok = line[i];
      }
    }
    // слово уехало на другую строку (код правили снаружи): ближайшее вхождение, только для своих пояснений
    if(!tok && n.source !== 'dict'){
      const reach = lines.length + Math.abs(n.line || 0);   // заметка могла быть ниже, чем строк в новом коде
      for(let d = 1; d <= reach && !tok; d++){ tok = tryLine(n.line - d) || tryLine(n.line + d); }
    }
    if(tok) tok.e = note; else if(n.source !== 'dict') unplaced.push(n);
  }
  return unplaced;
}

export function createLibraryStore({ root, legacyDir = null, dictPath = null, getDict, coverage = () => ({}) }){
  const byPath = new Map();   // путь кода → запись
  let byId = new Map();
  let version = 0, lastScan = 0, dirty = true;
  let lock = Promise.resolve();
  const withLock = fn => { const p = lock.then(fn, fn); lock = p.catch(() => {}); return p; };

  const dictOf = async () => { try { return (getDict && await getDict()) || {}; } catch(_){ return {}; } };

  async function walk(dir, out){
    let list; try { list = await fs.readdir(dir, { withFileTypes: true }); } catch(_){ return; }
    for(const d of list){
      if(d.name.startsWith('_') || d.name.startsWith('.')) continue;
      const p = path.join(dir, d.name);
      if(d.isDirectory()) await walk(p, out); else out.push(p);
    }
  }
  const extOf = p => path.extname(p).replace(/^\./, '').toLowerCase();
  const mtime = p => fs.stat(p).then(s => s.mtimeMs, () => null);

  function defaultMeta(codePath, id){
    const rel = path.relative(root, path.dirname(codePath)).split(path.sep).filter(Boolean);
    const lang = langForExt(extOf(codePath)) || rel[0] || 'txt';
    return {
      schema: 1, id, file: path.basename(codePath),
      title: id.replace(/[-_]+/g, ' ').trim() || id, lang, group: rel.length > 1 ? rel.slice(1).join(' / ') : 'Мои файлы',
      desc: '', output: '', tags: [], aliases: [],
      source: { title: null, desc: null, tags: null }, status: 'needs_description', wordNotes: []
    };
  }

  function buildRow(e){
    const m = e.meta, j = m.component;
    const nlines = e.code.replace(/\r\n?/g, '\n').split('\n').filter(l => l.trim()).length;
    const row = {
      id: e.id, lang: e.lang, group: m.group || 'Разное', title: m.title || e.id, desc: m.desc || '',
      descAt: m.descAt != null ? m.descAt : ((m.legacy && m.legacy.descAt) || 0),
      file: path.basename(e.codePath), nlines, cov: coverage({ component: j, _code: e.code }),
      tags: Array.isArray(m.tags) ? m.tags : [], aliases: Array.isArray(m.aliases) ? m.aliases : [], status: m.status || ''
    };
    if(j){
      row.comp = { type: j.type || '', tags: j.tags || {}, subcat: j.subcat || '', collections: Array.isArray(j.collections) ? j.collections : [], input: (j.summary && j.summary.input) || '', output: (j.summary && j.summary.output) || '', provides: Array.isArray(j.provides) ? j.provides : [], requires: Array.isArray(j.requires) ? j.requires : [] };
    }
    return row;
  }

  async function scan(force){
    if(!force && !dirty && Date.now() - lastScan < 1000) return;
    const files = []; await walk(root, files);
    const set = new Set(files);
    const seen = new Set(); let changed = false;
    for(const f of files){
      if(f.endsWith(META_SUFFIX)) continue;
      if(!CODE_EXTS.has(extOf(f))) continue;
      seen.add(f);
      const metaPath = f + META_SUFFIX, hasMeta = set.has(metaPath);
      const cm = await mtime(f), mm = hasMeta ? await mtime(metaPath) : null;
      const old = byPath.get(f);
      if(old && old.codeMtime === cm && old.metaMtime === mm) continue;
      let code; try { code = await fs.readFile(f, 'utf8'); } catch(_){ continue; }
      let meta = null;
      if(hasMeta){ try { meta = JSON.parse(await fs.readFile(metaPath, 'utf8')); } catch(_){ meta = null; } }
      const base = path.basename(f).replace(/\.[^.]+$/, '');
      const id = String((meta && meta.id) || base);
      const virtual = !meta;
      if(!meta) meta = defaultMeta(f, id);
      const lang = String(meta.lang || langForExt(extOf(f)) || 'txt').toLowerCase();
      const e = { id, codePath: f, metaPath, hasMeta, codeMtime: cm, metaMtime: mm, code, meta, lang, virtual };
      e.row = buildRow(e);
      byPath.set(f, e); changed = true;
    }
    for(const p of [...byPath.keys()]){ if(!seen.has(p)){ byPath.delete(p); changed = true; } }
    if(changed || force || !byId.size){
      const m = new Map();
      for(const e of [...byPath.values()].sort((a, b) => (a.codePath < b.codePath ? -1 : 1))){
        let id = e.id; if(m.has(id)){ id = id + '~' + e.lang; let k = 2; while(m.has(id)) id = e.id + '~' + e.lang + k++; e.id = id; e.row.id = id; }
        m.set(id, e);
      }
      byId = m;
      if(changed) version++;
    }
    dirty = false; lastScan = Date.now();
  }

  async function toTemplate(e){
    const dict = await dictOf();
    const m = e.meta;
    const lines = tokenize(e.code, e.lang);
    placeNotes(lines, m.wordNotes, makeLook(e.lang, dict), { onlyEmpty: true });
    annotateLines(lines, e.lang, dict, true);
    const obj = { id: e.id, lang: e.lang, group: m.group || '', title: m.title || e.id, desc: m.desc || '', lines, output: m.output || '' };
    const descAt = m.descAt != null ? m.descAt : (m.legacy && m.legacy.descAt);
    if(descAt != null) obj.descAt = descAt;
    if(m.component) obj.component = m.component;
    if(m.legacy && m.legacy.summary != null) obj.summary = m.legacy.summary;
    obj.tags = Array.isArray(m.tags) ? m.tags : [];
    obj.aliases = Array.isArray(m.aliases) ? m.aliases : [];
    obj.source = m.source || {};
    obj.status = m.status || '';
    return obj;
  }

  async function writeAtomic(p, text){
    await fs.mkdir(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp-' + process.pid + '-' + Date.now().toString(36);
    await fs.writeFile(tmp, text, 'utf8'); await fs.rename(tmp, p);
  }

  const api = {
    root,
    get version(){ return version; },

    async init(){
      await fs.mkdir(root, { recursive: true });
      await scan(true);
      let migrated = null;
      if(!byId.size && legacyDir){
        migrated = await migrateTemplates({ src: legacyDir, out: root, dictPath });
        if(migrated.created) await scan(true);
      }
      return { count: byId.size, migrated };
    },

    // принудительно перечитать папку (по умолчанию изменения подхватываются не чаще раза в секунду)
    async refresh(){ await scan(true); },
    // то же, но не чаще раза в секунду (для частых запросов, например поиска)
    async sync(){ await scan(); },
    async rows(){ await scan(); return [...byId.values()].map(e => e.row).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); },
    async has(id){ await scan(); return byId.has(id); },
    async get(id){ await scan(); const e = byId.get(id); return e ? toTemplate(e) : null; },
    // для дедупа и поиска: id, язык, название, код
    async entries(){ await scan(); return [...byId.values()].map(e => ({ id: e.id, lang: e.lang, title: e.meta.title || e.id, code: e.code, meta: e.meta })); },
    async count(){ await scan(); return byId.size; },

    // Документы для поискового индекса (с пояснениями слов, в том числе из словаря)
    async docs(){
      await scan();
      const out = [];
      for(const e of byId.values()){
        const t = await toTemplate(e);
        const notes = []; for(const l of t.lines) for(const k of l) if(k.e) notes.push(k.e);
        const c = e.meta.component || {};
        out.push({
          id: e.id, lang: e.lang, title: t.title, desc: t.desc, group: t.group, output: t.output,
          tags: t.tags, aliases: t.aliases, code: e.code, notes,
          extra: [(c.summary && c.summary.input) || '', (c.summary && c.summary.output) || '', ...(c.provides || []), ...(c.requires || []), ...(c.collections || [])]
        });
      }
      return out;
    },

    // Сохранить кусок (создать или обновить). obj — в старом формате шаблона (с lines).
    // origin — кто автор изменений: manual | imported | ai.
    save(obj, { origin = 'manual' } = {}){
      return withLock(async () => {
        await scan();
        const id = String(obj.id);
        const e = byId.get(id) || null;
        const dict = await dictOf();
        const lang = String(obj.lang || (e && e.lang) || 'js').toLowerCase();
        const ext = extFor(lang);
        const lines = Array.isArray(obj.lines) ? obj.lines : tokenize(String(obj.code || ''), lang);
        const code = codeFromLines(lines);
        const old = e ? e.meta : {};

        // куда писать
        let codePath;
        if(e && e.lang === lang) codePath = e.codePath;
        else {
          const dir = path.join(root, safeName(lang));
          codePath = path.join(dir, safeName(id) + '.' + ext);
          let k = 2; while(byPath.has(codePath) && !(e && e.codePath === codePath)) codePath = path.join(dir, safeName(id) + '-' + (k++) + '.' + ext);
        }
        const metaPath = codePath + META_SUFFIX;

        // прежние пояснения встают на новый код (если у токена нет своего)
        const look = makeLook(lang, dict);
        const oldNotes = [...(old.wordNotes || []).filter(n => n.source !== 'dict' && n.note), ...(old.orphanNotes || [])];
        const unplaced = placeNotes(lines, oldNotes, look, { onlyEmpty: true });
        const notes = [];
        lines.forEach((line, li) => {
          let col = 0;
          for(const t of line){
            const text = tokText(t);
            if(t.e != null){ const note = String(t.e); notes.push({ line: li, col, text, kind: t.k, note, source: look(text) === note ? 'dict' : 'custom' }); }
            col += text.length;
          }
        });

        const meta = { ...old };
        meta.schema = 1; meta.id = id; meta.file = path.basename(codePath); meta.lang = lang;
        const nv = (k, def) => (obj[k] != null ? obj[k] : (old[k] != null ? old[k] : def));
        meta.title = nv('title', id); meta.group = nv('group', ''); meta.desc = nv('desc', ''); meta.output = nv('output', '');
        if(obj.descAt != null) meta.descAt = obj.descAt;
        if('component' in obj && obj.component) meta.component = obj.component;
        if(Array.isArray(obj.tags)) meta.tags = obj.tags.map(String); else if(!Array.isArray(meta.tags)) meta.tags = [];
        if(Array.isArray(obj.aliases)) meta.aliases = obj.aliases.map(String); else if(!Array.isArray(meta.aliases)) meta.aliases = [];
        const src = { title: null, desc: null, tags: null, ...(old.source || {}) };
        if(!e || meta.title !== (old.title || '')) src.title = origin;
        if((meta.desc || '') !== (old.desc || '') && meta.desc) src.desc = origin;
        if(JSON.stringify(meta.tags) !== JSON.stringify(old.tags || []) && meta.tags.length) src.tags = origin;
        meta.source = src;
        meta.status = String(meta.desc || '').trim() ? 'described' : 'needs_description';
        meta.wordNotes = notes;
        if(unplaced.length) meta.orphanNotes = unplaced.slice(0, 50); else delete meta.orphanNotes;
        if(obj.source && typeof obj.source === 'object' && !e) meta.source = { ...src, ...obj.source };

        await writeAtomic(codePath, code);
        await writeAtomic(metaPath, JSON.stringify(meta, null, 2) + '\n');
        if(e && e.codePath !== codePath){
          await fs.unlink(e.codePath).catch(() => {}); await fs.unlink(e.metaPath).catch(() => {});
          byPath.delete(e.codePath);
        }
        const cm = await mtime(codePath), mm = await mtime(metaPath);
        const ne = { id, codePath, metaPath, hasMeta: true, codeMtime: cm, metaMtime: mm, code, meta, lang, virtual: false };
        ne.row = buildRow(ne);
        byPath.set(codePath, ne); byId.set(id, ne); version++; dirty = true;
        return { id, codePath };
      });
    },

    remove(id){
      return withLock(async () => {
        await scan();
        const e = byId.get(id); if(!e) return false;
        await fs.unlink(e.codePath).catch(() => {}); await fs.unlink(e.metaPath).catch(() => {});
        byPath.delete(e.codePath); byId.delete(id); version++; dirty = true;
        return true;
      });
    },

    // Применить результат фонового ИИ-описания, не затрагивая код и ручные поля.
    async applyDescription(id, result, { origin = 'ai' } = {}) {
      return withLock(async () => {
        await scan();
        const e = byId.get(String(id));
        if (!e) throw new Error('Кусок не найден: ' + id);
        const meta = { ...e.meta, source: { ...(e.meta.source || {}) } };
        const rank = { ai: 1, imported: 2, manual: 3 };
        const shortDesc = String(meta.desc || '').trim().length < 60;
        const mayWrite = (field, value) => {
          const existing = meta[field];
          const author = meta.source[field];
          if (rank[author] > rank[origin]) return false;
          // Содержательное описание без метки автора защищено; короткое можно переписать.
          if (field === 'desc' && String(existing || '').trim() && !author && !shortDesc) return false;
          if (field === 'title' && String(existing || '').trim() && !author && existing !== id) return false;
          if (value == null || (typeof value === 'string' && !value.trim())) return false;
          meta[field] = value;
          meta.source[field] = origin;
          return true;
        };
        // Теги и синонимы только дополняем: ничего из существующего не удаляется.
        const addList = (field, values, max) => {
          if (!Array.isArray(values)) return;
          const cur = Array.isArray(meta[field]) ? meta[field] : [];
          const seen = new Set(cur.map(x => String(x).trim().toLowerCase()));
          const add = [];
          for (const x of values.map(v => String(v).trim()).filter(Boolean)) {
            const k = x.toLowerCase();
            if (!seen.has(k)) { seen.add(k); add.push(x); }
          }
          if (!add.length) return;
          meta[field] = [...cur, ...add].slice(0, max);
          if (!cur.length) meta.source[field] = origin;   // автора у уже существующего списка не меняем
        };
        mayWrite('title', typeof result.title === 'string' ? result.title.trim().slice(0, 120) : null);
        mayWrite('desc', typeof result.desc === 'string' ? result.desc.trim().slice(0, 1200) : null);
        addList('tags', result.tags, 40);
        addList('aliases', result.aliases, 40);
        meta.enriched = true;   // метка: ИИ уже прошёл по этому куску, автоподбор повторно не берёт
        meta.status = String(meta.desc || '').trim() ? 'described' : 'needs_description';
        await writeAtomic(e.metaPath, JSON.stringify(meta, null, 2) + '\n');
        e.meta = meta; e.metaMtime = await mtime(e.metaPath); e.row = buildRow(e); dirty = true; version++;
        return { id: e.id, status: meta.status, source: meta.source };
      });
    },

    // нормализованный код — для поиска дублей
    normCode
  };
  return api;
}
