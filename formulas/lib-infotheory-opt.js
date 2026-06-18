/*
 * Формулы теории информации и комбинаторной оптимизации — общая
 * библиотека для oi-signal-v10.html и indlab_v10.html.
 *
 * Перенесено (как формулы, без привязки к исходной задаче) из
 * исследовательского репозитория mortyc126-debug/SHA-256
 * (INFO_THEORY_GUIDE.md — энтропия/MI/KL; superbit/core.py,
 * superbit/optimize.py — Ising/QUBO + simulated annealing).
 * Там это использовалось для анализа SHA-256/SAT, здесь — для
 * количественной оценки сигналов и совместной калибровки весов методов.
 *
 * Подключение: <script src="lib-infotheory-opt.js"></script> до
 * основного инлайн-скрипта файла.
 */

// ────────────────────────────────────────────────────────────────
// Теория информации
// ────────────────────────────────────────────────────────────────

// Гистограмма-вероятности для дискретизации непрерывного ряда (bins равных
// по ширине корзин в диапазоне [min,max] ряда).
function itHistProbs(arr, bins = 10) {
  const vals = arr.filter(x => x != null && !isNaN(x));
  if (vals.length < 2) return [];
  const lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi === lo) return [1];
  const counts = new Array(bins).fill(0);
  const w = (hi - lo) / bins;
  vals.forEach(v => {
    let idx = Math.floor((v - lo) / w);
    if (idx >= bins) idx = bins - 1;
    if (idx < 0) idx = 0;
    counts[idx]++;
  });
  return counts.map(c => c / vals.length).filter(p => p > 0);
}

// Энтропия Шеннона H(X) = -Σ p·log2(p), бит.
function itShannonEntropy(probs) {
  return -probs.reduce((s, p) => s + (p > 0 ? p * Math.log2(p) : 0), 0);
}

// Min-entropy (Rényi-энтропия при α→∞) = -log2(max p). Хуже всего "размывается"
// одним частым исходом — даёт оценку наихудшего случая предсказуемости,
// в отличие от Shannon-энтропии (средний случай). Полезно для оценки риска
// в хвостах распределения (напр. вероятность одного доминирующего сценария).
function itMinEntropy(probs) {
  if (!probs.length) return 0;
  return -Math.log2(Math.max(...probs));
}

// KL-дивергенция D_KL(p‖q) = Σ p·log2(p/q), бит. Несимметрична, ≥0.
// eps — сглаживание, чтобы избежать log(0)/деления на 0 при несовпадающих
// носителях распределений (типично при сравнении эмпирических гистограмм).
function itKLDivergence(p, q, eps = 1e-9) {
  const n = Math.max(p.length, q.length);
  let d = 0;
  for (let i = 0; i < n; i++) {
    const pi = (p[i] || 0) + eps, qi = (q[i] || 0) + eps;
    d += pi * Math.log2(pi / qi);
  }
  return d;
}

// Дрейф распределения: KL-дивергенция между гистограммой "короткого" (recent)
// и "длинного" (baseline) окна одного и того же ряда, на общих границах
// корзин (диапазон берётся из baseline, чтобы recent не "придумывал" новые
// корзины при выбросах). Растёт, когда текущее поведение ряда перестаёт
// быть похожим на привычное — естественная альтернатива ручным порогам
// percentile-based классификации режима.
function itDistributionDrift(shortArr, longArr, bins = 10) {
  const longVals = longArr.filter(x => x != null && !isNaN(x));
  const shortVals = shortArr.filter(x => x != null && !isNaN(x));
  if (longVals.length < 5 || shortVals.length < 3) return 0;
  const lo = Math.min(...longVals), hi = Math.max(...longVals);
  if (hi === lo) return 0;
  const w = (hi - lo) / bins;
  const toCounts = (vals) => {
    const counts = new Array(bins).fill(0);
    vals.forEach(v => {
      let idx = Math.floor((v - lo) / w);
      idx = Math.max(0, Math.min(bins - 1, idx));
      counts[idx]++;
    });
    return counts;
  };
  const pLong = toCounts(longVals).map(c => c / longVals.length);
  const pShort = toCounts(shortVals).map(c => c / shortVals.length);
  return itKLDivergence(pShort, pLong);
}

// Взаимная информация I(X;Y) между двумя рядами через совместную гистограмму.
// Используется для оценки нелинейной зависимости между score метода и
// фактическим исходом сделки — точнее, чем доля совпадений направления.
function itMutualInformation(x, y, bins = 8) {
  const n = Math.min(x.length, y.length);
  const xs = [], ys = [];
  for (let i = 0; i < n; i++) {
    if (x[i] != null && !isNaN(x[i]) && y[i] != null && !isNaN(y[i])) {
      xs.push(x[i]); ys.push(y[i]);
    }
  }
  if (xs.length < 5) return 0;
  const xlo = Math.min(...xs), xhi = Math.max(...xs);
  const ylo = Math.min(...ys), yhi = Math.max(...ys);
  if (xhi === xlo || yhi === ylo) return 0;
  const xw = (xhi - xlo) / bins, yw = (yhi - ylo) / bins;
  const joint = {}, px = new Array(bins).fill(0), py = new Array(bins).fill(0);
  for (let i = 0; i < xs.length; i++) {
    let xi = Math.floor((xs[i] - xlo) / xw); xi = Math.max(0, Math.min(bins - 1, xi));
    let yi = Math.floor((ys[i] - ylo) / yw); yi = Math.max(0, Math.min(bins - 1, yi));
    const key = xi + '_' + yi;
    joint[key] = (joint[key] || 0) + 1;
    px[xi]++; py[yi]++;
  }
  const total = xs.length;
  let mi = 0;
  Object.entries(joint).forEach(([key, cnt]) => {
    const [xi, yi] = key.split('_').map(Number);
    const pxy = cnt / total, pxm = px[xi] / total, pym = py[yi] / total;
    if (pxy > 0 && pxm > 0 && pym > 0) mi += pxy * Math.log2(pxy / (pxm * pym));
  });
  return Math.max(0, mi);
}

// ────────────────────────────────────────────────────────────────
// Ising / QUBO + Simulated Annealing
// ────────────────────────────────────────────────────────────────

// Энергия Ising: H(m) = -½ mᵀJm - hᵀm, m_i ∈ {-1,+1}.
function itIsingEnergy(m, J, h) {
  let e = 0;
  const n = m.length;
  for (let i = 0; i < n; i++) {
    e -= h[i] * m[i];
    for (let j = 0; j < n; j++) e -= 0.5 * J[i][j] * m[i] * m[j];
  }
  return e;
}

// QUBO (минимизация xᵀQx, x∈{0,1}) → Ising (m∈{-1,+1}).
function itQuboToIsing(Q) {
  const n = Q.length;
  const J = Array.from({ length: n }, () => new Array(n).fill(0));
  const h = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let off = 0;
    for (let j = 0; j < n; j++) if (j !== i) off += Q[i][j] + Q[j][i];
    h[i] = -Q[i][i] / 2 - off / 4;
    for (let j = i + 1; j < n; j++) {
      const v = -(Q[i][j] + Q[j][i]) / 4;
      J[i][j] = v; J[j][i] = v;
    }
  }
  return { J, h };
}

// Simulated Annealing для Ising-модели (последовательная, геометрическое
// охлаждение). Возвращает {bestEnergy, bestState}. Применимо к задачам вида
// "выбрать/взвесить подмножество коррелированных сигналов так, чтобы
// максимизировать совместную точность" — независимая покомпонентная
// калибровка (EWA) не учитывает избыточность между сигналами, а здесь
// матрица J явно кодирует их попарную корреляцию.
function itSimulatedAnnealing(n, J, h, opts = {}) {
  const { sweeps = 800, Tstart = 2.0, Tend = 0.01, seed = 42 } = opts;
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };

  let m = new Array(n).fill(0).map(() => (rnd() < 0.5 ? -1 : 1));
  let bestE = itIsingEnergy(m, J, h);
  let bestM = m.slice();
  let T = Tstart;
  const cool = Math.pow(Tend / Tstart, 1 / Math.max(sweeps * n, 1));

  for (let sweep = 0; sweep < sweeps; sweep++) {
    for (let i = 0; i < n; i++) {
      let local = h[i];
      for (let j = 0; j < n; j++) local += J[i][j] * m[j];
      const dE = 2 * m[i] * local;
      if (dE < 0 || rnd() < Math.exp(-dE / Math.max(T, 1e-10))) m[i] *= -1;
      T *= cool;
    }
    const e = itIsingEnergy(m, J, h);
    if (e < bestE) { bestE = e; bestM = m.slice(); }
  }
  return { bestEnergy: bestE, bestState: bestM };
}

// Совместная оптимизация весов методов: строит QUBO из (а) индивидуальной
// предсказательной силы каждого метода (вектор acc, чем выше — тем больше
// бонус за включение) и (б) попарной корреляции скоров методов (штраф за
// одновременное включение сильно коррелированных методов — избегаем
// задваивания одного и того же сигнала). Возвращает бинарную маску
// {id: 0|1} — какие методы оставить в композите при следующей сборке.
function itJointOptimizeMethodMask(methodIds, accById, corrMatrix, opts = {}) {
  const n = methodIds.length;
  if (n === 0) return {};
  const { redundancyPenalty = 1.0 } = opts;
  // QUBO: минимизируем -Σ acc_i·x_i + λ·Σ_{i<j} |corr_ij|·x_i·x_j
  const Q = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    const acc = accById[methodIds[i]] ?? 0.5;
    Q[i][i] = -(acc - 0.5) * 2; // центрируем вокруг 0.5 (случайное угадывание)
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const corr = Math.abs(corrMatrix?.[i]?.[j] ?? 0);
      Q[i][j] += redundancyPenalty * corr / 2;
    }
  }
  const { J, h } = itQuboToIsing(Q);
  const { bestState } = itSimulatedAnnealing(n, J, h, { sweeps: 500 });
  const mask = {};
  methodIds.forEach((id, i) => { mask[id] = bestState[i] > 0 ? 1 : 0; });
  return mask;
}

// Корреляция Пирсона между двумя числовыми рядами (для построения corrMatrix
// перед itJointOptimizeMethodMask).
function itPearsonCorr(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 3) return 0;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; }
  const mx = sx / n, my = sy / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx, dy = y[i] - my;
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
  }
  const den = Math.sqrt(dx2 * dy2);
  return den ? num / den : 0;
}
