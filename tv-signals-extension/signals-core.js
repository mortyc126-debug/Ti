/* signals-core.js — расчёт «Сигнальных моделей» на свечах графика.
 * Порт _ilStrat* + _ilBtStats из indlab (те же формулы → та же точность).
 * Чистый модуль: window.SignalsCore. Тестируется без TradingView. */
(function () {
  'use strict';

  // Рыночный breadth для полной версии фейда: карта время→медианная 3-барная
  // доходность рынка + медиана |M|. Заполняется извне (content.js тянет корзину
  // ликвидных тикеров). Пусто → фейд работает в level-режиме (см. M.fade).
  let _breadthMap = null, _breadthMedAbs = 0;
  function setBreadth(map, medAbs) { _breadthMap = map || null; _breadthMedAbs = medAbs || 0; }

  // ── ATR ─────────────────────────────────────────────────────────────────────
  function atr(cn, per) {
    const n = cn.length, r = new Array(n).fill(null);
    const tr = cn.map((c, i) => i === 0 ? c.high - c.low
      : Math.max(c.high - c.low, Math.abs(c.high - cn[i - 1].close), Math.abs(c.low - cn[i - 1].close)));
    if (n < per) return r;
    r[per - 1] = tr.slice(0, per).reduce((s, v) => s + v, 0) / per;
    for (let i = per; i < n; i++) r[i] = (r[i - 1] * (per - 1) + tr[i]) / per;
    return r;
  }

  // ── методы (знак = направление, 0/null = нет сигнала) ────────────────────────
  const M = {};
  M.zscore = (cd) => { const cl = cd.map(c => c.close), n = cl.length, w = 20, o = new Array(n).fill(null);
    for (let i = w; i < n; i++) { let s = 0, s2 = 0; for (let j = i - w + 1; j <= i; j++) { s += cl[j]; s2 += cl[j] * cl[j]; }
      const m = s / w, sd = Math.sqrt(Math.max(1e-9, s2 / w - m * m)); o[i] = Math.max(-2, Math.min(2, -(cl[i] - m) / sd)); } return o; };
  M.accel = (cd) => { const cl = cd.map(c => c.close), n = cl.length, m = 3, o = new Array(n).fill(0);
    const v = new Array(n).fill(null); for (let i = m; i < n; i++) v[i] = (cl[i] - cl[i - m]) / cl[i - m];
    const ac = new Array(n).fill(null); for (let i = 2 * m; i < n; i++) ac[i] = v[i] - v[i - m];
    const hl = 50, a = 1 - Math.pow(0.5, 1 / hl); let base = null; const b = new Array(n).fill(null);
    for (let i = 0; i < n; i++) { if (ac[i] == null) continue; const x = Math.abs(ac[i]); base = base == null ? x : a * x + (1 - a) * base; b[i] = base; }
    const tw = 50; for (let i = 0; i < n; i++) { const bp = i > 0 ? b[i - 1] : null; if (ac[i] == null || bp == null || bp <= 0 || i < tw) { o[i] = 0; continue; }
      const an = Math.abs(ac[i]) / bp, s = Math.sign(ac[i]), tr = Math.sign(cl[i] - cl[i - tw]); o[i] = (an >= 2 && s !== 0 && s === tr) ? -s : 0; } return o; };
  M.order_block = (cd) => { const n = cd.length, at = atr(cd, 14), o = new Array(n).fill(0); let ob = null;
    for (let i = 3; i < n; i++) { if (at[i] == null) { o[i] = null; continue; } const mv = cd[i].close - cd[i - 3].close;
      if (Math.abs(mv) >= 1.2 * at[i]) { const dir = Math.sign(mv);
        for (let j = i - 3; j >= Math.max(0, i - 10); j--) if (Math.sign(cd[j].close - cd[j].open) === -dir) { ob = { top: Math.max(cd[j].open, cd[j].close), bot: Math.min(cd[j].open, cd[j].close), dir }; break; } }
      if (ob && cd[i].low <= ob.top && cd[i].high >= ob.bot) o[i] = ob.dir; } return o; };
  M.fvg = (cd) => { const n = cd.length, o = new Array(n).fill(0); let g = [];
    for (let i = 2; i < n; i++) { if (cd[i - 2].high < cd[i].low) g.push({ lo: cd[i - 2].high, hi: cd[i].low, dir: 1 });
      if (cd[i - 2].low > cd[i].high) g.push({ lo: cd[i].high, hi: cd[i - 2].low, dir: -1 });
      const c = cd[i]; for (const x of g) if (c.low <= x.hi && c.high >= x.lo) { o[i] = x.dir; break; } if (g.length > 60) g = g.slice(-60); } return o; };
  M.liq_sweep = (cd) => { const n = cd.length, w = 20, o = new Array(n).fill(null);
    for (let i = w; i < n; i++) { let hh = -Infinity, ll = Infinity; for (let j = i - w; j < i; j++) { hh = Math.max(hh, cd[j].high); ll = Math.min(ll, cd[j].low); }
      const c = cd[i]; o[i] = (c.high > hh && c.close < hh) ? -1 : (c.low < ll && c.close > ll) ? 1 : 0; } return o; };
  M.false_breakout = (cd) => { const cl = cd.map(c => c.close), n = cl.length, w = 15, o = new Array(n).fill(null);
    for (let i = w; i < n; i++) { let hi = -Infinity, lo = Infinity; for (let j = i - w; j < i; j++) { hi = Math.max(hi, cl[j]); lo = Math.min(lo, cl[j]); }
      const c = cd[i]; o[i] = (c.high > hi && c.close <= hi) ? -1 : (c.low < lo && c.close >= lo) ? 1 : 0; } return o; };
  M.vsa_abs = (cd) => { const n = cd.length, at = atr(cd, 14), o = new Array(n).fill(null), vw = 20;
    for (let i = vw; i < n; i++) { if (at[i] == null) continue; let vs = 0; for (let j = i - vw; j < i; j++) vs += cd[j].volume || 0;
      const va = vs / vw, c = cd[i], rng = c.high - c.low, vol = c.volume || 0; o[i] = (va > 0 && vol >= 1.8 * va && rng > 0 && rng <= 0.7 * at[i]) ? (-Math.sign(c.close - c.open) || 0) : 0; } return o; };
  M.waning = (cd) => { const n = cd.length, o = new Array(n).fill(null), b = k => cd[k].close - cd[k].open;
    for (let i = 3; i < n; i++) { const d = Math.sign(b(i)); o[i] = (d !== 0 && d === Math.sign(b(i - 1)) && d === Math.sign(b(i - 2)) && Math.abs(b(i)) < Math.abs(b(i - 1)) && Math.abs(b(i - 1)) < Math.abs(b(i - 2))) ? -d : 0; } return o; };
  M.talib_anti = (cd) => { const n = cd.length, at = atr(cd, 14), o = new Array(n).fill(null);
    for (let i = 0; i < n; i++) { if (at[i] == null || at[i] <= 0) continue; const c = cd[i], body = c.close - c.open, rng = c.high - c.low; o[i] = (rng > 0 && Math.abs(body) >= 1.2 * at[i] && Math.abs(body) / rng >= 0.6) ? -Math.sign(body) : 0; } return o; };
  M.hawkes = (cd) => { const cl = cd.map(c => c.close), n = cl.length, o = new Array(n).fill(null);
    const hl = 10, a = 1 - Math.pow(0.5, 1 / hl); let it = 0; const I = new Array(n).fill(null);
    for (let i = 1; i < n; i++) { const r = Math.abs(cl[i] - cl[i - 1]) / cl[i - 1]; it = a * r + (1 - a) * it; I[i] = it; }
    const w = 5; for (let i = w + 1; i < n; i++) { if (I[i] == null || I[i - 1] == null) continue; const dr = Math.sign(cl[i] - cl[i - w]); o[i] = (I[i] > I[i - 1] && dr !== 0) ? dr : 0; } return o; };
  M.cascade = (cd) => { const z = M.zscore(cd), ob = M.order_block(cd), fv = M.fvg(cd), n = cd.length, o = new Array(n).fill(0);
    for (let i = 0; i < n; i++) { const parts = [z[i] != null ? Math.sign(z[i]) * (Math.abs(z[i]) >= 1.5 ? 1 : 0) : 0, Math.sign(ob[i] || 0), Math.sign(fv[i] || 0)];
      const s = parts.reduce((a, b) => a + b, 0); o[i] = Math.abs(s) >= 2 ? Math.sign(s) : 0; } return o; };
  M.nw = (cd) => { const cl = cd.map(c => c.close), n = cl.length, at = atr(cd, 14), N = 10, w = 60, k = 5, h = 0.4;
    const T = new Array(n).fill(null), P = new Array(n).fill(null), C = new Array(n).fill(null);
    for (let i = 0; i < n; i++) { const c = cd[i]; if (at[i] && at[i] > 0) { const vv = (c.volume && c.volume > 0) ? c.volume : 1; T[i] = vv * (c.high - c.low) / at[i]; } } // без объёма — прокси по размаху
    for (let i = N; i < n; i++) { const ch = Math.abs(cl[i] - cl[i - N]); let v = 0; for (let j = i - N + 1; j <= i; j++) v += Math.abs(cl[j] - cl[j - 1]); P[i] = v > 0 ? ch / v : 0; }
    const roc = new Array(n).fill(null); for (let i = N; i < n; i++) roc[i] = (cl[i] - cl[i - N]) / cl[i - N];
    for (let i = 2 * N; i < n; i++) C[i] = roc[i] - roc[i - N];
    const zf = (arr, i) => { if (i < w) return null; let s = 0, s2 = 0, c = 0; for (let j = i - w + 1; j <= i; j++) { if (arr[j] == null) continue; s += arr[j]; s2 += arr[j] * arr[j]; c++; }
      if (c < w * 0.6 || arr[i] == null) return null; const m = s / c, sd = Math.sqrt(Math.max(1e-12, s2 / c - m * m)); return (arr[i] - m) / sd; };
    const zT = [], zP = [], zC = []; for (let i = 0; i < n; i++) { zT[i] = zf(T, i); zP[i] = zf(P, i); zC[i] = zf(C, i); }
    const inQ = i => zT[i] != null && zP[i] != null && zC[i] != null && zT[i] < -0.4 && zP[i] > 0.6;
    const o = new Array(n).fill(0);
    for (let i = w; i < n; i++) { if (!inQ(i)) { o[i] = 0; continue; } let ws = 0, wp = 0, cnt = 0;
      for (let j = w; j <= i - k; j++) { if (!inQ(j)) continue; if (Math.sign(zC[j]) !== Math.sign(zC[i])) continue;
        const d2 = (zT[j] - zT[i]) ** 2 + (zP[j] - zP[i]) ** 2 + (zC[j] - zC[i]) ** 2, ww = Math.exp(-d2 / (2 * h * h)); ws += ww; wp += ww * (cl[j + k] > cl[j] ? 1 : 0); cnt++; }
      if (ws < 0.5 || cnt < 2) { o[i] = 0; continue; } const ph = wp / ws, g = 2 * ph - 1; o[i] = Math.abs(g) < 0.2 ? 0 : Math.max(-1, Math.min(1, g)); } return o; };
  // Wilder SMMA (для Аллигатора)
  function smma(arr, per) { const n = arr.length, o = new Array(n).fill(null); if (n < per) return o;
    let s = 0; for (let k = 0; k < per; k++) s += arr[k]; o[per - 1] = s / per;
    for (let i = per; i < n; i++) o[i] = (o[i - 1] * (per - 1) + arr[i]) / per; return o; }
  // Классический Аллигатор Уильямса (SMMA 13/8/5 по медиане, сдвиг вперёд +8/+5/+3),
  // взятый ИНВЕРТИРОВАННО: раскрытая пасть (тренд по Аллигатору) → сигнал ПРОТИВ.
  // На 5-мин РФ трендследящий Аллигатор системно ошибается (проверено: anti d≈−0.12,
  // держится в OOS), поэтому фейдим.
  M.alligator_inv = (cd) => { const n = cd.length, o = new Array(n).fill(0); if (n < 26) return o;
    const med = cd.map(c => (c.high + c.low) / 2), jaw = smma(med, 13), teeth = smma(med, 8), lips = smma(med, 5);
    for (let i = 0; i < n; i++) {
      const j = i - 8 >= 0 ? jaw[i - 8] : null, t = i - 5 >= 0 ? teeth[i - 5] : null, l = i - 3 >= 0 ? lips[i - 3] : null;
      if (j == null || t == null || l == null) { o[i] = 0; continue; }
      const c = cd[i].close;
      o[i] = (l > t && t > j && c > l) ? -1 : (l < t && t < j && c < l) ? 1 : 0; // инверсия классического сигнала
    } return o; };
  // Фейд у уровня: резкий ход (≥0.5 ATR за 3 бара), упёршийся в прошлый хай/лоу
  // (реджект) → сигнал ПРОТИВ хода. Валидировано в invest-bot (docs/MOVE_ANATOMY_
  // FINDINGS: ход в прошлый экстремум разворачивается сильнее всего). breadth-
  // фильтр из бэктеста тут недоступен (нужны все тикеры) — это level-версия.
  M.fade = (cd) => { const n = cd.length, at = atr(cd, 14), o = new Array(n).fill(0);
    const m = 3, W = 100, moveA = 0.5, band = 0.5;
    for (let i = m + W; i < n; i++) { const a = at[i]; if (a == null || a <= 0) continue;
      const move = cd[i].close - cd[i - m].close; if (Math.abs(move) / a < moveA) continue;
      const md = Math.sign(move); let hmax = -Infinity, lmin = Infinity;
      for (let j = i - m - W; j < i - m; j++) { if (cd[j].high > hmax) hmax = cd[j].high; if (cd[j].low < lmin) lmin = cd[j].low; }
      const c = cd[i].close;
      const inLvl = md > 0 ? (c <= hmax && hmax - c < band * a) : (c >= lmin && c - lmin < band * a);
      if (!inLvl) continue;
      // breadth-фильтр (полная версия): фейдим только идио/против-рынка ход;
      // ход СОНАПРАВЛЕН с рынком (|M|≥медианы и знак совпал) = моментум → не фейдим.
      if (_breadthMap) { const Mk = _breadthMap.get(cd[i].time);
        if (Mk != null && Math.abs(Mk) >= _breadthMedAbs && Math.sign(Mk) === md) continue; }
      o[i] = -md; // фейд: против хода, упёршегося в уровень
    } return o; };

  // ── бэктест: winrate (частота угадывания направления) + exp ATR (экспектанси
  //    сделки с тейком/стопом — как системный прогон дашборда). Для фейдов winrate
  //    врёт (низкая при плюсовом exp), поэтому считаем обе цифры. ──────────────
  // acc — доля баров, где знак сигнала совпал с ходом через horizon (как было).
  // exp — средний P&L сделки в ATR: вход по close, тейк +T·ATR / стоп −S·ATR
  //   (интрабар, стоп проверяем первым — консервативно), минус издержки cost·ATR,
  //   без перекрытия, тайм-выход через horizon баров. Порт
  //   system_backtest.simulate_analyze_strategy из invest-bot.
  function btStats(scoreArr, bars, horizon, opts) {
    if (!scoreArr || !bars || !bars.length) return { acc: null, exp: null, win: null, n: 0 };
    horizon = horizon || 12; opts = opts || {};
    // Брекет по умолчанию R:R 2:1 (тейк 1.5 / стоп 0.75) — валидировано в invest-bot:
    // узкий 1.0/0.5 занижал exp вдвое и давал обманчиво низкий win (артефакт брекета).
    const T = opts.take != null ? opts.take : 1.5, S = opts.stop != null ? opts.stop : 0.75;
    const cost = opts.cost != null ? opts.cost : 0.12;
    const closes = bars.map(b => b.close), n = bars.length, at = atr(bars, opts.atrPer || 20);
    // winrate: доля совпадений знака с ходом через horizon баров
    let hit = 0, hn = 0;
    for (let i = 0; i < n - horizon; i++) {
      const sc = scoreArr[i]; if (sc == null || sc === 0) continue;
      const fut = closes[i + horizon] - closes[i]; if (fut === 0) continue; hn++;
      if ((sc > 0 && fut > 0) || (sc < 0 && fut < 0)) hit++;
    }
    // exp ATR: бар-за-баром сделки с тейк/стопом, одна позиция за раз
    let pnlSum = 0, wins = 0, tn = 0, pos = null;
    for (let i = 0; i < n; i++) {
      const hi = bars[i].high, lo = bars[i].low, cl = bars[i].close;
      if (pos) { // ведём открытую: стоп первым, затем тейк, затем тайм-выход
        let ex = null;
        if (pos.dir > 0) { if (lo <= pos.sl) ex = pos.sl; else if (hi >= pos.tp) ex = pos.tp; }
        else { if (hi >= pos.sl) ex = pos.sl; else if (lo <= pos.tp) ex = pos.tp; }
        if (ex == null && i - pos.i >= horizon) ex = cl;
        if (ex != null) { const p = pos.dir * (ex - pos.entry) / pos.eatr - cost;
          pnlSum += p; if (p > 0) wins++; tn++; pos = null; }
      }
      if (!pos) { // вход, если флэт и есть сигнал (и посчитан ATR)
        const sc = scoreArr[i], e = at[i];
        if (sc != null && sc !== 0 && e != null && e > 0) {
          const dir = sc > 0 ? 1 : -1;
          pos = { dir, entry: cl, tp: cl + dir * T * e, sl: cl - dir * S * e, eatr: e, i };
        }
      }
    }
    return { acc: hn > 0 ? hit / hn : null, exp: tn > 0 ? pnlSum / tn : null,
             win: tn > 0 ? wins / tn : null, n: tn };
  }

  // ── парсинг exportData() → свечи (по schema, колонки динамические) ────────────
  function parseExport(res) {
    const schema = res && res.schema, data = res && (res.data || res);
    if (!schema || !data || !data.length) return [];
    let ti = -1, oi = -1, hi = -1, li = -1, ci = -1, vi = -1;
    schema.forEach((col, idx) => {
      if (col.type === 'time') ti = idx;
      const t = (col.plotTitle || '').toLowerCase();
      if (col.sourceType === 'series') { if (t === 'open') oi = idx; else if (t === 'high') hi = idx; else if (t === 'low') li = idx; else if (t === 'close') ci = idx; else if (t === 'volume') vi = idx; }
      if (vi < 0 && col.plotId === 'vol') vi = idx; // объём как студия «Объём»
    });
    if (ti < 0 || ci < 0) return [];
    const bars = [];
    for (const row of data) {
      const t = row[ti], c = row[ci];
      if (t == null || c == null) continue;
      bars.push({ time: t, open: row[oi] != null ? row[oi] : c, high: row[hi] != null ? row[hi] : c,
        low: row[li] != null ? row[li] : c, close: c, volume: vi >= 0 && row[vi] != null ? row[vi] : 0 });
    }
    return bars;
  }

  // ── всё вместе: серии + последний сигнал + точность ──────────────────────────
  const IDS = ['zscore', 'accel', 'order_block', 'fvg', 'liq_sweep', 'false_breakout', 'vsa_abs', 'waning', 'talib_anti', 'hawkes', 'cascade', 'nw', 'alligator_inv', 'fade'];
  function computeAll(bars, horizon) {
    horizon = horizon || 12;
    const out = {};
    IDS.forEach(id => {
      let series; try { series = M[id](bars); } catch (e) { series = bars.map(() => null); }
      let last = 0; for (let i = series.length - 1; i >= 0; i--) if (series[i] != null) { last = series[i]; break; }
      out[id] = { series, last, stats: btStats(series, bars, horizon) };
    });
    return out;
  }

  // ── режим бара + условная точность по режимам + прогноз от точки ─────────────
  function _rollMedian(arr, i, W) { const s = []; for (let j = Math.max(0, i - W); j < i; j++) { const v = arr[j]; if (v != null && isFinite(v)) s.push(v); }
    if (s.length < W * 0.4) return null; s.sort((a, b) => a - b); return s[s.length >> 1]; }

  // Режим на баре i: ER тренд/боковик (окно 60, порог 0.3 — как #3), vol-состояние
  // (ATR/медиана-200: сжатие/норма/расшир — #5), рынок (breadth: ↑/↓/тих — #2).
  function regimeInfo(bars, i) {
    const n = bars.length; if (i < 0 || i >= n) return null;
    const cl = bars.map(b => b.close), at = atr(bars, 14), W = 60;
    let er = null, trendDir = 0;
    if (i >= W) { let d = 0; for (let j = i - W + 1; j <= i; j++) d += Math.abs(cl[j] - cl[j - 1]);
      if (d > 0) { er = Math.abs(cl[i] - cl[i - W]) / d; trendDir = Math.sign(cl[i] - cl[i - W]); } }
    const isTrend = er != null && er >= 0.3;
    let vol = null; if (at[i] != null) { const med = _rollMedian(at, i, 200);
      if (med != null && med > 0) { const r = at[i] / med; vol = r < 0.8 ? 'сжатие' : (r > 1.3 ? 'расшир' : 'норма'); } }
    let mkt = null; if (_breadthMap) { const Mk = _breadthMap.get(bars[i].time);
      if (Mk != null) mkt = Math.abs(Mk) < _breadthMedAbs ? 'тих' : (Mk > 0 ? 'рынок↑' : 'рынок↓'); }
    return { er, isTrend, trendDir, vol, mkt };
  }

  // Исход одной сделки от бара i (тейк/стоп в ATR интрабар, стоп первым, тайм-выход
  // через horizon). Возвращает {pnl, exit:'тейк'|'стоп'|'тайм'|'открыта', bar}.
  function tradeOutcome(bars, i, dir, take, stop, cost, horizon, at) {
    at = at || atr(bars, 14); const a = at[i]; if (a == null || a <= 0) return null;
    const entry = bars[i].close, tp = entry + dir * take * a, sl = entry - dir * stop * a;
    const last = bars.length - 1, lim = Math.min(i + horizon, last);
    for (let j = i + 1; j <= lim; j++) {
      if (dir > 0) { if (bars[j].low <= sl) return { pnl: dir * (sl - entry) / a - cost, exit: 'стоп', bar: j, entry, tp, sl, a };
        if (bars[j].high >= tp) return { pnl: dir * (tp - entry) / a - cost, exit: 'тейк', bar: j, entry, tp, sl, a }; }
      else { if (bars[j].high >= sl) return { pnl: dir * (sl - entry) / a - cost, exit: 'стоп', bar: j, entry, tp, sl, a };
        if (bars[j].low <= tp) return { pnl: dir * (tp - entry) / a - cost, exit: 'тейк', bar: j, entry, tp, sl, a }; }
    }
    if (i + horizon > last) return { pnl: null, exit: 'открыта', bar: last, entry, tp, sl, a }; // ещё в будущем
    return { pnl: dir * (bars[lim].close - entry) / a - cost, exit: 'тайм', bar: lim, entry, tp, sl, a };
  }

  // Условная точность сигнала ПО ОСЯМ (описательная статистика, независимые сделки):
  //   режим (тренд/боковик, ER), vol (сжатие/норма/расшир), рынок (breadth относительно
  //   направления сигнала: идио/с рынком/против), сессия (UTC час → ядро/край/тонко).
  // Возвращает {режим:{...}, vol:{...}, рынок:{...}, сессия:{...}}, каждое ведро {exp,win,n}.
  function condStats(scoreArr, bars, horizon, opts) {
    horizon = horizon || 12; opts = opts || {};
    const T = opts.take != null ? opts.take : 1.5, S = opts.stop != null ? opts.stop : 0.75, cost = opts.cost != null ? opts.cost : 0.12;
    const n = bars.length, at = atr(bars, 14), cl = bars.map(b => b.close), W = 60;
    const isTrend = new Array(n).fill(null), vol = new Array(n).fill(null); // precompute (без O(n²))
    for (let i = 0; i < n; i++) {
      if (i >= W) { let d = 0; for (let j = i - W + 1; j <= i; j++) d += Math.abs(cl[j] - cl[j - 1]); if (d > 0) isTrend[i] = (Math.abs(cl[i] - cl[i - W]) / d) >= 0.3; }
      if (at[i] != null) { const med = _rollMedian(at, i, 200); if (med != null && med > 0) { const r = at[i] / med; vol[i] = r < 0.8 ? 'сжатие' : (r > 1.3 ? 'расшир' : 'норма'); } }
    }
    const groups = { 'режим': ['тренд', 'боковик'], 'vol': ['сжатие', 'норма', 'расшир'],
      'рынок': ['идио', 'с рынком', 'против'], 'сессия': ['ядро', 'край', 'тонко'] };
    const G = {}; for (const g in groups) { G[g] = {}; groups[g].forEach(k => G[g][k] = { sum: 0, win: 0, n: 0 }); }
    const put = (g, k, pnl) => { const a = G[g][k]; if (!a) return; a.sum += pnl; a.win += pnl > 0 ? 1 : 0; a.n++; };
    for (let i = 0; i < n; i++) {
      const sc = scoreArr[i]; if (sc == null || sc === 0) continue;
      const dir = Math.sign(sc), out = tradeOutcome(bars, i, dir, T, S, cost, horizon, at);
      if (!out || out.pnl == null) continue;
      if (isTrend[i] != null) put('режим', isTrend[i] ? 'тренд' : 'боковик', out.pnl);
      if (vol[i]) put('vol', vol[i], out.pnl);
      if (_breadthMap) { const Mk = _breadthMap.get(bars[i].time);
        if (Mk != null) put('рынок', Math.abs(Mk) < _breadthMedAbs ? 'идио' : (Math.sign(Mk) === dir ? 'с рынком' : 'против'), out.pnl); }
      const h = new Date(bars[i].time * 1000).getUTCHours();
      put('сессия', (h >= 7 && h < 14) ? 'ядро' : ((h >= 5 && h < 7) || (h >= 14 && h < 18)) ? 'край' : 'тонко', out.pnl);
    }
    const fin = a => a.n ? { exp: a.sum / a.n, win: a.win / a.n, n: a.n } : { exp: null, win: null, n: 0 };
    const res = {}; for (const g in groups) { res[g] = {}; groups[g].forEach(k => res[g][k] = fin(G[g][k])); }
    return res;
  }

  // Прогноз NW: по аналогам текущего бара (та же логика, что M.nw) собираем
  // ФОРВАРД-ПУТЬ — что было ПОСЛЕ похожих баров. Возвращает на каждый шаг 1..kFwd
  // взвешенное среднее доходности от входа + полосу ±σ (в долях цены), число
  // аналогов и направление. null, если бар вне квадранта / мало аналогов.
  function nwForecast(cd, iq, kFwd, opts) {
    kFwd = kFwd || 12; opts = opts || {};
    const cl = cd.map(c => c.close), n = cl.length, at = atr(cd, 14), N = 10, w = 60, h = 0.4;
    const T = new Array(n).fill(null), P = new Array(n).fill(null), C = new Array(n).fill(null);
    for (let i = 0; i < n; i++) { const c = cd[i]; if (at[i] && at[i] > 0) { const vv = (c.volume && c.volume > 0) ? c.volume : 1; T[i] = vv * (c.high - c.low) / at[i]; } }
    for (let i = N; i < n; i++) { const ch = Math.abs(cl[i] - cl[i - N]); let v = 0; for (let j = i - N + 1; j <= i; j++) v += Math.abs(cl[j] - cl[j - 1]); P[i] = v > 0 ? ch / v : 0; }
    const roc = new Array(n).fill(null); for (let i = N; i < n; i++) roc[i] = (cl[i] - cl[i - N]) / cl[i - N];
    for (let i = 2 * N; i < n; i++) C[i] = roc[i] - roc[i - N];
    const zf = (arr, i) => { if (i < w) return null; let s = 0, s2 = 0, c = 0; for (let j = i - w + 1; j <= i; j++) { if (arr[j] == null) continue; s += arr[j]; s2 += arr[j] * arr[j]; c++; }
      if (c < w * 0.6 || arr[i] == null) return null; const m = s / c, sd = Math.sqrt(Math.max(1e-12, s2 / c - m * m)); return (arr[i] - m) / sd; };
    const zT = [], zP = [], zC = []; for (let i = 0; i < n; i++) { zT[i] = zf(T, i); zP[i] = zf(P, i); zC[i] = zf(C, i); }
    const valid = i => zT[i] != null && zP[i] != null && zC[i] != null;
    const inQ = i => valid(i) && zT[i] < -0.4 && zP[i] > 0.6;
    // uncond: проецируем от ЛЮБОГО бара по ближайшим аналогам (вне валидированного
    // квадранта; надёжность ниже). Иначе — только квадрант lowT-highP, как валидировано.
    const okq = opts.uncond ? valid : inQ;
    if (iq < w || iq >= n || !okq(iq)) return null;
    const an = [];
    for (let j = w; j <= iq - kFwd && j + kFwd < n; j++) { if (!okq(j)) continue; if (Math.sign(zC[j]) !== Math.sign(zC[iq])) continue;
      const d2 = (zT[j] - zT[iq]) ** 2 + (zP[j] - zP[iq]) ** 2 + (zC[j] - zC[iq]) ** 2; an.push({ j: j, ww: Math.exp(-d2 / (2 * h * h)) }); }
    if (an.length < 3) return null;
    const med = [], lo = [], hi = [];
    for (let s = 1; s <= kFwd; s++) { let sw = 0, swx = 0; const vals = [];
      for (const a of an) { const r = (cl[a.j + s] - cl[a.j]) / cl[a.j]; sw += a.ww; swx += a.ww * r; vals.push([r, a.ww]); }
      const mean = sw > 0 ? swx / sw : 0; let sv = 0; for (const v of vals) sv += v[1] * (v[0] - mean) ** 2;
      const sd = Math.sqrt(Math.max(0, sw > 0 ? sv / sw : 0)); med.push(mean); lo.push(mean - sd); hi.push(mean + sd); }
    return { n: an.length, med: med, lo: lo, hi: hi, dir: Math.sign(med[med.length - 1]), inQuad: inQ(iq) };
  }

  // текущее ведро бара по каждой оси — для подсветки «сейчас» в таблице
  function regimeBuckets(bars, i) {
    const rg = regimeInfo(bars, i); if (!rg) return {};
    const h = new Date(bars[i].time * 1000).getUTCHours();
    const ses = (h >= 7 && h < 14) ? 'ядро' : ((h >= 5 && h < 7) || (h >= 14 && h < 18)) ? 'край' : 'тонко';
    let mk = null; if (rg.mkt) mk = rg.mkt === 'тих' ? 'идио' : null; // с рынком/против зависят от сигнала — в бейдже не метим
    return { 'режим': rg.isTrend ? 'тренд' : 'боковик', 'vol': rg.vol, 'рынок': mk, 'сессия': ses };
  }

  // пересчёт одного метода (для фейда после подгрузки breadth — без полного O(n²) NW)
  function computeOne(id, bars, horizon) {
    horizon = horizon || 12;
    let series; try { series = M[id](bars); } catch (e) { series = bars.map(() => null); }
    let last = 0; for (let i = series.length - 1; i >= 0; i--) if (series[i] != null) { last = series[i]; break; }
    return { series, last, stats: btStats(series, bars, horizon) };
  }

  window.SignalsCore = { methods: M, btStats, parseExport, computeAll, computeOne, atr, IDS,
    setBreadth, regimeInfo, regimeBuckets, condStats, tradeOutcome, nwForecast };
})();
