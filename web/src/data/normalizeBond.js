// Нормализатор bond_daily-строк бэкенда → форма, которую ожидают
// фильтры/таблица фронта (web/src/components/bonds/applyFilters.js).
// Контракт фильтров: см. bondsMock в data/bondsCatalog.js — поля
// type/listing/currency/trend/price/ytm/yield_to_mat/duration_years/
// volume_bn/coupon_freq/coupon_period_days/amort/offer/rating/
// ratingTrend/mode/spread/industry/mults/reportYear/reportDaysAgo.

const BOARD_TO_TYPE = {
  TQOB: 'ofz',          // ОФЗ
  TQCB: 'corporate',    // корпорат рублёвый
  TQOY: 'subfederal',   // юаневые суверены (берём как «корпорат» по типу UI)
  TQOD: 'corporate',    // юаневые корпораты
  TQIR: 'corporate',    // валютные корпораты
  TQED: 'corporate',    // евробонды
};

const FACE_TO_CURRENCY = {
  SUR: 'RUB', RUB: 'RUB',
  USD: 'USD',
  EUR: 'EUR',
  CNY: 'CNY',
};

// shortname от MOEX — компактное имя эмитента в выпуске («РусГид2Р12»).
// Для группировки нам нужно «человеческое» имя. Берём из emitent_name
// (длинное юр-название) и сокращаем — убираем ОПФ и кавычки.
function humanizeIssuer(name){
  if(!name) return '—';
  let s = String(name).trim();
  s = s.replace(/^(публичное\s+акционерное\s+общество|открытое\s+акционерное\s+общество|закрытое\s+акционерное\s+общество|акционерное\s+общество|общество\s+с\s+ограниченной\s+ответственностью|пао|оао|зао|ао|ооо)\s+/i, '');
  s = s.replace(/^[«"']+|[»"']+$/g, '').trim();
  // Слишком длинное → берём первые 30 символов
  if(s.length > 40) s = s.slice(0, 38).trim() + '…';
  return s || name;
}

// Тип купона/моды: пока берём fix по умолчанию, для floater'ов в name
// часто есть КС/RUONIA — простая эвристика.
function detectCouponMode(b){
  const n = (b.shortname || b.isin || '').toLowerCase();
  if(/флт|floater|кс\+|ruonia/i.test(n)) return 'float';
  return 'fix';
}

export function normalizeBond(b){
  const type = BOARD_TO_TYPE[b.board] || 'exchange';
  const currency = FACE_TO_CURRENCY[(b.face_unit || '').toUpperCase()] || 'RUB';

  // Тренд по сегодняшней цене относительно вчерашнего close
  let trend = 'flat';
  if(b.price && b.prev_close){
    const change = (b.price - b.prev_close) / b.prev_close;
    if(change > 0.005) trend = 'up';
    else if(change < -0.005) trend = 'down';
  }

  // Период купона → ярлык. coupon_period_days от MOEX — реальное число.
  const cpd = b.coupon_period_days || 0;
  const couponFreq =
    cpd <= 31 ? 'month' :
    cpd <= 95 ? 'quarter' :
    cpd <= 200 ? 'half' :
    cpd <= 400 ? 'year' : 'year';

  return {
    secid: b.secid,
    isin: b.isin || b.secid,
    name: b.shortname || b.secid,
    issuer: humanizeIssuer(b.emitent_name),
    issuerInn: b.emitent_inn || null,

    type,
    listing: b.list_level || 0,
    currency,
    trend,

    price: b.price ?? 0,
    ytm: b.yield ?? null,
    yield_to_mat: b.yield ?? null,           // тот же yield для обеих метрик
    duration_years: b.duration_days ? +(b.duration_days / 365).toFixed(2) : 0,
    mat_date: b.mat_date || null,
    offer_date: b.offer_date || null,

    volume_bn: b.volume_rub ? +(b.volume_rub / 1e9).toFixed(2) : 0,
    coupon_freq: couponFreq,
    coupon_period_days: cpd || null,
    coupon_pct: b.coupon_pct ?? null,

    amort: 'no',                              // нет в API — TODO когда появится
    offer: b.offer_date ? 'put' : 'any',      // упрощение
    rating: 'none',                           // TODO TRACK D
    ratingTrend: 'flat',
    mode: detectCouponMode(b),
    spread: null,

    industry: 'none',                         // TODO когда issuer.sector подтянется на bond
    mults: {},                                // TODO когда подключим issuer_reports

    // плейсхолдеры для фильтров «свежесть отчёта»
    reportYear: null,
    reportDaysAgo: null,
  };
}
