// Mock-каталог акций и фьючерсов с метриками для surface-вью.
// Структура совпадает с issuersMock — мульти-источник, потом
// заменим на /stocks /futures endpoint'ы backend'а.
//
// Поля для горизонта:
//   pe       — P/E на последнюю отчётность; ↓ = дешевле
//   ep       — Earnings Yield = 1/PE × 100% — это и есть «доходность»
//              акции. Y-ось горизонта = residual ep.
//   marketCapBn — капитализация в млрд ₽; используется как
//                 «объём» для размера точки и как вариант X-оси.
//   beta     — рыночная бета (волатильность относительно индекса).
//   ratingC  — корпоративный кредитный рейтинг эмитента (опц).

export const stocksMock = [
  // resources
  st('SBER',  'Сбербанк',     'banks',         5.2,  18000, 1.05, 'AAA', { roa:2.4, ebitdaMarg:0,  icr:1.6, currentR:null, equityR:13, nde:6.5, cashR:null }),
  st('GAZP',  'Газпром',      'oil-gas',       3.8,  3300,  0.95, 'AAA', { roa:7.4, ebitdaMarg:32, icr:8.2, currentR:1.8,  equityR:52, nde:1.0, cashR:0.55 }),
  st('LKOH',  'Лукойл',       'oil-gas',       4.5,  4900,  0.85, 'AAA', { roa:11.2,ebitdaMarg:24, icr:12.5,currentR:2.1,  equityR:64, nde:0.4, cashR:0.78 }),
  st('NVTK',  'НОВАТЭК',      'oil-gas',       7.1,  3600,  0.90, 'AAA', { roa:13,  ebitdaMarg:42, icr:11,  currentR:2.0,  equityR:58, nde:0.4, cashR:0.6  }),
  st('ROSN',  'Роснефть',     'oil-gas',       5.3,  6100,  0.95, 'AAA', { roa:6,   ebitdaMarg:24, icr:6,   currentR:1.4,  equityR:40, nde:1.4, cashR:0.4  }),
  st('GMKN',  'Норникель',    'metals',        6.8,  2400,  1.05, 'AAA', { roa:9,   ebitdaMarg:38, icr:7,   currentR:1.6,  equityR:38, nde:1.1, cashR:0.4  }),
  st('PLZL',  'Полюс',        'metals',        8.2,  1800,  1.15, 'AAA', { roa:14,  ebitdaMarg:55, icr:8,   currentR:1.8,  equityR:42, nde:0.8, cashR:0.5  }),
  st('CHMF',  'Северсталь',   'metals',        5.6,  1200,  1.10, 'AAA', { roa:11,  ebitdaMarg:32, icr:9,   currentR:2.0,  equityR:55, nde:0.6, cashR:0.45 }),
  st('NLMK',  'НЛМК',         'metals',        4.9,  1100,  1.20, 'AAA', { roa:12,  ebitdaMarg:26, icr:8.5, currentR:1.9,  equityR:58, nde:0.5, cashR:0.40 }),
  st('MGNT',  'Магнит',       'retail',        12.1, 600,   0.75, 'AA-', { roa:5,   ebitdaMarg:7,  icr:3.5, currentR:1.0,  equityR:28, nde:2.2, cashR:0.18 }),
  st('FIVE',  'X5 Group',     'retail',        9.5,  900,   0.70, 'AA+', { roa:8.2, ebitdaMarg:11, icr:5.8, currentR:1.6,  equityR:48, nde:1.5, cashR:0.41 }),
  st('YDEX',  'Яндекс',       'it',            22.0, 1500,  1.25, 'A',   { roa:11,  ebitdaMarg:18, icr:14,  currentR:1.9,  equityR:62, nde:0.3, cashR:0.7  }),
  st('POSI',  'Группа Позитив','it',           28.0, 200,   1.40, 'A',   { roa:14.2,ebitdaMarg:38, icr:18.5,currentR:2.4,  equityR:71, nde:0.2, cashR:0.92 }),
  st('PHOR',  'ФосАгро',      'agro',          5.0,  900,   0.80, 'AAA', { roa:14,  ebitdaMarg:35, icr:9,   currentR:1.7,  equityR:48, nde:1.2, cashR:0.5  }),
  st('AGRO',  'Русагро',      'agro',          7.8,  240,   0.85, 'A',   { roa:8,   ebitdaMarg:18, icr:5,   currentR:1.4,  equityR:42, nde:1.8, cashR:0.3  }),
  st('TATN',  'Татнефть',     'oil-gas',       4.1,  1700,  0.95, 'AAA', { roa:9.5, ebitdaMarg:22, icr:11,  currentR:1.9,  equityR:60, nde:0.6, cashR:0.45 }),
  st('AFLT',  'Аэрофлот',     'logistics',     14.0, 250,   1.30, 'A-',  { roa:2.2, ebitdaMarg:16, icr:1.7, currentR:1.0,  equityR:14, nde:5.1, cashR:0.20 }),
  st('SGZH',  'Сегежа',       'wood',          0.0,  60,    1.50, 'BBB-',{ roa:1.8, ebitdaMarg:12, icr:1.4, currentR:0.95, equityR:18, nde:4.1, cashR:0.12 }),
  st('AFKS',  'АФК Система',  'holdings',      8.5,  170,   1.20, 'A',   { roa:3.2, ebitdaMarg:19, icr:1.9, currentR:1.05, equityR:19, nde:4.3, cashR:0.14 }),
  st('OZON',  'Ozon',         'retail',        0.0,  600,   1.45, 'A-',  { roa:-3.0,ebitdaMarg:0,  icr:-0.5,currentR:0.85, equityR:8,  nde:6.8, cashR:0.20 }),
];

// Фьючерсы привязаны к акции (или к индексу) и наследуют её
// мультипликаторы. basisPp — базис фьюч-спот в процентных пунктах
// E/P (положительный = контанго, фьюч дороже спота; отрицательный
// = бэквардация, фьюч дешевле спота). В реальности базис = (F-S)/S
// + cost-of-carry; здесь — псевдо-данные для визуальной демонстрации.
export const futuresMock = [
  fu('SBRF',   'Сбербанк-фьюч',  'SBER', 'banks',    +0.6),
  fu('GAZR',   'Газпром-фьюч',   'GAZP', 'oil-gas',  +0.4),
  fu('LKOH-F', 'Лукойл-фьюч',    'LKOH', 'oil-gas',  -0.3),
  fu('GMKN-F', 'ГМК-фьюч',       'GMKN', 'metals',   +0.8),
  fu('YDEX-F', 'Яндекс-фьюч',    'YDEX', 'it',       -0.5),
  fu('TATN-F', 'Татнефть-фьюч',  'TATN', 'oil-gas',  +0.2),
  fu('NLMK-F', 'НЛМК-фьюч',      'NLMK', 'metals',   -0.7),
];

function st(ticker, name, ind, pe, marketCapBn, beta, ratingC, mults){
  return {
    secid: ticker,
    ticker,
    name,
    issuer: name,
    industry: ind,
    pe,                                     // P/E
    ep: pe > 0 ? 100 / pe : null,           // earnings yield, %
    marketCapBn,
    beta,
    rating: ratingC || 'none',
    mults: { ...mults },
  };
}

function fu(ticker, name, baseTicker, ind, basisPp){
  return {
    secid: ticker,
    ticker,
    name,
    issuer: name,
    industry: ind,
    baseTicker,
    basisPp: basisPp ?? 0,    // в п.п. earnings yield
  };
}
