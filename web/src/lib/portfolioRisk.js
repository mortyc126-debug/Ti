// Риск-метрики портфеля — порт открытых формул из multi-model-portfolio-backtester
// (src/polytest.py): CAGR, Sortino к безрисковой ставке, Ulcer, «подводная»
// Max Drawdown, Max Daily Drop + Монте-Карло устойчивости (bootstrap).
// Проприетарные ядра оптимизаторов там закрыты — переносим только риск-метрики
// и логику стресс-прогона, они самодостаточны.
//
// Все функции чистые (тестируются без UI). Доходности — дневные доли.

const TRADING_DAYS = 252;
// Кап дневной доходности: у неликвидных облигаций редкие сделки дают
// «дневной» скачок в десятки % (месячный ход, схлопнутый в один бар), а
// компаундинг в Монте-Карло раздувает его в сотни иксов. Клампим к ±25%/день —
// это гасит артефакты, сохраняя реальный стресс (даже дефолтный гэп редко >25%).
export const RET_CAP = 0.25;
export const clipRet = x => x > RET_CAP ? RET_CAP : x < -RET_CAP ? -RET_CAP : x;

// Дневные доходности из ряда стоимости [{date, val}] или [val] (винзоризованы).
export function dailyReturns(series){
  const v = series.map(x => (typeof x === 'number' ? x : x.val)).filter(x => x != null && isFinite(x));
  const r = [];
  for(let i = 1; i < v.length; i++){
    if(v[i - 1] > 0) r.push(clipRet(v[i] / v[i - 1] - 1));
  }
  return r;
}

// Годовая доходность (CAGR) по ряду стоимости: (end/start)^(252/N) − 1.
export function cagr(series){
  const v = series.map(x => (typeof x === 'number' ? x : x.val)).filter(x => x != null && isFinite(x));
  if(v.length < 2 || v[0] <= 0) return null;
  return Math.pow(v[v.length - 1] / v[0], TRADING_DAYS / v.length) - 1;
}

// «Подводная» просадка и Ulcer — ровно как в polytest.py: вершина клампится
// к 1.0 (прибыль сверх старта не учитывается), меряем только провал ниже
// начального капитала. maxDrawdown ≤ 0 (в долях), ulcer ≤ 0 (в %-пунктах RMS).
export function drawdownUlcer(returns){
  if(!returns.length) return { maxDrawdown: 0, ulcer: 0 };
  let top = 1.0, maxDD = 0.0, ucr = 0.0;
  for(const inc of returns){
    top *= (1 + inc);
    if(top >= 1.0) top = 1.0;
    if(1.0 - top > maxDD) maxDD = 1.0 - top;
    ucr += Math.pow((1 - top) * 100, 2);
  }
  return { maxDrawdown: -maxDD, ulcer: -Math.sqrt(ucr / returns.length) };
}

// Классическая просадка от бегущего пика (для наглядного графика), в долях ≤0.
export function classicMaxDrawdown(series){
  const v = series.map(x => (typeof x === 'number' ? x : x.val)).filter(x => x != null && isFinite(x));
  let peak = -Infinity, mdd = 0;
  for(const x of v){ if(x > peak) peak = x; if(peak > 0){ const dd = x / peak - 1; if(dd < mdd) mdd = dd; } }
  return mdd;
}

// Худшее дневное падение, % (≤0).
export function maxDailyDrop(returns){
  if(!returns.length) return 0;
  return Math.min(Math.min(...returns) * 100, 0);
}

// Годовая волатильность (σ дневных × √252), доля.
export function volatility(returns){
  if(returns.length < 2) return null;
  const m = returns.reduce((a, b) => a + b, 0) / returns.length;
  const v = returns.reduce((a, b) => a + (b - m) * (b - m), 0) / (returns.length - 1);
  return Math.sqrt(v) * Math.sqrt(TRADING_DAYS);
}

// Sortino к безрисковой ставке — порт polytest.py (знаковый вариант).
// rfDaily — дневная безрисковая доходность (константа или массив по датам).
export function sortino(series, returns, rfDaily){
  const n = series.length;
  const cg = cagr(series);
  if(cg == null) return null;
  const rf = Array.isArray(rfDaily) ? rfDaily : returns.map(() => (rfDaily || 0));
  // Годовая безрисковая: exp(Σ log1p(rf))^(252/N) − 1.
  let s = 0; for(const x of rf) s += Math.log1p(x);
  const cagrRf = Math.pow(Math.exp(s), TRADING_DAYS / n) - 1;
  const cagrExcess = cg - cagrRf;
  const downside = returns.map((r, i) => Math.min(0, r - (rf[i] || 0)));
  const dStd = Math.sqrt(downside.reduce((a, b) => a + b * b, 0) / downside.length);
  if(dStd > 0){
    return cagrExcess > 0
      ? cagrExcess / (dStd * Math.sqrt(TRADING_DAYS))
      : cagrExcess * dStd * Math.sqrt(TRADING_DAYS);   // знаковый, как в оригинале
  }
  return cagrExcess >= 0 ? Infinity : -Infinity;
}

// Historical VaR / CVaR (Expected Shortfall) на дневном горизонте, доля (≤0).
// beta — уровень (0.95). VaR = квантиль (1−beta) худших; CVaR = среднее хвоста.
export function varCvar(returns, beta = 0.95){
  if(returns.length < 20) return { var: null, cvar: null };
  const sorted = [...returns].sort((a, b) => a - b);
  const k = Math.max(1, Math.floor((1 - beta) * sorted.length));
  const tail = sorted.slice(0, k);
  const varv = sorted[k - 1];
  const cvar = tail.reduce((a, b) => a + b, 0) / tail.length;
  return { var: varv, cvar };
}

// Полный набор метрик по ряду стоимости портфеля.
export function portfolioMetrics(series, rfDaily = 0){
  const r = dailyReturns(series);
  const { maxDrawdown, ulcer } = drawdownUlcer(r);
  const { var: v95, cvar: cv95 } = varCvar(r, 0.95);
  return {
    n: series.length,
    cagr: cagr(series),
    vol: volatility(r),
    sortino: sortino(series, r, rfDaily),
    maxDrawdown,                       // «подводная», доля ≤0
    classicMaxDD: classicMaxDrawdown(series),
    ulcer,                             // ≤0 (%-пункты)
    maxDailyDrop: maxDailyDrop(r),     // %, ≤0
    var95: v95, cvar95: cv95,          // дневные, доля ≤0
    returns: r,
  };
}

// ── Монте-Карло устойчивости (bootstrap дневных доходностей) ─────────────
// Берём реальный ряд доходностей и resample'им его (блочный bootstrap, чтобы
// сохранить автокорреляцию), строим nPaths траекторий длиной horizon дней,
// по каждой считаем CAGR/MaxDD/Ulcer/Sortino. Возвращаем перцентили.
function _percentile(sorted, p){
  if(!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[i];
}
export function monteCarlo(returns, { horizon = 252, paths = 1000, block = 10, rfDaily = 0 } = {}){
  if(returns.length < 30) return null;
  const outCagr = [], outDD = [], outUlcer = [], outSortino = [];
  for(let p = 0; p < paths; p++){
    const path = [];
    while(path.length < horizon){
      const start = Math.floor(Math.random() * returns.length);
      for(let b = 0; b < block && path.length < horizon; b++){
        path.push(returns[(start + b) % returns.length]);
      }
    }
    // ряд стоимости из траектории доходностей
    const ser = [1]; for(const x of path) ser.push(ser[ser.length - 1] * (1 + x));
    outCagr.push(Math.pow(ser[ser.length - 1] / ser[0], TRADING_DAYS / ser.length) - 1);
    const du = drawdownUlcer(path);
    outDD.push(du.maxDrawdown); outUlcer.push(du.ulcer);
    const srt = sortino(ser, path, rfDaily);
    if(isFinite(srt)) outSortino.push(srt);
  }
  const q = arr => { const s = [...arr].sort((a, b) => a - b); return { p5: _percentile(s, 0.05), p50: _percentile(s, 0.50), p95: _percentile(s, 0.95) }; };
  // Доля траекторий с просадкой глубже −20% — грубая «вероятность боли».
  const probDD20 = outDD.filter(d => d <= -0.20).length / outDD.length;
  return { paths: outCagr.length, cagr: q(outCagr), maxDrawdown: q(outDD), ulcer: q(outUlcer), sortino: q(outSortino), probDrawdown20: probDD20 };
}

// Годовую КС → дневная безрисковая доходность.
export function annualToDaily(annualPct){
  const a = (annualPct || 0) / 100;
  return Math.pow(1 + a, 1 / TRADING_DAYS) - 1;
}
