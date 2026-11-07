// Теневой индекс направленных поисковых фраз legacy-словаря и отдельного хранилища понятий.
// Не меняет рабочий поиск: строит кандидатов и связывает их с проверяемыми фрагментами.
import { matchQueryPhrase, queryTokens } from './query-phrase-match.mjs';

const normalize = value => String(value == null ? '' : value)
  .trim().toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/\s+/g, ' ');
const canonicalLanguage = value => {
  const lang = normalize(value);
  return ({ javascript: 'js', node: 'js', typescript: 'ts', python3: 'python', html5: 'html', css3: 'css' })[lang] || lang;
};
const QUERY_LANGUAGE_HINTS = [
  ['ts', /\\b(?:typescript|ts)\\b|тайпскрипт/],
  ['js', /\\b(?:javascript|js|node(?:\\.js)?)\\b|яваскрипт/],
  ['python', /\\bpython(?:3)?\\b|питон/],
  ['sql', /\\bsql\\b/],
  ['css', /\\bcss\\b/],
  ['html', /\\bhtml\\b/],
  ['svg', /\\bsvg\\b/],
  ['sh', /\\b(?:bash|shell)\\b|оболочк/]
];
function inferQueryLanguage(query) {
  const matches = new Set(QUERY_LANGUAGE_HINTS.filter(([, pattern]) => pattern.test(query)).map(([lang]) => lang));
  return matches.size === 1 ? [...matches][0] : '';
}
const scopeLanguages = scope => normalize(scope) === 'web'
  ? new Set(['html', 'css', 'js', 'ts', 'svg'])
  : normalize(scope) === 'python' ? new Set(['python']) : null;

const EXCLUDED_PHRASE_TARGETS = new Set([
  'стрелочная функция\u0000lambda',
  'стрелочная функция\u0000lambda x',
  'найти элемент по id\u0000id'
]);

function pieceMatchesTarget(targetKey, phrase, piece, usage) {
  const target = normalize(targetKey);
  const q = normalize(phrase);
  if (EXCLUDED_PHRASE_TARGETS.has(q + '\u0000' + target)) return false;

  const code = typeof usage?.pieceText === 'function' ? String(usage.pieceText(piece.id) || '') : '';
  if (!code) return true; // совместимость с изолированными тестовыми адаптерами

  // Одного токена «a» недостаточно: в HTML он встречается в значениях атрибутов
  // (например, label="A"). Теговая цель должна присутствовать именно как разметка.
  const htmlTag = target.match(/^<([a-z][a-z0-9-]*)>$/);
  if (htmlTag) {
    const tag = htmlTag[1];
    const tagPattern = new RegExp('<\\s*' + tag + '(?=[\\s/>])|</\\s*' + tag + '\\s*>', 'i');
    return normalize(piece.lang) === 'html' && tagPattern.test(code);
  }

  // Ключи вроде display/open/join встречаются в посторонних конструкциях.
  // Здесь оставляем только тот синтаксический смысл, который описывает фраза.
  if (target === 'display' && (q === 'скрыть элемент' || q === 'скрыть элемент из потока')) return /\bdisplay\s*:\s*none\b/i.test(code);
  if (target === 'visibility' && (q === 'скрыть но оставить место' || q === 'спрятать элемент, сохранив место')) return /\bvisibility\s*:\s*hidden\b/i.test(code);
  if (target === 'float' && q === 'обтекание изображения текстом') return normalize(piece.lang) === 'css' && /\bfloat\s*:/i.test(code);
  if (target === '@media' && q === 'медиазапрос для телефона') return /@media\s*\([^)]*(?:max-width|width\s*[<>=])/i.test(code);
  if (target === 'parse' && q === 'разобрать json') return /\bJSON\s*\.\s*parse\s*\(/i.test(code);
  if (target === 'stringify' && q === 'сериализовать в json') return /\bJSON\s*\.\s*stringify\s*\(/i.test(code);
  if (target === 'addeventlistener' && q === 'подписаться на клик') return /\baddEventListener\s*\(\s*['"]click['"]/i.test(code);
  if (target === 'max-width' && q === 'ограничить ширину') return /(?<!\()\bmax-width\s*:/i.test(code);
  if (target === 'open' && q.startsWith('открыть файл')) {
    return normalize(piece.lang) === 'python' && /\bopen\s*\(/i.test(code);
  }
  if (target === 'with' && q.includes('открыть файл')) {
    return normalize(piece.lang) === 'python' && /\bwith\s+(?:aiofiles\.)?open\s*\(/i.test(code);
  }
  if (target === 'str.join(it)' && q.startsWith('join')) {
    return normalize(piece.lang) === 'python' && /\.\s*join\s*\(\s*[^)\s]/i.test(code);
  }
  if (target === 'float' && q === 'число с плавающей точкой') {
    return normalize(piece.lang) === 'python';
  }
  if (target.startsWith('copy.copy(') && q.startsWith('поверхностная копия')) {
    return normalize(piece.lang) === 'python' && /\bcopy\.copy\s*\(/i.test(code);
  }
  if (target === 'dict.copy()' && q.startsWith('поверхностная копия словаря')) {
    return normalize(piece.lang) === 'python' && !/\bimport\s+pandas\b|\bpd\.dataframe\b/i.test(code) &&
      (/\bdict\b/.test(code) || /\{\s*[^}]+:\s*[^}]+\}\s*\.\s*copy\s*\(/i.test(code));
  }
  return true;
}

const conceptIdentity = targetKey => normalize(targetKey).replace(/\([^()]*\)$/, '');
function overlap(text, phraseWords) {
  if (!phraseWords.size) return 0;
  const haystack = new Set(queryTokens(text));
  let common = 0;
  for (const word of phraseWords) if (haystack.has(word)) common++;
  return common / phraseWords.size;
}

function pieceRelevanceScore(piece, phrases) {
  const title = normalize(piece.title);
  const desc = normalize(piece.desc);
  const extra = normalize([piece.group, ...(piece.tags || []), ...(piece.aliases || [])].join(' '));
  let best = 0;
  for (const record of phrases) {
    const phrase = normalize(record.phrase);
    const phraseWords = new Set(queryTokens(phrase));
    let score = title === phrase ? 150 : title.includes(phrase) ? 120 : Math.round(70 * overlap(title, phraseWords));
    score += desc.includes(phrase) ? 40 : Math.round(25 * overlap(desc, phraseWords));
    score += Math.round(15 * overlap(extra, phraseWords));
    best = Math.max(best, score);
  }
  return best;
}

export function createLegacyQueryPhraseShadow({ queryPhrases = [], usage = null } = {}) {
  const byPhrase = new Map();
  for (const item of queryPhrases) {
    if (!item || !item.targetKey || !item.phrase) continue;
    const phrase = normalize(item.phrase);
    if (!phrase) continue;
    if (!byPhrase.has(phrase)) byPhrase.set(phrase, []);
    byPhrase.get(phrase).push(item);
  }

  const termLocations = new Map();
  for (const [section, terms] of Object.entries(usage?.terms || {})) {
    for (const key of Object.keys(terms || {})) {
      const normalized = normalize(key);
      if (!termLocations.has(normalized)) termLocations.set(normalized, []);
      termLocations.get(normalized).push({ section, key });
    }
  }

  function search(query, { language = '', scope = '', limit = 60 } = {}) {
    const q = normalize(query);
    if (!q) return { query: q, total: 0, hits: [], rankedPieces: [], ambiguous: false };
    const effectiveLanguage = language ? canonicalLanguage(language) : inferQueryLanguage(q);
    const grouped = new Map();
    const allowedLanguages = scopeLanguages(scope);

    for (const [phrase, records] of byPhrase) {
      for (const record of records) {
        const match = matchQueryPhrase(q, phrase, record.targetKey);
        if (!match) continue;
        const score = match.score;
        const recordLanguage = normalize(record.language);
        const recordScope = normalize(record.scope);
        if (recordLanguage && effectiveLanguage && canonicalLanguage(recordLanguage) !== effectiveLanguage) continue;
        if (allowedLanguages && recordLanguage && !allowedLanguages.has(canonicalLanguage(recordLanguage))) continue;
        if (recordScope && scope && recordScope !== normalize(scope) && !(allowedLanguages && allowedLanguages.has(canonicalLanguage(recordScope)))) continue;
        const key = record.targetKey;
        if (!grouped.has(key)) grouped.set(key, { targetKey: key, score, phrases: [], sections: [], pieces: [] });
        const hit = grouped.get(key);
        hit.score = Math.max(hit.score, score);
        if (!hit.phrases.some(x => x.id === record.id)) hit.phrases.push({
          id: record.id, phrase: record.phrase, language: record.language || '',
          scope: record.scope || '', note: record.note || '', source: record.source || null, match
        });
      }
    }

    for (const hit of grouped.values()) {
      const lookupKeys = [normalize(hit.targetKey)];
      // HTML tag names in the dictionary are bare, while imported phrase targets may be wrapped.
      const htmlTag = lookupKeys[0].match(/^<([a-z][a-z0-9-]*)>$/);
      if (htmlTag) lookupKeys.push(htmlTag[1]);
      const locations = [...new Map(
        lookupKeys.flatMap(key => termLocations.get(key) || [])
          .filter(location => !htmlTag || location.section === 'html')
          .map(location => [location.section + '|' + location.key, location])
      ).values()];
      for (const location of locations) {
        // Секция словаря может быть общей (например, base words); язык определяем по самому фрагменту.
        const ids = usage.piecesOf(location.section, location.key);
        for (const id of ids) {
          if (hit.pieces.some(piece => piece.id === id)) continue;
          const piece = usage.pieceInfo(id);
          if (!piece) continue;
          if (effectiveLanguage && canonicalLanguage(piece.lang) !== effectiveLanguage) continue;
          if (allowedLanguages && !allowedLanguages.has(canonicalLanguage(piece.lang))) continue;
          const relevant = hit.phrases.some(record =>
            pieceMatchesTarget(hit.targetKey, record.phrase, piece, usage)
          );
          if (!relevant) continue;
          if (!hit.sections.includes(location.section)) hit.sections.push(location.section);
          hit.pieces.push({ ...piece, relevanceScore: pieceRelevanceScore(piece, hit.phrases) });
        }
      }
      hit.phrases.sort((a, b) => (b.match?.score || 0) - (a.match?.score || 0) || a.phrase.localeCompare(b.phrase, 'ru'));
      hit.sections.sort();
      hit.pieces.sort((a, b) =>
        b.relevanceScore - a.relevanceScore ||
        String(a.title || a.id).localeCompare(String(b.title || b.id), 'ru')
      );
    }

    // Цель без единого реального фрагмента не является результатом поиска по библиотеке.
    const hits = [...grouped.values()].filter(hit => hit.pieces.length > 0).sort((a, b) =>
      b.score - a.score || a.targetKey.localeCompare(b.targetKey, 'ru')
    );
    const rankedById = new Map();
    for (const [targetPosition, hit] of hits.entries()) {
      for (const [piecePosition, piece] of hit.pieces.entries()) {
        const candidate = {
          ...piece, targetKey: hit.targetKey, targetScore: hit.score,
          targetPosition: targetPosition + 1, piecePositionWithinTarget: piecePosition + 1,
          combinedScore: hit.score * 1000 + piece.relevanceScore
        };
        const previous = rankedById.get(piece.id);
        if (!previous || candidate.combinedScore > previous.combinedScore) {
          rankedById.set(piece.id, { ...candidate, matchedTargets: [...(previous?.matchedTargets || []), hit.targetKey] });
        } else if (!previous.matchedTargets.includes(hit.targetKey)) {
          previous.matchedTargets.push(hit.targetKey);
        }
      }
    }
    const rankedPieces = [...rankedById.values()].sort((a, b) =>
      b.combinedScore - a.combinedScore ||
      String(a.title || a.id).localeCompare(String(b.title || b.id), 'ru')
    ).map((piece, index) => ({ ...piece, position: index + 1 }));

    return {
      query: q,
      total: hits.length,
      ambiguous: new Set(hits.map(hit => conceptIdentity(hit.targetKey))).size > 1,
      hits: hits.slice(0, Math.max(1, Math.min(200, Number(limit) || 60))),
      rankedPieces: rankedPieces.slice(0, Math.max(1, Math.min(200, Number(limit) || 60)))
    };
  }

  return { search, phraseCount: [...byPhrase.values()].reduce((n, list) => n + list.length, 0) };
}
