import { queryTokens } from './query-phrase-match.mjs';

const normalize = value => String(value == null ? '' : value).trim().toLocaleLowerCase('ru').replace(/ё/g, 'е');
const round = value => Math.round(value * 1e6) / 1e6;
const canonicalTerm = value => normalize(value).replace(/^<([a-z][a-z0-9-]*)>$/, '$1');

// Reciprocal-rank fusion: независимые поиски имеют разные шкалы score,
// поэтому объединяем позиции в выдаче, а не сравниваем несопоставимые числа.
export function combineTaskSearch({ query, language = '', limit = 60, library, directed, variants }) {
  const max = Math.max(1, Math.min(200, Number(limit) || 60));
  const q = normalize(query);
  const hasUiObject = /кнопк|ссылк|страниц|шапк|заголов|панел|блок|раздел|наведен|hover|подсвет|css|html|dom|форм|поле|цвет|текст|элемент/.test(q);
  const hasCollectionObject = /массив|список|коллекц|последовательност/.test(q);
  const webTask = hasUiObject && (!hasCollectionObject || /панел|блок|раздел|страниц|кнопк|ссылк/.test(q));
  const backendTask = /python|питон|сервер|backend|бэкенд|django|flask|fastapi|sql|postgres|баз данных/.test(q);
  const webOnly = webTask && !backendTask;
  const webLanguages = new Set(['html','css','js','ts','svg']);
  const inScope = item => !webOnly || webLanguages.has(String(item?.lang || '').toLowerCase());
  const byId = new Map();
  const ensure = id => {
    if (!byId.has(id)) byId.set(id, {
      id, title: id, lang: '', group: '', desc: '', tags: [], aliases: [],
      sources: [], why: [], matchedTargets: [], _phraseRank: null, _lexicalRank: null, _rrf: 0
    });
    return byId.get(id);
  };

  (directed?.rankedPieces || []).filter(inScope).forEach((piece, index) => {
    const item = ensure(piece.id);
    Object.assign(item, {
      title: piece.title || item.title, lang: piece.lang || item.lang,
      group: piece.group || item.group, desc: piece.desc || item.desc,
      tags: piece.tags || item.tags, aliases: piece.aliases || item.aliases
    });
    item._phraseRank = index + 1;
    item._rrf += 1.2 / (60 + index + 1);
    if (!item.sources.includes('направленные фразы')) item.sources.push('направленные фразы');
    for (const target of piece.matchedTargets || [piece.targetKey].filter(Boolean)) {
      if (!item.matchedTargets.includes(target)) item.matchedTargets.push(target);
    }
    item.why.push({
      source: 'направленные фразы',
      targets: [...(piece.matchedTargets || [piece.targetKey].filter(Boolean))],
      phraseRank: index + 1,
      targetScore: piece.targetScore ?? null
    });
  });

  (library?.hits || []).filter(inScope).forEach((hit, index) => {
    const item = ensure(hit.id);
    item.title = hit.title || item.title;
    item.lang = hit.lang || item.lang;
    item.group = hit.group || item.group;
    item.desc = hit.desc || item.desc;
    item._lexicalRank = index + 1;
    item._rrf += 1 / (60 + index + 1);
    if (!item.sources.includes('полнотекстовый поиск')) item.sources.push('полнотекстовый поиск');
    item.why.push({
      source: 'полнотекстовый поиск',
      lexicalRank: index + 1,
      matches: hit.why || []
    });
  });

  const pieces = [...byId.values()].sort((a, b) =>
    b._rrf - a._rrf ||
    (a._phraseRank ?? Infinity) - (b._phraseRank ?? Infinity) ||
    (a._lexicalRank ?? Infinity) - (b._lexicalRank ?? Infinity) ||
    String(a.title).localeCompare(String(b.title), 'ru')
  ).slice(0, max).map((item, index) => ({
    id: item.id, title: item.title, lang: item.lang, group: item.group,
    desc: item.desc, tags: item.tags, aliases: item.aliases,
    score: round(item._rrf), position: index + 1,
    sources: item.sources, matchedTargets: item.matchedTargets,
    phraseRank: item._phraseRank, lexicalRank: item._lexicalRank, why: item.why
  }));

  const roots = (variants?.roots || []).filter(inScope);
  const rootByKey = new Map(roots.map(root => [canonicalTerm(root.term), root]));
  const targetHits = (directed?.hits || []).filter(hit => !webOnly || (hit.pieces || []).some(inScope));
  const targets = targetHits.map(hit => ({
    targetKey: hit.targetKey,
    score: hit.score,
    phrases: hit.phrases || [],
    sections: hit.sections || [],
    pieceCount: (hit.pieces || []).filter(inScope).length,
    root: rootByKey.get(canonicalTerm(hit.targetKey)) || null
  }));

  const matchedTokens = new Set();
  for (const target of targets) for (const phrase of target.phrases) {
    for (const token of phrase.match?.matchedTokens || []) matchedTokens.add(token);
  }

  return {
    query: String(query || ''),
    language: String(language || '').toLowerCase(),
    mode: 'task',
    queryTokens: queryTokens(query),
    matchedTokens: [...matchedTokens],
    ambiguous: Boolean(directed?.ambiguous),
    targets,
    roots,
    pieces,
    counts: {
      targets: targets.length,
      roots: roots.length,
      pieces: pieces.length,
      directedPieces: (directed?.rankedPieces || []).filter(inScope).length,
      lexicalPieces: (library?.hits || []).filter(inScope).length
    }
  };
}
