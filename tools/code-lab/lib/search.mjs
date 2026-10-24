// Поиск по библиотеке: по названию, описанию, тегам, разделу, пояснениям слов и по самому коду.
//
//  • слова приводятся к основе (толщина/толщину/толщины → «толщин»), «ё» = «е», регистр не важен;
//  • font-weight, grid-template-columns ищутся и целиком, и по частям; camelCase (querySelector) режется на слова;
//  • синонимы из файла (толщина ≈ жирность ≈ bold ≈ font-weight): запрос «толщина букв» находит
//    «жирный», хотя такого слова в названии нет;
//  • начало слова и опечатки: «жирн», «шрифт» → «шрифты», «фнот» → «font»;
//  • у каждого результата есть объяснение, почему он найден («толщина → font-weight, в коде»);
//  • всё, что находил старый поиск по подстроке в названии и описании, находится по-прежнему.
//
// Индекс строится из документов хранилища и пересобирается, когда они поменялись.

import { promises as fs } from 'node:fs';
import { stem } from './ru-stem.mjs';

export const FIELDS = ['title', 'tags', 'aliases', 'group', 'desc', 'output', 'notes', 'code', 'extra'];
const WEIGHT = { title: 6, tags: 5, aliases: 5, group: 3, desc: 3, output: 1.5, notes: 1.5, code: 2, extra: 1 };
export const LABEL = { title: 'название', tags: 'тег', aliases: 'синоним', group: 'раздел', desc: 'описание', output: 'результат', notes: 'пояснение слова', code: 'код', extra: 'контракт' };
const BIT = Object.fromEntries(FIELDS.map((f, i) => [f, 1 << i]));

const STOP = new Set(('и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему ' +
  'теперь когда даже ну ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы ' +
  'тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы ' +
  'нее сейчас были куда зачем всех можно при два об другой после над больше тот через эти нас про всего них какая много три эту моя свою этой перед ' +
  'такой им более всегда между сделать сделай сделайте хочу нужно нужна нужен найти найди покажи показать подскажи какие какую какое').split(' '));

const norm = s => String(s == null ? '' : s).replace(/ё/g, 'е').replace(/Ё/g, 'Е');
const WORD_RE = /[\p{L}\p{N}]+(?:[-_][\p{L}\p{N}]+)*/gu;

// ключ слова в индексе: составное (font-weight) — как есть в нижнем регистре, остальное — основа
function keyOf(word){
  const w = word.toLowerCase();
  return /[-_]/.test(w) ? w.replace(/_/g, '-') : stem(w);
}
// слово → ключи: само слово + его части (font-weight → font-weight, font, weight; querySelector → queryselector, query, selector)
export function wordKeys(word){
  const out = [];
  const w = String(word);
  const compound = /[-_]/.test(w);
  const parts = w.split(/[-_]/).flatMap(p => p.split(/(?<=[a-zа-я0-9])(?=[A-ZА-Я])/u)).filter(Boolean);
  if(compound) out.push(keyOf(w));
  else out.push(keyOf(w));
  if(parts.length > 1) for(const p of parts){ const k = stem(p.toLowerCase()); if(k.length >= 2 && !out.includes(k)) out.push(k); }
  return out.filter(k => k.length >= 2);
}
export function terms(text){
  const out = [];
  for(const m of norm(text).matchAll(WORD_RE)) for(const k of wordKeys(m[0])) out.push(k);
  return out;
}

// расстояние Левенштейна с ранним выходом (нужно только «≤ 1»)
function within1(a, b){
  if(a === b) return true;
  const la = a.length, lb = b.length;
  if(Math.abs(la - lb) > 1) return false;
  let i = 0; while(i < la && i < lb && a[i] === b[i]) i++;
  if(la === lb) return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  return la > lb ? a.slice(i + 1) === b.slice(i) : b.slice(i + 1) === a.slice(i);
}

function loadSynonymGroups(data){
  const groups = (data && Array.isArray(data.groups)) ? data.groups : [];
  const map = new Map();   // ключ слова → индексы групп
  const out = [];
  groups.forEach(g => {
    const members = (Array.isArray(g) ? g : (g && g.words) || []).map(x => String(x).trim()).filter(Boolean);
    if(members.length < 2) return;
    const gi = out.length;
    const items = members.map(m => ({ label: m, keys: [...new Set(norm(m).split(/\s+/).filter(Boolean).map(w => keyOf(w)).filter(k => k.length >= 2))] })).filter(it => it.keys.length);
    out.push(items);
    items.forEach(it => { if(it.keys.length === 1){ const k = it.keys[0]; if(!map.has(k)) map.set(k, []); map.get(k).push(gi); } });
  });
  return { groups: out, map };
}

export function buildIndex(docs, { synonyms = { groups: [] } } = {}){
  const N = docs.length;
  const postings = new Map();   // ключ → Map(индекс документа → { w, mask })
  const lens = new Array(N).fill(0);
  const raws = [];

  docs.forEach((d, di) => {
    const f = {
      title: d.title, tags: (d.tags || []).join(' '), aliases: (d.aliases || []).join(' '), group: d.group, desc: d.desc, output: d.output,
      notes: (d.notes || []).join(' '), code: d.code, extra: (d.extra || []).join(' ')
    };
    raws.push(f);
    for(const field of FIELDS){
      const tf = new Map();
      for(const k of terms(f[field] || '')) tf.set(k, (tf.get(k) || 0) + 1);
      for(const [k, n] of tf){
        let p = postings.get(k); if(!p){ p = new Map(); postings.set(k, p); }
        let e = p.get(di); if(!e){ e = { w: 0, mask: 0 }; p.set(di, e); }
        e.w += WEIGHT[field] * Math.min(n, 3); e.mask |= BIT[field];
        lens[di] += n;
      }
    }
  });
  const avg = lens.reduce((a, b) => a + b, 0) / Math.max(1, N);
  const vocab = [...postings.keys()];
  const syn = loadSynonymGroups(synonyms);
  const idf = k => { const df = postings.has(k) ? postings.get(k).size : 0; return Math.log(1 + (N - df + 0.5) / (df + 0.5)); };
  const K1 = 1.2, B = 0.4;
  const termScore = (k, di) => {
    const e = postings.get(k) && postings.get(k).get(di); if(!e) return 0;
    return idf(k) * (e.w * (K1 + 1)) / (e.w + K1 * (1 - B + B * lens[di] / (avg || 1)));
  };

  // слово запроса → варианты: [{ kind, label, keys, w }]
  function alternatives(tok, isLast){
    const alts = [];
    const seen = new Set();
    const add = (kind, label, keys, w) => { const id = keys.join('\u0001'); if(seen.has(id)) return; if(!keys.every(k => postings.has(k))) return; seen.add(id); alts.push({ kind, label, keys, w }); };
    const main = wordKeys(tok)[0];
    add('exact', tok, [main], 1);
    const parts = wordKeys(tok).slice(1);
    if(parts.length > 1) add('parts', tok, parts, 0.8);   // font-weight → font + weight
    // синонимы
    for(const gi of (syn.map.get(main) || [])) for(const it of syn.groups[gi]) if(!(it.keys.length === 1 && it.keys[0] === main)) add('syn', it.label, it.keys, 0.85);
    // начало слова и обрезанные основы (массив → «масс» / «массив»)
    if(main.length >= 4 || (isLast && main.length >= 3)){
      let n = 0;
      for(const v of vocab){ if(v !== main && v.startsWith(main) && v.length - main.length <= 12){ add('prefix', v, [v], 0.5); if(++n >= 40) break; } }
      if(main.length >= 5) for(let cut = 1; cut <= 3; cut++){ const v = main.slice(0, main.length - cut); if(v.length >= 4 && postings.has(v)) add('prefix', v, [v], 0.45); }
    }
    // опечатки: только если вообще ничего не нашли
    if(!alts.length && main.length >= 5){
      let n = 0;
      for(const v of vocab){ if(Math.abs(v.length - main.length) <= 1 && v[0] === main[0] && within1(v, main)){ add('fuzzy', v, [v], 0.4); if(++n >= 20) break; } }
    }
    return alts;
  }

  function foundRaw(di, keys){
    // первое слово документа, у которого есть нужный ключ: показываем его пользователю
    for(const field of ['title', 'tags', 'aliases', 'group', 'desc', 'output', 'notes', 'code', 'extra']){
      for(const m of norm(raws[di][field] || '').matchAll(WORD_RE)){
        const ks = wordKeys(m[0]);
        if(keys.every(k => ks.includes(k)) || (keys.length === 1 && ks.includes(keys[0]))) return { word: m[0], field };
      }
    }
    return null;
  }

  function search(query, { limit = 60 } = {}){
    const raw = String(query || '').trim();
    if(!raw) return { q: raw, total: 0, hits: [], terms: [] };
    const qn = norm(raw).toLowerCase();
    let toks = [...norm(raw).matchAll(WORD_RE)].map(m => m[0]);
    const kept = toks.filter(t => !STOP.has(t.toLowerCase()));
    if(kept.length) toks = kept;
    toks = toks.filter(t => wordKeys(t).length);   // однобуквенные слова в основу не годятся (их ловит поиск по подстроке)
    const groups = toks.map((t, i) => ({ q: t, alts: alternatives(t, i === toks.length - 1) }));
    const scored = new Map();   // di → { score, matched, best: [] }
    groups.forEach((g, gi) => {
      const perDoc = new Map();   // di → { s, alt }
      for(const alt of g.alts){
        // документы, где есть ВСЕ ключи варианта
        const lists = alt.keys.map(k => postings.get(k));
        let base = lists[0]; for(const l of lists) if(l.size < base.size) base = l;
        for(const di of base.keys()){
          if(!lists.every(l => l.has(di))) continue;
          const s = alt.w * alt.keys.reduce((a, k) => a + termScore(k, di), 0);
          const cur = perDoc.get(di);
          if(!cur) perDoc.set(di, { s, alt, rest: 0 });
          else if(s > cur.s){ cur.rest += cur.s; cur.s = s; cur.alt = alt; }
          else cur.rest += s;
        }
      }
      for(const [di, v] of perDoc){
        let r = scored.get(di); if(!r){ r = { score: 0, matched: 0, best: [] }; scored.set(di, r); }
        // понятие, встреченное в нескольких формах (жирный + bold + font-weight), весит больше одного совпадения
        r.score += v.s + Math.min(0.35 * v.rest, v.s * 1.5); r.matched++; r.best.push({ gi, alt: v.alt });
      }
    });
    let ranked = [...scored.entries()].map(([di, r]) => {
      const cover = r.matched / Math.max(1, groups.length);
      let score = r.score * cover * cover;
      const title = norm(docs[di].title || '').toLowerCase();
      if(title.includes(qn)) score *= 1.6;   // запрос целиком в названии — выше всех
      return { di, score, r };
    });
    ranked.sort((a, b) => b.score - a.score);
    const top = ranked.length ? ranked[0].score : 0;
    ranked = ranked.filter(x => x.score >= top * 0.35);

    // всё, что находил старый поиск (подстрока в названии/описании), остаётся в выдаче
    const have = new Set(ranked.map(x => x.di));
    const floor = Math.max(top * 0.35, 0.01);
    docs.forEach((d, di) => {
      if(have.has(di)) return;
      const hay = norm((d.title || '') + ' ' + (d.desc || '')).toLowerCase();
      if(hay.includes(qn)) ranked.push({ di, score: floor, r: { best: [] }, substring: true });
    });
    ranked.sort((a, b) => b.score - a.score);

    const total = ranked.length;
    const hits = ranked.slice(0, limit).map(x => {
      const why = [];
      for(const b of x.r.best){
        const g = groups[b.gi];
        const f = foundRaw(x.di, b.alt.keys);
        why.push({ q: g.q, kind: b.alt.kind, via: b.alt.kind === 'exact' ? null : b.alt.label, found: f ? f.word : null, in: f ? LABEL[f.field] : null });
      }
      if(x.substring) why.push({ q: raw, kind: 'substring', via: null, found: raw, in: 'название/описание' });
      return { id: docs[x.di].id, score: Math.round(x.score * 1000) / 1000, why };
    });
    return { q: raw, total, hits, terms: groups.map(g => ({ q: g.q, alts: g.alts.filter(a => a.kind !== 'exact').slice(0, 8).map(a => ({ kind: a.kind, label: a.label })) })) };
  }

  return { search, size: N, vocabSize: vocab.length };
}

// Сервис: сам следит, когда нужно пересобрать индекс (поменялись куски или файл синонимов)
export function createSearchService({ store, synonymsPath, defaultSynonymsPath }){
  let index = null, builtVersion = -1, synMtime = -1, building = null;

  async function readSynonyms(){
    try { return JSON.parse(await fs.readFile(synonymsPath, 'utf8')); }
    catch(_){
      try { return JSON.parse(await fs.readFile(defaultSynonymsPath, 'utf8')); } catch(_2){ return { groups: [] }; }
    }
  }
  async function ensureSynonymsFile(){
    try { await fs.access(synonymsPath); }
    catch(_){ try { await fs.copyFile(defaultSynonymsPath, synonymsPath); } catch(_2){} }   // один раз кладём рядом с библиотекой, чтобы можно было править
  }
  const mt = () => fs.stat(synonymsPath).then(s => s.mtimeMs, () => 0);

  async function ensure(){
    await store.sync();
    const v = store.version, m = await mt();
    if(index && v === builtVersion && m === synMtime) return index;
    if(building) return building;
    building = (async () => {
      const docs = await store.docs();
      const syn = await readSynonyms();
      index = buildIndex(docs, { synonyms: syn });
      builtVersion = v; synMtime = m;
      return index;
    })().finally(() => { building = null; });
    return building;
  }
  return {
    async init(){ await ensureSynonymsFile(); },
    async search(q, opts){ const ix = await ensure(); return ix.search(q, opts); },
    async stats(){ const ix = await ensure(); return { docs: ix.size, terms: ix.vocabSize }; }
  };
}
