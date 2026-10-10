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

// Календарный размах ряда в годах (по датам, если есть), иначе N/252.
function _years(series){
  const withDates = series.filter(x => x && x.date);
  if(withDates.length >= 2){
    const d0 = new Date(withDates[0].date), d1 = new Date(withDates[withDates.length - 1].date);
    const y = (d1 - d0) / (365.25 * 864e5);
    if(y > 0.02) return y;
  }
  return series.length / TRADING_DAYS;
}

// CAGR по ВИНЗОРИЗОВАННОМУ росту за КАЛЕНДАРНЫЙ срок: (Π(1+r))^(1/лет) − 1.
// Считаем по клипнутым дневным доходностям, а не по end/start сырого ряда —
// иначе один битый тик цены (×100) или редкие сделки раздувают результат.
export function cagr(series){
  const r = dailyReturns(series);
  if(!r.length) return null;
  const growth = r.reduce((g, x) => g * (1 + x), 1);
  if(growth <= 0) return -1;
  const years = Math.max(0.05, _years(series));
  return Math.pow(growth, 1 / years) - 1;
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

// Годовая волатильность (σ дневных × √ppy). ppy — реальное число наблюдений
// в год (из календаря); при редких сделках ppy<252 и вола не переоценивается.
export function volatility(returns, ppy = TRADING_DAYS){
  if(returns.length < 2) return null;
  const m = returns.reduce((a, b) => a + b, 0) / returns.length;
  const v = returns.reduce((a, b) => a + (b - m) * (b - m), 0) / (returns.length - 1);
  return Math.sqrt(v) * Math.sqrt(ppy);
}

// Sortino к безрисковой ставке — порт polytest.py (знаковый вариант).
// rfDaily — дневная безрисковая доходность (константа или массив по датам).
export function sortino(series, returns, rfDaily, ppy = TRADING_DAYS){
  const cg = cagr(series);
  if(cg == null) return null;
  const rf = Array.isArray(rfDaily) ? rfDaily : returns.map(() => (rfDaily || 0));
  // Годовая безрисковая за тот же календарный срок.
  const years = Math.max(0.05, _years(series));
  let s = 0; for(const x of rf) s += Math.log1p(x);
  const cagrRf = Math.pow(Math.exp(s), 1 / years) - 1;
  const cagrExcess = cg - cagrRf;
  const downside = returns.map((r, i) => Math.min(0, r - (rf[i] || 0)));
  const dStd = Math.sqrt(downside.reduce((a, b) => a + b * b, 0) / downside.length) * Math.sqrt(ppy);
  if(dStd > 0) return cagrExcess / dStd;
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
  // Наблюдений в год по факту (из календаря) — для корректной годовой проекции.
  const years = Math.max(0.05, _years(series));
  const ppy = Math.min(TRADING_DAYS, Math.max(12, r.length / years));
  return {
    n: series.length,
    cagr: cagr(series),
    vol: volatility(r, ppy),
    sortino: sortino(series, r, rfDaily, ppy),
    maxDrawdown,                       // «подводная», доля ≤0
    classicMaxDD: classicMaxDrawdown(series),
    ulcer,                             // ≤0 (%-пункты)
    maxDailyDrop: maxDailyDrop(r),     // %, ≤0
    var95: v95, cvar95: cv95,          // дневные, доля ≤0
    returns: r,
    ppy,                               // наблюдений в год (для Монте-Карло)
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
// stepsPerYear — сколько РЕАЛЬНЫХ наблюдений приходится на год (из календаря).
// Горизонт = один год = stepsPerYear шагов. Так частота редких скачков в
// траектории совпадает с фактической (а не «как будто каждый бар = день»).
export function monteCarlo(returns, { stepsPerYear = TRADING_DAYS, paths = 1000, block = 10, rfDaily = 0 } = {}){
  if(returns.length < 30) return null;
  const horizon = Math.max(12, Math.round(stepsPerYear));
  const outCagr = [], outDD = [], outUlcer = [], outSortino = [];
  for(let p = 0; p < paths; p++){
    const path = [];
    while(path.length < horizon){
      const start = Math.floor(Math.random() * returns.length);
      for(let b = 0; b < block && path.length < horizon; b++){
        path.push(returns[(start + b) % returns.length]);
      }
    }
    const growth = path.reduce((g, x) => g * (1 + x), 1);
    outCagr.push(growth > 0 ? Math.pow(growth, stepsPerYear / path.length) - 1 : -1);   // ровно за год
    const du = drawdownUlcer(path);
    outDD.push(du.maxDrawdown); outUlcer.push(du.ulcer);
    // Sortino годовой: избыток годовой доходности / годовой downside-σ.
    const dswn = path.map(x => Math.min(0, x - rfDaily));
    const dStd = Math.sqrt(dswn.reduce((a, b) => a + b * b, 0) / dswn.length) * Math.sqrt(stepsPerYear);
    const cagrRf = Math.pow(1 + rfDaily, stepsPerYear) - 1;
    const ann = (growth > 0 ? Math.pow(growth, stepsPerYear / path.length) - 1 : -1) - cagrRf;
    if(dStd > 0 && isFinite(ann / dStd)) outSortino.push(ann / dStd);
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
