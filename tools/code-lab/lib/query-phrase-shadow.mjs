// Теневой индекс направленных поисковых фраз legacy-словаря.
// Не меняет ни словари, ни рабочий поиск: только строит кандидатов по targetKey.
const normalize = value => String(value == null ? '' : value)
  .trim().toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/\s+/g, ' ');

function phraseScore(query, phrase) {
  if (query === phrase) return 100;
  if (phrase.startsWith(query)) return 85;
  if (phrase.includes(query)) return 75;
  if (query.startsWith(phrase)) return 65;
  if (query.includes(phrase)) return 55;
  return 0;
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
    if (!q) return { query: q, total: 0, hits: [], ambiguous: 0 };
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
        if (!hit.sections.includes(location.section)) hit.sections.push(location.section);
        const ids = usage.piecesOf(location.section, location.key);
        for (const id of ids) {
          if (hit.pieces.some(piece => piece.id === id)) continue;
          const piece = usage.pieceInfo(id);
          if (piece) hit.pieces.push(piece);
        }
      }
      hit.phrases.sort((a, b) => a.phrase.localeCompare(b.phrase, 'ru'));
      hit.sections.sort();
      hit.pieces.sort((a, b) => String(a.title || a.id).localeCompare(String(b.title || b.id), 'ru'));
    }

    const hits = [...grouped.values()].sort((a, b) =>
      b.score - a.score || a.targetKey.localeCompare(b.targetKey, 'ru')
    );
    return {
      query: q,
      total: hits.length,
      ambiguous: hits.filter(hit => hit.phrases.length > 1).length,
      hits: hits.slice(0, Math.max(1, Math.min(200, Number(limit) || 60)))
    };
  }

  return { search, phraseCount: [...byPhrase.values()].reduce((n, list) => n + list.length, 0) };
}
