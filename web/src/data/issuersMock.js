// Карточки эмитентов для страницы «Сравнение». Пока агрегируем из
// bondsMock (одна карточка на эмитента) + добавляем горстку чисто
// акционерных и фьючерсных позиций, чтобы было что показывать в
// слоях радара.
//
// Реальные данные подъедут с backend (`/issuers` эндпоинт), формат
// карточки сохранится — потребуется заменить только функцию-источник.

import { bondsMock, safetyScore, bqiScore } from './bondsCatalog.js';

// kinds: какие типы бумаг есть у эмитента в нашем универсе.
//   'bond' | 'stock' | 'future'
// reportYear, reportDaysAgo — свежесть данных, нужны для весов в
// автокалибровке норм (lib/norms.js).
export function getAllIssuers(){
  const map = new Map();
  for(const b of bondsMock){
    const id = b.issuer;
    if(!map.has(id)){
      map.set(id, {
        id,
        name: b.issuer,
        ticker: null,
        industry: b.industry,
        kinds: new Set(['bond']),
        mults: { ...b.mults },
        reportYear: b.report?.year,
        reportDaysAgo: b.report?.daysAgo,
        // Чтобы могли вернуть пользователю ссылку на бумагу.
        sampleSecid: b.secid,
      });
    } else {
      map.get(id).kinds.add('bond');
    }
  }
  // Дополним эмитентов, которые на бирже представлены только акциями
  // или фьючерсами. Mock-данные.
  const extra = [
    mkStock('SBER',  'Сбербанк',         'banks',     { de:7.0, nde:6.5, icr:1.6, roa:2.4, ebitdaMarg:0,  currentR:null, cashR:null, equityR:13 }, 2025, 30),
    mkStock('YDEX',  'Яндекс',           'it',        { de:0.8, nde:0.3, icr:14,  roa:11,  ebitdaMarg:18, currentR:1.9, cashR:0.7,  equityR:62 }, 2024, 90),
    mkStock('NVTK',  'НОВАТЭК',          'oil-gas',   { de:0.9, nde:0.4, icr:11,  roa:13,  ebitdaMarg:42, currentR:2.0, cashR:0.6,  equityR:58 }, 2024, 120),
    mkStock('GMKN',  'Норникель',        'metals',    { de:1.5, nde:1.1, icr:7,   roa:9,   ebitdaMarg:38, currentR:1.6, cashR:0.4,  equityR:38 }, 2024, 150),
    mkStock('PLZL',  'Полюс',            'metals',    { de:1.2, nde:0.8, icr:8,   roa:14,  ebitdaMarg:55, currentR:1.8, cashR:0.5,  equityR:42 }, 2024, 200),
    mkStock('MGNT',  'Магнит',           'retail',    { de:2.6, nde:2.2, icr:3.5, roa:5,   ebitdaMarg:7,  currentR:1.0, cashR:0.18, equityR:28 }, 2024, 60),
    mkFut('SBRF',    'Сбербанк (фьюч)',  'banks',     { de:7.0, nde:6.5, icr:1.6, roa:2.4, ebitdaMarg:0,  currentR:null, cashR:null, equityR:13 }, 2025, 30),
    mkFut('SiM5',    'USD/RUB фьюч',     'other',     null, null, null),
  ];
  for(const e of extra){
    if(map.has(e.id)){
      // У этого эмитента уже есть бонд — добавляем kind.
      const cur = map.get(e.id);
      e.kinds.forEach(k => cur.kinds.add(k));
      continue;
    }
    map.set(e.id, e);
  }
  // Дополним composite-полями (BQI/Safety) и финализируем kinds → массив.
  const out = [];
  for(const iss of map.values()){
    const fakeBond = { mults: iss.mults };
    iss.mults = {
      ...iss.mults,
      bqi:    bqiScore(fakeBond),
      safety: safetyScore(fakeBond),
    };
    out.push({ ...iss, kinds: [...iss.kinds] });
  }
  return out;
}

function mkStock(ticker, name, ind, mults, year, daysAgo){
  return {
    id: name, name, ticker, industry: ind, kinds: new Set(['stock']),
    mults: mults || {}, reportYear: year, reportDaysAgo: daysAgo,
  };
}
function mkFut(ticker, name, ind, mults, year, daysAgo){
  return {
    id: name, name, ticker, industry: ind, kinds: new Set(['future']),
    mults: mults || {}, reportYear: year, reportDaysAgo: daysAgo,
  };
}

// Свежесть отчёта в годах (для веса в автокалибровке).
export function reportAgeYears(iss){
  if(iss.reportDaysAgo == null) return null;
  return iss.reportDaysAgo / 365;
}
