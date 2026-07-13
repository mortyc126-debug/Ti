/* signals-core.js — расчёт «Сигнальных моделей» на свечах графика.
 * Порт _ilStrat* + _ilBtStats из indlab (те же формулы → та же точность).
 * Чистый модуль: window.SignalsCore. Тестируется без TradingView. */
(function () {
  'use strict';

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
    const T = opts.take != null ? opts.take : 1.0, S = opts.stop != null ? opts.stop : 0.5;
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
  const IDS = ['zscore', 'accel', 'order_block', 'fvg', 'liq_sweep', 'false_breakout', 'vsa_abs', 'waning', 'talib_anti', 'hawkes', 'cascade', 'nw'];
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

  window.SignalsCore = { methods: M, btStats, parseExport, computeAll, atr, IDS };
})();
