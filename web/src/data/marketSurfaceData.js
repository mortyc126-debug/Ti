// Адаптер для страницы «Карта». Возвращает массивы точек разных
// kind'ов (bond / stock / future) для surface-фита и горизонта.
//
// Когда подъедет реальный backend — здесь меняются ровно три функции
// (loadBondPoints, loadStockPoints, loadFuturePoints). Всё остальное
// продолжит работать.

import { bondsMock, safetyScore, bqiScore } from './bondsCatalog.js';
import { stocksMock, futuresMock } from './stocksMock.js';
import { qualityY, maturityYears } from '../lib/qualityComposite.js';

// ─── ОБЛИГАЦИИ ─────────────────────────────────────────────────────
//   x = срок до погашения (годы), y = качество (composite/rating),
//   z = YTM (%).
export function loadBondPoints({ yMode = 'scoring', typeFilter = null } = {}){
  const out = [];
  for(const b of bondsMock){
    if(typeFilter && !typeFilter.has(b.type)) continue;
    const x = maturityYears(b.mat_date);
    const y = qualityY(b, yMode);
    const z = b.ytm;
    if(x == null || y == null || z == null) continue;
    out.push({
      secid: b.secid, name: b.name, issuer: b.issuer,
      type: b.type, rating: b.rating, industry: b.industry,
      volumeBn: b.volume_bn,
      mults: { ...b.mults, safety: safetyScore(b), bqi: bqiScore(b) },
      x, y, z,
    });
  }
  return out;
}

// ─── АКЦИИ ────────────────────────────────────────────────────────
//   Здесь нет «срока» — поверхность фитим 1D по качеству.
//   x = качество (то же, что y) — формально для совместимости с
//        kernelSurface, который ждёт (x, y, z). Передаём x = y.
//   y = качество (composite по yMode).
//   z = E/P (%) — earnings yield, аналог YTM для акции.
//   ratingC хранится в b.rating, ratingOrd работает.
export function loadStockPoints({ yMode = 'scoring' } = {}){
  const out = [];
  for(const s of stocksMock){
    if(s.ep == null) continue;
    const y = qualityY(s, yMode);
    if(y == null) continue;
    const fakeBondForScores = { mults: s.mults };
    out.push({
      secid: s.secid, name: s.name, issuer: s.issuer,
      ticker: s.ticker,
      industry: s.industry, rating: s.rating,
      // Размер точки и фильтры по «объёму» — теперь капитализация.
      volumeBn: s.marketCapBn,
      pe: s.pe, beta: s.beta,
      mults: {
        ...s.mults,
        pe: s.pe,
        safety: safetyScore(fakeBondForScores),
        bqi:    bqiScore(fakeBondForScores),
      },
      // x в горизонте обычно перебивается buildHorizonX, но fitSurface
      // ждёт оба измерения — без второй оси сдвигаем чуть случайно по x
      // (не имеет значения для 1D-сглаживания).
      x: y,
      y,
      z: s.ep,
    });
  }
  return out;
}

// ─── ФЬЮЧЕРСЫ ─────────────────────────────────────────────────────
// Фьюч на акцию наследует мультипликаторы базовой бумаги. Для фьюча
// «доходность» приравниваем к E/P базовой акции (точнее моделирование
// — отдельная история, тут — заглушка).
export function loadFuturePoints({ yMode = 'scoring' } = {}){
  const stockMap = new Map(stocksMock.map(s => [s.ticker, s]));
  const out = [];
  for(const f of futuresMock){
    const base = stockMap.get(f.baseTicker);
    if(!base || base.ep == null) continue;
    const y = qualityY(base, yMode);
    if(y == null) continue;
    const fakeBondForScores = { mults: base.mults };
    out.push({
      secid: f.secid, name: f.name, issuer: f.issuer, ticker: f.ticker,
      industry: f.industry, rating: base.rating,
      baseTicker: f.baseTicker,
      volumeBn: base.marketCapBn,
      pe: base.pe, beta: base.beta,
      mults: {
        ...base.mults, pe: base.pe,
        safety: safetyScore(fakeBondForScores),
        bqi: bqiScore(fakeBondForScores),
      },
      x: y, y, z: base.ep,
    });
  }
  return out;
}

// ─── Универсальный вход (используется страницей через kind) ───────
export function loadPointsByKind(kind, opts = {}){
  switch(kind){
    case 'bond':   return loadBondPoints(opts);
    case 'stock':  return loadStockPoints(opts);
    case 'future': return loadFuturePoints(opts);
    default:       return [];
  }
}

// Будущая backend-точка для bond'ов.
export async function loadBondPointsAsync(opts){
  return loadBondPoints(opts);
}
