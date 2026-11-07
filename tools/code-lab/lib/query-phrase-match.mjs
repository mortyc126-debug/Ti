import { terms } from './search.mjs';

const normalize = value => String(value == null ? '' : value)
  .trim().toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/\s+/g, ' ');

// Убираем только грамматический шум. Отрицание, условия и смысловые предлоги сохраняем.
const STOP = new Set('и а но или что который которая которые которое это этот эта эти мне мне надо нужно хочу сделать сделай сделайте добавить добавь добавьте создать создай создайте чтобы который которая которое которые когда как'.split(' '));
const NEGATION = new Set(['не', 'без', 'нельзя', 'запрещено', 'кроме']);
const UNIQUE = values => [...new Set(values)];
const RAW_WORD = /[\p{L}\p{N}]+(?:[-_][\p{L}\p{N}]+)*/gu;
const rawWords = value => normalize(value).match(RAW_WORD) || [];
const rawNegations = value => rawWords(value).filter(token => NEGATION.has(token));
const TOKEN_CACHE = new Map();
function cachedTokens(value) {
  const key = normalize(value);
  if (TOKEN_CACHE.has(key)) return TOKEN_CACHE.get(key);
  const result = UNIQUE(rawWords(key).filter(word => !STOP.has(word)).flatMap(word => terms(word)).filter(token => token.length > 1));
  if (TOKEN_CACHE.size >= 30000) TOKEN_CACHE.delete(TOKEN_CACHE.keys().next().value);
  TOKEN_CACHE.set(key, result);
  return result;
}
export function queryTokens(value) {
  return cachedTokens(value).slice();
}

function contextConflict(query, phrase, targetKey) {
  const q = normalize(query), p = normalize(phrase), target = normalize(targetKey);
  const qUi = /панел|блок|раздел|страниц|sidebar|меню|вкладк/.test(q);
  const qCollection = /массив|список|коллекц|последовательност/.test(q);
  const pUi = /панел|блок|раздел|страниц|sidebar|меню|вкладк/.test(p);
  const pCollection = /массив|список|коллекц|последовательност/.test(p);
  if (/(?:^|[.])reduce|fold/.test(target) && qUi && !qCollection) return true;
  if (/(?:details|summary)/.test(target) && qCollection && !qUi) return true;
  const qLink = /ссылк|переход|href|url/.test(q);
  const qButton = /кнопк|button/.test(q);
  if (qLink && /кнопк|button/.test(p) && !qButton) return true;
  if (qButton && /ссылк|href|переход/.test(p) && !qLink) return true;
  if ((target.includes('<button>') || target === 'button' || target.startsWith('button[')) && qLink && !qButton) return true;
  if ((target === 'a' || target.includes('href')) && qButton && !qLink) return true;
  if (qUi && pCollection && !pUi && !qCollection) return true;
  if (qCollection && pUi && !pCollection && !qUi) return true;
  return false;
}

export function matchQueryPhrase(query, phrase, targetKey = '') {
  const q = normalize(query), p = normalize(phrase);
  if (!q || !p) return null;
  if (contextConflict(q, p, targetKey)) return null;
  const qt = cachedTokens(q), pt = cachedTokens(p);
  if (!qt.length || !pt.length) return null;
  const qNeg = rawNegations(q);
  const pNeg = rawNegations(p);
  if (qNeg.length !== pNeg.length || qNeg.some(token => !pNeg.includes(token))) return null;

  if (q === p) return { score: 100, kind: 'exact', matchedTokens: pt, phraseCoverage: 1, queryCoverage: 1 };
  if (p.startsWith(q + ' ')) return { score: 90, kind: 'query-prefix', matchedTokens: qt, phraseCoverage: 1, queryCoverage: 1 };
  if (q.includes(' ' + p + ' ' ) || q.startsWith(p + ' ') || q.endsWith(' ' + p))
    return { score: 88, kind: 'phrase-contained', matchedTokens: pt, phraseCoverage: 1, queryCoverage: 1 };

  const qSet = new Set(qt);
  const matched = UNIQUE(pt.filter(token => qSet.has(token)));
  if (!matched.length) return null;

  const phraseCoverage = matched.length / pt.length;
  const queryCoverage = matched.length / qt.length;
  // Одиночный общий короткий токен слишком часто даёт ложные связи.
  if (matched.length === 1 && pt.length > 1 && matched[0].length < 4) return null;

  let ordered = 0;
  let cursor = 0;
  for (const token of matched) {
    const index = pt.indexOf(token, cursor);
    if (index >= 0) { ordered++; cursor = index + 1; }
  }
  const orderCoverage = ordered / Math.max(1, matched.length);
  const score = Math.round(35 * phraseCoverage + 25 * queryCoverage + 20 * orderCoverage);
  if (phraseCoverage < 0.5 || score < 35) return null;
  return {
    score: Math.min(84, score),
    kind: 'partial',
    matchedTokens: matched,
    phraseCoverage: Math.round(phraseCoverage * 100) / 100,
    queryCoverage: Math.round(queryCoverage * 100) / 100
  };
}
