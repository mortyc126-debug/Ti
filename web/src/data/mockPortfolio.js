// Mock-портфель. После миграции localStorage в D1 заменится на реальные данные.

export const positions = [
  { isin: 'RU000A105RH2', name: 'Сегежа 002Р-04R',  qty: 50,  avg: 92.4,  last: 94.1, ytm: 24.5, dur: 1.6, mat: '2027-09-15', issuer: 'Сегежа',     ind: 'wood' },
  { isin: 'RU000A106Y90', name: 'ПГК 001Р-04',      qty: 30,  avg: 99.0,  last: 99.6, ytm: 19.8, dur: 0.9, mat: '2026-11-02', issuer: 'ПГК',         ind: 'logistics' },
  { isin: 'RU000A107456', name: 'Делимобиль 002Р',   qty: 100, avg: 100.2, last: 102.8,ytm: 22.4, dur: 2.1, mat: '2028-04-10', issuer: 'Делимобиль', ind: 'leasing' },
  { isin: 'RU000A1054X9', name: 'РОЛЬФ БО-001Р-03', qty: 80,  avg: 95.5,  last: 91.2, ytm: 27.6, dur: 1.2, mat: '2027-02-22', issuer: 'РОЛЬФ',       ind: 'retail' },
  { isin: 'RU000A105HJ4', name: 'М.Видео 001Р-03',  qty: 40,  avg: 98.0,  last: 100.0,ytm: 18.9, dur: 0.4, mat: '2026-07-18', issuer: 'М.Видео',     ind: 'retail' },
  { isin: 'RU000A106SZ7', name: 'ВИС Финанс БО-04', qty: 60,  avg: 97.3,  last: 98.5, ytm: 21.2, dur: 1.8, mat: '2027-12-05', issuer: 'ВИС Финанс',  ind: 'construction' },
];

// Вспомогалка: PnL по позиции в рублях (номинал 1000).
export function rowPnl(p){
  const cur = (p.last - p.avg) / 100 * 1000 * p.qty;
  return cur;
}

export function totals(rows){
  const navRub = rows.reduce((s, p) => s + p.last / 100 * 1000 * p.qty, 0);
  const costRub = rows.reduce((s, p) => s + p.avg / 100 * 1000 * p.qty, 0);
  const ytmAvg = rows.reduce((s, p) => s + p.ytm * (p.last / 100 * 1000 * p.qty), 0) / Math.max(navRub, 1);
  const durAvg = rows.reduce((s, p) => s + p.dur * (p.last / 100 * 1000 * p.qty), 0) / Math.max(navRub, 1);
  return { navRub, costRub, pnlRub: navRub - costRub, ytmAvg, durAvg };
}

// Доли отраслей для donut/pie.
export function bySector(rows){
  const m = new Map();
  for(const p of rows){
    const v = p.last / 100 * 1000 * p.qty;
    m.set(p.ind, (m.get(p.ind) || 0) + v);
  }
  return [...m].map(([k, v]) => ({ name: k, value: v }));
}
