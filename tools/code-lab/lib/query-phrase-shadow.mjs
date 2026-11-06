// Теневой индекс направленных поисковых фраз legacy-словаря.
// Не меняет ни словари, ни рабочий поиск: строит кандидатов и связывает их с проверяемыми фрагментами.
const normalize = value => String(value == null ? '' : value)
  .trim().toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/\s+/g, ' ');

function phraseScore(query, phrase) {
  if (query === phrase) return 100;
  // Префиксное расширение полезно для уточнённых формулировок, но короткие
  // однословные запросы не должны размножать десятки частных понятий.
  if (query.includes(' ') && phrase.startsWith(query + ' ')) return 85;
  return 0;
}

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

  // Ключи вроде display/open/join встречаются в посторонних конструкциях.
  // Здесь оставляем только тот синтаксический смысл, который описывает фраза.
  if (target === 'display' && q === 'скрыть элемент') return /\bdisplay\s*:\s*none\b/i.test(code);
  if (target === 'visibility' && q === 'скрыть но оставить место') return /\bvisibility\s*:\s*hidden\b/i.test(code);
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
  return true;
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
    if (!q) return { query: q, total: 0, hits: [], ambiguous: false };
    const grouped = new Map();

    for (const [phrase, records] of byPhrase) {
      const score = phraseScore(q, phrase);
      if (!score) continue;
      for (const record of records) {
        const recordLanguage = normalize(record.language);
        const recordScope = normalize(record.scope);
        if (recordLanguage && language && recordLanguage !== normalize(language)) continue;
        if (recordScope && scope && recordScope !== normalize(scope)) continue;
        const key = record.targetKey;
        if (!grouped.has(key)) grouped.set(key, { targetKey: key, score, phrases: [], sections: [], pieces: [] });
        const hit = grouped.get(key);
        hit.score = Math.max(hit.score, score);
        if (!hit.phrases.some(x => x.id === record.id)) hit.phrases.push({
          id: record.id, phrase: record.phrase, language: record.language || '',
          scope: record.scope || '', note: record.note || '', source: record.source || null
        });
      }
    }

    for (const hit of grouped.values()) {
      for (const location of termLocations.get(normalize(hit.targetKey)) || []) {
        const ids = usage.piecesOf(location.section, location.key);
        for (const id of ids) {
          if (hit.pieces.some(piece => piece.id === id)) continue;
          const piece = usage.pieceInfo(id);
          if (!piece) continue;
          const relevant = hit.phrases.some(record =>
            pieceMatchesTarget(hit.targetKey, record.phrase, piece, usage)
          );
          if (!relevant) continue;
          if (!hit.sections.includes(location.section)) hit.sections.push(location.section);
          hit.pieces.push(piece);
        }
      }
      hit.phrases.sort((a, b) => a.phrase.localeCompare(b.phrase, 'ru'));
      hit.sections.sort();
      hit.pieces.sort((a, b) => String(a.title || a.id).localeCompare(String(b.title || b.id), 'ru'));
    }

    // Цель без единого реального фрагмента не является результатом поиска по библиотеке.
    const hits = [...grouped.values()].filter(hit => hit.pieces.length > 0).sort((a, b) =>
      b.score - a.score || a.targetKey.localeCompare(b.targetKey, 'ru')
    );
    return {
      query: q,
      total: hits.length,
      ambiguous: hits.length > 1,
      hits: hits.slice(0, Math.max(1, Math.min(200, Number(limit) || 60)))
    };
  }

  return { search, phraseCount: [...byPhrase.values()].reduce((n, list) => n + list.length, 0) };
}
