// Оптимизаторы весов портфеля (открытые модели из multi-model-portfolio-
// backtester/benchmarks.py, адаптировано под браузер без солверов):
//   • uniform 1/N
//   • inverse-vol (risk-parity lite)
//   • min-variance (Марковиц, ковариация с шринкажем Ледойта-Вулфа к диагонали)
//   • max-Sortino (tangency по избыточной доходности)
//   • min-CVaR 95% (Rockafellar–Uryasev, проекционный субградиент по симплексу)
// Все веса long-only, сумма = 1. Чистые функции.

const TD = 252;

// Матрица дневных доходностей по общим датам.
// positions: [{secid, hist:[{date,close}]}] → {assets, dates, R:[день][актив]}.
export function alignedReturns(positions){
  const assets = positions.map(p => p.secid);
  const maps = positions.map(p => { const m = new Map(); for(const h of (p.hist || [])) m.set(h.date, h.close); return m; });
  const firstDate = positions.map(p => (p.hist && p.hist.length ? p.hist[0].date : null));
  const dateSet = new Set(); for(const p of positions) for(const h of (p.hist || [])) dateSet.add(h.date);
  const allDates = [...dateSet].sort();
  // окно — с даты, когда у ВСЕХ активов уже есть первая котировка
  const start = firstDate.reduce((a, b) => (b && (!a || b > a)) ? b : a, null);
  const dates = allDates.filter(d => start && d >= start);
  if(dates.length < 3) return { assets, dates: [], R: [] };
  const last = new Array(maps.length).fill(null);
  const prices = [];               // [день][актив] ffill
  for(const d of dates){
    for(let i = 0; i < maps.length; i++){ const c = maps[i].get(d); if(c != null) last[i] = c; }
    if(last.some(x => x == null)) continue;   // пока не у всех есть цена — пропускаем
    prices.push(last.slice());
  }
  const R = [];
  for(let t = 1; t < prices.length; t++){
    R.push(prices[t].map((p, i) => prices[t - 1][i] > 0 ? p / prices[t - 1][i] - 1 : 0));
  }
  return { assets, dates, R };
}

const _mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);

// Среднедневная доходность по активам.
function colMeans(R){
  const n = R[0].length, mu = new Array(n).fill(0);
  for(const row of R) for(let i = 0; i < n; i++) mu[i] += row[i];
  return mu.map(x => x / R.length);
}

// Выборочная ковариация + шринкаж к диагонали (Ледойт-Вулф, упрощ. интенсивность).
export function covariance(R, shrink = null){
  const T = R.length, n = R[0].length;
  const mu = colMeans(R);
  const S = Array.from({ length: n }, () => new Array(n).fill(0));
  for(const row of R) for(let i = 0; i < n; i++){ const di = row[i] - mu[i]; for(let j = 0; j < n; j++) S[i][j] += di * (row[j] - mu[j]); }
  for(let i = 0; i < n; i++) for(let j = 0; j < n; j++) S[i][j] /= Math.max(1, T - 1);
  // цель F — диагональ выборочной (нулевые ковариации вне диагонали)
  const delta = shrink == null ? 0.3 : shrink;   // стабильный дефолт
  const F = Array.from({ length: n }, (_, i) => S.map((_, j) => i === j ? S[i][i] : 0));
  const Sh = Array.from({ length: n }, (_, i) => S[i].map((v, j) => (1 - delta) * v + delta * F[i][j]));
  return Sh;
}

// Инверсия матрицы Гауссом-Жорданом (малые n).
function invert(A){
  const n = A.length;
  const M = A.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => i === j ? 1 : 0)]);
  for(let c = 0; c < n; c++){
    let piv = c; for(let r = c + 1; r < n; r++) if(Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if(Math.abs(M[piv][c]) < 1e-12){ M[c][c] += 1e-9; piv = c; }
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c];
    for(let j = 0; j < 2 * n; j++) M[c][j] /= d;
    for(let r = 0; r < n; r++){ if(r === c) continue; const f = M[r][c]; for(let j = 0; j < 2 * n; j++) M[r][j] -= f * M[c][j]; }
  }
  return M.map(r => r.slice(n));
}
const matVec = (A, v) => A.map(r => r.reduce((s, x, j) => s + x * v[j], 0));

// Евклидова проекция вектора на симплекс {w≥0, Σw=1} (Wang & Carreira-Perpinan).
export function projectSimplex(v){
  const n = v.length;
  const u = [...v].sort((a, b) => b - a);
  let css = 0, rho = 0, theta = 0;
  for(let i = 0; i < n; i++){ css += u[i]; const t = (css - 1) / (i + 1); if(u[i] - t > 0){ rho = i + 1; theta = t; } }
  return v.map(x => Math.max(0, x - theta));
}

// ── Оптимизаторы (возвращают массив весов в порядке assets) ──────────────
export function wUniform(n){ return new Array(n).fill(1 / n); }

export function wInverseVol(R){
  const n = R[0].length, mu = colMeans(R);
  const sd = new Array(n).fill(0);
  for(const row of R) for(let i = 0; i < n; i++) sd[i] += (row[i] - mu[i]) ** 2;
  const inv = sd.map(s => { const v = Math.sqrt(s / Math.max(1, R.length - 1)); return v > 0 ? 1 / v : 0; });
  const sum = inv.reduce((a, b) => a + b, 0) || 1;
  return inv.map(x => x / sum);
}

export function wMinVariance(R){
  const S = covariance(R), n = S.length;
  const inv = invert(S);
  const ones = new Array(n).fill(1);
  const raw = matVec(inv, ones);
  const s = raw.reduce((a, b) => a + b, 0);
  const w = s !== 0 ? raw.map(x => x / s) : wUniform(n);
  return projectSimplex(w);
}

// Tangency / max-Sortino: w ∝ Σ⁻¹(μ − rf). Long-only проекцией.
export function wMaxSortino(R, rfDaily = 0){
  const S = covariance(R), n = S.length, mu = colMeans(R);
  const excess = mu.map(m => m - rfDaily);
  const inv = invert(S);
  const raw = matVec(inv, excess);
  const s = raw.reduce((a, b) => a + b, 0);
  const w = s !== 0 ? raw.map(x => x / s) : wUniform(n);
  return projectSimplex(w);
}

// Min-CVaR 95% (Rockafellar–Uryasev) проекционным субградиентом по симплексу.
// Минимизируем CVaR убытка L_t = −(R_t·w): для текущего w оптимальный α = VaR
// (квантиль убытков), субградиент по w = −среднее R_t по худшему (1−β) хвосту.
export function wMinCVaR(R, beta = 0.95, iters = 400){
  const n = R[0].length, T = R.length;
  let w = wUniform(n);
  let lr = 0.5;
  for(let it = 0; it < iters; it++){
    const loss = R.map(row => -row.reduce((s, x, j) => s + x * w[j], 0));
    const order = loss.map((l, t) => [l, t]).sort((a, b) => b[0] - a[0]);
    const k = Math.max(1, Math.floor((1 - beta) * T));
    const tail = order.slice(0, k).map(o => o[1]);
    // субградиент CVaR по w = −(1/k)Σ_tail R_t ; шаг против него (минимизируем)
    const g = new Array(n).fill(0);
    for(const t of tail) for(let j = 0; j < n; j++) g[j] += -R[t][j] / tail.length;
    w = projectSimplex(w.map((x, j) => x - lr * g[j]));
    lr *= 0.995;
  }
  return w;
}

// Характеристики портфеля с весами w на историч. доходностях.
export function statsForWeights(R, w, rfDaily = 0){
  const port = R.map(row => row.reduce((s, x, j) => s + x * w[j], 0));
  const mu = _mean(port);
  const varr = _mean(port.map(x => (x - mu) ** 2));
  const vol = Math.sqrt(varr) * Math.sqrt(TD);
  const retAnnual = Math.pow(1 + mu, TD) - 1;
  const downside = port.map(x => Math.min(0, x - rfDaily));
  const dStd = Math.sqrt(_mean(downside.map(x => x * x)));
  const excessAnnual = retAnnual - (Math.pow(1 + rfDaily, TD) - 1);
  const sortino = dStd > 0 ? excessAnnual / (dStd * Math.sqrt(TD)) : (excessAnnual >= 0 ? Infinity : -Infinity);
  // CVaR 95% дневной
  const sorted = [...port].sort((a, b) => a - b);
  const k = Math.max(1, Math.floor(0.05 * sorted.length));
  const cvar = _mean(sorted.slice(0, k));
  return { retAnnual, vol, sortino, cvar };
}

// Собрать все модели сразу. → [{key, label, weights:[{secid,w}], stats}]
export function optimizeAll(positions, rfDaily = 0){
  const { assets, R } = alignedReturns(positions);
  if(!assets.length || R.length < 20) return { assets: [], dates: 0, models: [] };
  const mk = (key, label, w) => ({ key, label, weights: assets.map((s, i) => ({ secid: s, w: w[i] })), stats: statsForWeights(R, w, rfDaily) });
  const models = [
    mk('uniform', '1/N (равные)', wUniform(assets.length)),
    mk('invvol', 'Обратная волатильность', wInverseVol(R)),
    mk('minvar', 'Min-variance (Марковиц)', wMinVariance(R)),
    mk('sortino', 'Max-Sortino (tangency)', wMaxSortino(R, rfDaily)),
    mk('cvar', 'Min-CVaR 95%', wMinCVaR(R)),
  ];
  return { assets, dates: R.length, models };
}
