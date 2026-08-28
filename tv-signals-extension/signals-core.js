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

  // Причинная EMA по всему ряду (порт invest-bot indicators._ema: сид — первое
  // значение, дальше стандартная рекурсия). null-дыры в начале не двигают сид.
  function _emaArr(arr, per) {
    const n = arr.length, o = new Array(n).fill(null);
    const k = 2 / (per + 1); let prev = null;
    for (let i = 0; i < n; i++) {
      const v = arr[i];
      if (v == null) { o[i] = prev; continue; }
      prev = prev == null ? v : k * v + (1 - k) * prev;
      o[i] = prev;
    }
    return o;
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

  // Зона-фейд — валидированная стратегия взамен NW (invest-bot аудит: весь edge NW =
  // mean-reversion в зоне + гейты, аналог-память избыточна). TEST short +0.25 ATR,
  // CI [+0.11,+0.20], permutation p≈0, holdout/синхронность/концентрация — чисто.
  //   зона : z(T)<-0.4 & z(P)>0.6 (низкая интенсивность, высокая направленность);
  //   вход : ФЕЙД хода 3 баров; гейты: не с рынком (breadth) + боковик (ER-60<0.3).
  M.zonefade = (cd) => {
    const n = cd.length, o = new Array(n).fill(0); if (n < 80) return o;
    const cl = cd.map(c => c.close), at = atr(cd, 14), N = 10, w = 60;
    const Ta = new Array(n).fill(null), Pa = new Array(n).fill(null);
    for (let i = 0; i < n; i++) { const c = cd[i]; if (at[i] && at[i] > 0) { const vv = (c.volume && c.volume > 0) ? c.volume : 1; Ta[i] = vv * (c.high - c.low) / at[i]; } }
    for (let i = N; i < n; i++) { const ch = Math.abs(cl[i] - cl[i - N]); let v = 0; for (let j = i - N + 1; j <= i; j++) v += Math.abs(cl[j] - cl[j - 1]); Pa[i] = v > 0 ? ch / v : 0; }
    const zf = (arr, i) => { if (i < w) return null; let s = 0, s2 = 0, c = 0; for (let j = i - w + 1; j <= i; j++) { if (arr[j] == null) continue; s += arr[j]; s2 += arr[j] * arr[j]; c++; }
      if (c < w * 0.6 || arr[i] == null) return null; const m = s / c, sd = Math.sqrt(Math.max(1e-12, s2 / c - m * m)); return (arr[i] - m) / sd; };
    for (let i = w; i < n; i++) {
      const zT = zf(Ta, i), zP = zf(Pa, i);
      if (zT == null || zP == null || !(zT < -0.4 && zP > 0.6)) continue;   // зона lowT-highP
      const mv = cl[i] - cl[i - 3]; if (mv === 0) continue;
      const dirn = mv > 0 ? -1 : 1;                                          // ФЕЙД хода
      if (i >= 60) { let den = 0; for (let j = i - 59; j <= i; j++) den += Math.abs(cl[j] - cl[j - 1]);
        if (den > 0 && Math.abs(cl[i] - cl[i - 60]) / den >= 0.3) continue; } // гейт: только боковик
      if (_breadthMap) { const Mk = _breadthMap.get(cd[i].time);
        if (Mk != null && Math.abs(Mk) >= _breadthMedAbs && Math.sign(Mk) === dirn) continue; } // не с рынком
      o[i] = dirn;
    } return o;
  };

  // ── новые «институциональные» методы (портированы из oi_composite_strategy.py) ─
  // Портированы после реального бэктеста в боте (score_methods.py ALL --days 180):
  //   DFA_REGIME     d=+0.178 win 55.5% — сильнейший
  //   BIPOWER_JUMP   d=+0.164 win 54.5%
  //   AMIHUD_SHOCK   d=+0.144 win 54.7%
  //   VPIN_TOXICITY  d=+0.127 win 49.7%
  //   ANCHORED_VWAP  d=-0.074 win 43.9% (реализована уже ИНВЕРТИРОВАННОЙ — сигнал
  //                                       fade от anchored VWAP как MEAN-REVERSION)
  //   ELLIOTT_WAVE   d=-0.055 win 44.8% (тоже ИНВЕРТИРОВАННАЯ — 5-волновка как фейд)
  //
  // Для скорости все методы разделяют один рабочий проход и переиспользуют
  // σ доходностей / медианы там где можно; сложные окна пересчитываются per-бар.

  // AMIHUD_SHOCK: |r|/v выше 2×медианы длинного окна + недавнее движение → контр
  M.amihud_shock = (cd) => {
    const n = cd.length, o = new Array(n).fill(0);
    if (n < 50) return o;
    const cl = cd.map(c => c.close);
    // amihud[i] = |ret_i|/vol_i (0 если vol<=0)
    const am = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
      const v = cd[i].volume; if (!(v > 0) || cl[i - 1] === 0) continue;
      am[i] = Math.abs(cl[i] - cl[i - 1]) / cl[i - 1] / v;
    }
    // рекуррентная σ доходностей (по всему префиксу)
    for (let i = 50; i < n; i++) {
      // медиана Amihud по последним ≤200
      const base = am.slice(Math.max(1, i - 199), i + 1).filter(x => x > 0).sort((a, b) => a - b);
      if (!base.length) continue;
      const median = base[base.length >> 1];
      if (median <= 0) continue;
      const tailN = Math.min(10, (i - 1) >> 2);
      let tail = 0; for (let j = i - tailN + 1; j <= i; j++) tail += am[j];
      const tailAvg = tail / tailN;
      const ratio = tailAvg / median;
      // σ доходностей за префикс
      const rets = [], from = 1;
      let sm = 0; for (let j = from; j <= i; j++) { rets.push(cl[j] - cl[j - 1]); sm += cl[j] - cl[j - 1]; }
      const mr = sm / rets.length;
      let vr = 0; for (const r of rets) vr += (r - mr) * (r - mr);
      const sigma = Math.sqrt(vr / Math.max(1, rets.length - 1)) || 1e-9;
      const recRet = (cl[i] - cl[i - tailN - 1]) / (sigma * Math.sqrt(tailN));
      if (ratio < 2.0 || Math.abs(recRet) < 0.5) continue;
      const strength = Math.min(1.0, (ratio - 2.0) / 3.0);
      const dir = recRet > 0 ? -1 : 1;
      o[i] = dir * (0.20 + strength * 0.40);
    }
    return o;
  };

  // BIPOWER_JUMP: скачки в realized variance (BNS) + недавнее движение → контр
  M.bipower_jump = (cd) => {
    const n = cd.length, o = new Array(n).fill(0);
    if (n < 50) return o;
    const cl = cd.map(c => c.close);
    for (let i = 50; i < n; i++) {
      const w = Math.min(40, i);
      const rets = new Array(w);
      for (let k = 0; k < w; k++) rets[k] = cl[i - w + k + 1] - cl[i - w + k];
      let rv = 0; for (const r of rets) rv += r * r;
      if (rv <= 0) continue;
      let bv = 0; for (let k = 1; k < rets.length; k++) bv += Math.abs(rets[k]) * Math.abs(rets[k - 1]);
      bv *= Math.PI / 2;
      const jumpRatio = Math.max(0, (rv - bv)) / rv;
      if (jumpRatio < 0.4) continue;
      let sm = 0; for (const r of rets) sm += r;
      const mr = sm / rets.length;
      let vr = 0; for (const r of rets) vr += (r - mr) * (r - mr);
      const sigma = Math.sqrt(vr / Math.max(1, rets.length - 1)) || 1e-9;
      const recN = Math.min(6, rets.length);
      let recSum = 0; for (let k = rets.length - recN; k < rets.length; k++) recSum += rets[k];
      const recRet = recSum / (sigma * Math.sqrt(recN));
      if (Math.abs(recRet) < 0.7) continue;
      const strength = Math.min(1.0, (jumpRatio - 0.4) / 0.4);
      const dir = recRet > 0 ? -1 : 1;
      o[i] = dir * (0.20 + strength * 0.35);
    }
    return o;
  };

  // VPIN_TOXICITY: BVC (Bulk Volume Classification) на объёмных бакетах,
  // перцентиль VPIN относительно своей истории → контр-сигнал против движения
  M.vpin_toxicity = (cd) => {
    const n = cd.length, o = new Array(n).fill(0);
    if (n < 80) return o;
    const cl = cd.map(c => c.close);
    for (let i = 80; i < n; i++) {
      // σ доходностей на префиксе
      let sm = 0, sq = 0; for (let j = 1; j <= i; j++) { const r = cl[j] - cl[j - 1]; sm += r; sq += r * r; }
      const mr = sm / i; const sigma = Math.sqrt(Math.max(1e-18, sq / i - mr * mr)) || 1e-9;
      // avg vol
      let avgV = 0, cnt = 0; for (let j = 1; j <= i; j++) { if (cd[j].volume > 0) { avgV += cd[j].volume; cnt++; } }
      if (cnt === 0) continue; avgV /= cnt;
      // бакет-объём: 2% от суммарного объёма → ~50 бакетов на окно
      const V = Math.max(1.0, avgV * 0.02 * i);
      const buckets = [];
      let cB = 0, cS = 0, cV = 0;
      for (let j = 1; j <= i; j++) {
        const r = cl[j] - cl[j - 1], v = cd[j].volume;
        if (!(v > 0)) continue;
        // buy_frac по CDF нормали
        const z = r / (sigma * Math.SQRT2);
        // приближение erf ≈ tanh для скорости (в реальных задачах точность достаточна)
        const erf = Math.tanh(1.1283791670955126 * z); // 2/√π
        const buy = 0.5 * (1 + erf);
        let rem = v;
        while (rem > 0) {
          const room = V - cV, take = Math.min(rem, room);
          cB += take * buy; cS += take * (1 - buy); cV += take; rem -= take;
          if (cV >= V - 1e-9) { buckets.push(Math.abs(cB - cS) / V); cB = cS = cV = 0; }
        }
      }
      if (buckets.length < 5) continue;
      const winB = buckets.slice(-15);
      const vpin = winB.reduce((a, b) => a + b, 0) / winB.length;
      let below = 0; for (const b of buckets) if (b <= vpin) below++;
      const pct = below / buckets.length;
      if (pct < 0.75) continue;
      const refI = Math.max(0, i - Math.min(30, i >> 2));
      const recRet = (cl[i] - cl[refI]) / (sigma * Math.sqrt(i - refI) + 1e-9);
      if (Math.abs(recRet) < 0.5) continue;
      const strength = (pct - 0.75) / 0.25;
      const dir = recRet > 0 ? -1 : 1;
      o[i] = dir * Math.min(0.6, 0.20 + strength * 0.40);
    }
    return o;
  };

  // ANCHORED_VWAP: VWAP от последнего ATR-зигзаг пивота → сигнал fade
  // (в боте ANCHORED_VWAP anti — отклонение → mean-reversion, не тренд).
  M.anchored_vwap = (cd) => {
    const n = cd.length, o = new Array(n).fill(0), at = atr(cd, 14);
    // per-бар: находим последний пивот на префиксе, считаем VWAP от него до i
    for (let i = 30; i < n; i++) {
      const a = at[i]; if (a == null || a <= 0) continue;
      const thresh = 1.5 * a;
      // zigzag на префиксе [0..i]
      let lastPivot = -1;
      let up = true, extI = 0, extP = cd[0].high;
      for (let j = 1; j <= i; j++) {
        if (up) {
          if (cd[j].high > extP) { extI = j; extP = cd[j].high; }
          else if (extP - cd[j].low >= thresh) { lastPivot = extI; up = false; extI = j; extP = cd[j].low; }
        } else {
          if (cd[j].low < extP) { extI = j; extP = cd[j].low; }
          else if (cd[j].high - extP >= thresh) { lastPivot = extI; up = true; extI = j; extP = cd[j].high; }
        }
      }
      if (lastPivot < 0 || i - lastPivot < 8) continue;
      let num = 0, den = 0;
      for (let j = lastPivot; j <= i; j++) {
        const typ = (cd[j].high + cd[j].low + cd[j].close) / 3, v = cd[j].volume || 0;
        num += typ * v; den += v;
      }
      if (den <= 0) continue;
      const vwap = num / den;
      const dev = (cd[i].close - vwap) / a;
      // сырой сигнал tanh(dev*0.8), но ИНВЕРТИРУЕМ (fade от anchored VWAP)
      o[i] = -Math.tanh(dev * 0.8);
    }
    return o;
  };

  // ELLIOTT_WAVE (v2): жёсткие правила + инверсия (в боте anti)
  M.elliott_wave = (cd) => {
    const n = cd.length, o = new Array(n).fill(0), at = atr(cd, 14);
    for (let i = 40; i < n; i++) {
      const a = at[i]; if (a == null || a <= 0) continue;
      const thresh = 1.8 * a;
      // zigzag пивоты на префиксе
      const piv = []; // [i, price, kind]
      let up = true, extI = 0, extP = cd[0].high;
      for (let j = 1; j <= i; j++) {
        if (up) {
          if (cd[j].high > extP) { extI = j; extP = cd[j].high; }
          else if (extP - cd[j].low >= thresh) { piv.push([extI, extP, 1]); up = false; extI = j; extP = cd[j].low; }
        } else {
          if (cd[j].low < extP) { extI = j; extP = cd[j].low; }
          else if (cd[j].high - extP >= thresh) { piv.push([extI, extP, -1]); up = true; extI = j; extP = cd[j].high; }
        }
      }
      if (piv.length < 5) continue;
      const [p0i, p0p, k0] = piv[piv.length - 5];
      const [p1i, p1p, k1] = piv[piv.length - 4];
      const [, p2p, k2] = piv[piv.length - 3];
      const [, p3p, k3] = piv[piv.length - 2];
      const [p4i, p4p, k4] = piv[piv.length - 1];
      if (!(k0 === -k1 && k1 === k2 * -1 && k2 === -k3 && k3 === k4 * -1)) continue;
      const direction = k1 === 1 ? 1 : -1;
      const w1 = Math.abs(p1p - p0p), w2 = Math.abs(p2p - p1p), w3 = Math.abs(p3p - p2p), w4 = Math.abs(p4p - p3p);
      const lastClose = cd[i].close;
      const w5 = Math.max(0, direction * (lastClose - p4p));
      if (w1 <= 0 || w2 <= 0 || w3 <= 0 || w4 <= 0) continue;
      if (direction > 0 && p2p <= p0p) continue;
      if (direction < 0 && p2p >= p0p) continue;
      if (w3 < w1) continue;
      if (direction > 0 && p4p < p1p) continue;
      if (direction < 0 && p4p > p1p) continue;
      const r2 = w2 / w1;
      if (!(r2 >= 0.236 && r2 <= 0.886)) continue;
      if (w5 <= 0 && Math.abs(lastClose - p4p) >= a * 1.8) continue;
      let conf = 0.55; if (w3 >= w1 * 1.5) conf = Math.min(0.85, conf + 0.15);
      const w5r = w5 / w1;
      let rawScore = 0;
      if (w5r < 0.25) continue;
      if (w5r < 1.0) {
        const prog = (w5r - 0.25) / 0.75;
        rawScore = direction * conf * (0.35 + 0.65 * prog);
      } else if (w5r <= 1.68) {
        const fade = 1 - (w5r - 1) / 0.68;
        rawScore = direction * conf * fade * 0.5;
      } else {
        const excess = Math.min(1.0, (w5r - 1.68) / 1.0);
        rawScore = -direction * conf * (0.30 + 0.35 * excess);
      }
      // ИНВЕРТИРУЕМ (в боте anti)
      o[i] = -rawScore;
    }
    return o;
  };

  // DFA_REGIME: α по Detrended Fluctuation Analysis на доходностях
  // α > 0.65 → persistent → продолжение; α < 0.35 → anti → контр
  function _dfaAlpha(series) {
    const nS = series.length, minS = 8, maxS = 6;
    if (nS < minS * 4) return 0.5;
    let mean = 0; for (const x of series) mean += x; mean /= nS;
    const y = new Array(nS); let acc = 0;
    for (let i = 0; i < nS; i++) { acc += series[i] - mean; y[i] = acc; }
    const maxScale = Math.max(minS * 2, Math.floor(nS / 4));
    if (maxScale <= minS) return 0.5;
    const scales = [];
    const step = (Math.log(maxScale) - Math.log(minS)) / Math.max(1, maxS - 1);
    for (let k = 0; k < maxS; k++) {
      const s = Math.max(minS, Math.round(Math.exp(Math.log(minS) + k * step)));
      if (!scales.length || s > scales[scales.length - 1]) scales.push(s);
    }
    const logS = [], logF = [];
    for (const s of scales) {
      const nW = Math.floor(nS / s); if (nW < 4) continue;
      let fSum = 0;
      for (let w = 0; w < nW; w++) {
        // линрегрессия внутри окна
        const mx = (s - 1) / 2; let my = 0;
        for (let j = 0; j < s; j++) my += y[w * s + j]; my /= s;
        let num = 0, den = 0;
        for (let j = 0; j < s; j++) { const dx = j - mx; num += dx * (y[w * s + j] - my); den += dx * dx; }
        const slope = num / (den || 1e-9), intercept = my - slope * mx;
        for (let j = 0; j < s; j++) { const r = y[w * s + j] - (slope * j + intercept); fSum += r * r; }
      }
      const F = Math.sqrt(fSum / (nW * s));
      if (F > 0) { logS.push(Math.log(s)); logF.push(Math.log(F)); }
    }
    if (logS.length < 3) return 0.5;
    let mx = 0, my = 0;
    for (let i = 0; i < logS.length; i++) { mx += logS[i]; my += logF[i]; }
    mx /= logS.length; my /= logS.length;
    let num = 0, den = 0;
    for (let i = 0; i < logS.length; i++) { num += (logS[i] - mx) * (logF[i] - my); den += (logS[i] - mx) ** 2; }
    return num / (den || 1e-9);
  }
  M.dfa_regime = (cd) => {
    const n = cd.length, o = new Array(n).fill(0);
    if (n < 60) return o;
    const cl = cd.map(c => c.close);
    for (let i = 60; i < n; i++) {
      const rets = new Array(i);
      for (let j = 1; j <= i; j++) rets[j - 1] = cl[j] - cl[j - 1];
      const alpha = _dfaAlpha(rets);
      let sm = 0; for (const r of rets) sm += r; const mr = sm / rets.length;
      let vr = 0; for (const r of rets) vr += (r - mr) * (r - mr);
      const sigma = Math.sqrt(vr / Math.max(1, rets.length - 1)) || 1e-9;
      const recN = Math.min(10, rets.length / 5 | 0);
      if (recN < 2) continue;
      let recSum = 0; for (let k = rets.length - recN; k < rets.length; k++) recSum += rets[k];
      const recRet = recSum / (sigma * Math.sqrt(recN));
      if (Math.abs(recRet) < 0.4) continue;
      if (alpha > 0.65) {
        const strength = Math.min(1.0, (alpha - 0.65) / 0.35);
        o[i] = (recRet > 0 ? 1 : -1) * (0.25 + strength * 0.35);
      } else if (alpha < 0.35) {
        const strength = Math.min(1.0, (0.35 - alpha) / 0.35);
        o[i] = (recRet > 0 ? -1 : 1) * (0.20 + strength * 0.30);
      }
    }
    return o;
  };

  // ── топ-10 по вкладу в toggle_effect.py (invest-bot): 6 disable-кандидатов
  // (RMI/KLINGER/TWIGGS/DONCHIAN/WICK_REJECTION/LEVEL_QUALITY — везде носили
  // ноль/шум в BASELINE+walk_forward) + 4 invert-кандидата (BB_KELTNER_SQUEEZE/
  // ADAPTIVE_MA/FRACTIONAL_DIFF/CUMUL_DELTA — anti во всех прогонах). Портированы
  // с той же степенью упрощения, что и остальные extension-методы: базовая
  // формула сохранена 1:1, второстепенные бонусы (дивергенции, накопление,
  // long-tail-множители на 40+ баров истории) свёрнуты — они на знак почти не
  // влияют, только на амплитуду. disable-методы всё равно обнуляются в
  // computeAll (_DISABLED_METHODS) — их точность не критична для composite,
  // но сохранена для ⓘ-описаний и потенциального re-enable в будущем.

  M.rmi = (cd) => { const cl = cd.map(c => c.close), n = cl.length, per = 14, mom = 5, o = new Array(n).fill(0);
    for (let i = per + mom; i < n; i++) {
      let up = 0, down = 0;
      for (let j = i - per + 1; j <= i; j++) { const d = cl[j] - cl[j - mom]; if (d > 0) up += d; else down -= d; }
      const total = up + down; if (total <= 0) { o[i] = 0; continue; }
      const v = 100 * up / total;
      o[i] = v > 70 ? -1 : v > 55 ? 0.5 : v < 30 ? 1 : v < 45 ? -0.5 : 0;
    } return o; };

  M.klinger = (cd) => { const n = cd.length, o = new Array(n).fill(0);
    if (n < 10) return o;
    const hlc = cd.map(c => c.high + c.low + c.close);
    const trend = new Array(n).fill(1); for (let i = 1; i < n; i++) trend[i] = hlc[i] > hlc[i - 1] ? 1 : -1;
    const dm = cd.map(c => c.high - c.low);
    const vf = new Array(n).fill(0); let cumDm = dm[0] || 1e-9, prevTrend = trend[0];
    for (let i = 1; i < n; i++) {
      if (trend[i] !== prevTrend) cumDm = dm[i] || 1e-9; else cumDm += dm[i];
      prevTrend = trend[i];
      const ratio = cumDm ? dm[i] / cumDm : 0;
      vf[i] = (cd[i].volume || 0) * Math.abs(2 * ratio - 1) * trend[i] * 100;
    }
    const fastP = Math.min(34, Math.max(2, n >> 1)), slowP = Math.min(55, Math.max(2, n - 1));
    const fast = _emaArr(vf, fastP), slow = _emaArr(vf, slowP);
    for (let i = 1; i < n; i++) {
      const v = (fast[i] || 0) - (slow[i] || 0), p = (fast[i - 1] || 0) - (slow[i - 1] || 0);
      o[i] = (v > 0 && p < 0) ? 1 : (v < 0 && p > 0) ? -1 : v > 0 ? 0.5 : v < 0 ? -0.5 : 0;
    } return o; };

  M.twiggs = (cd) => { const n = cd.length, o = new Array(n).fill(0);
    if (n < 10) return o;
    const adv = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
      const trh = Math.max(cd[i].high, cd[i - 1].close), trl = Math.min(cd[i].low, cd[i - 1].close);
      const rng = (trh - trl) || 1e-9;
      adv[i] = (cd[i].volume || 0) * (2 * cd[i].close - trh - trl) / rng;
    }
    const vol = cd.map(c => c.volume || 0), per = Math.min(21, n - 1);
    const emaAdv = _emaArr(adv, per), emaVol = _emaArr(vol, per);
    for (let i = 0; i < n; i++) {
      const ev = emaVol[i]; if (!ev) { o[i] = 0; continue; }
      const v = (emaAdv[i] || 0) / ev;
      o[i] = v > 0.05 ? 1 : v > 0 ? 0.5 : v < -0.05 ? -1 : v < 0 ? -0.5 : 0;
    } return o; };

  // Асимметрия касаний краёв Дончиана в боковике (<4% диапазона): плотный край
  // = стена стопов/позиций → выброс идёт в менее плотную сторону.
  M.donchian = (cd) => { const n = cd.length, o = new Array(n).fill(0), period = 20;
    for (let i = period; i < n; i++) {
      let upper = -Infinity, lower = Infinity;
      for (let j = i - period + 1; j <= i; j++) { upper = Math.max(upper, cd[j].high); lower = Math.min(lower, cd[j].low); }
      const mid = (upper + lower) / 2, bandRange = upper - lower;
      if (bandRange < 1e-9) { o[i] = 0; continue; }
      if (bandRange / (mid || 1e-9) > 0.04) { o[i] = 0; continue; }
      const touchThr = bandRange * 0.15;
      let upperT = 0, lowerT = 0;
      for (let j = i - period + 1; j <= i; j++) { if (cd[j].high >= upper - touchThr) upperT++; if (cd[j].low <= lower + touchThr) lowerT++; }
      const total = upperT + lowerT; if (total < 2) { o[i] = 0; continue; }
      const asym = (upperT - lowerT) / total, strength = Math.abs(asym);
      if (strength < 0.20) { o[i] = 0; continue; }
      let signal = -Math.tanh(asym * 2.5);
      const closePos = (cd[i].close - lower) / bandRange;
      if (signal > 0 && closePos < 0.25) signal *= 1.20;
      else if (signal < 0 && closePos > 0.75) signal *= 1.20;
      o[i] = Math.max(-1, Math.min(1, signal * (0.5 + strength * 0.5)));
    } return o; };

  // Дисбаланс хвостов свечей (взвешен на объём и на "тело мало → хвост важен"),
  // окно ~2ч (24×5м). +1 = нижние хвосты доминируют (бычье отвержение).
  M.wick_rejection = (cd) => { const n = cd.length, o = new Array(n).fill(0), W = 24;
    if (n < W + 5) return o;
    const at = atr(cd, 14);
    for (let i = W + 5; i < n; i++) {
      if (at[i] == null || at[i] <= 0) { o[i] = 0; continue; }
      let volSum = 0; for (let j = i - W + 1; j <= i; j++) volSum += (cd[j].volume || 0);
      const avgVol = volSum / W || 1;
      let upperTotal = 0, lowerTotal = 0;
      for (let j = i - W + 1; j <= i; j++) {
        const c = cd[j], rng = (c.high - c.low) || 1e-9;
        const upperWick = c.high - Math.max(c.open, c.close), lowerWick = Math.min(c.open, c.close) - c.low;
        const body = Math.abs(c.close - c.open), bodyFactor = Math.max(0.3, 1.0 - body / rng);
        const volW = ((c.volume || 0) / avgVol) * bodyFactor;
        upperTotal += upperWick / rng * volW; lowerTotal += lowerWick / rng * volW;
      }
      const total = (upperTotal + lowerTotal) || 1e-9;
      const imbalance = (lowerTotal - upperTotal) / total;
      let l3u = 0, l3l = 0;
      for (let j = Math.max(0, i - 2); j <= i; j++) { l3u += cd[j].high - Math.max(cd[j].open, cd[j].close); l3l += Math.min(cd[j].open, cd[j].close) - cd[j].low; }
      const confirm = ((imbalance > 0 && l3l > l3u) || (imbalance < 0 && l3u > l3l)) ? 1.2 : 0.8;
      o[i] = Math.max(-1, Math.min(1, imbalance * confirm));
    } return o; };

  // Упрощено до 2 из 5 критериев confluence (order block + POC-прокси по
  // максимальному объёму бара в окне 100) — weekly-open/52w/second-touch
  // пропущены (не имеют внутридневного смысла и метод всё равно disabled).
  M.level_quality = (cd) => { const n = cd.length, o = new Array(n).fill(0), at = atr(cd, 14);
    for (let i = 50; i < n; i++) {
      if (at[i] == null || at[i] <= 0) { o[i] = 0; continue; }
      const price = cd[i].close, prox = 1.2 * at[i];
      let criteria = 0, direction = 0;
      for (let k = 2; k < Math.min(25, i); k++) {
        const cOb = cd[i - k - 1], cImp = cd[i - k]; if (!cOb || !cImp) continue;
        if (Math.abs(cImp.close - cImp.open) < 1.2 * at[i]) continue;
        const isBullOb = cOb.close < cOb.open && cImp.close > cImp.open;
        const isBearOb = cOb.close > cOb.open && cImp.close < cImp.open;
        const obLo = Math.min(cOb.open, cOb.close, cOb.low), obHi = Math.max(cOb.open, cOb.close, cOb.high);
        if (isBullOb && price >= obLo && price <= obHi + prox) { criteria++; direction += 1; break; }
        if (isBearOb && price >= obLo - prox && price <= obHi) { criteria++; direction -= 1; break; }
      }
      let bestV = -1, bestP = price;
      for (let j = Math.max(0, i - 100); j < i; j++) { const v = cd[j].volume || 0; if (v > bestV) { bestV = v; bestP = (cd[j].high + cd[j].low) / 2; } }
      if (Math.abs(bestP - price) <= prox) { criteria++; direction += price < bestP ? 1 : -1; }
      if (criteria < 2 || direction === 0) { o[i] = 0; continue; }
      o[i] = Math.max(-1, Math.min(1, (criteria / 5) * Math.sign(direction)));
    } return o; };

  // TTM Squeeze: BB(20,2σ) внутри KC(EMA20, 1.5×ATR14) = компрессия. Выход из
  // сжатия + TTM-momentum (close vs mid донченовского канала) → направленный
  // сигнал. Упрощено: без duration_mult (бонус за долготу сжатия по 40-бар
  // истории BB-std) — второстепенный множитель силы, знак не меняет.
  M.bb_keltner_squeeze = (cd) => { const n = cd.length, o = new Array(n).fill(0), P = 20;
    if (n < 25) return o;
    const closesAll = cd.map(c => c.close), at = atr(cd, 14);
    const kcMidArr = _emaArr(closesAll, P); // EMA считаем ОДИН раз на весь ряд, не на каждый бар
    for (let i = P + 5; i < n; i++) {
      if (at[i] == null || at[i] <= 0) { o[i] = 0; continue; }
      const win = cd.slice(i - P + 1, i + 1), closes = win.map(c => c.close);
      let s = 0, s2 = 0; for (const v of closes) { s += v; s2 += v * v; }
      const bbMid = s / P, bbStd = Math.sqrt(Math.max(0, s2 / P - (bbMid * bbMid)));
      const bbUpper = bbMid + 2.0 * bbStd, bbLower = bbMid - 2.0 * bbStd;
      const kcMid = kcMidArr[i] || bbMid, kcAtr = at[i];
      const kcUpper = kcMid + 1.5 * kcAtr, kcLower = kcMid - 1.5 * kcAtr;
      const squeezeOn = bbUpper < kcUpper && bbLower > kcLower;
      const squeezeOff = bbUpper > kcUpper && bbLower < kcLower;
      const hh = Math.max(...win.map(c => c.high)), ll = Math.min(...win.map(c => c.low));
      const delta = cd[i].close - (hh + ll + bbMid) / 3.0;
      if (squeezeOn) { o[i] = Math.abs(delta) > 1e-9 ? Math.sign(delta) * 0.20 : 0; continue; }
      if (squeezeOff) { o[i] = Math.abs(delta) > 1e-9 ? Math.sign(delta) * 0.55 : 0; continue; }
      o[i] = 0;
    } return o; };

  // Отклонение цены от KAMA (Efficiency Ratio Кауфмана), z-score от собственной
  // волатильности, tanh-сжатие. Базовая формула (без ER-множителя/дивергенции
  // из полной _candle-версии бота — та лишь модулирует амплитуду, знак тот же).
  M.adaptive_ma = (cd) => { const n = cd.length, o = new Array(n).fill(0);
    if (n < 20) return o;
    const cl = cd.map(c => c.close), period = 10, fast = 2 / 3, slow = 2 / 31;
    const kama = new Array(n).fill(null);
    kama[period] = cl[period];
    for (let i = period + 1; i < n; i++) {
      const change = Math.abs(cl[i] - cl[i - period]);
      let vol = 0; for (let j = i - period + 1; j <= i; j++) vol += Math.abs(cl[j] - cl[j - 1]);
      const er = change / (vol || 1e-9), sc = Math.pow(er * (fast - slow) + slow, 2);
      kama[i] = kama[i - 1] + sc * (cl[i] - kama[i - 1]);
    }
    for (let i = period + 1; i < n; i++) {
      const km = kama[i]; if (km == null || km <= 0) { o[i] = 0; continue; }
      const W = Math.min(200, i); let s = 0, s2 = 0;
      for (let j = i - W + 1; j <= i; j++) { s += cl[j]; s2 += cl[j] * cl[j]; }
      const m = s / W, sd = Math.sqrt(Math.max(1e-9, s2 / W - m * m)) || (km * 0.005);
      const z = (cl[i] - km) / (sd || 1e-9);
      o[i] = Math.max(-1, Math.min(1, Math.tanh(z * 0.5)));
    } return o; };

  // Дробное дифференцирование (d=0.4): веса w_k=(-1)^k·C(d,k), обрыв при |w|<1e-4
  // (окно до 40). Знак = позиция цены к взвешенной "памяти" (0.45) + наклон
  // frac-diff серии, усиленный при совпадении с ускорением (0.55).
  M.fractional_diff = (cd) => { const n = cd.length, o = new Array(n).fill(0);
    if (n < 30) return o;
    const cl = cd.map(c => c.close), d = 0.4, threshold = 1e-4, maxW = 40;
    const weights = [1.0];
    for (let k = 1; k <= maxW; k++) {
      const w = weights[weights.length - 1] * (d - k + 1) / k;
      if (Math.abs(w) < threshold) break;
      weights.push(w);
    }
    const wlen = weights.length;
    const fd = (idx) => { let s = 0; for (let k = 0; k < wlen; k++) { if (idx - k < 0) break; s += weights[k] * cl[idx - k]; } return s; };
    for (let i = wlen + 8; i < n; i++) {
      const fdNow = fd(i), fdPrev = fd(i - 3), fdOld = fd(i - 8);
      // Точная python-формула tanh((fd/(|fd|+1e-3))·|fd|/(close·0.005+1e-9))
      // при |fd|≫1e-3 сводится к tanh(fd/(close·0.005+1e-9)) — тот же знак,
      // без экзотики с двойным делением на |fd_now|.
      const signSignal = Math.tanh(fdNow / (cl[i] * 0.005 + 1e-9));
      const slope = fdNow - fdPrev, slopeOld = fdPrev - fdOld;
      const accelMult = ((slope > 0 && slopeOld > 0) || (slope < 0 && slopeOld < 0)) ? 1.2 : 0.8;
      const slopeSignal = Math.tanh(slope / (cl[i] * 0.002 + 1e-9)) * accelMult;
      o[i] = Math.max(-1, Math.min(1, signSignal * 0.45 + slopeSignal * 0.55));
    } return o; };

  // Накопленный order-flow прокси: Σ объём×знак(close-open)×min(1,2×тело/размах)
  // за окно ~1.5ч (18×5м), нормировано в диапазон окна [-1..1] + бонус за
  // растущую дельту за последние 3 бара.
  M.cumul_delta = (cd) => { const n = cd.length, o = new Array(n).fill(0), W = 18;
    if (n < W + 5) return o;
    for (let i = W + 5; i < n; i++) {
      const deltas = []; let cum = 0;
      for (let j = i - W + 1; j <= i; j++) {
        const c = cd[j], sign = c.close >= c.open ? 1 : -1;
        const rng = (c.high - c.low) || 1e-9, bodyFrac = Math.abs(c.close - c.open) / rng;
        cum += (c.volume || 0) * sign * Math.min(1, bodyFrac * 2);
        deltas.push(cum);
      }
      const mn = Math.min(...deltas), mx = Math.max(...deltas), rng2 = mx - mn;
      if (rng2 < 1e-9) { o[i] = 0; continue; }
      let norm = (deltas[deltas.length - 1] - mn) / rng2 * 2 - 1;
      if (deltas.length >= 4) {
        const recentTrend = (deltas[deltas.length - 1] - deltas[deltas.length - 4]) / (rng2 || 1e-9);
        norm = Math.max(-1, Math.min(1, norm + recentTrend * 0.3));
      }
      o[i] = norm;
    } return o; };

  // Возврат к EMA200 (mean-reversion от отрыва).
  //
  // Идея: цена ниже EMA200 и давно (≥MIN_AWAY баров) не касалась — ждём
  // отскок вверх, лонг. Выше и давно не касались — ждём откат вниз, шорт.
  //
  // Первая версия (без событийности и режимного фильтра) на OOS дала −0.10
  // ATR exp на тысячах сделок (elite_preset_validate.py, 50 тикеров/180
  // дней/5м), инверсия — ~0. Диагноз: (1) метод стрелял КАЖДЫЙ бар, пока
  // условие держится — один отрыв раздувался в 10+ сделок с одной и той же
  // предпосылкой; (2) в трендовом рынке "давно не касался EMA" означает
  // продолжение тренда, а не откат — mean-reversion туда лезть нельзя.
  //
  // Правки:
  //   1) стреляем ОДИН БАР — на кроссе (sinceTouch впервые дотягивает до
  //      minAway). Дальше держим 0, пока не будет нового касания EMA;
  //   2) режимный фильтр: сигнал только когда ER<0.3 (диапазон / слабый
  //      тренд, как в regimeInfo). В сильном тренде — 0.
  // Параллельный к M.ema200_revert массив брекетов: для баров с сигналом —
  // {take, stop} в ATR (тейк подгоняется под цель "доехать до EMA", а не под
  // общий 1.5/0.75), для остальных null. Живой composite/агрегат читает
  // только скор — брекеты нужны бэктесту (bt_stats.opts.brackets), Node-мосту
  // (run_signals_core.js) и потенциально расчёту тейк/стоп-меток на графике.
  // Заводим как атрибут функции, чтобы не менять формат методов и не плодить
  // глобальные словари.
  M.ema200_revert = (cd) => { const n = cd.length, o = new Array(n).fill(0);
    const per = 200, minAway = 40, W = 60;
    const brk = new Array(n).fill(null);
    M.ema200_revert.brackets = brk;
    if (n < per + minAway) return o;
    const cl = cd.map(c => c.close), ema = _emaArr(cl, per), at = atr(cd, 20);
    let sinceTouch = 0, fired = false; // fired: событие уже отработано на этом отрыве
    for (let i = 0; i < n; i++) {
      const e = ema[i]; if (e == null) continue;
      const touched = cd[i].high >= e && cd[i].low <= e;
      if (touched) { sinceTouch = 0; fired = false; continue; }
      sinceTouch += 1;
      if (fired) continue; // одно событие на один отрыв
      if (sinceTouch !== minAway) continue; // только момент пересечения порога
      const e20 = at[i]; if (e20 == null || e20 <= 0) continue;
      // Режимный фильтр (efficiency ratio за W баров, тот же критерий, что
      // в regimeInfo): ER≥0.3 = тренд, mean-reversion туда не лезем.
      if (i >= W) {
        let d = 0; for (let j = i - W + 1; j <= i; j++) d += Math.abs(cl[j] - cl[j - 1]);
        if (d > 0 && Math.abs(cl[i] - cl[i - W]) / d >= 0.3) { fired = true; continue; }
      }
      const dist = cl[i] - e, distAtr = Math.abs(dist) / e20;
      const mag = 0.3 + 0.7 * Math.min(1, distAtr / 3);
      o[i] = dist > 0 ? -mag : mag;
      // Fade-брекет: тейк = 60% пути к EMA (не до самой EMA — она может быть
      // далеко и никогда не сработает), но не меньше 1 ATR и не больше 5 ATR
      // (верхняя граница — чтобы сделка не висела вечно тайм-выходом). Стоп —
      // 1 ATR: отрыв продолжился ещё на ATR = наша гипотеза "разворот" не
      // сбылась. R:R получается от 1:1 (при distAtr≈1.7) до 3:1 (при distAtr≥5).
      const take = Math.max(1.0, Math.min(5.0, distAtr * 0.6));
      brk[i] = { take, stop: 1.0 };
      fired = true;
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
          // opts.brackets — параллельный массив {take,stop}|null от метода,
          // для которого дефолтный 1.5/0.75 не подходит (см. ema200_revert:
          // цель "доехать до EMA" может быть в разы дальше 1.5 ATR — узкий
          // тейк никогда не срабатывает, торгуется шум и exp уходит в минус).
          const b = opts.brackets && opts.brackets[i];
          const T_i = b ? b.take : T, S_i = b ? b.stop : S;
          pos = { dir, entry: cl, tp: cl + dir * T_i * e, sl: cl - dir * S_i * e, eatr: e, i };
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
  const IDS = ['zscore', 'accel', 'order_block', 'fvg', 'liq_sweep', 'false_breakout', 'vsa_abs', 'waning', 'talib_anti', 'hawkes', 'cascade', 'nw', 'alligator_inv', 'fade', 'zonefade',
    'dfa_regime', 'bipower_jump', 'amihud_shock', 'vpin_toxicity', 'anchored_vwap', 'elliott_wave',
    'rmi', 'klinger', 'twiggs', 'donchian', 'wick_rejection', 'level_quality',
    'bb_keltner_squeeze', 'adaptive_ma', 'fractional_diff', 'cumul_delta', 'ema200_revert'];

  // Универсал ANTI по данным score_methods.py (invest-bot/docs/BASELINE_method_
  // verdicts_2026-07.md + свежий top-50 top-liq): методы, у которых d<0 во всех
  // режимах в обоих прогонах. Инвертируем ряд перед агрегатом — так же, как
  // alligator_inv, но декларативно списком. Пороги/цифры:
  //   accel              (PRICE_ACCEL)       BASE -0.054 / top50 -0.050
  //   liq_sweep          (LIQUIDITY_SWEEP)   BASE -0.105 / глоб -0.094
  //   bb_keltner_squeeze (BB_KELTNER_SQUEEZE) walk-fw stable -0.07..-0.19
  //   adaptive_ma        (ADAPTIVE_MA)        walk-fw stable -0.07..-0.30
  //   fractional_diff    (FRACTIONAL_DIFF)    BASE -0.063, top-50 drift но anti
  //   cumul_delta        (CUMUL_DELTA)        walk-fw stable -0.02..-0.10
  // По toggle_effect.py (invest-bot): именно эта четвёрка (кроме accel/liq_sweep,
  // уже учтены) дала +6973/+5084/+3940 к весовому Δ WR — крупнейший вклад среди
  // invert-кандидатов. anchored_vwap УЖЕ инвертирован внутри метода (см.
  // "ИНВЕРТИРУЕМ (fade от anchored VWAP)") — второй раз крутить нельзя.
  const _INVERTED_GLOBAL = new Set(['accel', 'liq_sweep', 'bb_keltner_squeeze', 'adaptive_ma', 'fractional_diff', 'cumul_delta']);

  // Отключённые методы. ELLIOTT_WAVE — единственный noise по walk_forward
  // (12 окон): знак пляшет (+0.15/-0.24/+0.02/-0.66/...), инверсия не спасает.
  // rmi/klinger/twiggs/donchian/wick_rejection/level_quality — 6 disable-
  // кандидатов из method_toggle_state.json бота (по BASELINE везде нейтраль/шум,
  // подтверждено toggle_effect.py: их отключение освобождает вес для сигнальных
  // методов, -20984/-16538/-16074/-14507/-13627/-12264/-9559 к Δ WR если бы
  // остались голосовать). ema200_revert — OOS-проверка invest-bot/
  // elite_preset_validate.py (50 тикеров, 180 дней, 5м): в прямом виде
  // exp OOS стабильно отрицателен (-0.10 ATR на тысячах сделок — не шум), с
  // --invert (гипотеза «работает наоборот», как раньше оказалось у ряда
  // методов из _INVERTED_GLOBAL) стало ~0 (-0.001), а не в плюс — то есть
  // edge нет ни в одном направлении на 5-минутках, идея не подтвердилась
  // (возможно, сработает на дневных барах — не проверялось). Не дают голос
  // в composite, не рисуются (UI-бейдж «off»).
  const _DISABLED_METHODS = new Set(['elliott_wave', 'rmi', 'klinger', 'twiggs', 'donchian', 'wick_rejection', 'level_quality']);

  // Контекстная (режимная) инверсия для NW: в trending_down d от -0.109
  // (BASELINE) до -0.353 (top-50), во всех остальных режимах — signal.
  // Инвертируем только те бары, где ER≥0.3 и цена ниже, чем W баров назад.
  function _isTrendDown(bars) {
    const n = bars.length, out = new Uint8Array(n), W = 60;
    if (n < W + 1) return out;
    const cl = bars.map(b => b.close);
    for (let i = W; i < n; i++) {
      let d = 0; for (let j = i - W + 1; j <= i; j++) d += Math.abs(cl[j] - cl[j - 1]);
      if (d <= 0) continue;
      const diff = cl[i] - cl[i - W];
      if (Math.abs(diff) / d < 0.3) continue;
      if (diff < 0) out[i] = 1;
    }
    return out;
  }

  function computeAll(bars, horizon) {
    horizon = horizon || 12;
    const out = {};
    const trendDown = _isTrendDown(bars);
    IDS.forEach(id => {
      let series; try { series = M[id](bars); } catch (e) { series = bars.map(() => null); }
      let inverted = false;
      let disabled = false;
      if (_DISABLED_METHODS.has(id)) {
        // Отключённый метод: пустая серия, никакого голоса в composite.
        series = bars.map(() => 0);
        disabled = true;
      } else if (_INVERTED_GLOBAL.has(id)) {
        series = series.map(v => v == null ? null : -v);
        inverted = 'global';
      } else if (id === 'nw') {
        // Только бары в trending_down переворачиваем.
        series = series.map((v, i) => (v == null || !trendDown[i]) ? v : -v);
        inverted = 'regime:trending_down';
      }
      let last = 0; for (let i = series.length - 1; i >= 0; i--) if (series[i] != null) { last = series[i]; break; }
      out[id] = { series, last, stats: btStats(series, bars, horizon), inverted, disabled };
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

  // Variance Ratio VR(q): дисперсия q-барных лог-доходностей / (q × дисперсия
  // 1-барных). VR>1 — персистентность (тренд/момент), VR<1 — возврат к среднему
  // (шум). Порт из бота (_variance_ratio) — то же сырое число, что крутит стоп.
  function _varianceRatio(bars, q) {
    q = q || 4; const cl = bars.map(b => b.close), r = [];
    for (let i = 1; i < cl.length; i++) if (cl[i] > 0 && cl[i - 1] > 0) r.push(Math.log(cl[i] / cl[i - 1]));
    if (r.length < q * 3) return null;
    const pv = a => { const m = a.reduce((s, x) => s + x, 0) / a.length; return a.reduce((s, x) => s + (x - m) * (x - m), 0) / a.length; };
    const v1 = pv(r); if (v1 <= 0) return null;
    const qs = []; for (let i = 0; i + q <= r.length; i++) { let s = 0; for (let k = 0; k < q; k++) s += r[i + k]; qs.push(s); }
    if (qs.length < 2) return null;
    return pv(qs) / (q * v1);
  }
  // Адаптивная ширина стопа по VR (порт __noise_stop_scale). VR<0.7 — шум/возврат:
  // узкий стоп (×0.7). VR>1.3 — устойчивый тренд: стопу нужен запас (×1.15). Между —
  // гладкая интерполяция. Тейк масштабируется тем же, R:R держится.
  function _noiseStopScale(vr) {
    if (vr == null) return 1.0;
    if (vr <= 0.7) return 0.7;
    if (vr >= 1.3) return 1.15;
    if (vr <= 1.0) return 0.7 + (vr - 0.7) / 0.3 * 0.3;
    return 1.0 + (vr - 1.0) / 0.3 * 0.15;
  }
  // Волатильностный профиль тикера → адаптивные тейк/стоп (порт логики бота
  // __take_stop_mults: барьеры от ATR, ширина крутится VR-шумом). База R:R 2:1
  // (валидированная Зона-фейд), опц. override через opts.take/opts.stop.
  function volProfile(bars, opts) {
    opts = opts || {}; if (!bars || bars.length < 20) return null;
    const at = atr(bars, 14); let a = null; for (let i = at.length - 1; i >= 0; i--) if (at[i] != null) { a = at[i]; break; }
    const price = bars[bars.length - 1].close; if (!a || !price) return null;
    const baseStop = opts.stop != null ? opts.stop : 1.0, baseTake = opts.take != null ? opts.take : 2.0;
    const vr = _varianceRatio(bars, 4), noise = _noiseStopScale(vr);
    const stopK = baseStop * noise, takeK = baseTake * noise;      // R:R сохраняется
    const i = bars.length - 1; let vol = null; const med = _rollMedian(at, i, 200);
    if (med != null && med > 0) { const rr = a / med; vol = rr < 0.8 ? 'сжатие' : (rr > 1.3 ? 'расшир' : 'норма'); }
    const kind = vr == null ? 'н/д' : (vr < 0.7 ? 'возврат к среднему' : vr > 1.3 ? 'тренд/момент' : 'смешанный');
    // Пол на стоп: на тихих тикерах/коротких ТФ (или на облигациях, где цена — % от
    // номинала и дневная волатильность сотые процента) сырой ATR-стоп может выйти
    // 0.02–0.05% — уже сопоставимо со спредом/шагом цены, а не с реальным риском.
    // Такой стоп выбьет шумом раньше, чем скажет что-то о сделке — считать размер
    // позиции по нему бессмысленно. Держим R:R, просто масштабируем стоп/тейк вверх
    // до пола (эвристика, не биржевые данные о спреде — сверяй по своему тикеру).
    const minStopPct = opts.minStopPct != null ? opts.minStopPct : 0.15;
    let stopDist = stopK * a, takeDist = takeK * a, floorApplied = false;
    const rawStopPct = 100 * stopDist / price, minDist = price * minStopPct / 100;
    if (stopDist > 0 && stopDist < minDist) { const scale = minDist / stopDist; stopDist *= scale; takeDist *= scale; floorApplied = true; }
    return { atr: a, price: price, atrPct: 100 * a / price, vr: vr, noise: noise,
      stopK: stopK, takeK: takeK, stopDist: stopDist, takeDist: takeDist, vol: vol, kind: kind,
      floorApplied: floorApplied, minStopPct: minStopPct, rawStopPct: rawStopPct };
  }

  // текущее ведро бара по каждой оси — для подсветки «сейчас» в таблице
  function regimeBuckets(bars, i) {
    const rg = regimeInfo(bars, i); if (!rg) return {};
    const h = new Date(bars[i].time * 1000).getUTCHours();
    const ses = (h >= 7 && h < 14) ? 'ядро' : ((h >= 5 && h < 7) || (h >= 14 && h < 18)) ? 'край' : 'тонко';
    let mk = null; if (rg.mkt) mk = rg.mkt === 'тих' ? 'идио' : null; // с рынком/против зависят от сигнала — в бейдже не метим
    return { 'режим': rg.isTrend ? 'тренд' : 'боковик', 'vol': rg.vol, 'рынок': mk, 'сессия': ses };
  }

  // ── план активного сигнала: с какого бара идёт, ещё жив/уже опровергнут стопом,
  //    усиливается/слабеет метод в последних сделках ─────────────────────────────
  // Контигентный забег сигнала одного знака, заканчивающийся на баре i. Возвращает
  // {startIdx, dir, ageBars} или null, если на i нет сигнала.
  function signalRun(scoreArr, i) {
    if (!scoreArr || i < 0 || i >= scoreArr.length) return null;
    const dir = Math.sign(scoreArr[i] || 0); if (!dir) return null;
    let k = i; while (k > 0 && Math.sign(scoreArr[k - 1] || 0) === dir) k--;
    return { startIdx: k, dir, ageBars: i - k };
  }

  // Живой исход сделки от бара i в направлении dir: проверяет ВСЕ бары, что уже
  // случились (не только horizon), поэтому ловит стоп/тейк, даже если индикатор
  // всё ещё держит тот же знак (лаг). state: 'active' — ещё в пути (≤horizon баров
  // прошло); 'stopped' — цена уже выбила стоп (сигнал ОПРОВЕРГНУТ рынком); 'reached'
  // — цель уже достигнута; 'expired' — прошло больше horizon баров БЕЗ тейка/стопа,
  // ИЛИ (если dt задан) реального времени уже сильно больше, чем 12 обычных баров
  // заняли бы. Время — от nowTs (реальные часы «сейчас»), НЕ от bars[last].time:
  // пока биржа закрыта (после вечерней сессии до утренней/выходные), новых баров
  // не появляется, bars[last].time замирает на моменте закрытия — и без nowTs
  // сигнал висел бы «активным» всю ночь, а не переходил в 'expired'. При
  // открытии, когда придёт первый гэпующий бар, цикл выше и так поймает стоп/тейк
  // по факту гэпа — но пока данных ещё нет, статус должен опираться на часы.
  function liveOutcome(bars, i, dir, take, stop, cost, horizon, at, dt, nowTs) {
    at = at || atr(bars, 14); const a = at[i]; if (a == null || a <= 0) return null;
    const entry = bars[i].close, tp = entry + dir * take * a, sl = entry - dir * stop * a;
    const last = bars.length - 1;
    for (let j = i + 1; j <= last; j++) {
      if (dir > 0) { if (bars[j].low <= sl) return { state: 'stopped', bar: j, pnl: dir * (sl - entry) / a - cost, entry, tp, sl, a, barsElapsed: j - i };
        if (bars[j].high >= tp) return { state: 'reached', bar: j, pnl: dir * (tp - entry) / a - cost, entry, tp, sl, a, barsElapsed: j - i }; }
      else { if (bars[j].high >= sl) return { state: 'stopped', bar: j, pnl: dir * (sl - entry) / a - cost, entry, tp, sl, a, barsElapsed: j - i };
        if (bars[j].low <= tp) return { state: 'reached', bar: j, pnl: dir * (tp - entry) / a - cost, entry, tp, sl, a, barsElapsed: j - i }; }
    }
    const elapsed = last - i;
    const refNow = nowTs != null ? Math.max(nowTs, bars[last].time) : bars[last].time;
    const realElapsed = refNow - bars[i].time;
    const timeCap = dt ? horizon * dt * 1.5 : Infinity; // ×1.5 запас на обеденный перерыв/пару тонких баров
    if (elapsed >= horizon || realElapsed >= timeCap) return { state: 'expired', pnl: dir * (bars[last].close - entry) / a - cost, entry, tp, sl, a, barsElapsed: elapsed, realElapsed };
    return { state: 'active', entry, tp, sl, a, barsElapsed: elapsed, barsRemaining: horizon - elapsed, realElapsed };
  }

  // Тренд метода: экспектанси последних K закрытых сделок против K сделок ДО них
  // (тот же бар-за-баром проход, что в btStats, но со списком сделок, не только
  // суммой). state: 'up' — усиливается, 'down' — слабеет, 'flat' — стабильно,
  // null — сделок мало для сравнения.
  function methodTrend(scoreArr, bars, horizon, opts) {
    if (!scoreArr || !bars || !bars.length) return null;
    horizon = horizon || 12; opts = opts || {};
    const T = opts.take != null ? opts.take : 1.5, S = opts.stop != null ? opts.stop : 0.75, cost = opts.cost != null ? opts.cost : 0.12;
    const at = atr(bars, opts.atrPer || 20), n = bars.length;
    const trades = []; let pos = null;
    for (let i = 0; i < n; i++) {
      const hi = bars[i].high, lo = bars[i].low, cl = bars[i].close;
      if (pos) { let ex = null;
        if (pos.dir > 0) { if (lo <= pos.sl) ex = pos.sl; else if (hi >= pos.tp) ex = pos.tp; }
        else { if (hi >= pos.sl) ex = pos.sl; else if (lo <= pos.tp) ex = pos.tp; }
        if (ex == null && i - pos.i >= horizon) ex = cl;
        if (ex != null) { trades.push(pos.dir * (ex - pos.entry) / pos.eatr - cost); pos = null; } }
      if (!pos) { const sc = scoreArr[i], e = at[i];
        if (sc != null && sc !== 0 && e != null && e > 0) { const dir = sc > 0 ? 1 : -1;
          pos = { dir, entry: cl, tp: cl + dir * T * e, sl: cl - dir * S * e, eatr: e, i }; } }
    }
    const K = opts.window || 10;
    if (trades.length < K * 2) return { state: null, recentN: trades.length };
    const recent = trades.slice(-K), prior = trades.slice(-2 * K, -K);
    const avg = a => a.reduce((s, x) => s + x, 0) / a.length;
    const recentExp = avg(recent), priorExp = avg(prior), d = recentExp - priorExp;
    const state = d > 0.08 ? 'up' : d < -0.08 ? 'down' : 'flat';
    return { state, recentExp, priorExp, recentN: recent.length, priorN: prior.length };
  }

  // пересчёт одного метода (для фейда после подгрузки breadth — без полного O(n²) NW)
  function computeOne(id, bars, horizon) {
    horizon = horizon || 12;
    let series; try { series = M[id](bars); } catch (e) { series = bars.map(() => null); }
    let last = 0; for (let i = series.length - 1; i >= 0; i--) if (series[i] != null) { last = series[i]; break; }
    return { series, last, stats: btStats(series, bars, horizon) };
  }

  window.SignalsCore = { methods: M, btStats, parseExport, computeAll, computeOne, atr, IDS,
    setBreadth, regimeInfo, regimeBuckets, condStats, tradeOutcome, nwForecast, volProfile,
    signalRun, liveOutcome, methodTrend };
})();
