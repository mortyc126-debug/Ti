// Расширенный mock-каталог облигаций для UI фильтров. Содержит все поля,
// которые могут запросить фильтры (тип, листинг, валюта, тенденция,
// фикс/флоатер, купон-периодичность, амортизация, оферта, объём,
// рейтинг, тенденция рейтинга) + финансовые метрики эмитента
// (D/E, ICR, Net Debt/EBITDA, Current Ratio и т.д.). Реальные данные
// подсосутся через api.js когда backend научится их отдавать.

export const BOND_TYPES = [
  { id: 'ofz',         label: 'ОФЗ' },
  { id: 'corporate',   label: 'Корпоративная' },
  { id: 'municipal',   label: 'Муниципальная' },
  { id: 'exchange',    label: 'Биржевая' },
];

export const CURRENCIES = ['RUB', 'USD', 'EUR', 'CNY'];

export const TRENDS = [
  { id: 'flat', label: 'Стабильно' },
  { id: 'down', label: 'Дешевеет' },
  { id: 'up',   label: 'Дорожает' },
];

export const COUPON_FREQ = [
  { id: 'month',   label: 'Месяц',   days: 30  },
  { id: 'quarter', label: 'Квартал', days: 91  },
  { id: 'half',    label: 'Полгода', days: 182 },
  { id: 'year',    label: 'Год',     days: 365 },
];

export const AMORT = [
  { id: 'any',  label: 'Не важно' },
  { id: 'with', label: 'С амортизацией' },
  { id: 'no',   label: 'Без амортизации' },
];

export const OFFER = [
  { id: 'any',  label: 'Не важно' },
  { id: 'put',  label: 'Put (право держателя)' },
  { id: 'call', label: 'Call (право эмитента)' },
];

export const RATINGS = [
  'AAA','AA+','AA','AA-','A+','A','A-','BBB+','BBB','BBB-',
  'BB+','BB','BB-','B+','B','B-','CCC','D','none',
];

export const RATING_TRENDS = [
  { id: 'flat',     label: 'Стабилен' },
  { id: 'down',     label: 'Был понижен' },
  { id: 'up',       label: 'Был повышен' },
];

// Метрики эмитента для мультипликатор-фильтра.
// higher: true → больше = лучше; false → меньше = лучше.
// tip — короткое примечание в HTML title по hover.
// resolver(b) — если задан, метрика считается из bond, а не из b.mults
//              (для composite-метрик типа safety/bqi).
export const MULTIPLIERS = [
  { id: 'safety',     label: '🛡 Запас прочности',  higher: true,  suggest: 50,   fmt: '',
    tip: 'Composite-индекс 0..100. Среднее по 4 осям равного веса: ICR (покрытие %), Net Debt/EBITDA, Current Ratio (текущая ликвидность) и EBITDA-маржа. Чем выше, тем устойчивее эмитент к росту ставок и падению выручки.',
    resolver: b => safetyScore(b) },
  { id: 'bqi',        label: '⚖ Качество баланса',   higher: true,  suggest: 50,   fmt: '',
    tip: 'Balance Quality Index 0..100 — структурная надёжность баланса. Среднее по Cash Ratio, Equity Ratio и Current Ratio (упрощённо: cash, доля собственного капитала, оборотная подушка). Низкий BQI = высокая доля «мутных» обязательств и слабый запас ликвидности.',
    resolver: b => bqiScore(b) },
  { id: 'de',         label: 'Долг/EBITDA',         higher: false, suggest: 3,    fmt: 'x' },
  { id: 'nde',        label: 'Чистый долг/EBITDA',  higher: false, suggest: 2.5,  fmt: 'x' },
  { id: 'icr',        label: 'ICR (EBIT/%)',        higher: true,  suggest: 3,    fmt: 'x' },
  { id: 'roa',        label: 'ROA',                 higher: true,  suggest: 3,    fmt: '%' },
  { id: 'ebitdaMarg', label: 'EBITDA-маржа',        higher: true,  suggest: 10,   fmt: '%' },
  { id: 'currentR',   label: 'Current Ratio',       higher: true,  suggest: 1.2,  fmt: 'x' },
  { id: 'cashR',      label: 'Cash Ratio',          higher: true,  suggest: 0.2,  fmt: 'x' },
  { id: 'equityR',    label: 'Equity Ratio',        higher: true,  suggest: 30,   fmt: '%' },
];

// 24 mock-облигации с правдоподобными значениями. Цены/YTM выбраны так,
// чтобы фильтры визуально что-то показывали в широком диапазоне.
export const bondsMock = [
  mk('SU26238RMFS4', 'ОФЗ 26238',           'Минфин РФ',     'ofz',       1, 'flat', 89.10, 14.20, 14.20, 6.4, '2031-05-15', 100,  6, 'no',   'any',  'AAA', 'flat', 'fix',     null, 'none',     {de: null, nde: null, icr: null, roa: null, ebitdaMarg: null, currentR: null, cashR: null, equityR: null}),
  mk('SU26242RMFS6', 'ОФЗ 26242',           'Минфин РФ',     'ofz',       1, 'down', 91.50, 13.80, 13.80, 4.2, '2029-08-29',  90,  6, 'no',   'any',  'AAA', 'flat', 'fix',     null, 'none',     {de: null, nde: null, icr: null, roa: null, ebitdaMarg: null, currentR: null, cashR: null, equityR: null}),
  mk('RU000A105RH2', 'Сегежа 002Р-04R',     'Сегежа',        'corporate', 2, 'down', 94.10, 24.50, 24.50, 1.6, '2027-09-15',  10,  4, 'with', 'put',  'BBB-','down', 'fix',     null, 'wood',     {de: 4.5, nde: 4.1, icr: 1.4, roa: 1.8, ebitdaMarg: 12, currentR: 0.95, cashR: 0.12, equityR: 18}),
  mk('RU000A106Y90', 'ПГК 001Р-04',         'ПГК',           'corporate', 2, 'up',   99.60, 19.80, 19.80, 0.9, '2026-11-02',  20, 12, 'no',   'any',  'A-',  'flat', 'fix',     null, 'logistics',{de: 2.8, nde: 2.1, icr: 3.4, roa: 5.2, ebitdaMarg: 22, currentR: 1.1,  cashR: 0.25, equityR: 41}),
  mk('RU000A107456', 'Делимобиль 002Р',     'Делимобиль',    'corporate', 2, 'up',   102.80,22.40, 22.40, 2.1, '2028-04-10',  15,  4, 'no',   'any',  'BB+', 'up',   'float', 'КС+4%','leasing',  {de: 3.6, nde: 3.0, icr: 2.1, roa: 6.4, ebitdaMarg: 28, currentR: 1.4,  cashR: 0.32, equityR: 35}),
  mk('RU000A1054X9', 'РОЛЬФ БО-001Р-03',    'РОЛЬФ',         'corporate', 2, 'down', 91.20, 27.60, 27.60, 1.2, '2027-02-22',  18,  4, 'with', 'put',  'BBB', 'down', 'fix',     null, 'retail',   {de: 5.1, nde: 4.6, icr: 1.2, roa: 2.3, ebitdaMarg: 7,  currentR: 1.05, cashR: 0.18, equityR: 24}),
  mk('RU000A105HJ4', 'М.Видео 001Р-03',     'М.Видео',       'corporate', 2, 'flat', 100.00,18.90, 18.90, 0.4, '2026-07-18',  20,  4, 'with', 'any',  'BBB+','flat', 'fix',     null, 'retail',   {de: 3.4, nde: 2.9, icr: 2.4, roa: 3.1, ebitdaMarg: 8,  currentR: 1.2,  cashR: 0.22, equityR: 31}),
  mk('RU000A106SZ7', 'ВИС Финанс БО-04',    'ВИС Финанс',    'corporate', 2, 'flat', 98.50, 21.20, 21.20, 1.8, '2027-12-05',  12,  4, 'no',   'any',  'A-',  'flat', 'fix',     null, 'construction',{de: 2.4, nde: 2.0, icr: 3.8, roa: 5.9, ebitdaMarg: 18, currentR: 1.5,  cashR: 0.30, equityR: 44}),
  mk('RU000A105GQ7', 'Самолёт ГК 001Р-12',  'Самолёт ГК',    'corporate', 2, 'up',   97.80, 23.10, 23.10, 1.4, '2027-06-30',  25,  4, 'with', 'put',  'A',   'up',   'fix',     null, 'construction',{de: 3.2, nde: 2.7, icr: 2.7, roa: 4.5, ebitdaMarg: 14, currentR: 1.25, cashR: 0.20, equityR: 36}),
  mk('RU000A106UB8', 'ВТБ Лизинг 001Р-MC',  'ВТБ Лизинг',    'corporate', 1, 'flat', 100.10,17.50, 17.50, 2.7, '2028-09-20',  30, 12, 'no',   'any',  'AA',  'flat', 'float', 'КС+1.5%','leasing',{de: 6.2, nde: 5.8, icr: 1.8, roa: 1.4, ebitdaMarg: 35, currentR: 1.0,  cashR: 0.15, equityR: 12}),
  mk('RU000A107LK0', 'ИКС 5 БО-001P-09',    'X5 Group',      'corporate', 1, 'up',   102.20,16.40, 16.40, 3.1, '2029-04-12',  35,  2, 'no',   'any',  'AA+', 'up',   'fix',     null, 'retail',   {de: 1.9, nde: 1.5, icr: 5.8, roa: 8.2, ebitdaMarg: 11, currentR: 1.6,  cashR: 0.41, equityR: 48}),
  mk('RU000A107M62', 'МосОбл 35013',        'Московская обл.','municipal',1, 'flat', 99.00, 15.30, 15.30, 4.5, '2030-10-15',  15, 12, 'with', 'any',  'AA-', 'flat', 'fix',     null, 'none',     {de: null, nde: null, icr: null, roa: null, ebitdaMarg: null, currentR: null, cashR: null, equityR: null}),
  mk('RU000A106HN6', 'ГТЛК БО-002Р-03',     'ГТЛК',          'corporate', 1, 'flat', 100.50,16.80, 16.80, 5.2, '2031-01-20',  40,  4, 'no',   'call', 'AA',  'flat', 'fix',     null, 'leasing',  {de: 5.4, nde: 5.0, icr: 1.6, roa: 1.0, ebitdaMarg: 42, currentR: 0.9,  cashR: 0.08, equityR: 10}),
  mk('RU000A105JG1', 'Эталон-Финанс 002Р',  'Эталон',        'corporate', 2, 'down', 92.30, 25.80, 25.80, 1.5, '2027-08-01',   8,  4, 'with', 'put',  'BBB', 'down', 'fix',     null, 'construction',{de: 4.2, nde: 3.7, icr: 1.7, roa: 2.0, ebitdaMarg: 10, currentR: 1.1,  cashR: 0.16, equityR: 22}),
  mk('RU000A107788', 'АФК Система 001Р-26', 'АФК Система',   'corporate', 1, 'up',   101.30,18.20, 18.20, 2.8, '2028-12-10',  50,  4, 'no',   'any',  'A',   'flat', 'fix',     null, 'holdings', {de: 4.8, nde: 4.3, icr: 1.9, roa: 3.2, ebitdaMarg: 19, currentR: 1.05, cashR: 0.14, equityR: 19}),
  mk('RU000A106GG2', 'МКБ 001Р-12',         'МКБ',           'corporate', 1, 'flat', 99.80, 17.10, 17.10, 1.9, '2027-05-25',  20,  4, 'no',   'any',  'A',   'flat', 'fix',     null, 'banks',    {de: 8.1, nde: 7.8, icr: 1.4, roa: 1.6, ebitdaMarg: 0,  currentR: null, cashR: null, equityR: 11}),
  mk('RU000A105NV2', 'Новые Технологии',    'НТ-Холдинг',    'corporate', 3, 'down', 88.00, 28.40, 28.40, 1.0, '2026-11-30',   5,  4, 'with', 'put',  'B+',  'down', 'fix',     null, 'machinery',{de: 6.8, nde: 6.5, icr: 0.8, roa: -1.2, ebitdaMarg: 4, currentR: 0.85, cashR: 0.06, equityR: 8}),
  mk('RU000A107P67', 'Газпром Капитал',     'Газпром',       'corporate', 1, 'flat',101.10,15.80, 15.80, 4.8, '2030-02-15', 100,  2, 'no',   'any',  'AAA', 'flat', 'fix',     null, 'oil-gas',  {de: 1.4, nde: 1.0, icr: 8.2, roa: 7.4, ebitdaMarg: 32, currentR: 1.8,  cashR: 0.55, equityR: 52}),
  mk('RU000A107A14', 'Лукойл 001P-01',      'Лукойл',        'corporate', 1, 'up',   102.50,15.20, 15.20, 5.5, '2031-06-08', 120,  2, 'no',   'any',  'AAA', 'up',   'fix',     null, 'oil-gas',  {de: 0.8, nde: 0.4, icr: 12.5, roa: 11.2, ebitdaMarg: 24, currentR: 2.1, cashR: 0.78, equityR: 64}),
  mk('RU000A1066Z6', 'СПБ Биржа 001Р',      'СПБ Биржа',     'corporate', 2, 'down', 89.50, 26.30, 26.30, 1.7, '2027-10-12',   6,  4, 'with', 'put',  'BB',  'down', 'fix',     null, 'finance',  {de: 3.5, nde: 2.9, icr: 1.5, roa: 0.8, ebitdaMarg: 22, currentR: 1.3,  cashR: 0.40, equityR: 28}),
  mk('RU000A105YT1', 'Аэрофлот БО-П09',     'Аэрофлот',      'corporate', 2, 'flat',100.20,17.80, 17.80, 2.3, '2028-03-18',  25,  4, 'no',   'any',  'A-',  'flat', 'fix',     null, 'logistics',{de: 5.6, nde: 5.1, icr: 1.7, roa: 2.2, ebitdaMarg: 16, currentR: 1.0,  cashR: 0.20, equityR: 14}),
  mk('RU000A107EV7', 'НоваБев Групп',       'НоваБев',       'corporate', 2, 'up',   100.80,19.50, 19.50, 2.0, '2027-12-25',  10,  4, 'no',   'any',  'A',   'up',   'fix',     null, 'agro',     {de: 1.6, nde: 1.2, icr: 6.4, roa: 9.1, ebitdaMarg: 14, currentR: 1.7,  cashR: 0.50, equityR: 47}),
  mk('RU000A106EM8', 'Группа Позитив',      'Позитив',       'corporate', 1, 'up',   103.50,17.40, 17.40, 2.5, '2028-06-15',  18,  4, 'no',   'any',  'A',   'up',   'fix',     null, 'it',       {de: 0.6, nde: 0.2, icr: 18.5, roa: 14.2, ebitdaMarg: 38, currentR: 2.4, cashR: 0.92, equityR: 71}),
  mk('RU000A104JX7', 'ОР (Обувь России)',   'ОР',            'corporate', 3, 'down', 12.00, 99.00, 99.00, 0.3, '2026-05-10',   2,  4, 'with', 'put',  'D',   'down', 'fix',     null, 'retail',   {de: 12.0,nde: 11.5,icr: 0.1, roa: -8.4,ebitdaMarg: -4, currentR: 0.4, cashR: 0.02, equityR: 2}),
];

function mk(secid, name, issuer, type, list, trend, price, ytm, ytm2, durY, mat, volBn, freqPerY, amort, offer, rating, ratingTrend, mode, spread, ind, mults){
  const freqMap = { 12: 'month', 4: 'quarter', 2: 'half', 1: 'year', 6: 'month' };
  // Псевдо-даты публикации последнего отчёта эмитента: год + сколько
  // дней назад. Mock-генератор детерминирован — id-хэш из issuer.
  // Когда backend начнёт отдавать реальные периоды из reportsDB,
  // эти поля сменим на настоящие.
  const h = hashStr(issuer);
  const reportYear = h % 10 === 0 ? 2022 : h % 7 === 0 ? 2023 : h % 5 === 0 ? 2024 : 2025;
  const reportDaysAgo = (h * 13) % 720;          // 0..720 дней
  return {
    secid, name, issuer, type, listing: list, currency: 'RUB',
    trend, price, ytm, yield_to_mat: ytm2,
    duration_years: durY, mat_date: mat,
    volume_bn: volBn,
    coupon_freq: freqMap[freqPerY] || 'quarter',
    coupon_period_days: Math.round(365 / freqPerY),
    amort, offer, rating, ratingTrend,
    coupon_mode: mode,
    coupon_spread: spread,
    industry: ind,
    mults,
    report: { year: reportYear, daysAgo: reportDaysAgo },
  };
}

function hashStr(s){
  let h = 0;
  for(let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// «Запас прочности» — упрощённый composite score 0..100, как в old SPA,
// но на одном периоде. Считаем по 4 ключевым осям с равным весом 25.
// Если данных нет — возвращаем null (не засчитываем плюсом и не штрафуем).
export function safetyScore(b){
  if(!b.mults) return null;
  const m = b.mults;
  const parts = [];
  if(m.icr != null)        parts.push(clamp01((m.icr - 1) / (5 - 1)));
  if(m.nde != null)        parts.push(clamp01((6 - m.nde) / (6 - 1)));
  if(m.currentR != null)   parts.push(clamp01((m.currentR - 0.5) / (2 - 0.5)));
  if(m.ebitdaMarg != null) parts.push(clamp01(m.ebitdaMarg / 25));
  if(!parts.length) return null;
  const avg = parts.reduce((s, x) => s + x, 0) / parts.length;
  return Math.round(avg * 100);
}

// «Качество баланса» (BQI) 0..100 — структурная надёжность.
// Упрощённая версия _repBalanceQuality из old SPA. Среднее по
// Cash Ratio (1%→0, 50%→100), Equity Ratio (10%→0, 50%→100) и
// Current Ratio (0.5x→0, 2x→100).
export function bqiScore(b){
  if(!b.mults) return null;
  const m = b.mults;
  const parts = [];
  if(m.cashR    != null) parts.push(clamp01((m.cashR    - 0.05) / (0.5 - 0.05)));
  if(m.equityR  != null) parts.push(clamp01((m.equityR  - 10)   / (50 - 10)));
  if(m.currentR != null) parts.push(clamp01((m.currentR - 0.5)  / (2 - 0.5)));
  if(!parts.length) return null;
  const avg = parts.reduce((s, x) => s + x, 0) / parts.length;
  return Math.round(avg * 100);
}

function clamp01(x){ return Math.max(0, Math.min(1, x)); }
