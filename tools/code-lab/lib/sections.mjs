// Общее дерево разделов (library/_sections.json) и перенос старых разделов в него.
// Правила — текст «старый путь => новый путь»: побеждает самое длинное совпадение начала пути,
// «/ *» в конце — оставить прежний подраздел. Применение меняет только поле group у кусков и задач.
import { promises as fs } from 'node:fs';

export const normPath = g => String(g || '').split('/').map(x => x.trim()).filter(Boolean).join(' / ');
const key = g => normPath(g).toLowerCase().replace(/ё/g, 'е');

export function parseRules(lines){
  const out = [], bad = [];
  for(const raw of Array.isArray(lines) ? lines : String(lines || '').split(/\r?\n/)){
    const s = String(raw).trim(); if(!s || s.startsWith('#')) continue;
    const m = s.match(/^(.+?)\s*=>\s*(.+)$/); if(!m){ bad.push(s); continue; }
    let to = normPath(m[2]); const keepSub = /\s*\/\s*\*$/.test(m[2].trim()) || to.endsWith(' / *');
    to = normPath(to.replace(/\s*\/\s*\*$/, ''));
    out.push({ from: normPath(m[1]), fromKey: key(m[1]), to, keepSub, text: s });
  }
  return { rules: out, bad };
}

// дерево ↔ текст «Раздел: под1, под2» (для правки в окне)
// подразделы через «;» — в названиях бывают запятые («Перебор, фильтр, сортировка»)
export function treeToText(tree){ return (tree || []).map(t => t.name + ': ' + (t.subs || []).join('; ')).join('\n'); }
export function treeFromText(text){
  return String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => {
    const i = l.indexOf(':'); const name = (i < 0 ? l : l.slice(0, i)).trim();
    const subs = i < 0 ? [] : l.slice(i + 1).split(';').map(x => x.trim()).filter(Boolean);
    return { name, subs };
  }).filter(t => t.name);
}

// куда уходит раздел: {to, rule}; без правила — остаётся как есть
export function mapGroup(group, rules){
  const g = normPath(group) || '(пусто)', gk = key(g);
  let best = null;
  for(const r of rules){ if(gk === r.fromKey || gk.startsWith(r.fromKey + ' / ')){ if(!best || r.fromKey.length > best.fromKey.length) best = r; } }
  if(!best) return { to: g, rule: null };
  const rest = g.split(' / ').slice(best.from.split(' / ').length).join(' / ');
  const to = best.keepSub && rest ? best.to + ' / ' + rest : best.to;
  return { to, rule: best.text };
}

// где путь стоит в дереве: top — есть ли такой раздел, sub — есть ли подраздел (или его нет вовсе)
export function placeInTree(p, tree){
  const [top, ...rest] = normPath(p).split(' / '); const sub = rest.join(' / ');
  const t = (tree || []).find(x => key(x.name) === key(top));
  return { top: !!t, sub: !sub || !!(t && (t.subs || []).some(s => key(s) === key(sub))) };
}

export function createSections({ file }){
  async function load(){
    try { const j = JSON.parse(await fs.readFile(file, 'utf8')); return { note: j._note || '', tree: Array.isArray(j.tree) ? j.tree : [], rules: Array.isArray(j.rules) ? j.rules : [] }; }
    catch(_){ return { note: '', tree: [], rules: [] }; }
  }
  async function save({ tree, rules }){
    const cur = await load();
    const obj = { _note: cur.note || 'Общее дерево разделов. rules: «старый путь => новый путь».', tree: tree || cur.tree, rules: rules || cur.rules };
    await fs.writeFile(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    return obj;
  }
  // items: [{id, kind, group}] → сводка переносов и что останется вне дерева
  function plan(items, { tree, rules }){
    const { rules: rs, bad } = parseRules(rules);
    const moves = new Map(), stay = new Map(), changes = [];
    for(const it of items){
      const from = normPath(it.group) || '(пусто)';
      const { to, rule } = mapGroup(from, rs);
      if(to !== from){ changes.push({ id: it.id, kind: it.kind, to });
        const k = from + '\u0000' + to; const m = moves.get(k) || { from, to, rule, pieces: 0, tasks: 0 }; m[it.kind === 'task' ? 'tasks' : 'pieces']++; moves.set(k, m); }
      const pl = placeInTree(to, tree);
      if(!pl.top || !pl.sub){ const s = stay.get(to) || { path: to, pieces: 0, tasks: 0, top: pl.top }; s[it.kind === 'task' ? 'tasks' : 'pieces']++; stay.set(to, s); }
    }
    // итог по новому дереву: сколько будет в каждом разделе/подразделе
    const after = new Map();
    const changed = new Map(changes.map(c => [c.kind + ':' + c.id, c.to]));
    for(const it of items){ const from = normPath(it.group) || '(пусто)'; const to = changed.get(it.kind + ':' + it.id) || from;
      const a = after.get(to) || { path: to, pieces: 0, tasks: 0 }; a[it.kind === 'task' ? 'tasks' : 'pieces']++; after.set(to, a); }
    return { moves: [...moves.values()].sort((a, b) => a.to.localeCompare(b.to, 'ru') || a.from.localeCompare(b.from, 'ru')),
      outside: [...stay.values()].sort((a, b) => (b.pieces + b.tasks) - (a.pieces + a.tasks)), after: [...after.values()].sort((a, b) => a.path.localeCompare(b.path, 'ru')),
      changes, bad, total: items.length };
  }
  return { load, save, plan };
}

// ── «разложить неразобранное»: раздел для куска по самым похожим разложенным кускам ──
// Похожесть — общие слова названия/тегов/описания/кода; редкое общее слово весит больше частого (idf).
const splitWords = s => String(s || '').replace(/([a-zа-яё])([A-ZА-ЯЁ])/g, '$1 $2').toLowerCase().replace(/ё/g, 'е').match(/[a-zа-я][a-zа-я0-9]{2,}/g) || [];
const STOPW = new Set('the and for with from this that const let var function return new true false null undefined если это для как что или при без над под все его она они'.split(' '));
function bag(e){
  const m = e.meta || {}; const out = new Map();
  const add = (s, w) => { for(const x of splitWords(s)){ if(STOPW.has(x)) continue; out.set(x, (out.get(x) || 0) + w); } };
  add(m.title || e.title, 3); add((m.tags || []).join(' '), 2); add((m.aliases || []).join(' '), 2); add(m.desc, 1); add(String(e.code || '').slice(0, 4000), 1);
  return out;
}
export function suggestSections({ entries, tree, rules, isUnsorted, k = 7 }){
  const { rules: rs } = parseRules(rules);
  const pathOf = e => mapGroup((e.meta && e.meta.group) || '', rs).to;
  const docs = entries.map(e => ({ e, path: pathOf(e), bag: bag(e) }));
  const df = new Map(); docs.forEach(d => d.bag.forEach((_, w) => df.set(w, (df.get(w) || 0) + 1)));
  const N = docs.length || 1, idf = w => Math.log(1 + N / (df.get(w) || 1));
  const vec = b => { const v = new Map(); let n = 0; b.forEach((c, w) => { const x = Math.min(c, 4) * idf(w); v.set(w, x); n += x * x; }); return { v, n: Math.sqrt(n) || 1 }; };
  docs.forEach(d => d.vec = vec(d.bag));
  const sorted = docs.filter(d => !isUnsorted(d.path)), todo = docs.filter(d => isUnsorted(d.path));
  // одноимённый разложенный кусок — самый сильный довод; тот же код без шапки-комментариев — значит, дубль
  const tkey = e => String((e.meta && e.meta.title) || e.title || '').trim().toLowerCase().replace(/ё/g, 'е');
  const body = c => String(c || '').replace(/\r/g, '').replace(/\/\/[^\n]*|#[^\n]*/g, '').replace(/\s+/g, ' ').trim();
  const byTitle = new Map(); sorted.forEach(o => { const k = tkey(o.e); if(!byTitle.has(k)) byTitle.set(k, []); byTitle.get(k).push(o); });
  return todo.map(d => {
    const twins = byTitle.get(tkey(d.e)) || [];
    const twin = twins.find(o => body(o.e.code) === body(d.e.code)) || twins[0] || null;
    const near = [];
    for(const o of sorted){ let s = 0; d.vec.v.forEach((x, w) => { const y = o.vec.v.get(w); if(y) s += x * y; }); if(s > 0) near.push({ o, s: s / (d.vec.n * o.vec.n) }); }
    near.sort((a, b) => b.s - a.s);
    const top = near.slice(0, k), votes = new Map(); let total = 0;
    top.forEach(({ o, s }) => { if(!placeInTree(o.path, tree).top) return; votes.set(o.path, (votes.get(o.path) || 0) + s); total += s; });
    let opts = [...votes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([path, v]) => ({ path, share: total ? Math.round(v / total * 100) : 0 }));
    if(twin && placeInTree(twin.path, tree).top) opts = [{ path: twin.path, share: 100, twin: true }].concat(opts.filter(o => o.path !== twin.path)).slice(0, 3);
    return { id: d.e.id, title: (d.e.meta && d.e.meta.title) || d.e.title, lang: d.e.lang, from: d.path, options: opts,
      twin: twin ? { id: twin.e.id, path: twin.path, same: body(twin.e.code) === body(d.e.code) } : null,
      sim: top.length ? Math.round(top[0].s * 100) : 0, like: top.slice(0, 3).map(({ o }) => o.e.meta.title || o.e.id) };
  }).sort((a, b) => ((b.options[0] || {}).share || 0) - ((a.options[0] || {}).share || 0));
}
