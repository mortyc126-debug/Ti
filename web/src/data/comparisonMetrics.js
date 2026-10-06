// Метрики страницы «Сравнение». 8 осей радара + 4 дополнительные,
// которые показываются в фильтрах и в правой панели карточки компании,
// но не на радаре (чтобы тот не превратился в слипшийся комок).
//
// higher: true — больше = лучше; false — меньше = лучше.
// fmt — '%' / 'x' / '' (raw 0-100).
// percentileBased: true означает «абсолютной нормы нет, зелёное = top
// quartile отрасли». Такие метрики недоступны в последовательном
// режиме фильтра (нечестно — норма у банка и у ритейлера разная).

export const COMP_METRICS = {
  nde: {
    id: 'nde',  label: 'ND/EBITDA',  short: 'ND/E',
    higher: false, fmt: 'x', radar: true,
    tip: 'Чистый долг к EBITDA. Меньше — устойчивее. Норма по отраслям из IND_NORMS.',
  },
  icr: {
    id: 'icr',  label: 'ICR',        short: 'ICR',
    higher: true,  fmt: 'x', radar: true,
    tip: 'EBIT / процентные расходы. Покрытие %. >3 хорошо, <1.5 опасно.',
  },
  ebitdaMarg: {
    id: 'ebitdaMarg', label: 'EBITDA-маржа', short: 'EBITDA m.',
    higher: true,  fmt: '%', radar: true,
    tip: 'EBITDA / выручка. Сильно зависит от отрасли — норма из IND_NORMS.',
  },
  currentR: {
    id: 'currentR', label: 'Current Ratio', short: 'Curr',
    higher: true,  fmt: 'x', radar: true,
    tip: 'Оборотные активы / краткосрочные обязательства. >1.2 норма.',
  },
  equityR: {
    id: 'equityR', label: 'Equity Ratio', short: 'Eq',
    higher: true,  fmt: '%', radar: true,
    tip: 'Капитал / Активы. ≥30% прочно, <15% тонко (банки в исключение).',
  },
  roa: {
    id: 'roa', label: 'ROA', short: 'ROA',
    higher: true,  fmt: '%', radar: true, percentileBased: true,
    tip: 'Net Income / Activitys. Зависит от отрасли — нормы перцентильные.',
  },
  roic: {
    id: 'roic', label: 'ROIC', short: 'ROIC',
    higher: true,  fmt: '%', radar: false, percentileBased: true,
    tip: 'NOPAT / инвестированный капитал = EBIT·(1−налог) / (капитал + долг − деньги). Отдача на вложенный капитал; сравнивать с стоимостью капитала.',
  },
  roe: {
    id: 'roe', label: 'ROE', short: 'ROE',
    higher: true,  fmt: '%', radar: false, percentileBased: true,
    tip: 'Чистая прибыль / собственный капитал. Отдача на капитал акционеров. Высокий ROE при низком ROIC = эффект долга (риск).',
  },
  bqi: {
    id: 'bqi', label: 'Качество баланса', short: 'BQI',
    higher: true,  fmt: '', radar: true,
    tip: 'Composite 0-100. Cash share, equity share, working capital, retained, прочие обязательства.',
  },
  safety: {
    id: 'safety', label: 'Запас прочности', short: 'Стресс',
    higher: true,  fmt: '', radar: true,
    tip: 'Composite 0-100. Stressed ICR (40%) + Altman Z\' (35%) + Долговая стена (25%).',
  },
  // Доп.метрики — есть в фильтрах и панели, но не в радаре:
  de: {
    id: 'de',  label: 'D/EBITDA', short: 'D/E',
    higher: false, fmt: 'x', radar: false,
    tip: 'Полный долг к EBITDA, без вычета кэша.',
  },
  cashR: {
    id: 'cashR', label: 'Cash Ratio', short: 'Cash',
    higher: true,  fmt: 'x', radar: false,
    tip: 'Кэш / краткосрочные обязательства. >0.2 — есть подушка.',
  },
  pe: {
    id: 'pe', label: 'P/E', short: 'P/E',
    higher: false, fmt: 'x', radar: false, percentileBased: true,
    tip: 'Цена / прибыль. Без отрасли смысла нет — нормы перцентильные.',
  },
  yield: {
    id: 'yield', label: 'YTM', short: 'YTM',
    higher: true, fmt: '%', radar: false,
    tip: 'Доходность облигации к погашению (для бондов).',
  },

  // ── Банковские метрики (своя модель: считаются из extra периода, %) ──
  // radar:false — на обычный радар не лезут; для банков используется
  // отдельный набор BANK_RADAR_AXES (см. buildRadarData).
  b_roe: { id: 'b_roe', label: 'ROE банка', short: 'ROE', higher: true,  fmt: '%', radar: false, bank: true, tip: 'Рентабельность капитала банка.' },
  b_roa: { id: 'b_roa', label: 'ROA банка', short: 'ROA', higher: true,  fmt: '%', radar: false, bank: true, tip: 'Рентабельность активов банка.' },
  b_nim: { id: 'b_nim', label: 'NIM',       short: 'NIM', higher: true,  fmt: '%', radar: false, bank: true, tip: 'Чистая процентная маржа.' },
  b_cor: { id: 'b_cor', label: 'Cost of Risk', short: 'CoR', higher: false, fmt: '%', radar: false, bank: true, tip: 'Стоимость риска: отчисления в резервы к портфелю. Меньше — лучше.' },
  b_npl: { id: 'b_npl', label: 'NPL',       short: 'NPL', higher: false, fmt: '%', radar: false, bank: true, tip: 'Доля проблемных кредитов. Меньше — лучше.' },
  b_cov: { id: 'b_cov', label: 'Покрытие резервами', short: 'Покр.', higher: true, fmt: '%', radar: false, bank: true, tip: 'Резервы к неработающим кредитам.' },
  b_car: { id: 'b_car', label: 'Достаточность капитала', short: 'CAR', higher: true, fmt: '%', radar: false, bank: true, tip: 'Норматив достаточности капитала.' },
  b_cir: { id: 'b_cir', label: 'CIR',       short: 'CIR', higher: false, fmt: '%', radar: false, bank: true, tip: 'Cost-to-income: расходы/доходы. Меньше — эффективнее.' },
  b_ltd: { id: 'b_ltd', label: 'Кредиты/депозиты', short: 'L/D', higher: true, fmt: '%', radar: false, bank: true, tip: 'Loan-to-deposit: насколько кредиты фондируются депозитами.' },
  b_loans: { id: 'b_loans', label: 'Кредитный портфель', short: 'Кредиты', higher: true, fmt: 'bn', radar: false, bank: true, tip: 'Кредитный портфель, млрд ₽.' },
  b_dep:   { id: 'b_dep',   label: 'Депозиты', short: 'Депозиты', higher: true, fmt: 'bn', radar: false, bank: true, tip: 'Депозиты клиентов, млрд ₽.' },
};

export const RADAR_AXES = Object.values(COMP_METRICS).filter(m => m.radar).map(m => m.id);

// Оси радара для банков (своя модель). Используются, когда выборка —
// преимущественно банки (см. buildRadarData).
export const BANK_RADAR_AXES = ['b_roe', 'b_roa', 'b_nim', 'b_cov', 'b_car', 'b_cir', 'b_npl', 'b_ltd'];

// Оси для последовательной воронки (без перцентильных).
export const SEQUENTIAL_AXES = Object.values(COMP_METRICS)
  .filter(m => !m.percentileBased && m.id !== 'bqi' && m.id !== 'safety')
  .map(m => m.id);

export function metricSpec(id){
  return COMP_METRICS[id];
}
