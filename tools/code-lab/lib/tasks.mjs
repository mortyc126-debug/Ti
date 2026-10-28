// «Задачи» — деревья решений поверх кусков библиотеки: вопрос → варианты → кусок / другая задача / свой код.
// Хранятся отдельными JSON в tasks/ (стабильно для git, правятся и руками). Формат текста — public/tasks-format.js.
// Здесь: хранилище, привязка ссылок «кусок: Название» к id и подсказки «что дальше» по контрактам кусков.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const TaskFormat = require('../public/tasks-format.js');

const MAX_DEPTH = 12, MAX_STEPS = 400;
const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const str = (v, n) => String(v == null ? '' : v).slice(0, n);

// чистим присланное дерево: только известные поля, ограничения по размеру и глубине
export function cleanTask(t){
  let count = 0;
  const cleanSteps = (list, depth) => {
    if(!Array.isArray(list) || depth > MAX_DEPTH) return [];
    const out = [];
    for(const st of list){
      if(!st || typeof st !== 'object' || ++count > MAX_STEPS) continue;
      const options = (Array.isArray(st.options) ? st.options : []).slice(0, 30).map(o => ({
        label: str(o && o.label, 160),
        kind: ['piece', 'task', 'code', 'skip'].includes(o && o.kind) ? o.kind : '',
        ref: str(o && o.ref, 200), id: str(o && o.id, 200),
        note: str(o && o.note, 1500), code: str(o && o.code, 20000), lang: str(o && o.lang, 20).toLowerCase(),
        steps: cleanSteps(o && o.steps, depth + 1)
      }));
      out.push({ q: str(st.q, 300), hint: str(st.hint, 1500), auto: !!st.auto, options });
    }
    return out;
  };
  return {
    id: str(t.id, 120), title: str(t.title || 'Задача', 160), lang: str(t.lang, 20).toLowerCase(), group: str(t.group, 120),
    desc: str(t.desc, 3000), aliases: (Array.isArray(t.aliases) ? t.aliases : []).map(a => str(a, 80)).filter(Boolean).slice(0, 40),
    steps: cleanSteps(t.steps, 0)
  };
}

export function createTaskStore({ root, rows, slug, createPiece }){
  const fileOf = id => path.join(root, id + '.json');
  const okId = id => /^[\p{L}\p{N}_.-]+$/u.test(String(id || '')) && !String(id).includes('..');

  async function list(){
    let names = []; try { names = (await fs.readdir(root)).filter(n => n.endsWith('.json')); } catch(_){ return []; }
    const out = [];
    for(const n of names.sort()){
      try {
        const t = JSON.parse(await fs.readFile(path.join(root, n), 'utf8'));
        const s = TaskFormat.stats(t);
        out.push({ id: t.id || n.slice(0, -5), title: t.title || '', lang: t.lang || '', group: t.group || '', desc: t.desc || '', aliases: t.aliases || [], savedAt: t.savedAt || 0, ...s });
      } catch(_){}
    }
    return out;
  }
  async function get(id){
    if(!okId(id)) return null;
    try { return JSON.parse(await fs.readFile(fileOf(id), 'utf8')); } catch(_){ return null; }
  }
  async function remove(id){ if(!okId(id)) return false; await fs.unlink(fileOf(id)).catch(() => {}); return true; }

  // ссылка «кусок: X» → id куска: id:…, точный id, точное название (свой язык первым), название без знаков
  function pieceResolver(all, lang){
    const byId = new Map(all.map(r => [r.id, r]));
    const byTitle = new Map(), byNorm = new Map();
    const put = (m, k, r) => { if(!k) return; const a = m.get(k) || []; a.push(r); m.set(k, a); };
    for(const r of all){ put(byTitle, String(r.title || '').trim().toLowerCase(), r); put(byNorm, norm(r.title), r); }
    const pick = arr => !arr || !arr.length ? null : (arr.find(r => r.lang === lang) || arr[0]);
    return ref => {
      let s = String(ref || '').trim(); if(!s) return null;
      const mid = s.match(/^id\s*:\s*(.+)$/i); if(mid) s = mid[1].trim();
      if(byId.has(s)) return byId.get(s);
      return pick(byTitle.get(s.toLowerCase())) || pick(byNorm.get(norm(s)));
    };
  }

  // привязать все ссылки дерева; варианты «код» превращаются в куски библиотеки (там контракт и поиск)
  async function resolve(task, { createCode = true, tasksIndex = null } = {}){
    const all = await rows();
    const findPiece = pieceResolver(all, task.lang);
    const tIndex = tasksIndex || await list();
    const tById = new Map(tIndex.map(t => [t.id, t])), tByNorm = new Map(tIndex.map(t => [norm(t.title), t]));
    const report = { linked: 0, created: 0, unresolved: [] };
    const jobs = [];
    TaskFormat.eachOption(task.steps, o => jobs.push(o));
    for(const o of jobs){
      if(o.kind === 'piece'){
        const hit = (o.id && all.find(r => r.id === o.id)) || findPiece(o.ref);
        if(hit){ o.id = hit.id; o.ref = hit.title || hit.id; report.linked++; } else { o.id = ''; report.unresolved.push({ kind: 'piece', ref: o.ref, label: o.label }); }
      } else if(o.kind === 'task'){
        const s = String(o.ref || '').replace(/^id\s*:\s*/i, '').trim();
        const hit = tById.get(o.id) || tById.get(s) || tByNorm.get(norm(s));
        if(hit && hit.id !== task.id){ o.id = hit.id; o.ref = hit.title; report.linked++; } else { o.id = ''; report.unresolved.push({ kind: 'task', ref: o.ref, label: o.label }); }
      } else if(o.kind === 'code' && createCode && String(o.code || '').trim() && createPiece){
        const lang = o.lang || task.lang || 'js';
        const title = (task.title + ': ' + (o.label || 'вариант')).slice(0, 80);
        const r = await createPiece({ title, lang, code: o.code, group: task.group || 'Задачи', desc: o.note || '' });
        if(r && r.id){ o.kind = 'piece'; o.id = r.id; o.ref = r.title || title; o.code = ''; o.lang = ''; if(r.created) report.created++; else report.linked++; }
      }
    }
    return report;
  }

  async function save(input, opts = {}){
    const t = cleanTask(input);
    if(!t.id || !okId(t.id)) t.id = slug(t.title || 'задача');
    const report = await resolve(t, opts);
    t.savedAt = Date.now();
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(fileOf(t.id), JSON.stringify(t, null, 2), 'utf8');
    return { task: t, report };
  }

  // пачка текстом: одноимённая задача обновляется (не плодим двойники), остальные создаются
  async function importText(text, { dry = false } = {}){
    const { tasks, warnings } = TaskFormat.parse(text);
    const existing = await list();
    const byNorm = new Map(existing.map(t => [norm(t.title), t]));
    const out = [];
    // сначала id всем — чтобы задачи пачки могли ссылаться друг на друга
    for(const t of tasks){ const old = byNorm.get(norm(t.title)); t.id = old ? old.id : slug(t.title); t._new = !old; }
    const index = existing.concat(tasks.filter(t => t._new).map(t => ({ id: t.id, title: t.title })));
    for(const t of tasks){
      const isNew = t._new; delete t._new;
      if(dry){ const c = cleanTask(t); const report = await resolve(c, { createCode: false, tasksIndex: index }); out.push({ id: c.id, title: c.title, isNew, report, stats: TaskFormat.stats(c), task: c }); continue; }
      const { task, report } = await save(t, { tasksIndex: index });
      out.push({ id: task.id, title: task.title, isNew, report, stats: TaskFormat.stats(task) });
    }
    return { ok: true, dry, tasks: out, warnings };
  }

  // текст задачи для правки: ссылки пишем названием, а если название неоднозначно — id:…
  async function toText(task){
    const all = await rows();
    const cnt = new Map(); for(const r of all){ const k = String(r.title || '').trim().toLowerCase(); cnt.set(k, (cnt.get(k) || 0) + 1); }
    const tl = await list(); const tTitle = new Map(tl.map(t => [t.id, t.title]));
    return TaskFormat.serialize(task, o => {
      if(o.kind === 'task') return o.id ? (tTitle.get(o.id) || o.ref || o.id) : (o.ref || '');
      if(!o.id) return o.ref || '';
      const r = all.find(x => x.id === o.id); const title = r ? r.title : o.ref;
      return title && cnt.get(String(title).trim().toLowerCase()) === 1 ? title : 'id:' + o.id;
    });
  }

  // где упоминается кусок/задача (для «используется в задачах»)
  async function usedBy(id){
    const out = [];
    for(const t of await list()){
      const full = await get(t.id); if(!full) continue;
      let hit = false; TaskFormat.eachOption(full.steps, o => { if(o.id === id) hit = true; });
      if(hit) out.push({ id: t.id, title: t.title });
    }
    return out;
  }

  return { list, get, save, remove, importText, toText, resolve, usedBy, parseText: TaskFormat.parse };
}

// «Что дальше» по контрактам: какие имена код использует, но нигде не получает,
// и какие куски/задачи их дают. files — все открытые файлы (HTML даёт #id для JS и т. п.).
export function suggestNext({ files, contract, contractLangs, rows, tasks }){
  const provided = new Set(), perFile = [];
  for(const f of files || []){
    const lang = String(f.lang || '').toLowerCase();
    if(!contractLangs.has(lang)){ perFile.push({ name: f.name || '', lang, provides: [], requires: [] }); continue; }
    const c = contract(String(f.code || ''), lang);
    c.provides.forEach(p => provided.add(p));
    perFile.push({ name: f.name || '', lang, provides: c.provides, requires: c.requires });
  }
  const unmet = [];
  const seen = new Set();
  for(const f of perFile) for(const r of f.requires){ if(provided.has(r) || seen.has(r)) continue; seen.add(r); unmet.push({ name: r, file: f.name, lang: f.lang }); }

  // индекс «имя → куски, которые его дают». Короткие общие имена (i, x, data) — шум, их не предлагаем
  const GENERIC = new Set(['i', 'j', 'k', 'x', 'y', 'e', 'el', 'data', 'res', 'result', 'value', 'item', 'items', 'list', 'obj', 'arr', 'n', 'a', 'b', 'key', 'text']);
  const giving = new Map();
  for(const r of rows){ const p = r.comp && r.comp.provides; if(!Array.isArray(p) || p.length > 12) continue;
    for(const nm of p){ const a = giving.get(nm) || []; if(a.length < 40) a.push(r); giving.set(nm, a); } }
  const pieceTask = new Map();   // кусок → задачи, где он вариант
  for(const t of tasks || []) TaskFormat.eachOption(t.steps, o => { if(o.kind === 'piece' && o.id){ const a = pieceTask.get(o.id) || []; if(!a.find(x => x.id === t.id)) a.push({ id: t.id, title: t.title }); pieceTask.set(o.id, a); } });

  for(const u of unmet){
    if(GENERIC.has(u.name) || u.name.length < 2){ u.pieces = []; u.tasks = []; u.generic = true; continue; }
    const cand = (giving.get(u.name) || []).slice().sort((a, b) =>
      (b.lang === u.lang) - (a.lang === u.lang) || ((a.comp.requires || []).length - (b.comp.requires || []).length) || (a.nlines || 0) - (b.nlines || 0));
    u.pieces = cand.slice(0, 6).map(r => ({ id: r.id, title: r.title, lang: r.lang, needs: (r.comp.requires || []).slice(0, 6) }));
    const tk = new Map(); for(const r of cand) for(const t of pieceTask.get(r.id) || []) tk.set(t.id, t);
    u.tasks = [...tk.values()].slice(0, 4);
  }
  return { provided: [...provided].slice(0, 200), unmet, files: perFile };
}
