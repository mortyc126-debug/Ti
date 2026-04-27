import { findMetricByAlias, METRICS } from './metrics.js';

// Парсер строки запроса в SearchBar.
//
// На входе: «газпром YTM > 20% срок < 2 лет»
// На выходе:
//   {
//     conditions: [{metric, op, value, unit, raw}, ...],
//     freeText: 'газпром',
//   }
//
// Стратегия: ищем все вхождения шаблона
//   <alias-метрики> <оператор> <число> <необязательная-единица>
// итеративно. Что осталось — это freeText для fuzzy-поиска по именам.
//
// Поддерживаемые операторы: < <= > >= = == ≤ ≥
// Единицы: %, x (×), года/лет/y/yr, мес/m, дн/d, млрд/млн/k/m/b
//
// Намеренно простой regex-подход (не настоящий парсер) — этого
// достаточно для 95% запросов. Если когда-нибудь упрёмся в скобки/OR —
// перепишем.

const OP_RE = '(?:<=|>=|<|>|==|=|≤|≥)';
// число: 1.5, .5, 1,5, 100, -2.3
const NUM_RE = '(-?\\d+(?:[.,]\\d+)?|\\.\\d+)';
// единица: %, x, ×, года/лет/year/yr/y, мес/m/months, дн/d/days, млрд/млн/b/k
const UNIT_RE = '\\s*(%|x|×|years?|yr|y|год[а]?|лет|г|мес\\.?|месяц[а-я]*|m|months?|дн[ейй]*|d|days?|млрд|млн|b|k)?';

// Все известные алиасы, отсортированные по убыванию длины — самый
// длинный матчится первым (чтобы «ND/EBITDA» победил «EBITDA»).
function buildAliasPattern(){
  const all = new Set();
  for(const m of METRICS){
    for(const a of m.aliases) all.add(a);
  }
  const sorted = [...all].sort((a, b) => b.length - a.length);
  // экранируем regex-метасимволы внутри алиасов: /, ., точки, скобки
  return sorted.map(a => a.replace(/[-/\\^$.*+?()[\]{}|]/g, '\\$&')).join('|');
}

const ALIAS_PATTERN = buildAliasPattern();
// «alias» «op» «num» «unit?», все группы фиксированы.
// 'i' для регистронезависимости, 'u' для unicode (русский).
const COND_RE = new RegExp(
  `\\b(${ALIAS_PATTERN})\\s*(${OP_RE})\\s*${NUM_RE}${UNIT_RE}`,
  'giu'
);

const OP_NORM = { '=': '==', '==': '==', '<': '<', '>': '>', '<=': '<=', '>=': '>=', '≤': '<=', '≥': '>=' };

const UNIT_NORM = u => {
  if(!u) return null;
  const v = u.toLowerCase();
  if(v === '%') return '%';
  if(v === 'x' || v === '×') return 'x';
  if(/^(years?|yr|y|год[а]?|лет|г)$/.test(v)) return 'years';
  if(/^(m|месяц|месяца|месяцев|мес|months?)$/.test(v)) return 'months';
  if(/^(d|дн|дней|day|days)$/.test(v)) return 'days';
  if(v === 'млрд' || v === 'b') return 'rub';
  if(v === 'млн') return 'rub_mln';
  if(v === 'k')   return 'k';
  return null;
};

// Перевод значения в каноническую единицу метрики.
// Например, для metric.unit='years' и unit='months' делим на 12.
function convertValue(value, unitInQuery, metricUnit){
  if(unitInQuery == null) return value;
  if(metricUnit === 'years'){
    if(unitInQuery === 'years')  return value;
    if(unitInQuery === 'months') return value / 12;
    if(unitInQuery === 'days')   return value / 365.25;
  }
  if(metricUnit === '%'){
    return value; // в любом случае ожидаем процент как число
  }
  if(metricUnit === 'rub'){
    // у нас выручка/прибыль хранятся в млрд ₽. Если человек написал
    // «млн» — делим на 1000.
    if(unitInQuery === 'rub_mln') return value / 1000;
    return value;
  }
  return value;
}

export function parseQuery(input){
  const text = String(input || '');
  const conditions = [];
  let cleaned = text;
  let m;
  // важный нюанс: COND_RE с глобальным флагом — сбрасываем lastIndex
  COND_RE.lastIndex = 0;
  while((m = COND_RE.exec(text)) !== null){
    const [whole, alias, op, numStr, unit] = m;
    const metric = findMetricByAlias(alias);
    if(!metric) continue;
    const num = parseFloat(numStr.replace(',', '.'));
    if(!isFinite(num)) continue;
    const u = UNIT_NORM(unit);
    const value = convertValue(num, u, metric.unit);
    conditions.push({
      metric,
      op:  OP_NORM[op] || op,
      value,
      unit: u || metric.unit,
      raw: whole.trim(),
    });
    cleaned = cleaned.replace(whole, ' ');
  }
  const freeText = cleaned.replace(/\s+/g, ' ').trim();
  return { conditions, freeText };
}

// Применить условие к одному элементу.
export function matchCondition(cond, item){
  if(!cond.metric.resolver) return null; // данных пока нет — не фильтруем
  const v = cond.metric.resolver(item);
  if(v == null) return null;
  switch(cond.op){
    case '<':  return v <  cond.value;
    case '<=': return v <= cond.value;
    case '>':  return v >  cond.value;
    case '>=': return v >= cond.value;
    case '==': return Math.abs(v - cond.value) < 1e-9;
    default:   return null;
  }
}

// Фильтровать массив items по списку условий (AND). Если хотя бы одно
// условие неприменимо к данному типу (resolver=null), он игнорируется,
// но возвращается пометка hasUnsupported=true чтобы UI мог сообщить
// пользователю «X из условий пока без данных».
export function applyConditions(items, conditions){
  if(!conditions.length) return { matched: items, unsupportedConds: [] };
  const unsupportedConds = conditions.filter(c => !c.metric.resolver);
  const supported = conditions.filter(c => c.metric.resolver);
  if(!supported.length) return { matched: items, unsupportedConds };
  const matched = items.filter(it => supported.every(c => matchCondition(c, it) === true));
  return { matched, unsupportedConds };
}

// Подсказка по «недописанному» хвосту: если в конце строки висит
// alias без оператора («... EBITDA»), вернём этот alias и его метрику —
// чтобы UI мог предложить шаблоны условий «EBITDA > __», «EBITDA < __».
export function trailingAlias(input){
  // последнее слово/несколько слов перед концом строки, пытаемся
  // распознать как alias
  const tail = String(input || '').toLowerCase().split(/[\s,;]+/).filter(Boolean);
  if(!tail.length) return null;
  // пробуем 3 → 2 → 1 слово (учтём «net profit margin», «текущая ликвидность»)
  for(let n = Math.min(3, tail.length); n >= 1; n--){
    const candidate = tail.slice(-n).join(' ');
    const metric = findMetricByAlias(candidate);
    if(metric) return { alias: candidate, metric, words: n };
  }
  return null;
}
