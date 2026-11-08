import { terms } from './search.mjs';

const normalize = value => String(value == null ? '' : value)
  .trim().toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/\s+/g, ' ');

// Убираем только грамматический шум. Отрицание, условия и смысловые предлоги сохраняем.
const STOP = new Set('и а но или что который которая которые которое это этот эта эти мне мне надо нужно хочу сделать сделай сделайте добавить добавь добавьте создать создай создайте чтобы который которая которое которые когда как'.split(' '));
const NEGATION = new Set(['не', 'без', 'нельзя', 'запрещено', 'кроме']);
// Общие существительные не должны сами по себе притягивать несвязанные конструкции.
const GENERIC_CONTEXT_TOKENS = new Set(['блок', 'элемент', 'текст', 'страниц', 'дан', 'объект', 'мест', 'результат', 'содержим', 'част', 'област', 'на']);
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
  const qUi = /панел|блок|раздел|страниц|sidebar|меню|вкладк|шапк|заголов|кнопк|ссылк|надпис|карточк|поле|форм/.test(q);
  const qCollection = /массив|список|коллекц|последовательност/.test(q);
  const pUi = /панел|блок|раздел|страниц|sidebar|меню|вкладк|шапк|заголов|кнопк|ссылк|надпис|карточк|поле|форм/.test(p);
  const pCollection = /массив|список|коллекц|последовательност/.test(p);
  const qInside = /внутр/.test(q), qOutside = /снаруж/.test(q);
  const pInside = /внутр/.test(p), pOutside = /снаруж/.test(p);
  const qSpacing = /отступ|padding|margin/.test(q);
  if (qSpacing && (target === 'in' || target.endsWith('appendchild') || target.endsWith('textcontent'))) return true;
  const qList = /спис|массив|\blist\b/.test(q);
  const qArray = /массив|\barray\b/.test(q);
  if(qList && !qArray && target === 'array') return true;
  const qDict = /словар|\bdict\b|\bdictionary\b/.test(q);
  if (qList && !qDict && /^(?:dict(?:\.|\(|$)|\*\*x$|\|$)/.test(target)) return true;
  if (qDict && !qList && /^list(?:\.|\(|$)/.test(target)) return true;
  const qFloor = /округл.*вниз|в меньшую сторону|round down/.test(q);
  if (qFloor && /^(?:round(?:\(|$)|math\.round|tofixed)/.test(target)) return true;
  const qDecimalPlaces = /до (?:двух|трех|трёх|\d+) знаков|после запятой|decimal places|decimals/.test(q);
  if (qDecimalPlaces && /^(?:math\.floor|floor|math\.trunc|trunc|math\.round)$/.test(target)) return true;
  if ((qInside && !qOutside && pOutside && !pInside) || (qOutside && !qInside && pInside && !pOutside)) return true;
  if ((qInside && !qOutside && !pInside) || (qOutside && !qInside && !pOutside)) return true;
  const qThickness = /толщин|жирност/.test(q), qSize = /размер/.test(q);
  const pThickness = /толщин|жирност/.test(p), pSize = /размер/.test(p);
  if ((qThickness && !qSize && pSize && !pThickness) || (qSize && !qThickness && pThickness && !pSize)) return true;
  const qLetters = /межбуквен|букв/.test(q), qLines = /межстроч|межстрочн|строк/.test(q);
  const pLetters = /межбуквен|букв/.test(p), pLines = /межстроч|межстрочн|строк/.test(p);
  if ((qLetters && !qLines && pLines && !pLetters) || (qLines && !qLetters && pLetters && !pLines)) return true;
  const qPreserve = /сохрани|оставить место|не терять место|без удаления места/.test(q);
  const qFlow = /из потока|убрать из потока/.test(q);
  const pPreserve = /сохрани|оставить место|не терять место|без удаления места/.test(p);
  const pFlow = /из потока|убрать из потока/.test(p);
  if ((qPreserve && !qFlow && pFlow && !pPreserve) || (qFlow && !qPreserve && pPreserve && !pFlow)) return true;
  if (target.startsWith('display') && qPreserve && !pPreserve) return true;
  if (target.startsWith('visibility') && qFlow && !pFlow) return true;
  const qHover = /наведен|hover/.test(q), qClick = /нажат|клик|click/.test(q);
  const pHover = /наведен|hover/.test(p), pClick = /нажат|клик|click/.test(p);
  if ((qHover && !qClick && pClick && !pHover) || (qClick && !qHover && pHover && !pClick)) return true;
  const qText = /текст/.test(q), qElements = /элемент/.test(q);
  const pText = /текст/.test(p), pElements = /элемент/.test(p);
  if ((qText && !qElements && pElements && !pText) || (qElements && !qText && pText && !pElements)) return true;
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
  if (target.includes('assert') && !/провер|утверж|услов|assert|допущен/.test(q)) return true;
  if (/(?:raise|throw|exception|valueerror|error)/.test(target) && !/ошиб|исключ|error|exception|raise|throw/.test(q)) return true;
  if ((target.includes('console.log') || target.includes('console.error') || target === 'print') && !/консол|вывод|напечат|print/.test(q)) return true;
  if (target.includes('insert into') && !/баз|таблиц|sql|запис|insert/.test(q)) return true;
  if ((target === 'import' || target.startsWith('import ')) && !/импорт|модул|библиотек|подключ/.test(q)) return true;
  if (/(?:^|[.])try|catch|except|finally|^pass$/.test(target) && qUi && !/ошиб|исключ|error|exception|try|catch|except|finally|код/.test(q)) return true;
  if ((target === 'open' || target.startsWith('open(') || /read_csv|readfile|read_file|writefile|write_file/.test(target)) && qUi && !/файл|путь|каталог|csv|кодиров|прочит|запис|открыть файл/.test(q)) return true;
  if ((target === 'str' || target === 'string' || target === 's*n') && qUi && !/строк|тип str|преобразовать|умножить строку/.test(q)) return true;
  if (target === 'headers' && /шапк|заголов/.test(q) && !/http|запрос|ответ|заголовки http/.test(q)) return true;
  if ((target === 'pre' || target === '<pre>') && qUi && !/код|пример|предформат/.test(q)) return true;
  if (target === 'value' && qUi && !/поле|input|значение|выбран|ввод/.test(q)) return true;
  if (target === 'from' && qUi && !(/импорт|модул/.test(q) || q.includes('from '))) return true;
  if (target === 'number' && qUi && !/число|числов|number|количеств/.test(q)) return true;
  if (target === 'select' && qUi && !/выбрать|выпадающ|список вариантов|select|поле выбора/.test(q)) return true;
  if ((target.includes('!r') || target.includes('repr') || target.includes('f"')) && qUi && !/формат|представлен|repr|f-string|отладк/.test(q)) return true;
  if ((target === 'canvas' || target === '<canvas>') && qUi && !/рисован|canvas|график|изображен/.test(q)) return true;
  if (target === 'text-align' && !/выровнять|по центру|text-align|align/.test(q)) return true;
  const qCollapse = /свер|раскры|открыть|collapse|expand/.test(q);
  if ((target === 'div' || target === '<div>') && qCollapse && !/раскрывающ|свернуть блок|раскрыть блок|toggle|aria-expanded/.test(p)) return true;
  const qColor = /цвет|фон|тень|скруг|подсвет|границ|прозрачн/.test(q);
  const qTypography = /шрифт|размер|жирн|наклон|подчерк/.test(q);
  const qAnimation = /анимац|плавн/.test(q);
  if (/^(?:box-shadow|border-radius|background-color|opacity)$/.test(target) && !qColor) return true;
  if (target === 'animation' && !qAnimation) return true;
  if (/^(?:font-size|font-weight|font-style|text-decoration|text-shadow|text-transform)$/.test(target) && !qTypography) return true;
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
  if (qt.length === 1 && pt[0] === qt[0]) return { score: 86, kind: 'query-token-prefix', matchedTokens: qt, phraseCoverage: 1, queryCoverage: 1 };
  if (q.includes(' ' + p + ' ' ) || q.startsWith(p + ' ') || q.endsWith(' ' + p))
    return { score: 88, kind: 'phrase-contained', matchedTokens: pt, phraseCoverage: 1, queryCoverage: 1 };

  const qSet = new Set(qt);
  const matched = UNIQUE(pt.filter(token => qSet.has(token)));
  if (!matched.length) return null;
  const target = normalize(targetKey);
  const structuralCollapse = /details|summary/.test(target) && /свер|раскры|collapse|expand/.test(q);
  const bottomRegion = /footer/.test(target) && /внизу|нижн|подвал|footer/.test(q);
  if (qt.length > 1 && matched.every(token => GENERIC_CONTEXT_TOKENS.has(token)) && !structuralCollapse && !bottomRegion) return null;

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
  const score = pt.length === 1 && qt.length > 1
    ? Math.round(40 + 40 * queryCoverage)
    : Math.round(35 * phraseCoverage + 25 * queryCoverage + 20 * orderCoverage);
  if (phraseCoverage < 0.5 || score < 35) return null;
  return {
    score: Math.min(84, score),
    kind: 'partial',
    matchedTokens: matched,
    phraseCoverage: Math.round(phraseCoverage * 100) / 100,
    queryCoverage: Math.round(queryCoverage * 100) / 100
  };
}
