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

export function createTaskStore({ root, rows, slug, createPiece, similarPieces }){
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

  // кандидаты — только для ненайденных ссылок: ничего не заменяют сами, человек выбирает кликом
  async function pieceCandidates(ref, lang){
    if(!similarPieces || !String(ref || '').trim()) return [];
    try {
      // одинаковые названия схлопываем: ссылка пишется названием, и выбор между двойниками ничего не меняет
      const seen = new Set(), out = [];
      for(const r of await similarPieces(String(ref).replace(/^id\s*:\s*/i, ''), lang)){ const k = String(r.title || '').trim().toLowerCase(); if(seen.has(k)) continue; seen.add(k); out.push({ id: r.id, title: r.title, lang: r.lang }); if(out.length === 3) break; }
      return out;
    } catch(_){ return []; }
  }
  function taskCandidates(ref, index){
    const words = norm(ref).split(' ').filter(w => w.length > 2);
    if(!words.length) return [];
    return index.map(t => { const tw = norm(t.title).split(' '); const n = words.filter(w => tw.some(x => x.startsWith(w.slice(0, Math.max(4, w.length - 2))))).length; return { t, n }; })
      .filter(x => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 3).map(x => ({ id: x.t.id, title: x.t.title }));
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
        // ИИ часто пишет «кусок:» с названием ЗАДАЧИ — точное совпадение с задачей превращаем в ссылку на неё
        const asTask = !hit && tByNorm.get(norm(String(o.ref || '').replace(/^id\s*:\s*/i, '')));
        if(hit){ o.id = hit.id; o.ref = hit.title || hit.id; report.linked++; }
        else if(asTask && asTask.id !== task.id){ o.kind = 'task'; o.id = asTask.id; o.ref = asTask.title; report.linked++; report.converted = (report.converted || 0) + 1; }
        else { o.id = ''; report.unresolved.push({ kind: 'piece', ref: o.ref, label: o.label,
          candidates: taskCandidates(o.ref, tIndex.filter(t => t.id !== task.id)).map(c => ({ ...c, kind: 'task' })).slice(0, 2).concat(await pieceCandidates(o.ref, task.lang)).slice(0, 4) }); }
      } else if(o.kind === 'task'){
        const s = String(o.ref || '').replace(/^id\s*:\s*/i, '').trim();
        const hit = tById.get(o.id) || tById.get(s) || tByNorm.get(norm(s));
        if(hit && hit.id !== task.id){ o.id = hit.id; o.ref = hit.title; report.linked++; }
        else { o.id = ''; report.unresolved.push({ kind: 'task', ref: o.ref, label: o.label, candidates: taskCandidates(s, tIndex.filter(t => t.id !== task.id)).map(c => ({ ...c, kind: 'task' })) }); }
      }
      // вариант «код» остаётся внутри задачи: раньше он становился куском «Задача: вариант» и засорял библиотеку
    }
    return report;
  }

  // записи строго по очереди: двойной клик «сохранить» раньше успевал создать копии одной задачи
  let chain = Promise.resolve();
  const queued = fn => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

  async function save(input, opts = {}){ return queued(() => saveNow(input, opts)); }
  async function saveNow(input, opts = {}){
    const t = cleanTask(input);
    // новая задача с уже существующим названием — обновляет её, а не плодит копию
    if(!t.id || !okId(t.id)){ const same = (await list()).find(x => norm(x.title) === norm(t.title)); t.id = same ? same.id : slug(t.title || 'задача'); }
    const report = await resolve(t, opts);
    t.savedAt = Date.now();
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(fileOf(t.id), JSON.stringify(t, null, 2), 'utf8');
    return { task: t, report };
  }

  // пачка текстом: одноимённая задача обновляется (не плодим двойники), остальные создаются
  async function importText(text, opts = {}){ return opts.dry ? importNow(text, opts) : queued(() => importNow(text, opts)); }
  async function importNow(text, { dry = false } = {}){
    const { tasks, warnings } = TaskFormat.parse(text);
    const existing = await list();
    const byNorm = new Map(existing.map(t => [norm(t.title), t]));
    const out = [];
    // сначала id всем — чтобы задачи пачки могли ссылаться друг на друга
    // одноимённые внутри самой пачки тоже получают один id — последняя версия перезапишет предыдущую
    for(const t of tasks){ const k = norm(t.title); const old = byNorm.get(k); t.id = old ? old.id : slug(t.title); t._new = !old; if(!old) byNorm.set(k, { id: t.id, title: t.title, _fromPack: true }); }
    const index = existing.concat([...new Map(tasks.filter(t => t._new).map(t => [t.id, { id: t.id, title: t.title }])).values()]);
    for(const t of tasks){
      const isNew = t._new; delete t._new;
      if(dry){ const c = cleanTask(t); const report = await resolve(c, { createCode: false, tasksIndex: index }); out.push({ id: c.id, title: c.title, isNew, report, stats: TaskFormat.stats(c), task: c }); continue; }
      const { task, report } = await saveNow(t, { tasksIndex: index });
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

  // перенос в общее дерево разделов: меняем только group, ссылки и savedAt не трогаем
  async function setGroups(map){
    let changed = 0;
    for(const [id, g] of Object.entries(map || {})){ const t = await get(id); if(!t || !g || t.group === g) continue; t.group = String(g).slice(0, 120); await fs.writeFile(fileOf(t.id), JSON.stringify(t, null, 2), 'utf8'); changed++; }
    return { changed };
  }

  return { list, get, save, remove, importText, toText, resolve, usedBy, setGroups, parseText: TaskFormat.parse, eachOption: TaskFormat.eachOption };
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

// ── полоска «🧭 пригодится»: какие задачи подходят к открытому коду ──────────
// Веса подобраны на глаз — когда задач станет 20–30, их стоит подправить по тому, как часто попадает в точку.
export const SUGGEST_WEIGHTS = {
  unmet: 3,          // за каждое имя, которого коду не хватает, а кусок задачи его даёт (не больше 3 имён)
  started: 2,        // × доля уже сделанных кусков задачи (часть есть в коде, часть нет)
  similar: 2,        // × доля «своих» слов задачи, которые уже встречаются в коде у курсора
  similarMin: 0.3,   // с какой доли похожесть считается сигналом от кода
  cursorWord: 0.5,   // за слово текущей/прошлой строки в названии или синонимах — ТОЛЬКО если есть сигнал от кода
  cursorMax: 1,
  otherLang: 0.3,    // множитель, если язык задачи не совпадает с языком файла
  threshold: 1.5, top: 3
};
const STOP = new Set(('const let var function return if else for while do switch case break continue new this true false null undefined '
  + 'typeof instanceof in of class extends import export from default async await try catch finally throw def elif and or not is none '
  + 'pass self print len range str int list dict the and with').split(' '));
const tokensOf = code => { const set = new Set(); for(const m of String(code || '').toLowerCase().matchAll(/[a-zа-яё_$][\wа-яё$-]{2,}/g)) if(!STOP.has(m[0])) set.add(m[0]); return set; };

export function createTaskRanker({ entries, contract, contractLangs }){
  const cache = new Map();   // taskId → {savedAt, pieces:[id], parts:[{provides}], tokens:Set}
  // части задачи: куски по ссылке и код, живущий внутри задачи (у него контракт считаем сами)
  async function profile(t, byId){
    const c = cache.get(t.id); if(c && c.savedAt === t.savedAt) return c;
    const ids = [], inline = [];
    TaskFormat.eachOption(t.steps, o => { if(o.kind === 'piece' && o.id && !ids.includes(o.id)) ids.push(o.id); if(o.kind === 'code' && String(o.code || '').trim()) inline.push(o); });
    const tokens = new Set(); for(const id of ids){ const e = byId.get(id); if(e) tokensOf(e.code).forEach(x => tokens.add(x)); }
    inline.forEach(o => tokensOf(o.code).forEach(x => tokens.add(x)));
    const parts = inline.map(o => { const lang = o.lang || t.lang || 'js'; let prov = []; try { if(contract && contractLangs.has(lang)) prov = contract(o.code, lang).provides; } catch(_){} return { provides: prov }; });
    const p = { savedAt: t.savedAt, pieces: ids, parts, tokens }; cache.set(t.id, p); return p;
  }
  async function rank({ tasks, rows, next, lang, window: win, cursor }){
    const W = SUGGEST_WEIGHTS;
    const all = await entries(); const byId = new Map(all.map(e => [e.id, e]));
    const rowById = new Map(rows.map(r => [r.id, r]));
    const provided = new Set(next.provided || []);
    const unmet = (next.unmet || []).filter(u => !u.generic).map(u => u.name);
    const codeTok = tokensOf(win);
    const curWords = String(cursor || '').toLowerCase().replace(/ё/g, 'е').match(/[\p{L}_]{3,}/gu) || [];
    const out = [];
    for(const t of tasks){
      const p = await profile(t, byId); if(!p.pieces.length && !p.parts.length) continue;
      const why = []; let score = 0;
      const gives = new Set(); let withProv = 0, done = 0;
      const provs = p.pieces.map(id => { const r = rowById.get(id); return (r && r.comp && r.comp.provides) || []; }).concat(p.parts.map(x => x.provides));
      for(const prov of provs){ prov.forEach(x => gives.add(x)); if(prov.length){ withProv++; if(prov.every(x => provided.has(x))) done++; } }
      if(withProv && done === withProv) continue;                         // всё уже есть в коде — не предлагаем
      const need = unmet.filter(n => gives.has(n)).slice(0, 3);
      if(need.length){ score += W.unmet * need.length; why.push('не хватает: ' + need.join(', ')); }
      // «начато» имеет смысл, только если у задачи несколько кусков: один из одного — это «готово»
      if(done > 0 && withProv > 1){ score += W.started * done / withProv; why.push('начато ' + done + ' из ' + withProv); }
      let sim = 0; if(p.tokens.size && codeTok.size){ let k = 0; for(const x of p.tokens) if(codeTok.has(x)) k++; sim = k / p.tokens.size; }
      if(sim >= W.similarMin){ score += W.similar * sim; why.push('похоже на код ' + Math.round(sim * 100) + '%'); }
      if(score > 0 && curWords.length){
        const tw = [t.title].concat(t.aliases || []).join(' ').toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
        const hit = [...new Set(curWords)].filter(w => tw.some(x => x.startsWith(w) || w.startsWith(x) && x.length > 3)).length;
        if(hit) score += Math.min(W.cursorMax, W.cursorWord * hit);
      }
      if(t.lang && lang && t.lang !== lang) score *= W.otherLang;
      if(score >= W.threshold) out.push({ id: t.id, title: t.title, score: Math.round(score * 10) / 10, why });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, W.top);
  }
  return { rank };
}
