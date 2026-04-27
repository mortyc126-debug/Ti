// Заглушка-каталог. Используется поиском пока бэкенд /catalog не готов.
// Структура совпадает с тем, что отдаст Worker позже:
//   {issuers:[{inn,name,ticker?,sector,aliases?}],
//    bonds:[{isin,issuerInn,name,ytm?,coupon?,maturity?}],
//    stocks:[{ticker,name,price?,changePct?}]}

export const MOCK_CATALOG = {
  issuers: [
    { inn: '7736050003', name: 'ПАО Газпром',          ticker: 'GAZP', sector: 'Нефть и газ',     aliases: ['Газпром'] },
    { inn: '5044049710', name: 'ПАО Газпром нефть',    ticker: 'SIBN', sector: 'Нефть и газ',     aliases: ['Газпром нефть', 'Сибнефть'] },
    { inn: '7707083893', name: 'ПАО Сбербанк',         ticker: 'SBER', sector: 'Банки',           aliases: ['Сбер', 'Сбербанк'] },
    { inn: '7728168971', name: 'ПАО Лукойл',           ticker: 'LKOH', sector: 'Нефть и газ',     aliases: ['Лукойл'] },
    { inn: '7706107510', name: 'ПАО Роснефть',         ticker: 'ROSN', sector: 'Нефть и газ',     aliases: ['Роснефть'] },
    { inn: '7707049388', name: 'ПАО МТС',              ticker: 'MTSS', sector: 'Телеком',         aliases: ['МТС'] },
    { inn: '7702070139', name: 'ПАО ВТБ',              ticker: 'VTBR', sector: 'Банки',           aliases: ['ВТБ'] },
    { inn: '7717327013', name: 'ПАО Северсталь',       ticker: 'CHMF', sector: 'Металлургия',     aliases: ['Северсталь'] },
    { inn: '7708503727', name: 'ПАО НЛМК',             ticker: 'NLMK', sector: 'Металлургия',     aliases: ['НЛМК'] },
    { inn: '7705034202', name: 'ПАО ФосАгро',          ticker: 'PHOR', sector: 'Удобрения',       aliases: ['ФосАгро'] },
  ],
  bonds: [
    { isin: 'RU000A105SP8', issuerInn: '7736050003', name: 'Газпром 3P-06', ytm: 21.4, coupon: 14.5, maturity: '2027-04' },
    { isin: 'RU000A106AS9', issuerInn: '7736050003', name: 'Газпром 3P-07', ytm: 19.8, coupon: 13.0, maturity: '2028-01' },
    { isin: 'RU000A107XB3', issuerInn: '7736050003', name: 'Газпром 3P-08', ytm: 18.5, coupon: 12.5, maturity: '2029-09' },
    { isin: 'RU000A108CY4', issuerInn: '5044049710', name: 'Газпром нефть 003P-12', ytm: 20.1, coupon: 13.8, maturity: '2027-08' },
    { isin: 'RU000A106LE6', issuerInn: '7707083893', name: 'Сбер 002P-SBER36', ytm: 16.9, coupon: 11.0, maturity: '2028-02' },
    { isin: 'RU000A104YT6', issuerInn: '7728168971', name: 'Лукойл 001P-04', ytm: 17.5, coupon: 10.0, maturity: '2026-11' },
    { isin: 'RU000A105NV7', issuerInn: '7706107510', name: 'Роснефть 002P-09', ytm: 19.2, coupon: 12.2, maturity: '2028-05' },
    { isin: 'RU000A107HB6', issuerInn: '7707049388', name: 'МТС 001P-22', ytm: 21.0, coupon: 13.7, maturity: '2027-12' },
  ],
  stocks: [
    { ticker: 'GAZP', name: 'Газпром',         price: 285.40, changePct:  1.21 },
    { ticker: 'SIBN', name: 'Газпром нефть',   price: 642.30, changePct: -0.45 },
    { ticker: 'SBER', name: 'Сбербанк',        price: 312.55, changePct:  0.87 },
    { ticker: 'LKOH', name: 'Лукойл',          price: 7124.0, changePct:  1.95 },
    { ticker: 'ROSN', name: 'Роснефть',        price: 564.80, changePct: -1.10 },
    { ticker: 'MTSS', name: 'МТС',             price: 251.10, changePct:  0.32 },
    { ticker: 'VTBR', name: 'ВТБ',             price:  86.45, changePct: -0.22 },
    { ticker: 'CHMF', name: 'Северсталь',      price: 1189.0, changePct:  2.15 },
    { ticker: 'NLMK', name: 'НЛМК',            price: 165.20, changePct:  1.40 },
    { ticker: 'PHOR', name: 'ФосАгро',         price: 6840.0, changePct:  0.05 },
  ],
};
