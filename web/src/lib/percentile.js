// Перцентильные ранги и взвешенная статистика по сэмплу значений.
// Используется в автокалибровке норм и в радаре («лучшее = top 25%»).

// Перцентиль-ранг каждого значения в массиве: 0 (минимум) → 100 (максимум).
// higher=false инвертирует: меньшее становится 100.
export function percentileRanks(values, higher = true){
  const idx = values
    .map((v, i) => ({ v, i }))
    .filter(x => x.v != null && isFinite(x.v))
    .sort((a, b) => higher ? a.v - b.v : b.v - a.v);
  const n = idx.length;
  const out = new Array(values.length).fill(null);
  if(!n) return out;
  // Дробный ранг через linear position; tie-break — стабильный.
  idx.forEach((x, k) => {
    out[x.i] = n === 1 ? 100 : Math.round(k / (n - 1) * 100);
  });
  return out;
}

// Взвешенный перцентиль (Type 7, R-style) с весами свежести.
// values, weights — параллельные массивы. q — 0..1.
export function weightedQuantile(values, weights, q){
  const pairs = [];
  for(let i = 0; i < values.length; i++){
    const v = values[i], w = weights[i];
    if(v == null || !isFinite(v) || w == null || w <= 0) continue;
    pairs.push([v, w]);
  }
  if(!pairs.length) return null;
  pairs.sort((a, b) => a[0] - b[0]);
  const total = pairs.reduce((s, p) => s + p[1], 0);
  if(total <= 0) return null;
  const target = q * total;
  let acc = 0;
  for(let i = 0; i < pairs.length; i++){
    acc += pairs[i][1];
    if(acc >= target) return pairs[i][0];
  }
  return pairs[pairs.length - 1][0];
}

// Винзоризация: значения <p[lo]/100 = p[lo]/100, >p[hi]/100 = p[hi]/100.
// Возвращает пару { lo, hi } границ, дальше уже подрезается на месте.
export function winsorBounds(values, weights, loQ = 0.02, hiQ = 0.98){
  return {
    lo: weightedQuantile(values, weights, loQ),
    hi: weightedQuantile(values, weights, hiQ),
  };
}

// Экспоненциальный вес по возрасту (years, halfLife в годах).
//   weight = 0.5 ^ (age / halfLife)
// age=null → null (запись не учитывается).
export function freshnessWeight(ageYears, halfLife = 2){
  if(ageYears == null || !isFinite(ageYears) || ageYears < 0) return null;
  return Math.pow(0.5, ageYears / halfLife);
}
