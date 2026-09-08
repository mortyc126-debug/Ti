// Адаптер для страницы «Карта». Возвращает массивы точек разных
// kind'ов (bond / stock / future) для surface-фита и горизонта.
//
// Когда подъедет реальный backend — здесь меняются ровно три функции
// (loadBondPoints, loadStockPoints, loadFuturePoints). Всё остальное
// продолжит работать.

import { safetyScore, bqiScore } from './bondsCatalog.js';
import { stocksMock, futuresMock } from './stocksMock.js';
import { qualityY, maturityYears } from '../lib/qualityComposite.js';
import { currentBonds, currentStocks } from '../store/marketData.js';
import { currentIssuers } from '../store/issuers.js';
import { sectorToIndustry } from './marketReal.js';
import { bestIssuerMatch } from '../lib/issuerMatch.js';

// ─── ОБЛИГАЦИИ ─────────────────────────────────────────────────────
//   x = срок до погашения (годы), y = качество (composite/rating),
//   z = YTM (%). Источник — реальная вселенная (цены+отчётность) либо демо.
//   Фундамент (mults) берём по ТЕКУЩЕМУ винтажу из стора эмитентов (год/тип),
//   а не из кеша вселенной — иначе смешивались бы разные периоды.
export function loadBondPoints({ yMode = 'scoring', typeFilter = null, bonds = null } = {}){
  const out = [];
  const src = bonds || currentBonds();
  // карта inn → mults эмитента под выбранный винтаж
  const innMults = new Map();
  for(const it of currentIssuers()){
    if(it.inn && it.mults) innMults.set(String(it.inn), it.mults);
  }
  for(const b of src){
    if(typeFilter && !typeFilter.has(b.type)) continue;
    const mults = (b.inn && innMults.get(String(b.inn))) || b.mults || {};
    const bm = { ...b, mults };
    const x = maturityYears(b.mat_date);
    const y = qualityY(bm, yMode);
    const z = b.ytm;
    if(x == null || y == null || z == null) continue;
    out.push({
      secid: b.secid, name: b.name, issuer: b.issuer, inn: b.inn || null,
      type: b.type, rating: b.rating, industry: b.industry,
      volumeBn: b.volume_bn,
      mults: { ...mults, safety: safetyScore(bm), bqi: bqiScore(bm) },
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
export function loadStockPoints({ yMode = 'scoring', stocks = null } = {}){
  const src = stocks || currentStocks();
  // индекс эмитентов по инн + список для нечёткого матчинга по названию
  const issuersList = currentIssuers();
  const innMap = new Map();
  for(const it of issuersList){ if(it.inn) innMap.set(String(it.inn), it); }
  const out = [];
  for(const s of src){
    let mults = s.mults, ep = s.ep, marketCapBn = s.marketCapBn, pe = s.pe;
    let industry = s.industry, rating = s.rating || 'none', issuer = s.issuer, inn = s.inn || null;
    // реальная запись (цена+акции, без фундамента) — джойним отчётность и
    // считаем E/P = чистая прибыль / капитализация
    if((!mults || ep == null) && s.price != null){
      const iss = (inn && innMap.get(String(inn))) || bestIssuerMatch(s.name, issuersList) || null;
      mults = iss?.mults || null;
      industry = iss?.industry || sectorToIndustry(s.sector);
      issuer = iss?.name || s.name;
      inn = iss?.inn || null;
      marketCapBn = (s.shares && s.price) ? s.price * s.shares / 1e9 : null;
      const npRaw = mults?.npRaw;   // чистая прибыль (обычно млн ₽)
      ep = (npRaw != null && marketCapBn > 0) ? (npRaw * 1e6) / (marketCapBn * 1e9) * 100 : null;
      pe = (ep && ep !== 0) ? 100 / ep : null;
    }
    if(!mults || ep == null) continue;
    const y = qualityY({ mults, rating }, yMode);
    if(y == null) continue;
    const fakeBondForScores = { mults };
    out.push({
      secid: s.secid || s.ticker, name: s.name, issuer: issuer || s.name,
      ticker: s.ticker, inn: inn || null,
      industry, rating,
      volumeBn: marketCapBn,
      pe, beta: s.beta || null,
      mults: { ...mults, pe, safety: safetyScore(fakeBondForScores), bqi: bqiScore(fakeBondForScores) },
      x: y, y, z: ep,
    });
  }
  return out;
}

// Диагностика джойна акций (для плашки статуса): где отваливаются точки.
export function diagnoseStocks(){
  const src = currentStocks();
  const issuersList = currentIssuers();
  const innMap = new Map();
  for(const it of issuersList){ if(it.inn) innMap.set(String(it.inn), it); }
  let loaded = 0, real = 0, matched = 0, withShares = 0, withEp = 0;
  for(const s of src){
    loaded++;
    const isReal = (s.price != null && (!s.mults || s.ep == null));
    if(!isReal){ if(s.ep != null) withEp++; continue; }
    real++;
    if(s.shares) withShares++;
    const iss = (s.inn && innMap.get(String(s.inn))) || bestIssuerMatch(s.name, issuersList);
    if(iss) matched++;
    const npRaw = iss?.mults?.npRaw;
    const mc = (s.shares && s.price) ? s.price * s.shares / 1e9 : null;
    if(npRaw != null && mc > 0) withEp++;
  }
  return { loaded, real, matched, withShares, withEp, issuers: issuersList.length };
}

// ─── ФЬЮЧЕРСЫ ─────────────────────────────────────────────────────
// Фьюч на акцию наследует мультипликаторы базовой бумаги. Для фьюча
// «доходность» = E/P базовой акции − basisPp (контанго → ниже E/P,
// бэквардация → выше E/P). basisPp задан в futuresMock.
export function loadFuturePoints({ yMode = 'scoring' } = {}){
  const stockMap = new Map(stocksMock.map(s => [s.ticker, s]));
  const out = [];
  for(const f of futuresMock){
    const base = stockMap.get(f.baseTicker);
    if(!base || base.ep == null) continue;
    const y = qualityY(base, yMode);
    if(y == null) continue;
    const fakeBondForScores = { mults: base.mults };
    // Базис: контанго (фьюч дороже спота) → доходность фьюча ниже,
    // т.е. ep_future = ep_stock − basisPp.
    const basis = f.basisPp || 0;
    const epF = base.ep - basis;
    out.push({
      secid: f.secid, name: f.name, issuer: f.issuer, ticker: f.ticker,
      industry: f.industry, rating: base.rating,
      baseTicker: f.baseTicker,
      basisPp: basis,
      volumeBn: base.marketCapBn,
      pe: epF > 0 ? 100 / epF : null, beta: base.beta,
      mults: {
        ...base.mults, pe: epF > 0 ? 100 / epF : null,
        safety: safetyScore(fakeBondForScores),
        bqi: bqiScore(fakeBondForScores),
      },
      x: y, y, z: epF,
    });
  }
  return out;
}

// ─── СПРЕД (overlay) ─────────────────────────────────────────────
// Возвращает обе серии + пары. Используется в табе «Спред» — на
// одном горизонте видны и акции, и фьючерсы, плюс соединительная
// линия акция↔фьюч.
export function loadOverlayPoints(opts = {}){
  const stocks = loadStockPoints(opts);
  const futures = loadFuturePoints(opts);
  // Пары по baseTicker → соответствующая stock-точка.
  const stockByTicker = new Map(stocks.map(s => [s.ticker, s]));
  const pairs = [];
  for(const f of futures){
    const s = stockByTicker.get(f.baseTicker);
    if(s) pairs.push({ stock: s, future: f });
  }
  return { stocks, futures, pairs };
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
