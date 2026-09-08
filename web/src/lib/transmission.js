// Карта трансмиссии: фактор → канал воздействия → что меняется в отчёте →
// типичный лаг → что важно смотреть. Общий справочник «как импульс доходит
// до цифр отчёта», не привязан к конкретной компании.

export const TRANSMISSION = [
  { factor: 'Ставка ↓', channel: 'стоимость фондирования ↓', report: 'процентные расходы ↓ → NII/NIM ↑ → прибыль ↑', lag: '1–3 кв.', watch: 'структура долга, скорость переоценки ставок' },
  { factor: 'Ставка ↓', channel: 'качество заёмщиков ↑', report: 'Cost of Risk ↓ → резервы ↓ → прибыль ↑', lag: '1–4 кв.', watch: 'просрочка, реструктуризации' },
  { factor: 'Ставка ↑', channel: 'спрос на кредит ↓', report: 'рост портфеля ↓', lag: '1–3 кв.', watch: 'выдачи vs погашения' },
  { factor: 'FX ↑ (рубль слабеет)', channel: 'экспортная выручка в RUB ↑', report: 'Revenue ↑ → EBITDA ↑', lag: 'почти сразу', watch: 'доля экспорта и валютных затрат' },
  { factor: 'FX ↑', channel: 'валютный долг дороже в RUB', report: 'FX loss / долг ↑', lag: 'сразу при переоценке', watch: 'валюта долга' },
  { factor: 'Цена продукта ↑', channel: 'больше выручки на единицу', report: 'Revenue ↑ → EBITDA ↑', lag: 'сразу / 1 кв.', watch: 'объём продаж' },
  { factor: 'Объём ↑', channel: 'больше продано', report: 'Revenue ↑ → EBITDA ↑', lag: 'сразу', watch: 'цена × объём' },
  { factor: 'Сырьё / топливо ↑', channel: 'себестоимость ↑', report: 'EBITDA ↓', lag: '0–1 кв.', watch: 'возможность переложить рост цены' },
  { factor: 'OPEX ↓', channel: 'операционная эффективность', report: 'EBITDA / margin ↑', lag: '1–4 кв.', watch: 'не разовая ли экономия / не сжатие ли масштаба' },
  { factor: 'CAPEX ↑', channel: 'больше инвестиций', report: 'FCF ↓', lag: 'обычно сразу', watch: 'рост будущих мощностей' },
  { factor: 'CAPEX ↑ → мощности ↑', channel: 'больше производственных возможностей', report: 'Volume / Revenue ↑ позже', lag: '2–8 кв.', watch: 'загрузка новых мощностей' },
  { factor: 'Долг ↑', channel: 'больше ликвидности сейчас', report: 'Cash ↑, Debt ↑', lag: 'сразу', watch: 'зачем взяли долг' },
  { factor: 'Долг ↑', channel: 'процентные расходы ↑', report: 'Net income ↓', lag: '1–4 кв.', watch: 'ставка и валюта долга' },
  { factor: 'Дивиденды ↑', channel: 'деньги уходят акционерам', report: 'Cash ↓', lag: 'сразу', watch: 'FCF / Debt (не из долга ли)' },
  { factor: 'Buyback ↑', channel: 'Cash ↓ / shares outstanding ↓', report: 'EPS потенциально ↑', lag: '1–4 кв.', watch: 'цена выкупа' },
  { factor: 'Реструктуризация кредита', channel: 'проблемный актив «очищается»', report: 'резервы / CoR меняются', lag: '1–4 кв.', watch: 'не ухудшается ли качество снова' },
  { factor: 'Переоценка бумаг ↑', channel: 'бухгалтерская прибыль', report: 'Net income ↑', lag: 'мгновенно', watch: 'cash это или paper gain' },
  { factor: 'Сезонность', channel: 'разный спрос по кварталам', report: 'Revenue / EBITDA сильно меняются', lag: 'каждый год', watch: 'YoY вместо только QoQ' },
];
