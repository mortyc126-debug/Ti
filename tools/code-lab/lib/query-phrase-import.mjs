import { createHash } from 'node:crypto';
import { validateConceptStore } from './concept-model.mjs';

const normalize = value => String(value || '').trim().toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/\s+/g, ' ');
const stableId = (prefix, value) => prefix + createHash('sha256').update(String(value)).digest('hex').slice(0, 20);

// Преобразует направленный legacy-словарь «ключ → фразы запроса»
// в отдельные записи queryPhrases. Не создаёт фиктивные понятия и ничего не записывает на диск.
export function buildLegacyQueryPhraseImport(source, { sourceFile = 'public/dict/synonyms.json' } = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new TypeError('Ожидается объект legacy-словаря');
  const queryPhrases = [], warnings = [], owners = new Map();
  let sourceKeys = 0, sourcePhrases = 0, skipped = 0;
  for (const [key, values] of Object.entries(source)) {
    sourceKeys++;
    if (!Array.isArray(values)) {
      warnings.push({ key, reason: 'Значения ключа должны быть массивом' });
      skipped++;
      continue;
    }
    values.forEach((phrase, index) => {
      if (typeof phrase !== 'string' || !phrase.trim()) {
        warnings.push({ key, index, reason: 'Пустая или нестроковая поисковая фраза' });
        skipped++;
        return;
      }
      sourcePhrases++;
      const clean = phrase.trim();
      const id = stableId('legacy-query-', key + '\u0000' + index + '\u0000' + clean);
      queryPhrases.push({
        id,
        phrase: clean,
        targetKey: key,
        language: '',
        scope: '',
        origin: 'import',
        source: { file: sourceFile, key, index },
        note: 'Направленная поисковая формулировка из legacy-словаря; не синоним ключа.'
      });
      const n = normalize(clean);
      if (!owners.has(n)) owners.set(n, new Set());
      owners.get(n).add(key);
    });
  }
  const ambiguous = [...owners].filter(([, keys]) => keys.size > 1);
  const manifest = { schemaVersion: 2, concepts: [], relations: [], queryPhrases };
  const validation = validateConceptStore(manifest);
  if (!validation.valid) {
    const error = new Error('Пробный импорт не прошёл проверку модели');
    error.validation = validation;
    throw error;
  }
  return {
    manifest,
    stats: {
      sourceKeys,
      sourcePhrases,
      importedPhrases: queryPhrases.length,
      skipped,
      uniquePhrases: owners.size,
      ambiguousPhrases: ambiguous.length,
      maxTargetsPerPhrase: Math.max(0, ...ambiguous.map(([, keys]) => keys.size)),
      warnings: warnings.length,
      validationWarnings: validation.warnings.length
    },
    warnings
  };
}
