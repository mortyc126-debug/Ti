// indicators-lib.js — независимый модуль чистых функций технического анализа.
// Никакой привязки к oi-signal/indlab — просто набор функций.
//
// Формат входных данных:
//   candles: [{o,h,l,c,v}, ...]  — по возрастанию времени (старые → новые)
//   closes:  [number, ...]       — там, где нужны только цены закрытия
//
// Возврат — либо числовой ряд той же длины (с NaN в начале, где не хватает
// данных для расчёта), либо одно число (для индексов/оценок последней точки).
// Никаких побочных эффектов, никакого состояния модуля.

(function (global) {
  'use strict';

  // ── Общие хелперы ──────────────────────────────────────────────────────
  function closesOf(candles) { return candles.map(c => c.c); }
  function highsOf(candles)  { return candles.map(c => c.h); }
  function lowsOf(candles)   { return candles.map(c => c.l); }
  function opensOf(candles)  { return candles.map(c => c.o); }
  function volsOf(candles)   { return candles.map(c => c.v ?? 0); }

  function sma(arr, period) {
    const out = new Array(arr.length).fill(NaN);
    let sum = 0;
    for (let i = 0; i < arr.length; i++) {
      sum += arr[i];
      if (i >= period) sum -= arr[i - period];
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  }

  function ema(arr, period) {
    const out = new Array(arr.length).fill(NaN);
    const k = 2 / (period + 1);
    let prev;
    for (let i = 0; i < arr.length; i++) {
      if (Number.isNaN(arr[i])) { out[i] = prev; continue; }
      prev = prev === undefined ? arr[i] : arr[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  function stdev(arr, period) {
    const out = new Array(arr.length).fill(NaN);
    for (let i = period - 1; i < arr.length; i++) {
      const slice = arr.slice(i - period + 1, i + 1);
      const m = slice.reduce((a, b) => a + b, 0) / period;
      const v = slice.reduce((a, b) => a + (b - m) * (b - m), 0) / period;
      out[i] = Math.sqrt(v);
    }
    return out;
  }

  // index 0 = 0 (а не NaN) — иначе NaN "заражает" скользящие суммы sma()/stdev() навсегда
  function returns(closes) {
    const out = new Array(closes.length).fill(0);
    for (let i = 1; i < closes.length; i++) out[i] = closes[i] / closes[i - 1] - 1;
    return out;
  }

  function logReturns(closes) {
    const out = new Array(closes.length).fill(0);
    for (let i = 1; i < closes.length; i++) out[i] = Math.log(closes[i] / closes[i - 1]);
    return out;
  }

  function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }

  function lastN(arr, n, i) { return arr.slice(Math.max(0, i - n + 1), i + 1); }

  // ── 1. Адаптивные средние ─────────────────────────────────────────────

  // KAMA — Kaufman Adaptive Moving Average
  function kama(closes, period = 10, fast = 2, slow = 30) {
    const out = new Array(closes.length).fill(NaN);
    const fastSC = 2 / (fast + 1), slowSC = 2 / (slow + 1);
    let prevKama;
    for (let i = period; i < closes.length; i++) {
      const change = Math.abs(closes[i] - closes[i - period]);
      let vol = 0;
      for (let j = i - period + 1; j <= i; j++) vol += Math.abs(closes[j] - closes[j - 1]);
      const er = vol === 0 ? 0 : change / vol;
      const sc = Math.pow(er * (fastSC - slowSC) + slowSC, 2);
      prevKama = prevKama === undefined ? closes[i] : prevKama + sc * (closes[i] - prevKama);
      out[i] = prevKama;
    }
    return out;
  }

  // FRAMA — Fractal Adaptive Moving Average
  function frama(candles, period = 16) {
    const closes = closesOf(candles), highs = highsOf(candles), lows = lowsOf(candles);
    const out = new Array(closes.length).fill(NaN);
    const half = Math.floor(period / 2);
    let prev;
    for (let i = period - 1; i < closes.length; i++) {
      const h1 = Math.max(...lastN(highs, half, i - half));
      const l1 = Math.min(...lastN(lows, half, i - half));
      const h2 = Math.max(...lastN(highs, half, i));
      const l2 = Math.min(...lastN(lows, half, i));
      const h3 = Math.max(...lastN(highs, period, i));
      const l3 = Math.min(...lastN(lows, period, i));
      const n1 = (h1 - l1) / half, n2 = (h2 - l2) / half, n3 = (h3 - l3) / period;
      let d = 1;
      if (n1 > 0 && n2 > 0 && n3 > 0) d = (Math.log(n1 + n2) - Math.log(n3)) / Math.log(2);
      const alpha = Math.exp(-4.6 * (d - 1));
      const a = Math.max(0.01, Math.min(1, alpha));
      prev = prev === undefined ? closes[i] : a * closes[i] + (1 - a) * prev;
      out[i] = prev;
    }
    return out;
  }

  // VIDYA — Variable Index Dynamic Average (по Chande Momentum Oscillator)
  function vidya(closes, period = 9, cmoPeriod = 9) {
    const out = new Array(closes.length).fill(NaN);
    let prev;
    for (let i = cmoPeriod; i < closes.length; i++) {
      let up = 0, down = 0;
      for (let j = i - cmoPeriod + 1; j <= i; j++) {
        const d = closes[j] - closes[j - 1];
        if (d > 0) up += d; else down -= d;
      }
      const cmo = (up + down) === 0 ? 0 : Math.abs((up - down) / (up + down));
      const alpha = 2 / (period + 1) * cmo;
      prev = prev === undefined ? closes[i] : alpha * closes[i] + (1 - alpha) * prev;
      out[i] = prev;
    }
    return out;
  }

  // JMA — упрощённая реализация (двойной EMA-сглаживатель с фазой)
  function jma(closes, period = 7, phase = 0) {
    const phaseRatio = Math.max(-1, Math.min(1, phase / 100)) * 0.5 + 0.5;
    const beta = 0.45 * (period - 1) / (0.45 * (period - 1) + 2);
    const out = new Array(closes.length).fill(NaN);
    let e0, e1, e2, jmaVal;
    for (let i = 0; i < closes.length; i++) {
      e0 = e0 === undefined ? closes[i] : (1 - beta) * closes[i] + beta * e0;
      e1 = e1 === undefined ? (closes[i] - (e0 ?? closes[i])) : (closes[i] - e0) * (1 - phaseRatio) + beta * e1;
      e2 = e2 === undefined ? e1 : (e0 + phaseRatio * e1 - (jmaVal ?? e0)) * Math.pow(1 - beta, 2) + Math.pow(beta, 2) * e2;
      jmaVal = (jmaVal ?? e0) + e2;
      out[i] = jmaVal;
    }
    return out;
  }

  // ZLEMA — Zero Lag EMA
  function zlema(closes, period = 14) {
    const lag = Math.floor((period - 1) / 2);
    const adjusted = closes.map((c, i) => i >= lag ? c + (c - closes[i - lag]) : c);
    return ema(adjusted, period);
  }

  // MAMA/FAMA — Ehlers MESA Adaptive MA (упрощённый Hilbert-based вариант)
  function mamaFama(closes, fastLimit = 0.5, slowLimit = 0.05) {
    const n = closes.length;
    const mama = new Array(n).fill(NaN), fama = new Array(n).fill(NaN);
    const smooth = new Array(n).fill(0), detrender = new Array(n).fill(0);
    const i1 = new Array(n).fill(0), q1 = new Array(n).fill(0);
    const i2 = new Array(n).fill(0), q2 = new Array(n).fill(0);
    const re = new Array(n).fill(0), im = new Array(n).fill(0);
    const period = new Array(n).fill(0), phase = new Array(n).fill(0);
    let mamaPrev = closes[0] ?? 0, famaPrev = closes[0] ?? 0;
    for (let i = 6; i < n; i++) {
      smooth[i] = (4 * closes[i] + 3 * closes[i - 1] + 2 * closes[i - 2] + closes[i - 3]) / 10;
      detrender[i] = (0.0962 * smooth[i] + 0.5769 * smooth[i - 2] - 0.5769 * smooth[i - 4] - 0.0962 * smooth[i - 6]) * (0.075 * (period[i - 1] || 1) + 0.54);
      q1[i] = (0.0962 * detrender[i] + 0.5769 * detrender[i - 2] - 0.5769 * detrender[i - 4] - 0.0962 * detrender[i - 6]) * (0.075 * (period[i - 1] || 1) + 0.54);
      i1[i] = detrender[i - 3] || detrender[i];
      const j1 = (0.0962 * i1[i] + 0.5769 * i1[i - 2] - 0.5769 * (i1[i - 4] || 0) - 0.0962 * (i1[i - 6] || 0)) * (0.075 * (period[i - 1] || 1) + 0.54);
      const jQ = (0.0962 * q1[i] + 0.5769 * (q1[i - 2] || 0) - 0.5769 * (q1[i - 4] || 0) - 0.0962 * (q1[i - 6] || 0)) * (0.075 * (period[i - 1] || 1) + 0.54);
      const i2v = i1[i] - jQ, q2v = q1[i] + j1;
      i2[i] = 0.2 * i2v + 0.8 * (i2[i - 1] || 0);
      q2[i] = 0.2 * q2v + 0.8 * (q2[i - 1] || 0);
      re[i] = 0.2 * (i2[i] * (i2[i - 1] || 0) + q2[i] * (q2[i - 1] || 0)) + 0.8 * (re[i - 1] || 0);
      im[i] = 0.2 * (i2[i] * (q2[i - 1] || 0) - q2[i] * (i2[i - 1] || 0)) + 0.8 * (im[i - 1] || 0);
      let p = (re[i] !== 0 && im[i] !== 0) ? 2 * Math.PI / Math.atan(im[i] / re[i]) : (period[i - 1] || 15);
      if (p > 1.5 * (period[i - 1] || p)) p = 1.5 * (period[i - 1] || p);
      if (p < 0.67 * (period[i - 1] || p)) p = 0.67 * (period[i - 1] || p);
      p = Math.max(6, Math.min(50, p));
      period[i] = 0.2 * p + 0.8 * (period[i - 1] || p);
      phase[i] = (i1[i] !== 0) ? Math.atan(q1[i] / i1[i]) * 180 / Math.PI : 0;
      let deltaPhase = (phase[i - 1] || 0) - phase[i];
      if (deltaPhase < 1) deltaPhase = 1;
      let alpha = fastLimit / deltaPhase;
      if (alpha < slowLimit) alpha = slowLimit;
      mamaPrev = alpha * closes[i] + (1 - alpha) * mamaPrev;
      famaPrev = 0.5 * alpha * mamaPrev + (1 - 0.5 * alpha) * famaPrev;
      mama[i] = mamaPrev; fama[i] = famaPrev;
    }
    return { mama, fama };
  }

  // T3 — Tilson T3 Moving Average
  function t3(closes, period = 5, vFactor = 0.7) {
    const e1 = ema(closes, period), e2 = ema(e1, period), e3 = ema(e2, period);
    const e4 = ema(e3, period), e5 = ema(e4, period), e6 = ema(e5, period);
    const c1 = -(vFactor ** 3), c2 = 3 * vFactor ** 2 + 3 * vFactor ** 3;
    const c3 = -6 * vFactor ** 2 - 3 * vFactor - 3 * vFactor ** 3, c4 = 1 + 3 * vFactor + vFactor ** 3 + 3 * vFactor ** 2;
    return closes.map((_, i) => c1 * e6[i] + c2 * e5[i] + c3 * e4[i] + c4 * e3[i]);
  }

  // ── 2. Фрактальный анализ ─────────────────────────────────────────────

  // FDI — Fractal Dimension Index
  function fdi(closes, period = 30) {
    const out = new Array(closes.length).fill(NaN);
    for (let i = period - 1; i < closes.length; i++) {
      const slice = closes.slice(i - period + 1, i + 1);
      const max = Math.max(...slice), min = Math.min(...slice);
      let length = 0;
      for (let j = 1; j < slice.length; j++) length += Math.abs(slice[j] - slice[j - 1]) / (max - min || 1);
      out[i] = 1 + (Math.log(length) + Math.log(2)) / Math.log(2 * (period - 1));
    }
    return out;
  }

  // Hurst Exponent через R/S-анализ (одно число для всего ряда/окна)
  function hurstExponent(closes, minWindow = 8) {
    const rets = logReturns(closes).filter(x => !Number.isNaN(x));
    const n = rets.length;
    if (n < minWindow * 2) return NaN;
    const sizes = [];
    for (let s = minWindow; s <= Math.floor(n / 2); s = Math.floor(s * 1.5)) sizes.push(s);
    const logSizes = [], logRS = [];
    for (const size of sizes) {
      const chunks = Math.floor(n / size);
      if (chunks < 1) continue;
      let rsSum = 0;
      for (let c = 0; c < chunks; c++) {
        const chunk = rets.slice(c * size, (c + 1) * size);
        const m = mean(chunk);
        const dev = chunk.map(x => x - m);
        let cum = 0; const cumSeries = dev.map(x => (cum += x));
        const range = Math.max(...cumSeries) - Math.min(...cumSeries);
        const sd = Math.sqrt(mean(dev.map(x => x * x)));
        rsSum += sd === 0 ? 0 : range / sd;
      }
      const avgRS = rsSum / chunks;
      if (avgRS > 0) { logSizes.push(Math.log(size)); logRS.push(Math.log(avgRS)); }
    }
    if (logSizes.length < 2) return NaN;
    // линейная регрессия logRS ~ H * logSizes + c
    const mx = mean(logSizes), my = mean(logRS);
    let num = 0, den = 0;
    for (let i = 0; i < logSizes.length; i++) { num += (logSizes[i] - mx) * (logRS[i] - my); den += (logSizes[i] - mx) ** 2; }
    return den === 0 ? NaN : num / den;
  }

  // R/S Analysis — само значение R/S для окна (без оценки H)
  function rsAnalysis(closes, window = 30) {
    const out = new Array(closes.length).fill(NaN);
    const rets = logReturns(closes);
    for (let i = window; i < closes.length; i++) {
      const chunk = rets.slice(i - window + 1, i + 1).filter(x => !Number.isNaN(x));
      const m = mean(chunk);
      const dev = chunk.map(x => x - m);
      let cum = 0; const cumSeries = dev.map(x => (cum += x));
      const range = Math.max(...cumSeries) - Math.min(...cumSeries);
      const sd = Math.sqrt(mean(dev.map(x => x * x)));
      out[i] = sd === 0 ? 0 : range / sd;
    }
    return out;
  }

  // Fractal Chaos Bands — верх/низ по фракталам Вильямса (5-バ pattern)
  function fractalChaosBands(candles) {
    const highs = highsOf(candles), lows = lowsOf(candles);
    const upper = new Array(candles.length).fill(NaN), lower = new Array(candles.length).fill(NaN);
    let lastUp = NaN, lastDown = NaN;
    for (let i = 2; i < candles.length - 2; i++) {
      if (highs[i] > highs[i - 1] && highs[i] > highs[i - 2] && highs[i] > highs[i + 1] && highs[i] > highs[i + 2]) lastUp = highs[i];
      if (lows[i] < lows[i - 1] && lows[i] < lows[i - 2] && lows[i] < lows[i + 1] && lows[i] < lows[i + 2]) lastDown = lows[i];
      upper[i] = lastUp; lower[i] = lastDown;
    }
    return { upper, lower };
  }

  // Polarized Fractal Efficiency
  function pfe(closes, period = 10, smoothing = 5) {
    const raw = new Array(closes.length).fill(NaN);
    for (let i = period; i < closes.length; i++) {
      const priceChange = closes[i] - closes[i - period];
      let path = 0;
      for (let j = i - period + 1; j <= i; j++) path += Math.sqrt((closes[j] - closes[j - 1]) ** 2 + 1);
      const dist = Math.sqrt(priceChange ** 2 + period ** 2);
      const sign = priceChange >= 0 ? 1 : -1;
      raw[i] = path === 0 ? 0 : sign * 100 * dist / path;
    }
    return ema(raw, smoothing);
  }

  // Fractal Adaptive Channel — канал на базе FRAMA ± ATR
  function fractalAdaptiveChannel(candles, period = 16, mult = 1.5) {
    const base = frama(candles, period);
    const tr = trueRange(candles);
    const atr14 = sma(tr, 14);
    return {
      mid: base,
      upper: base.map((v, i) => Number.isNaN(v) ? NaN : v + mult * (atr14[i] || 0)),
      lower: base.map((v, i) => Number.isNaN(v) ? NaN : v - mult * (atr14[i] || 0)),
    };
  }

  // ── 3. Энтропийные методы ──────────────────────────────────────────────

  function histogramProbs(arr, bins = 10) {
    const min = Math.min(...arr), max = Math.max(...arr);
    if (max === min) return [1];
    const counts = new Array(bins).fill(0);
    arr.forEach(v => { const idx = Math.min(bins - 1, Math.floor((v - min) / (max - min) * bins)); counts[idx]++; });
    return counts.filter(c => c > 0).map(c => c / arr.length);
  }

  // Shannon Entropy
  function shannonEntropy(closes, window = 30, bins = 10) {
    const rets = logReturns(closes);
    const out = new Array(closes.length).fill(NaN);
    for (let i = window; i < closes.length; i++) {
      const chunk = rets.slice(i - window + 1, i + 1).filter(x => !Number.isNaN(x));
      const probs = histogramProbs(chunk, bins);
      out[i] = -probs.reduce((s, p) => s + p * Math.log2(p), 0);
    }
    return out;
  }

  // Renyi Entropy (alpha != 1)
  function renyiEntropy(closes, window = 30, alpha = 2, bins = 10) {
    const rets = logReturns(closes);
    const out = new Array(closes.length).fill(NaN);
    for (let i = window; i < closes.length; i++) {
      const chunk = rets.slice(i - window + 1, i + 1).filter(x => !Number.isNaN(x));
      const probs = histogramProbs(chunk, bins);
      const sum = probs.reduce((s, p) => s + Math.pow(p, alpha), 0);
      out[i] = alpha === 1 ? NaN : (1 / (1 - alpha)) * Math.log2(sum);
    }
    return out;
  }

  // Tsallis Entropy (q != 1)
  function tsallisEntropy(closes, window = 30, q = 2, bins = 10) {
    const rets = logReturns(closes);
    const out = new Array(closes.length).fill(NaN);
    for (let i = window; i < closes.length; i++) {
      const chunk = rets.slice(i - window + 1, i + 1).filter(x => !Number.isNaN(x));
      const probs = histogramProbs(chunk, bins);
      const sum = probs.reduce((s, p) => s + Math.pow(p, q), 0);
      out[i] = (1 - sum) / (q - 1);
    }
    return out;
  }

  // Permutation Entropy — по ordinal-паттернам длины m
  function permutationEntropy(closes, window = 30, m = 3) {
    const out = new Array(closes.length).fill(NaN);
    for (let i = window; i < closes.length; i++) {
      const chunk = closes.slice(i - window + 1, i + 1);
      const patternCounts = new Map();
      for (let j = 0; j <= chunk.length - m; j++) {
        const sub = chunk.slice(j, j + m);
        const order = sub.map((v, idx) => idx).sort((a, b) => sub[a] - sub[b]).join(',');
        patternCounts.set(order, (patternCounts.get(order) || 0) + 1);
      }
      const total = chunk.length - m + 1;
      let h = 0;
      patternCounts.forEach(c => { const p = c / total; h -= p * Math.log2(p); });
      out[i] = h / Math.log2(factorial(m));
    }
    return out;
  }
  function factorial(n) { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; }

  // Approximate Entropy (ApEn)
  function approximateEntropy(closes, window = 30, m = 2, r = 0.2) {
    const out = new Array(closes.length).fill(NaN);
    for (let i = window; i < closes.length; i++) {
      const chunk = closes.slice(i - window + 1, i + 1);
      const sd = Math.sqrt(mean(chunk.map(v => (v - mean(chunk)) ** 2)));
      const tol = r * sd;
      out[i] = phiM(chunk, m, tol) - phiM(chunk, m + 1, tol);
    }
    return out;
  }
  function phiM(arr, m, tol) {
    const n = arr.length - m + 1;
    if (n <= 0) return 0;
    const patterns = [];
    for (let i = 0; i < n; i++) patterns.push(arr.slice(i, i + m));
    let sum = 0;
    for (let i = 0; i < n; i++) {
      let count = 0;
      for (let j = 0; j < n; j++) {
        const maxDiff = Math.max(...patterns[i].map((v, k) => Math.abs(v - patterns[j][k])));
        if (maxDiff <= tol) count++;
      }
      sum += Math.log(count / n);
    }
    return sum / n;
  }

  // Sample Entropy (SampEn) — без self-match
  function sampleEntropy(closes, window = 30, m = 2, r = 0.2) {
    const out = new Array(closes.length).fill(NaN);
    for (let i = window; i < closes.length; i++) {
      const chunk = closes.slice(i - window + 1, i + 1);
      const sd = Math.sqrt(mean(chunk.map(v => (v - mean(chunk)) ** 2)));
      const tol = r * sd;
      const a = countMatches(chunk, m + 1, tol);
      const b = countMatches(chunk, m, tol);
      out[i] = (a === 0 || b === 0) ? NaN : -Math.log(a / b);
    }
    return out;
  }
  function countMatches(arr, m, tol) {
    const n = arr.length - m + 1;
    let count = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const a = arr.slice(i, i + m), b = arr.slice(j, j + m);
      const maxDiff = Math.max(...a.map((v, k) => Math.abs(v - b[k])));
      if (maxDiff <= tol) count++;
    }
    return count;
  }

  // Spectral Entropy — на основе спектра мощности (через DFT)
  function spectralEntropy(closes, window = 32) {
    const out = new Array(closes.length).fill(NaN);
    for (let i = window; i < closes.length; i++) {
      const chunk = closes.slice(i - window + 1, i + 1);
      const power = powerSpectrum(chunk);
      const total = power.reduce((a, b) => a + b, 0) || 1;
      const probs = power.map(p => p / total).filter(p => p > 0);
      out[i] = -probs.reduce((s, p) => s + p * Math.log2(p), 0) / Math.log2(probs.length || 2);
    }
    return out;
  }
  function powerSpectrum(arr) {
    const n = arr.length;
    const power = [];
    for (let k = 0; k < n / 2; k++) {
      let re = 0, im = 0;
      for (let t = 0; t < n; t++) {
        const angle = 2 * Math.PI * k * t / n;
        re += arr[t] * Math.cos(angle);
        im -= arr[t] * Math.sin(angle);
      }
      power.push(re * re + im * im);
    }
    return power;
  }

  // ── 4. Индикаторы Джона Элерса ──────────────────────────────────────────

  // Cyber Cycle
  function cyberCycle(closes, alpha = 0.07) {
    const n = closes.length;
    const smooth = new Array(n).fill(0), cycle = new Array(n).fill(0);
    for (let i = 3; i < n; i++) {
      smooth[i] = (closes[i] + 2 * closes[i - 1] + 2 * closes[i - 2] + closes[i - 3]) / 6;
      cycle[i] = (1 - 0.5 * alpha) ** 2 * (smooth[i] - 2 * smooth[i - 1] + smooth[i - 2])
        + 2 * (1 - alpha) * (cycle[i - 1] || 0) - (1 - alpha) ** 2 * (cycle[i - 2] || 0);
    }
    return cycle;
  }

  // Roofing Filter — high-pass + super-smoother (Elhers)
  function roofingFilter(closes, hpPeriod = 48, lpPeriod = 10) {
    const n = closes.length;
    const alpha1 = (Math.cos(2 * Math.PI / hpPeriod) + Math.sin(2 * Math.PI / hpPeriod) - 1) / Math.cos(2 * Math.PI / hpPeriod);
    const hp = new Array(n).fill(0);
    for (let i = 2; i < n; i++) {
      hp[i] = (1 - alpha1 / 2) ** 2 * (closes[i] - 2 * closes[i - 1] + closes[i - 2])
        + 2 * (1 - alpha1) * hp[i - 1] - (1 - alpha1) ** 2 * hp[i - 2];
    }
    const a = Math.exp(-1.414 * Math.PI / lpPeriod);
    const b = 2 * a * Math.cos(1.414 * Math.PI / lpPeriod);
    const c2 = b, c3 = -a * a, c1 = 1 - c2 - c3;
    const out = new Array(n).fill(0);
    for (let i = 2; i < n; i++) out[i] = c1 * (hp[i] + hp[i - 1]) / 2 + c2 * out[i - 1] + c3 * out[i - 2];
    return out;
  }

  // Instantaneous Trendline
  function instantaneousTrendline(closes, alpha = 0.07) {
    const n = closes.length;
    const it = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      if (i < 2) { it[i] = closes[i]; continue; }
      it[i] = (alpha - alpha * alpha / 4) * closes[i] + 0.5 * alpha * alpha * closes[i - 1]
        - (alpha - 0.75 * alpha * alpha) * closes[i - 2] + 2 * (1 - alpha) * it[i - 1] - (1 - alpha) ** 2 * it[i - 2];
    }
    return it;
  }

  // Sinewave Indicator (упрощённо, через фазу Hilbert-преобразования cyberCycle)
  function sinewaveIndicator(closes) {
    const cycle = cyberCycle(closes);
    const n = closes.length;
    const sine = new Array(n).fill(NaN), leadSine = new Array(n).fill(NaN);
    for (let i = 6; i < n; i++) {
      const ip = cycle[i] - (cycle[i - 6] || 0);
      const qp = (cycle[i - 3] || 0);
      const phase = Math.atan2(qp, ip) * 180 / Math.PI;
      sine[i] = Math.sin(phase * Math.PI / 180);
      leadSine[i] = Math.sin((phase + 45) * Math.PI / 180);
    }
    return { sine, leadSine };
  }

  // Decycler Oscillator — close минус roofing-filtered версия (низкочастотный тренд)
  function decyclerOscillator(closes, hpPeriod = 125) {
    const n = closes.length;
    const alpha1 = (Math.cos(2 * Math.PI / hpPeriod) + Math.sin(2 * Math.PI / hpPeriod) - 1) / Math.cos(2 * Math.PI / hpPeriod);
    const decycler = new Array(n).fill(closes[0] || 0);
    for (let i = 1; i < n; i++) decycler[i] = (alpha1 / 2) * (closes[i] + closes[i - 1]) + (1 - alpha1) * decycler[i - 1];
    return closes.map((c, i) => c - decycler[i]);
  }

  // Fisherized RSI
  function fisherRsi(closes, period = 10) {
    const r = rsi(closes, period);
    return r.map(v => {
      if (Number.isNaN(v)) return NaN;
      const x = Math.max(-0.999, Math.min(0.999, (v / 100) * 2 - 1));
      return 0.5 * Math.log((1 + x) / (1 - x));
    });
  }

  // Even Better Sinewave (Ehlers) — упрощённая версия
  function evenBetterSinewave(closes, hpPeriod = 40, period = 10) {
    const hp = roofingFilter(closes, hpPeriod, period);
    const n = hp.length;
    const out = new Array(n).fill(0);
    for (let i = period; i < n; i++) {
      const window = hp.slice(i - period + 1, i + 1);
      const rms = Math.sqrt(mean(window.map(v => v * v))) || 1;
      out[i] = hp[i] / rms;
    }
    return out;
  }

  // Dominant Cycle Detector — через автокорреляцию (период максимальной корреляции)
  function dominantCycleDetector(closes, window = 50, minP = 6, maxP = 50) {
    const out = new Array(closes.length).fill(NaN);
    for (let i = window; i < closes.length; i++) {
      const chunk = closes.slice(i - window + 1, i + 1);
      let bestLag = minP, bestCorr = -Infinity;
      for (let lag = minP; lag <= Math.min(maxP, window - 1); lag++) {
        const a = chunk.slice(0, chunk.length - lag), b = chunk.slice(lag);
        const corr = pearson(a, b);
        if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
      }
      out[i] = bestLag;
    }
    return out;
  }
  function pearson(a, b) {
    const ma = mean(a), mb = mean(b);
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    return (da === 0 || db === 0) ? 0 : num / Math.sqrt(da * db);
  }

  // ── 5. Индикаторы режима рынка ───────────────────────────────────────

  // Market Meanness Index
  function marketMeannessIndex(closes, period = 200) {
    const out = new Array(closes.length).fill(NaN);
    for (let i = period - 1; i < closes.length; i++) {
      const chunk = closes.slice(i - period + 1, i + 1);
      const m = mean(chunk);
      let above = 0, crosses = 0;
      let prevAbove = chunk[0] > m;
      for (let j = 0; j < chunk.length; j++) {
        const isAbove = chunk[j] > m;
        if (isAbove) above++;
        if (j > 0 && isAbove !== prevAbove) crosses++;
        prevAbove = isAbove;
      }
      out[i] = 100 * (1 - crosses / period);
    }
    return out;
  }

  // Trend Intensity Index
  function trendIntensityIndex(closes, period = 30) {
    const sma30 = sma(closes, period);
    const out = new Array(closes.length).fill(NaN);
    for (let i = period - 1; i < closes.length; i++) {
      let posDev = 0, negDev = 0;
      for (let j = i - period + 1; j <= i; j++) {
        const dev = closes[j] - sma30[j];
        if (dev > 0) posDev += dev; else negDev -= dev;
      }
      out[i] = 100 * posDev / (posDev + negDev || 1);
    }
    return out;
  }

  // Efficiency Ratio (Kaufman)
  function efficiencyRatio(closes, period = 10) {
    const out = new Array(closes.length).fill(NaN);
    for (let i = period; i < closes.length; i++) {
      const change = Math.abs(closes[i] - closes[i - period]);
      let vol = 0;
      for (let j = i - period + 1; j <= i; j++) vol += Math.abs(closes[j] - closes[j - 1]);
      out[i] = vol === 0 ? 0 : change / vol;
    }
    return out;
  }

  // Vertical Horizontal Filter
  function vhf(closes, period = 28) {
    const out = new Array(closes.length).fill(NaN);
    for (let i = period - 1; i < closes.length; i++) {
      const chunk = closes.slice(i - period + 1, i + 1);
      const hi = Math.max(...chunk), lo = Math.min(...chunk);
      let sumAbsDiff = 0;
      for (let j = 1; j < chunk.length; j++) sumAbsDiff += Math.abs(chunk[j] - chunk[j - 1]);
      out[i] = sumAbsDiff === 0 ? 0 : (hi - lo) / sumAbsDiff;
    }
    return out;
  }

  // Trend Persistence Index — доля баров, где направление совпадает с предыдущим
  function trendPersistenceIndex(closes, period = 20) {
    const out = new Array(closes.length).fill(NaN);
    for (let i = period; i < closes.length; i++) {
      let same = 0, total = 0;
      let prevDir = Math.sign(closes[i - period + 1] - closes[i - period]);
      for (let j = i - period + 2; j <= i; j++) {
        const dir = Math.sign(closes[j] - closes[j - 1]);
        if (dir !== 0 && prevDir !== 0) { total++; if (dir === prevDir) same++; }
        if (dir !== 0) prevDir = dir;
      }
      out[i] = total === 0 ? NaN : same / total;
    }
    return out;
  }

  // Trend Quality Indicator — ER, взвешенный наклоном линейной регрессии
  function trendQualityIndicator(closes, period = 20) {
    const er = efficiencyRatio(closes, period);
    const out = new Array(closes.length).fill(NaN);
    for (let i = period - 1; i < closes.length; i++) {
      const chunk = closes.slice(i - period + 1, i + 1);
      const xs = chunk.map((_, idx) => idx);
      const mx = mean(xs), my = mean(chunk);
      let num = 0, den = 0;
      for (let j = 0; j < chunk.length; j++) { num += (xs[j] - mx) * (chunk[j] - my); den += (xs[j] - mx) ** 2; }
      const slope = den === 0 ? 0 : num / den;
      out[i] = (er[i] || 0) * Math.sign(slope) * Math.min(1, Math.abs(slope) / (my || 1) * period);
    }
    return out;
  }

  // ── 6. Продвинутая волатильность ─────────────────────────────────────

  function trueRange(candles) {
    const out = new Array(candles.length).fill(NaN);
    if (candles.length) out[0] = candles[0].h - candles[0].l;
    for (let i = 1; i < candles.length; i++) {
      const c = candles[i], p = candles[i - 1];
      out[i] = Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
    }
    return out;
  }

  // Historical Volatility (annualized stdev of log returns)
  function historicalVolatility(closes, period = 20, annualize = 252) {
    const lr = logReturns(closes);
    const out = new Array(closes.length).fill(NaN);
    for (let i = period; i < closes.length; i++) {
      const chunk = lr.slice(i - period + 1, i + 1);
      const sd = Math.sqrt(mean(chunk.map(v => (v - mean(chunk)) ** 2)));
      out[i] = sd * Math.sqrt(annualize);
    }
    return out;
  }

  // Parkinson Volatility — использует только high/low
  function parkinsonVolatility(candles, period = 20, annualize = 252) {
    const out = new Array(candles.length).fill(NaN);
    const factor = 1 / (4 * Math.log(2));
    for (let i = period - 1; i < candles.length; i++) {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += Math.pow(Math.log(candles[j].h / candles[j].l), 2);
      out[i] = Math.sqrt(factor * sum / period * annualize);
    }
    return out;
  }

  // Garman-Klass Volatility
  function garmanKlassVolatility(candles, period = 20, annualize = 252) {
    const out = new Array(candles.length).fill(NaN);
    for (let i = period - 1; i < candles.length; i++) {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) {
        const c = candles[j];
        sum += 0.5 * Math.pow(Math.log(c.h / c.l), 2) - (2 * Math.log(2) - 1) * Math.pow(Math.log(c.c / c.o), 2);
      }
      out[i] = Math.sqrt(Math.max(0, sum / period) * annualize);
    }
    return out;
  }

  // Rogers-Satchell Volatility (без drift bias)
  function rogersSatchellVolatility(candles, period = 20, annualize = 252) {
    const out = new Array(candles.length).fill(NaN);
    for (let i = period - 1; i < candles.length; i++) {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) {
        const c = candles[j];
        sum += Math.log(c.h / c.c) * Math.log(c.h / c.o) + Math.log(c.l / c.c) * Math.log(c.l / c.o);
      }
      out[i] = Math.sqrt(Math.max(0, sum / period) * annualize);
    }
    return out;
  }

  // Yang-Zhang Volatility — комбинация overnight + Rogers-Satchell
  function yangZhangVolatility(candles, period = 20, annualize = 252) {
    const out = new Array(candles.length).fill(NaN);
    const k = 0.34 / (1.34 + (period + 1) / (period - 1));
    for (let i = period; i < candles.length; i++) {
      let overnightSum = 0, openCloseSum = 0, rsSum = 0;
      for (let j = i - period + 1; j <= i; j++) {
        const c = candles[j], p = candles[j - 1];
        const o2c = Math.log(c.o / p.c);
        overnightSum += (o2c - mean(candles.slice(i - period + 1, i + 1).map((cc, idx, arr) => idx > 0 ? Math.log(cc.o / arr[idx - 1].c) : 0))) ** 2;
        const c2c = Math.log(c.c / c.o);
        openCloseSum += c2c ** 2;
        rsSum += Math.log(c.h / c.c) * Math.log(c.h / c.o) + Math.log(c.l / c.c) * Math.log(c.l / c.o);
      }
      const sigmaO = overnightSum / (period - 1), sigmaC = openCloseSum / (period - 1), sigmaRS = rsSum / period;
      out[i] = Math.sqrt(Math.max(0, sigmaO + k * sigmaC + (1 - k) * sigmaRS) * annualize);
    }
    return out;
  }

  // Ulcer Index — глубина и длительность просадок
  function ulcerIndex(closes, period = 14) {
    const out = new Array(closes.length).fill(NaN);
    for (let i = period - 1; i < closes.length; i++) {
      const chunk = closes.slice(i - period + 1, i + 1);
      let maxSoFar = -Infinity, sumSq = 0;
      for (const c of chunk) { maxSoFar = Math.max(maxSoFar, c); const dd = 100 * (c - maxSoFar) / maxSoFar; sumSq += dd * dd; }
      out[i] = Math.sqrt(sumSq / period);
    }
    return out;
  }

  // Volatility Ratio — текущий TR / средний TR
  function volatilityRatio(candles, period = 14) {
    const tr = trueRange(candles);
    const avgTr = sma(tr, period);
    return tr.map((v, i) => (avgTr[i] ? v / avgTr[i] : NaN));
  }

  // Relative Volatility Index (RVI)
  function relativeVolatilityIndex(closes, period = 10) {
    const sd = stdev(closes, period);
    const out = new Array(closes.length).fill(NaN);
    let upSum = 0, downSum = 0;
    for (let i = 1; i < closes.length; i++) {
      const isUp = closes[i] > closes[i - 1];
      const u = isUp ? sd[i] || 0 : 0, d = !isUp ? sd[i] || 0 : 0;
      if (i <= period) { upSum += u; downSum += d; }
      else { upSum = (upSum * (period - 1) + u) / period; downSum = (downSum * (period - 1) + d) / period; }
      out[i] = (upSum + downSum) === 0 ? 50 : 100 * upSum / (upSum + downSum);
    }
    return out;
  }

  // ── 7. Объёмные индикаторы ───────────────────────────────────────────

  // Klinger Volume Oscillator
  function klingerOscillator(candles, fast = 34, slow = 55) {
    const n = candles.length;
    const vf = new Array(n).fill(0);
    let prevTrend = 1, prevHLC = candles[0] ? (candles[0].h + candles[0].l + candles[0].c) : 0, cumDM = 0;
    for (let i = 1; i < n; i++) {
      const hlc = candles[i].h + candles[i].l + candles[i].c;
      const trend = hlc > prevHLC ? 1 : -1;
      const dm = candles[i].h - candles[i].l;
      cumDM = trend === prevTrend ? cumDM + dm : dm;
      const vol = candles[i].v || 0;
      vf[i] = vol * Math.abs(2 * (dm / (cumDM || 1) - 1)) * trend * 100;
      prevTrend = trend; prevHLC = hlc;
    }
    const fastE = ema(vf, fast), slowE = ema(vf, slow);
    return fastE.map((v, i) => v - slowE[i]);
  }

  // Volume Zone Oscillator
  function volumeZoneOscillator(candles, period = 14) {
    const n = candles.length;
    const vp = new Array(n).fill(0);
    for (let i = 1; i < n; i++) vp[i] = candles[i].c > candles[i - 1].c ? (candles[i].v || 0) : -(candles[i].v || 0);
    const vols = volsOf(candles);
    const emaVp = ema(vp, period), emaVol = ema(vols, period);
    return emaVp.map((v, i) => emaVol[i] ? 100 * v / emaVol[i] : NaN);
  }

  // Twiggs Money Flow
  function twiggsMoneyFlow(candles, period = 21) {
    const n = candles.length;
    const adv = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
      const c = candles[i], p = candles[i - 1];
      const trh = Math.max(c.h, p.c), trl = Math.min(c.l, p.c);
      const range = trh - trl;
      adv[i] = range === 0 ? 0 : (c.v || 0) * (2 * c.c - trh - trl) / range;
    }
    const vols = volsOf(candles);
    const emaAdv = ema(adv, period), emaVol = ema(vols, period);
    return emaAdv.map((v, i) => emaVol[i] ? v / emaVol[i] : NaN);
  }

  // Demand Index (упрощённая версия James Sibbet)
  function demandIndex(candles, period = 1) {
    const n = candles.length;
    const out = new Array(n).fill(NaN);
    for (let i = 1; i < n; i++) {
      const c = candles[i], p = candles[i - 1];
      const k = (3 * c.c) / ((c.h + c.l + c.c) / 3) - (3 * p.c) / ((p.h + p.l + p.c) / 3);
      const vAdj = (c.v || 0) * Math.abs(k || 0.001);
      out[i] = c.c > p.c ? vAdj : -vAdj;
    }
    return out;
  }

  // Volume Flow Indicator
  function volumeFlowIndicator(candles, period = 130, coef = 0.2) {
    const n = candles.length;
    const typical = candles.map(c => (c.h + c.l + c.c) / 3);
    const logVF = new Array(n).fill(0);
    for (let i = 1; i < n; i++) logVF[i] = Math.log(typical[i] / typical[i - 1]);
    const sd = stdev(logVF, period);
    const vols = volsOf(candles);
    const avgVol = sma(vols, period);
    const out = new Array(n).fill(NaN);
    let cumVF = 0;
    for (let i = period; i < n; i++) {
      const cutoff = coef * (sd[i] || 0) * typical[i];
      const vinter = vols[i];
      const minV = Math.min(vinter, avgVol[i] * 2 || vinter);
      const dir = typical[i] - typical[i - 1] > cutoff ? 1 : typical[i] - typical[i - 1] < -cutoff ? -1 : 0;
      cumVF += dir * minV;
      out[i] = avgVol[i] ? cumVF / avgVol[i] : NaN;
    }
    return out;
  }

  // Ease of Movement
  function easeOfMovement(candles, period = 14, divisor = 10000) {
    const n = candles.length;
    const emv = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
      const c = candles[i], p = candles[i - 1];
      const distance = (c.h + c.l) / 2 - (p.h + p.l) / 2;
      const boxRatio = (c.v || 1) / divisor / (c.h - c.l || 1);
      emv[i] = boxRatio === 0 ? 0 : distance / boxRatio;
    }
    return sma(emv, period);
  }

  // Negative/Positive Volume Index
  function negativeVolumeIndex(candles) {
    const n = candles.length;
    const out = new Array(n).fill(1000);
    for (let i = 1; i < n; i++) {
      const vol = candles[i].v || 0, prevVol = candles[i - 1].v || 0;
      out[i] = vol < prevVol ? out[i - 1] * (1 + (candles[i].c - candles[i - 1].c) / candles[i - 1].c) : out[i - 1];
    }
    return out;
  }
  function positiveVolumeIndex(candles) {
    const n = candles.length;
    const out = new Array(n).fill(1000);
    for (let i = 1; i < n; i++) {
      const vol = candles[i].v || 0, prevVol = candles[i - 1].v || 0;
      out[i] = vol > prevVol ? out[i - 1] * (1 + (candles[i].c - candles[i - 1].c) / candles[i - 1].c) : out[i - 1];
    }
    return out;
  }

  // ── 8. Относительная сила и межрыночный анализ ───────────────────────
  // Все функции принимают closes основного актива и closes бенчмарка/peer'а

  // Mansfield Relative Strength
  function mansfieldRS(closes, benchCloses, period = 52) {
    const ratio = closes.map((c, i) => benchCloses[i] ? c / benchCloses[i] : NaN);
    const smaRatio = sma(ratio, period);
    return ratio.map((r, i) => smaRatio[i] ? 100 * (r / smaRatio[i] - 1) : NaN);
  }

  // Relative Strength Comparative
  function rsComparative(closes, benchCloses) {
    return closes.map((c, i) => benchCloses[i] ? c / benchCloses[i] : NaN);
  }

  // Relative Momentum Index (RMI) — RSI на momentum вместо delta
  function relativeMomentumIndex(closes, period = 14, momentum = 5) {
    const mom = closes.map((c, i) => i >= momentum ? c - closes[i - momentum] : NaN);
    const out = new Array(closes.length).fill(NaN);
    let upAvg, downAvg;
    for (let i = momentum + 1; i < closes.length; i++) {
      const d = mom[i] - mom[i - 1];
      const u = Math.max(0, d), dn = Math.max(0, -d);
      if (upAvg === undefined) { upAvg = u; downAvg = dn; }
      else { upAvg = (upAvg * (period - 1) + u) / period; downAvg = (downAvg * (period - 1) + dn) / period; }
      out[i] = (upAvg + downAvg) === 0 ? 50 : 100 * upAvg / (upAvg + downAvg);
    }
    return out;
  }

  // Comparative Relative Strength — % изменение спреда актив-бенчмарк
  function comparativeRelativeStrength(closes, benchCloses, period = 20) {
    const ratio = closes.map((c, i) => benchCloses[i] ? c / benchCloses[i] : NaN);
    return ratio.map((r, i) => i >= period ? (r / ratio[i - period] - 1) * 100 : NaN);
  }

  // Beta Relative Strength — скользящая бета актива к бенчмарку
  function betaRelativeStrength(closes, benchCloses, period = 60) {
    const r1 = returns(closes), r2 = returns(benchCloses);
    const out = new Array(closes.length).fill(NaN);
    for (let i = period; i < closes.length; i++) {
      const a = r1.slice(i - period + 1, i + 1), b = r2.slice(i - period + 1, i + 1);
      const ma = mean(a), mb = mean(b);
      let cov = 0, varB = 0;
      for (let j = 0; j < a.length; j++) { cov += (a[j] - ma) * (b[j] - mb); varB += (b[j] - mb) ** 2; }
      out[i] = varB === 0 ? NaN : cov / varB;
    }
    return out;
  }

  // ── 9. Спредовый и парный анализ ─────────────────────────────────────

  // Spread Z-Score — z-оценка спреда между двумя ценовыми рядами
  function spreadZScore(closesA, closesB, period = 30) {
    const spread = closesA.map((a, i) => a - closesB[i]);
    const m = sma(spread, period), sd = stdev(spread, period);
    return spread.map((s, i) => sd[i] ? (s - m[i]) / sd[i] : NaN);
  }

  // Cointegration Score — приближённо: R² линейной регрессии A на B + ADF-подобный тест остатков
  function cointegrationScore(closesA, closesB) {
    const n = Math.min(closesA.length, closesB.length);
    const a = closesA.slice(-n), b = closesB.slice(-n);
    const mb = mean(b), ma = mean(a);
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (b[i] - mb) * (a[i] - ma); den += (b[i] - mb) ** 2; }
    const beta = den === 0 ? 0 : num / den;
    const alpha = ma - beta * mb;
    const resid = a.map((v, i) => v - (alpha + beta * b[i]));
    // приблизительный ADF: автокорреляция остатков 1-го порядка (ближе к 0 = более стационарно)
    const r1 = pearson(resid.slice(0, -1), resid.slice(1));
    return { beta, alpha, residualAutocorr: r1, isLikelyCointegrated: Math.abs(r1) < 0.3 };
  }

  // Pair Divergence Indicator — нормированное расхождение доходностей пары
  function pairDivergenceIndicator(closesA, closesB, period = 20) {
    const ra = returns(closesA), rb = returns(closesB);
    const diff = ra.map((v, i) => v - rb[i]);
    const m = sma(diff, period), sd = stdev(diff, period);
    return diff.map((d, i) => sd[i] ? (d - m[i]) / sd[i] : NaN);
  }

  // Lead-Lag Indicator — кросс-корреляция с лагом, ищем максимум
  function leadLagIndicator(closesA, closesB, maxLag = 10) {
    const ra = returns(closesA).filter(x => !Number.isNaN(x));
    const rb = returns(closesB).filter(x => !Number.isNaN(x));
    let best = { lag: 0, corr: -Infinity };
    for (let lag = -maxLag; lag <= maxLag; lag++) {
      let a, b;
      if (lag >= 0) { a = ra.slice(lag); b = rb.slice(0, rb.length - lag); }
      else { a = ra.slice(0, ra.length + lag); b = rb.slice(-lag); }
      const n = Math.min(a.length, b.length);
      if (n < 5) continue;
      const corr = pearson(a.slice(-n), b.slice(-n));
      if (corr > best.corr) best = { lag, corr };
    }
    return best; // lag>0: A ведёт B; lag<0: B ведёт A
  }

  // Statistical Arbitrage Score — комбинация z-score спреда и cointegration
  function statArbScore(closesA, closesB, period = 30) {
    const z = spreadZScore(closesA, closesB, period);
    const coint = cointegrationScore(closesA, closesB);
    const lastZ = z.filter(v => !Number.isNaN(v)).slice(-1)[0] ?? 0;
    const confidence = coint.isLikelyCointegrated ? 1 : 0.4;
    return { zscore: lastZ, confidence, signal: Math.abs(lastZ) > 2 ? -Math.sign(lastZ) * confidence : 0 };
  }

  // ── 10. Статистические признаки ──────────────────────────────────────

  function rollingZScore(closes, period = 20) {
    const m = sma(closes, period), sd = stdev(closes, period);
    return closes.map((c, i) => sd[i] ? (c - m[i]) / sd[i] : NaN);
  }

  function percentRank(closes, period = 20) {
    const out = new Array(closes.length).fill(NaN);
    for (let i = period - 1; i < closes.length; i++) {
      const chunk = closes.slice(i - period + 1, i + 1);
      const rank = chunk.filter(v => v < closes[i]).length;
      out[i] = 100 * rank / (period - 1);
    }
    return out;
  }

  function percentileRank(closes, period = 20) {
    const out = new Array(closes.length).fill(NaN);
    for (let i = period - 1; i < closes.length; i++) {
      const chunk = [...closes.slice(i - period + 1, i + 1)].sort((a, b) => a - b);
      const idx = chunk.indexOf(closes[i]);
      out[i] = 100 * idx / (period - 1);
    }
    return out;
  }

  function skewness(closes, period = 20) {
    const out = new Array(closes.length).fill(NaN);
    for (let i = period - 1; i < closes.length; i++) {
      const chunk = closes.slice(i - period + 1, i + 1);
      const m = mean(chunk);
      const sd = Math.sqrt(mean(chunk.map(v => (v - m) ** 2)));
      out[i] = sd === 0 ? 0 : mean(chunk.map(v => ((v - m) / sd) ** 3));
    }
    return out;
  }

  function kurtosis(closes, period = 20) {
    const out = new Array(closes.length).fill(NaN);
    for (let i = period - 1; i < closes.length; i++) {
      const chunk = closes.slice(i - period + 1, i + 1);
      const m = mean(chunk);
      const sd = Math.sqrt(mean(chunk.map(v => (v - m) ** 2)));
      out[i] = sd === 0 ? 0 : mean(chunk.map(v => ((v - m) / sd) ** 4)) - 3;
    }
    return out;
  }

  function autocorrelation(closes, lag = 1, period = 30) {
    const out = new Array(closes.length).fill(NaN);
    for (let i = period + lag - 1; i < closes.length; i++) {
      const chunk = closes.slice(i - period + 1, i + 1);
      const a = chunk.slice(0, chunk.length - lag), b = chunk.slice(lag);
      out[i] = pearson(a, b);
    }
    return out;
  }

  // Partial Autocorrelation (упрощённо, через рекурсию Durbin-Levinson по log returns)
  function partialAutocorrelation(closes, maxLag = 5, period = 60) {
    const rets = logReturns(closes).filter(x => !Number.isNaN(x));
    const out = [];
    const acf = [];
    for (let lag = 0; lag <= maxLag; lag++) {
      const a = rets.slice(0, rets.length - lag), b = rets.slice(lag);
      acf.push(lag === 0 ? 1 : pearson(a, b));
    }
    const phi = [[]];
    phi[1] = [acf[1]];
    out.push(acf[1]);
    for (let k = 2; k <= maxLag; k++) {
      let num = acf[k], den = 1;
      for (let j = 1; j < k; j++) { num -= phi[k - 1][j - 1] * acf[k - j]; den -= phi[k - 1][j - 1] * acf[j]; }
      const pkk = den === 0 ? 0 : num / den;
      phi[k] = phi[k - 1].map((v, j) => v - pkk * phi[k - 1][k - 2 - j]);
      phi[k].push(pkk);
      out.push(pkk);
    }
    return out; // [pacf(1), pacf(2), ..., pacf(maxLag)]
  }

  // Variance Ratio test (Lo-MacKinlay) — VR(q) для проверки random walk
  function varianceRatio(closes, q = 5) {
    const lr = logReturns(closes).filter(x => !Number.isNaN(x));
    const n = lr.length;
    if (n < q * 2) return NaN;
    const mu = mean(lr);
    const var1 = mean(lr.map(r => (r - mu) ** 2));
    let sumQ = 0;
    for (let i = q - 1; i < n; i++) {
      let s = 0;
      for (let j = i - q + 1; j <= i; j++) s += lr[j];
      sumQ += (s - q * mu) ** 2;
    }
    const varQ = sumQ / (n - q + 1) / q;
    return var1 === 0 ? NaN : varQ / var1; // ~1 = random walk, <1 = mean-reverting, >1 = trending
  }

  function volatilityPercentile(closes, volPeriod = 20, lookback = 252) {
    const vol = historicalVolatility(closes, volPeriod);
    const out = new Array(closes.length).fill(NaN);
    for (let i = lookback - 1; i < closes.length; i++) {
      const chunk = vol.slice(i - lookback + 1, i + 1).filter(v => !Number.isNaN(v));
      if (!chunk.length || Number.isNaN(vol[i])) continue;
      out[i] = 100 * chunk.filter(v => v < vol[i]).length / chunk.length;
    }
    return out;
  }

  function realizedVolatility(closes, period = 20, annualize = 252) {
    const lr = logReturns(closes);
    const out = new Array(closes.length).fill(NaN);
    for (let i = period; i < closes.length; i++) {
      const chunk = lr.slice(i - period + 1, i + 1);
      const sumSq = chunk.reduce((s, v) => s + v * v, 0);
      out[i] = Math.sqrt(sumSq * annualize / period);
    }
    return out;
  }

  // ── Вспомогательный RSI (используется Fisher RSI) ───────────────────
  function rsi(closes, period = 14) {
    const out = new Array(closes.length).fill(NaN);
    let upAvg, downAvg;
    for (let i = 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      const u = Math.max(0, d), dn = Math.max(0, -d);
      if (i <= period) { upAvg = (upAvg || 0) + u / period; downAvg = (downAvg || 0) + dn / period; }
      else { upAvg = (upAvg * (period - 1) + u) / period; downAvg = (downAvg * (period - 1) + dn) / period; }
      out[i] = (upAvg + downAvg) === 0 ? 50 : 100 * upAvg / (upAvg + downAvg);
    }
    return out;
  }

  // ── Экспорт ──────────────────────────────────────────────────────────
  const IND = {
    // утилиты
    closesOf, highsOf, lowsOf, opensOf, volsOf, sma, ema, stdev, returns, logReturns, trueRange, rsi, pearson,
    // 1. адаптивные средние
    kama, frama, vidya, jma, zlema, mamaFama, t3,
    // 2. фрактальный анализ
    fdi, hurstExponent, rsAnalysis, fractalChaosBands, pfe, fractalAdaptiveChannel,
    // 3. энтропия
    shannonEntropy, permutationEntropy, sampleEntropy, approximateEntropy, spectralEntropy, renyiEntropy, tsallisEntropy,
    // 4. Элерс
    cyberCycle, roofingFilter, sinewaveIndicator, instantaneousTrendline, decyclerOscillator, fisherRsi, evenBetterSinewave, dominantCycleDetector,
    // 5. режим рынка
    marketMeannessIndex, trendIntensityIndex, efficiencyRatio, vhf, trendPersistenceIndex, trendQualityIndicator,
    // 6. волатильность
    historicalVolatility, parkinsonVolatility, garmanKlassVolatility, rogersSatchellVolatility, yangZhangVolatility, ulcerIndex, volatilityRatio, relativeVolatilityIndex,
    // 7. объём
    klingerOscillator, volumeZoneOscillator, twiggsMoneyFlow, demandIndex, volumeFlowIndicator, easeOfMovement, negativeVolumeIndex, positiveVolumeIndex,
    // 8. относительная сила
    mansfieldRS, rsComparative, relativeMomentumIndex, comparativeRelativeStrength, betaRelativeStrength,
    // 9. спред/пары
    cointegrationScore, spreadZScore, pairDivergenceIndicator, leadLagIndicator, statArbScore,
    // 10. статистика
    rollingZScore, percentRank, percentileRank, skewness, kurtosis, autocorrelation, partialAutocorrelation, varianceRatio, volatilityPercentile, realizedVolatility,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = IND;
  else global.IND = IND;

})(typeof window !== 'undefined' ? window : globalThis);
