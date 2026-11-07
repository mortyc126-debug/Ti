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
  const buttonTask = /кнопк|button/.test(q);
  const linkTask = /ссылк|href|переход/.test(q);
  const hoverTask = /наведен|hover/.test(q);
  const headingTask = /заголов|шапк|надпис/.test(q);
  const collapseTask = /свер|раскры|collapse|expand/.test(q);
  const multiSourceTask = /источник|сервер|api|данн/.test(q) && /два|нескольк|разных|источник/.test(q);
  const asksMouse = /мыш|mouse/.test(q);
  const asksKeyboard = /клавиатур|keyboard|keydown|keyup/.test(q);
  const asksGamepad = /геймпад|gamepad/.test(q);
  const asksServiceWorker = /service worker|offline|кэш|кеш/.test(q);
  const asksSpacing = /межбуквен|межстроч|интервал|перенос|пробел|высота строки/.test(q);
  const asksSorting = /сортир|упорядоч|sort/.test(q);
  const asksFile = /файл|путь|каталог|запис|write/.test(q);
  const pieceCompatible = item => {
    const text = normalize([item?.title, item?.group, item?.desc, ...(item?.tags || []), ...(item?.aliases || [])].filter(Boolean).join(' '));
    if (buttonTask && !asksGamepad && /геймпад|gamepad/.test(text)) return false;
    if (buttonTask && !asksKeyboard && /keydown|keyup|клавиатур|keyboard/.test(text)) return false;
    if (buttonTask && !asksMouse && (text.includes('event.button') || /кнопку мыши|кнопка мыши/.test(text))) return false;
    if (linkTask && !asksServiceWorker && /service worker|кэш сразу|кеш сразу/.test(text)) return false;
    if (headingTask && !buttonTask && /кнопк/.test(text)) return false;
    if (hoverTask && !asksSpacing && /letter-spacing|line-height|white-space/.test(text)) return false;
    if (hoverTask && !asksSorting && /sort(?:ed|ing)?|сортир/.test(text)) return false;
    if (webTask && !asksFile && (text.includes('document.write') || /записать файл/.test(text))) return false;
    if (multiSourceTask && /источник узла|идентификатор источника узла|заголовок источника узла|описание источника узла/.test(text) && !/dom|узел|node/.test(q)) return false;
    return true;
  };
  const targetCompatible = target => {
    const key = normalize(target);
    if (buttonTask && !asksMouse && key.includes('event.button')) return false;
    if (linkTask && !asksServiceWorker && /serviceworker|service worker/.test(key)) return false;
    if (linkTask && /^(?:self|none)$/.test(key) && !/новом окне|вкладк|target|blank|self/.test(q)) return false;
    if (hoverTask && !asksSpacing && /letter-spacing|line-height|white-space/.test(key)) return false;
    if (hoverTask && !asksSorting && /^(?:sort|sorted|write)$/.test(key)) return false;
    if (collapseTask && !/подвал|footer|низ страницы/.test(q) && /^(?:<footer>|footer)$/.test(key)) return false;
    if (collapseTask && !/абзац|параграф|текст/.test(q) && /^(?:p|<p>)$/.test(key)) return false;
    return true;
  };
  const inTaskScope = item => inScope(item) && pieceCompatible(item);
  const byId = new Map();
  const ensure = id => {
    if (!byId.has(id)) byId.set(id, {
      id, title: id, lang: '', group: '', desc: '', tags: [], aliases: [],
      sources: [], why: [], matchedTargets: [], _phraseRank: null, _lexicalRank: null, _rrf: 0
    });
    return byId.get(id);
  };

  (directed?.rankedPieces || []).filter(inTaskScope).forEach((piece, index) => {
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

  (library?.hits || []).filter(inTaskScope).forEach((hit, index) => {
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

  const roots = (variants?.roots || []).filter(root => inScope(root) && targetCompatible(root.term));
  const rootByKey = new Map(roots.map(root => [canonicalTerm(root.term), root]));
  const targetHits = (directed?.hits || []).filter(hit => targetCompatible(hit.targetKey) && (!webOnly || (hit.pieces || []).some(inScope)));
  const targets = targetHits.map(hit => ({
    targetKey: hit.targetKey,
    score: hit.score,
    phrases: hit.phrases || [],
    sections: hit.sections || [],
    pieceCount: (hit.pieces || []).filter(inTaskScope).length,
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
      directedPieces: (directed?.rankedPieces || []).filter(inTaskScope).length,
      lexicalPieces: (library?.hits || []).filter(inTaskScope).length
    }
  };
}
