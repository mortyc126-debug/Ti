// Нормы по группам отраслей (Тир 1) + универсальные пороги для
// производных 0-100 метрик (Тир 2). Тир 3 (P/E, ROA) считается
// перцентильно из реальных данных, см. lib/norms.js.
//
// Источник дефолтов: расширение IND_NORMS из app.js:61 на 10 групп
// нового каталога industries.js. Числа подобраны по Russian-market
// рейтинговым отчётам и сопоставимы с практикой Эксперт РА / АКРА.
//
// Структура: { metricId: { green, red } }
// - higher=true (ICR, currentR, ebitdaMarg, equityR): green = «не ниже»,
//   red = «ниже этого — критично». Жёлтое — между.
// - higher=false (nde, de): green = «не выше», red = «выше — критично».

import { INDUSTRIES } from './industries.js';

// 10 групп каталога industries.js: raw, manuf, energy, build, trade,
// transport, it-media, finance, services, other.
export const NORMS_BY_GROUP = {
  raw: {     nde: { green: 2.0, red: 4.0 }, icr: { green: 3.5, red: 1.5 }, currentR: { green: 1.2, red: 0.8 }, ebitdaMarg: { green: 18, red: 8 }, equityR: { green: 40, red: 20 } },
  manuf: {   nde: { green: 2.5, red: 4.5 }, icr: { green: 3.0, red: 1.5 }, currentR: { green: 1.2, red: 0.8 }, ebitdaMarg: { green: 12, red: 5 },  equityR: { green: 35, red: 18 } },
  energy: {  nde: { green: 2.5, red: 5.0 }, icr: { green: 3.0, red: 1.5 }, currentR: { green: 1.0, red: 0.7 }, ebitdaMarg: { green: 20, red: 10 }, equityR: { green: 35, red: 18 } },
  build: {   nde: { green: 4.0, red: 7.0 }, icr: { green: 2.0, red: 1.2 }, currentR: { green: 1.1, red: 0.8 }, ebitdaMarg: { green: 18, red: 8 },  equityR: { green: 25, red: 12 } },
  trade: {   nde: { green: 3.0, red: 5.5 }, icr: { green: 2.5, red: 1.4 }, currentR: { green: 1.1, red: 0.8 }, ebitdaMarg: { green: 6,  red: 2 },  equityR: { green: 28, red: 12 } },
  transport: { nde: { green: 3.0, red: 5.5 }, icr: { green: 2.5, red: 1.3 }, currentR: { green: 1.0, red: 0.7 }, ebitdaMarg: { green: 14, red: 6 },  equityR: { green: 25, red: 10 } },
  'it-media': { nde: { green: 1.5, red: 3.5 }, icr: { green: 5.0, red: 2.0 }, currentR: { green: 1.5, red: 1.0 }, ebitdaMarg: { green: 25, red: 10 }, equityR: { green: 50, red: 25 } },
  finance: { nde: { green: 5.0, red: 8.0 }, icr: { green: 1.5, red: 1.0 }, currentR: { green: 1.0, red: 0.7 }, ebitdaMarg: { green: 30, red: 10 }, equityR: { green: 12, red: 6 } },
  services: { nde: { green: 2.5, red: 4.5 }, icr: { green: 3.0, red: 1.5 }, currentR: { green: 1.2, red: 0.8 }, ebitdaMarg: { green: 14, red: 6 },  equityR: { green: 35, red: 15 } },
  other: {   nde: { green: 3.0, red: 5.0 }, icr: { green: 2.5, red: 1.5 }, currentR: { green: 1.2, red: 0.8 }, ebitdaMarg: { green: 10, red: 4 },  equityR: { green: 30, red: 15 } },
};

// Универсальные пороги для нормированных 0-100 метрик (Тир 2).
// Финансовые группы (banks/leasing/insurance/mfo/holdings) — ниже,
// потому что BQI у них структурно меньше из-за низкого equityR.
export const NORMS_UNIVERSAL = {
  bqi:    { green: 70, red: 40 },
  safety: { green: 70, red: 40 },
};

export const NORMS_FINANCE_OVERRIDE = {
  bqi:    { green: 55, red: 30 },
  safety: { green: 60, red: 35 },
};

// Резолвинг нормы для пары (industryId, metricId). Возвращает
// { green, red, source: 'group'|'universal'|null } или null если нормы
// не определены для этой метрики (например percentileBased).
export function defaultNormFor(industryId, metricId){
  const groupId = INDUSTRIES[industryId]?.groupId ?? 'other';
  // Тир 2: универсальные 0-100 (с finance-override).
  if(NORMS_UNIVERSAL[metricId]){
    if(groupId === 'finance' && NORMS_FINANCE_OVERRIDE[metricId]){
      return { ...NORMS_FINANCE_OVERRIDE[metricId], source: 'universal-finance' };
    }
    return { ...NORMS_UNIVERSAL[metricId], source: 'universal' };
  }
  // Тир 1: per-group.
  const g = NORMS_BY_GROUP[groupId];
  if(g && g[metricId]) return { ...g[metricId], source: 'group' };
  return null;
}

// Список (groupId, label) для UI «Нормы».
export const NORM_GROUPS = [
  { id: 'raw',       label: 'Ресурсы и сырьё' },
  { id: 'manuf',     label: 'Обрабатывающая промышленность' },
  { id: 'energy',    label: 'Энергетика и ЖКХ' },
  { id: 'build',     label: 'Стройка и недвижимость' },
  { id: 'trade',     label: 'Торговля' },
  { id: 'transport', label: 'Транспорт' },
  { id: 'it-media',  label: 'IT, связь и медиа' },
  { id: 'finance',   label: 'Финансы' },
  { id: 'services',  label: 'Услуги' },
  { id: 'other',     label: 'Прочее' },
];

// Метрики, которые имеют numeric пороги в таблице норм (Тир 1+2).
// percentileBased исключены — они конфигурируются квартилем в UI.
export const NORM_METRICS = ['nde', 'icr', 'ebitdaMarg', 'currentR', 'equityR', 'bqi', 'safety'];
