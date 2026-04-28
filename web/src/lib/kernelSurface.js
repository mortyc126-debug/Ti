// Поверхность E[YTM | maturity, quality] через Nadaraya-Watson kernel
// regression с гауссовым ядром. Локальная sigma остатков → z-score
// для каждого выпуска.
//
// Точки: { x, y, z } — где x = maturity (years), y = quality (0..100),
// z = ytm (%). На выходе для каждой точки — { expected, residual,
// zscore, sampleN }, плюс готовая сетка expected для рендера фона.

const DEFAULT_BW = { x: 1.2, y: 12 };  // σ ядра (годы / пункты качества)

// K(dx, dy) — нормированное гауссово ядро.
function kernel(dx, dy, bw){
  const u = dx / bw.x;
  const v = dy / bw.y;
  return Math.exp(-(u * u + v * v) / 2);
}

// Локальное E[z] в точке (x*, y*) по данным.
function nwAt(x, y, points, bw){
  let num = 0, den = 0;
  for(const p of points){
    const w = kernel(x - p.x, y - p.y, bw);
    num += w * p.z;
    den += w;
  }
  return den > 0 ? { mu: num / den, weight: den } : { mu: null, weight: 0 };
}

// Локальная std остатков. Отдельная свёртка по тем же ядерным весам.
function nwSigmaAt(x, y, points, bw, mu){
  if(mu == null) return null;
  let num = 0, den = 0;
  for(const p of points){
    const w = kernel(x - p.x, y - p.y, bw);
    const r = p.z - mu;
    num += w * r * r;
    den += w;
  }
  if(den <= 0) return null;
  const variance = num / den;
  return Math.sqrt(Math.max(0, variance));
}

// Эффективный размер сэмпла в окрестности (Kish): (Σw)² / Σw²,
// измеряет сколько «по сути» точек влияли на оценку.
function effSampleN(x, y, points, bw){
  let s = 0, s2 = 0;
  for(const p of points){
    const w = kernel(x - p.x, y - p.y, bw);
    s += w; s2 += w * w;
  }
  return s2 > 0 ? (s * s) / s2 : 0;
}

// Главный процедурник. Возвращает:
//   points:     [{ ...inputPoint, expected, residual, zscore, sampleN, sparse }]
//   gridExpected: { xs, ys, z[i][j] } — готовое поле для фона
export function fitSurface(rawPoints, opts){
  const bw = (opts && opts.bandwidth) || DEFAULT_BW;
  // Минимальный эффективный сэмпл, ниже которого z-score не считаем.
  const minN = (opts && opts.minSample) || 3;

  // Чистим: оставляем только с обоими x, y, z.
  const pts = rawPoints
    .map(p => ({ ...p, x: +p.x, y: +p.y, z: +p.z }))
    .filter(p => isFinite(p.x) && isFinite(p.y) && isFinite(p.z));

  if(!pts.length){
    return { points: [], gridExpected: null };
  }

  const out = pts.map(p => {
    const { mu } = nwAt(p.x, p.y, pts, bw);
    const sigma = nwSigmaAt(p.x, p.y, pts, bw, mu);
    const n = effSampleN(p.x, p.y, pts, bw);
    const residual = mu != null ? p.z - mu : null;
    const sparse = n < minN;
    let zscore = null;
    if(!sparse && sigma != null && sigma > 0.05 && residual != null){
      zscore = residual / sigma;
    }
    return {
      ...p,
      expected: mu,
      residual,
      zscore,
      sampleN: n,
      sparse,
    };
  });

  // Сетка для фона: считаем E[z] на 30×24 узлах в пределах bbox.
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const NX = (opts && opts.gridX) || 30;
  const NY = (opts && opts.gridY) || 24;
  const xGrid = [];
  for(let i = 0; i < NX; i++) xGrid.push(xMin + (xMax - xMin) * i / (NX - 1));
  const yGrid = [];
  for(let j = 0; j < NY; j++) yGrid.push(yMin + (yMax - yMin) * j / (NY - 1));
  const z = [];
  for(let i = 0; i < NX; i++){
    z.push([]);
    for(let j = 0; j < NY; j++){
      const { mu } = nwAt(xGrid[i], yGrid[j], pts, bw);
      z[i].push(mu);
    }
  }

  return {
    points: out,
    gridExpected: { xs: xGrid, ys: yGrid, z, xMin, xMax, yMin, yMax },
    bandwidth: bw,
  };
}

// Цвет «температуры» поверхности по значению YTM (% годовых). Низкая
// доходность — холодный, высокая — горячая. Вход 0..40, выход HSL.
export function ytmColor(v){
  if(v == null || !isFinite(v)) return 'rgba(80,80,80,0.05)';
  // 8% YTM → синий (220), 30% → красный (10). Линейно через лиловый.
  const t = Math.max(0, Math.min(1, (v - 8) / (30 - 8)));
  const hue = 220 - t * 210;        // 220 → 10
  const sat = 50 + t * 30;
  const lig = 22 + (1 - t) * 16;    // ниже = темнее, выше = светлее (но не белее)
  return `hsl(${hue.toFixed(0)} ${sat}% ${lig}%)`;
}

// Цвет точки по z-score: <-1 синий-холод (рынок «спокоен», дешёвая
// доходность), 0 нейтральный, >+1 красный (премия за риск). Размер
// точки — отдельно, по объёму выпуска.
export function zScoreColor(z){
  if(z == null) return '#5e6573';
  // clamp ±2.5σ
  const t = Math.max(-2.5, Math.min(2.5, z)) / 2.5;   // [-1..1]
  // -1 → 200 (синий), 0 → серый, +1 → 0 (красный)
  if(Math.abs(t) < 0.05) return '#9ba3b1';
  const hue = t > 0 ? 0 : 200;
  const sat = 60 + Math.abs(t) * 30;
  const lig = 50 + (1 - Math.abs(t)) * 8;
  return `hsl(${hue} ${sat}% ${lig}%)`;
}
