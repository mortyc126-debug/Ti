// Кредитное качество как непрерывная Y-ось. Три режима:
//   - rating:  ординал AAA → D, дискретные «полки»
//   - scoring: composite (safety×0.5 + BQI×0.3 + rating-ord×0.2) — плавный
//   - mix:     то же что scoring, но UI рисует обводку точки цветом
//              рейтинговой группы. Визуально видно, где скоринг и
//              рынок (рейтинг) расходятся.

import { safetyScore, bqiScore } from '../data/bondsCatalog.js';

// Шкала ~ кредитного спреда: AAA=100, D=10. «none» = null (исключаем
// из выборки целиком).
const RATING_ORD = {
  'AAA': 100,
  'AA+': 95, 'AA': 92, 'AA-': 88,
  'A+':  85, 'A':  82, 'A-':  78,
  'BBB+':75, 'BBB':72, 'BBB-':68,
  'BB+': 65, 'BB': 62, 'BB-': 58,
  'B+':  55, 'B':  52, 'B-':  48,
  'CCC': 35, 'D':  10,
  'none': null,
};

export function ratingOrd(r){
  return RATING_ORD[r] ?? null;
}

// Семейство рейтинга — для цветной обводки в режиме mix.
//   IG (≥A) | crossover (BBB) | HY (BB и ниже) | distress (CCC и ниже)
export function ratingTier(r){
  if(!r || r === 'none') return null;
  if(/^AAA|^AA|^A[+\-]?$/.test(r))  return 'ig';
  if(/^BBB/.test(r))                return 'cross';
  if(/^BB/.test(r))                 return 'hy';
  if(/^B[+\-]?$/.test(r))           return 'hy';
  if(/^C|^D/.test(r))               return 'dist';
  return null;
}

export function tierColor(t){
  switch(t){
    case 'ig':    return '#22d3a0';
    case 'cross': return '#00d4ff';
    case 'hy':    return '#f5a623';
    case 'dist':  return '#ff4d6d';
    default:      return '#5e6573';
  }
}

// Y-композит. Для bond возвращает число 0..100 или null.
// b.mults может быть пуст (ОФЗ/муни) — используем только rating.
export function qualityY(bond, mode){
  const ord = ratingOrd(bond.rating);
  if(mode === 'rating'){
    return ord;
  }
  // scoring и mix используют один и тот же composite.
  const fakeBond = { mults: bond.mults };
  const safety = safetyScore(fakeBond);
  const bqi    = bqiScore(fakeBond);
  // Если у бумаги нет mults и есть только рейтинг (типичные ОФЗ) —
  // отдаём ord как есть, чтобы они не выпадали из выборки.
  if(safety == null && bqi == null){
    return ord;
  }
  const parts = [];
  if(safety != null) parts.push({ v: safety, w: 0.5 });
  if(bqi != null)    parts.push({ v: bqi,    w: 0.3 });
  if(ord != null)    parts.push({ v: ord,    w: 0.2 });
  if(!parts.length) return null;
  const wsum = parts.reduce((s, p) => s + p.w, 0);
  return parts.reduce((s, p) => s + p.v * p.w, 0) / wsum;
}

// Срок в годах от сегодня до `mat_date` (ISO YYYY-MM-DD). null если
// дата не парсится или уже прошла.
export function maturityYears(matISO){
  if(!matISO) return null;
  const m = new Date(matISO).getTime();
  if(!isFinite(m)) return null;
  const now = Date.now();
  const yrs = (m - now) / (365.25 * 86400000);
  return yrs > 0 ? yrs : null;
}

// Тики для Y-оси в режиме «рейтинг»: основные точки шкалы.
export const RATING_TICKS = [
  { ord: 100, label: 'AAA' },
  { ord: 92,  label: 'AA' },
  { ord: 82,  label: 'A' },
  { ord: 72,  label: 'BBB' },
  { ord: 62,  label: 'BB' },
  { ord: 52,  label: 'B' },
  { ord: 35,  label: 'CCC' },
  { ord: 10,  label: 'D' },
];

// Обратное отображение ord → ближайшая буква (для тултипов в скоринге).
export function ratingFromOrd(ord){
  if(ord == null) return '';
  let best = RATING_TICKS[0];
  let dist = Math.abs(ord - best.ord);
  for(const t of RATING_TICKS){
    const d = Math.abs(ord - t.ord);
    if(d < dist){ dist = d; best = t; }
  }
  return best.label;
}

// Для тогглера в UI.
export const Y_MODES = [
  { id: 'rating',  label: 'Рейтинг'  },
  { id: 'scoring', label: 'Скоринг'  },
  { id: 'mix',     label: 'Микс'     },
];
