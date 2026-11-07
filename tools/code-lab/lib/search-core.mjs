import { queryTokens } from './query-phrase-match.mjs';

const normalize = value => String(value == null ? '' : value).trim().toLocaleLowerCase('ru').replace(/ё/g, 'е');
const round = value => Math.round(value * 1e6) / 1e6;
const canonicalTerm = value => normalize(value).replace(/^<([a-z][a-z0-9-]*)>$/, '$1');
const canonicalLanguage = value => {
  const lang = normalize(value);
  return ({ javascript: 'js', node: 'js', typescript: 'ts', python3: 'python', html5: 'html', css3: 'css' })[lang] || lang;
};

// Reciprocal-rank fusion: независимые поиски имеют разные шкалы score,
// поэтому объединяем позиции в выдаче, а не сравниваем несопоставимые числа.
export function combineTaskSearch({ query, language = '', limit = 60, library, directed, variants }) {
  const max = Math.max(1, Math.min(200, Number(limit) || 60));
  const q = normalize(query);
  const activeLanguage = canonicalLanguage(language);
  const hasUiObject = /кнопк|ссылк|страниц|шапк|заголов|панел|блок|раздел|наведен|hover|подсвет|css|html|dom|форм|поле|цвет|текст|элемент/.test(q);
  const hasCollectionObject = /массив|список|коллекц|последовательност|в одно значение|агрегир|reduce/.test(q);
  const webTask = hasUiObject && (!hasCollectionObject || /панел|блок|раздел|страниц|кнопк|ссылк/.test(q));
  const backendTask = /python|питон|сервер|backend|бэкенд|django|flask|fastapi|sql|postgres|баз данных/.test(q);
  const webOnly = webTask && !backendTask;
  const webLanguages = new Set(['html','css','js','ts','svg']);
  const inScope = item => !webOnly || webLanguages.has(canonicalLanguage(item?.lang || ''));
  const buttonTask = /кнопк|button/.test(q);
  const linkTask = /ссылк|href|переход/.test(q);
  const hoverTask = /наведен|hover/.test(q);
  const headingTask = /заголов|шапк|надпис/.test(q);
  const collapseTask = /свер|раскры|collapse|expand/.test(q);
  const multiSourceTask = /источник|сервер|api|данн/.test(q) && /два|нескольк|разных|источник/.test(q);
  const asksMouse = /мыш|mouse/.test(q);
  const asksKeyboard = /клавиатур|keyboard|keydown|keyup/.test(q);
  const asksGamepad = /геймпад|gamepad/.test(q);
  const asksServiceWorker = /worker|воркер|offline|кэш|кеш/.test(q);
  const asksSpacing = /межбуквен|межстроч|интервал|перенос|пробел|высота строки/.test(q);
  const asksSorting = /сортир|упорядоч|sort/.test(q);
  const asksFile = /файл|путь|каталог|запис|write/.test(q);
  const asksWriteData = /отправ|запис|созда|обнов|измен|сохран|post|put|patch/.test(q);
  const asksAuth = /авторизац|токен|учётн|учетн|credential|auth|доступ/.test(q);
  const asksImage = /изображен|картин|image|blob|bitmap|canvas/.test(q);
  const asksMarkup = /html|разметк|innerhtml|insertadjacenthtml/.test(q);
  const asksAttributes = /атрибут/.test(q);
  const asksFirstSuccess = /любой один|первый успешн|хотя бы один|promise.any/.test(q);
  const pieceCompatible = item => {
    const text = normalize([item?.title, item?.group, item?.desc, ...(item?.tags || []), ...(item?.aliases || [])].filter(Boolean).join(' '));
    if (buttonTask && !asksGamepad && /геймпад|gamepad/.test(text)) return false;
    if (webTask && !asksServiceWorker && /service worker|web worker/.test(text)) return false;
    if (linkTask && !/файл|каталог|путь|символическ|symlink|filesystem|linux|unix/.test(q) && /символическ.*ссылк|symbolic link|symlink|удаление файла/.test(text)) return false;
    if (collapseTask && !hasCollectionObject && /свёртк|свертк|свернуть в одно значение|reduce|массив|список элементов/.test(text)) return false;
    if (buttonTask && !asksKeyboard && /keydown|keyup|клавиатур|keyboard/.test(text)) return false;
    if (buttonTask && !asksMouse && (text.includes('event.button') || /кнопку мыши|кнопка мыши/.test(text))) return false;
    if (buttonTask && !/ошиб|исключ|error|exception/.test(q) && /ошибка|исключение|error|exception|assertion/.test(text)) return false;
    if (buttonTask && !/отлад|devtools|inspect|диагност/.test(q) && /geteventlisteners|devtools/.test(text)) return false;
    if (buttonTask && !/всплыти|распростран|bubbling|propagation/.test(q) && /stoppropagation|остановить распространение/.test(text)) return false;
    if (linkTask && !asksServiceWorker && /service worker|кэш сразу|кеш сразу/.test(text)) return false;
    if (linkTask && !/worker|данн|json|api|fetch|запрос|сохран|сериализ/.test(q) && /web worker|service worker|сериализуем|передача больших данных|обработка данных/.test(text)) return false;
    if (linkTask && !/динамич|вставить|заменить|создать элемент/.test(q) && /insertadjacenthtml|replacechildren/.test(text)) return false;
    if (headingTask && !buttonTask && /кнопк/.test(text)) return false;
    if (hoverTask && !asksSpacing && /letter-spacing|line-height|white-space/.test(text)) return false;
    if (hoverTask && !asksSorting && /sort(?:ed|ing)?|сортир/.test(text)) return false;
    if (hoverTask && headingTask && !/список|маркер|list/.test(q) && /маркер списка|list marker/.test(text)) return false;
    if (collapseTask && !/свер|раскры|toggle|переключ|панел|sidebar|aside|details|summary|hidden|aria-expanded|display|visibility|overflow|classlist|скрыть|закрыть/.test(text)) return false;
    if (webTask && !asksFile && (text.includes('document.write') || /записать файл/.test(text))) return false;
    if (multiSourceTask && /источник узла|идентификатор источника узла|заголовок источника узла|описание источника узла/.test(text) && !/dom|узел|node/.test(q)) return false;
    if (multiSourceTask && /узл|node|indexeddb|localstorage|sessionstorage|ковариац|корреляц|статист/.test(text) && !/dom|узел|node|indexeddb|localstorage|хранилищ|корреляц|статист|ряд/.test(q)) return false;
    if (multiSourceTask && !asksServiceWorker && /service worker|web worker|push-сообщение/.test(text)) return false;
    if (multiSourceTask && !asksWriteData && /fetch post|метод post|post запрос|отправить данные на сервер/.test(text)) return false;
    if (multiSourceTask && !asksAuth && /учётные данные|учетные данные|credentials|authorization|авторизац/.test(text)) return false;
    if (multiSourceTask && !asksImage && /декодирован.*изображ|imagebitmap|blob|пиксел.*canvas/.test(text)) return false;
    if (multiSourceTask && !asksMarkup && /insertadjacenthtml|innerhtml|вставить html/.test(text)) return false;
    if (multiSourceTask && !asksAttributes && /атрибут|attributes/.test(text)) return false;
    if (multiSourceTask && !asksFirstSuccess && /promise\\.any|первый успешный промис/.test(text)) return false;
    return true;
  };
  const targetCompatible = target => {
    const key = normalize(target);
    if (buttonTask && !asksMouse && key.includes('event.button')) return false;
    if (key === 'disabled' && !/отключ|заблок|неактив|запрет|disable/.test(q)) return false;
    if (key === 'event.target' && !/делегир|всплыти|распростран|event.target|нажатый элемент|определить элемент/.test(q)) return false;
    if (hoverTask && key === 'textcontent' && !/изменить текст|обновить текст|заменить текст|текст при наведении/.test(q)) return false;
    if (linkTask && !asksServiceWorker && /serviceworker|service worker/.test(key)) return false;
    if (linkTask && /^(?:self|none)$/.test(key) && !/новом окне|вкладк|target|blank|self/.test(q)) return false;
    if (hoverTask && !asksSpacing && /letter-spacing|line-height|white-space/.test(key)) return false;
    if (hoverTask && !asksSorting && /^(?:sort|sorted|write)$/.test(key)) return false;
    if (multiSourceTask && key.includes('event.target') && !/клик|нажат|событ/.test(q)) return false;
    if (multiSourceTask && /^(?:sort|sorted)$/.test(key) && !asksSorting) return false;
    if (multiSourceTask && key.includes('math.floor') && !/округл|floor|дроб|десятичн|точност/.test(q)) return false;
    if (multiSourceTask && key === 'src' && !/изображен|картин|img|src|url/.test(q)) return false;
    if (collapseTask && !/подвал|footer|низ страницы/.test(q) && /^(?:<footer>|footer)$/.test(key)) return false;
    if (collapseTask && !/абзац|параграф|текст/.test(q) && /^(?:p|<p>)$/.test(key)) return false;
    if (collapseTask && key === 'with' && !/python|контекст|with/.test(q)) return false;
    if (collapseTask && /^(?:append|appendchild)$/.test(key) && !/добавить содержимое|вставить содержимое|append/.test(q)) return false;
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

  // Связи собираем из hit.pieces, но сам список кандидатов берём из rankedPieces:
  // иначе широкий набор фрагментов одной цели вытеснит ранжирование теневого индекса.
  const targetMemberships = new Map();
  for (const hit of directed?.hits || []) {
    for (const piece of hit.pieces || []) {
      if (!piece?.id || !hit.targetKey) continue;
      if (!targetMemberships.has(piece.id)) targetMemberships.set(piece.id, new Set());
      targetMemberships.get(piece.id).add(hit.targetKey);
    }
  }
  const rawRankedPieces = Array.isArray(directed?.rankedPieces) ? directed.rankedPieces : [];
  const makeCandidateMap = (source, ranked) => {
    const map = new Map();
    for (const piece of source) {
      if (!piece?.id) continue;
      const targets = new Set([
        ...(piece.matchedTargets || []),
        ...(targetMemberships.get(piece.id) || [])
      ]);
      const candidate = {
        ...piece, matchedTargets: [...targets],
        _rankPosition: ranked ? (Number(piece.position) || null) : null
      };
      const previous = map.get(piece.id);
      if (!previous || Number(candidate.combinedScore ?? candidate.score ?? 0) > Number(previous.combinedScore ?? previous.score ?? 0)) {
        map.set(piece.id, {
          ...candidate,
          matchedTargets: [...new Set([...(previous?.matchedTargets || []), ...candidate.matchedTargets])]
        });
      } else {
        previous.matchedTargets = [...new Set([...(previous.matchedTargets || []), ...candidate.matchedTargets])];
      }
    }
    return map;
  };
  let directedById = makeCandidateMap(rawRankedPieces, true);
  if (!directedById.size || ![...directedById.values()].some(inTaskScope)) {
    // Резервный путь только при пустом/непригодном rankedPieces.
    // Сохраняем порядок целей и релевантность фрагмента внутри каждой цели.
    const fallback = [];
    for (const [targetIndex, hit] of (directed?.hits || []).entries()) {
      for (const [pieceIndex, piece] of (hit.pieces || []).entries()) {
        if (!piece?.id) continue;
        fallback.push({
          ...piece, targetKey: hit.targetKey, targetScore: hit.score,
          targetPosition: targetIndex + 1, piecePositionWithinTarget: pieceIndex + 1,
          combinedScore: (Number(hit.score) || 0) * 1000 + (Number(piece.relevanceScore) || 0),
          matchedTargets: hit.targetKey ? [hit.targetKey] : []
        });
      }
    }
    directedById = makeCandidateMap(fallback, false);
  }
  const directedPieces = [...directedById.values()].filter(inTaskScope).sort((a, b) => {
    const rank = item => item._rankPosition ?? (-(item.combinedScore || 0));
    return rank(a) - rank(b) ||
      (a.targetPosition || Infinity) - (b.targetPosition || Infinity) ||
      (a.piecePositionWithinTarget || Infinity) - (b.piecePositionWithinTarget || Infinity) ||
      String(a.title || a.id).localeCompare(String(b.title || b.id), 'ru');
  }).slice(0, max).map(({ _rankPosition, ...piece }) => piece);

  directedPieces.forEach((piece, index) => {
    const item = ensure(piece.id);
    Object.assign(item, {
      title: piece.title || item.title, lang: piece.lang || item.lang,
      group: piece.group || item.group, desc: piece.desc || item.desc,
      tags: piece.tags || item.tags, aliases: piece.aliases || item.aliases
    });
    item._phraseRank = index + 1;
    item._rrf += 1.2 / (60 + index + 1);
    if (!item.sources.includes('направленные фразы')) item.sources.push('направленные фразы');
    const matchedTargets = Array.isArray(piece.matchedTargets) && piece.matchedTargets.length
      ? piece.matchedTargets : [piece.targetKey].filter(Boolean);
    for (const target of matchedTargets) {
      if (!item.matchedTargets.includes(target)) item.matchedTargets.push(target);
    }
    item.why.push({
      source: 'направленные фразы',
      targets: [...matchedTargets],
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
    if ((hit.why || []).some(reason => reason.in === 'название' && reason.kind === 'exact')) item._rrf += 0.006;
    else if ((hit.why || []).some(reason => reason.in === 'название/описание' && reason.kind === 'substring')) item._rrf += 0.003;
    if (!item.sources.includes('полнотекстовый поиск')) item.sources.push('полнотекстовый поиск');
    item.why.push({
      source: 'полнотекстовый поиск',
      lexicalRank: index + 1,
      matches: hit.why || []
    });
  });

  // Язык активного файла — мягкий контекстный сигнал, а не фильтр:
  // составная задача по-прежнему может вернуть HTML, CSS и JS вместе.
  for (const item of byId.values()) {
    item._languageMatch = Boolean(activeLanguage && canonicalLanguage(item.lang) === activeLanguage);
    item._rankScore = item._rrf * (item._languageMatch ? 1.12 : 1);
    if (item._languageMatch) item.why.push({
      source: 'контекст', reason: 'язык активного файла', language: item.lang, boost: 1.12
    });
  }
  const pieces = [...byId.values()].sort((a, b) =>
    b._rankScore - a._rankScore ||
    (a._phraseRank ?? Infinity) - (b._phraseRank ?? Infinity) ||
    (a._lexicalRank ?? Infinity) - (b._lexicalRank ?? Infinity) ||
    String(a.title).localeCompare(String(b.title), 'ru')
  ).slice(0, max).map((item, index) => ({
    id: item.id, title: item.title, lang: canonicalLanguage(item.lang || ''), group: item.group,
    desc: item.desc, tags: item.tags, aliases: item.aliases,
    score: round(item._rankScore), position: index + 1,
    contextBoost: item._languageMatch ? 'язык активного файла' : null,
    sources: item.sources, matchedTargets: item.matchedTargets,
    phraseRank: item._phraseRank, lexicalRank: item._lexicalRank, why: item.why
  }));

  const roots = (variants?.roots || []).filter(root => inScope(root) && targetCompatible(root.term));
  const rootByKey = new Map();
  // Корни уже отсортированы по релевантности; для одноимённых конструкций
  // сохраняем первый (лучший) языковой вариант, а не последний.
  for (const root of roots) {
    const key = canonicalTerm(root.term);
    if (!rootByKey.has(key)) rootByKey.set(key, root);
  }
  const targetHits = (directed?.hits || []).filter(hit => targetCompatible(hit.targetKey) && (hit.pieces || []).some(inTaskScope));
  const targets = targetHits.map(hit => {
    const root = rootByKey.get(canonicalTerm(hit.targetKey)) || null;
    const matchedPieces = (hit.pieces || []).filter(inTaskScope);
    return {
      targetKey: hit.targetKey,
      score: hit.score,
      phrases: hit.phrases || [],
      sections: hit.sections || [],
      pieceCount: matchedPieces.length,
      rootTerm: root?.term || hit.targetKey,
      rootLang: canonicalLanguage(root?.lang || matchedPieces[0]?.lang || '') || null
    };
  });

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
      directedRawPieces: (directed?.rankedPieces || []).length,
      directedRawLanguages: [...new Set((directed?.rankedPieces || []).map(piece => String(piece.lang || '')))].slice(0, 8),
      directedPieces: directedPieces.length,
      lexicalPieces: (library?.hits || []).filter(inTaskScope).length
    }
  };
}
