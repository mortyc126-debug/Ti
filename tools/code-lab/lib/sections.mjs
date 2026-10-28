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
