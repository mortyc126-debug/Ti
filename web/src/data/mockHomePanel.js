// Mock-данные для блока «Выплаты» — календарь купонов и оферт ближайших
// 90 дней по позициям из портфеля + кривая ежемесячной долговой нагрузки.

export const upcomingPayments = [
  { date: '2026-05-02', issuer: 'ПГК',          kind: 'coupon', amount: 575,    secid: 'RU000A106Y90' },
  { date: '2026-05-15', issuer: 'М.Видео',      kind: 'coupon', amount: 412,    secid: 'RU000A105HJ4' },
  { date: '2026-05-22', issuer: 'Сегежа',       kind: 'coupon', amount: 1240,   secid: 'RU000A105RH2' },
  { date: '2026-06-04', issuer: 'РОЛЬФ',        kind: 'offer',  amount: 80000,  secid: 'RU000A1054X9' },
  { date: '2026-06-18', issuer: 'Делимобиль',   kind: 'coupon', amount: 1820,   secid: 'RU000A107456' },
  { date: '2026-07-03', issuer: 'ВИС Финанс',   kind: 'coupon', amount: 720,    secid: 'RU000A106SZ7' },
  { date: '2026-07-18', issuer: 'М.Видео',      kind: 'redeem', amount: 40000,  secid: 'RU000A105HJ4' },
];

// Кривая «нагрузки» — сумма выплат по месяцам в тыс. рублей.
export const debtLoad = [
  { m: 'Май',  v: 22.3 },
  { m: 'Июн',  v: 81.8 },
  { m: 'Июл',  v: 40.7 },
  { m: 'Авг',  v: 12.1 },
  { m: 'Сен',  v: 28.5 },
  { m: 'Окт',  v: 9.4  },
];

// Состав портфеля — отрасль / рейтинг / параметры (дюрация, YTM-бакеты).
export const compRatings = [
  { k: 'A',    v: 38 },
  { k: 'BBB',  v: 32 },
  { k: 'BB',   v: 22 },
  { k: 'B',    v: 8  },
];

export const compDuration = [
  { k: '<1y',   v: 18 },
  { k: '1-2y',  v: 41 },
  { k: '2-3y',  v: 27 },
  { k: '3-5y',  v: 14 },
];

export const compYtm = [
  { k: '<15%',   v: 12 },
  { k: '15-20',  v: 28 },
  { k: '20-25',  v: 41 },
  { k: '>25%',   v: 19 },
];
