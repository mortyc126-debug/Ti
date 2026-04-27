// Словарь метрик для поиска по параметрам.
//
// Каждая метрика имеет:
//   key       — каноническое имя в коде (snake_case)
//   label     — короткое имя для UI (как пишет человек: «EBITDA», «ICR»)
//   full      — развёрнутое объяснение (тултип)
//   aliases   — список синонимов, по которым ищется (en + ru + сокращения,
//               всё в нижнем регистре, без диакритики)
//   unit      — '%' | 'x' | 'years' | 'days' | 'rub' | null — для подсказок
//               и автоподстановки в шаблон условия
//   scope     — 'bond'   — фильтр применим к выпуску из каталога
//               'issuer' — нужны финансовые отчёты эмитента
//               'stock'  — данные по акции
//   resolver  — функция (item) → number | null, как достать значение из
//               объекта каталога. Для 'issuer' пока возвращаем null
//               (нет данных), но включение в словарь даёт автокомплит.
//
// Ключи у bond-объектов в каталоге см. backend/worker.js handleCatalog:
//   {isin, issuerInn, name, ytm, coupon, maturity, offer, board}
// maturity — 'YYYY-MM' (последний срез из bond_daily.mat_date).

function ttmYears(maturity){
  if(!maturity) return null;
  // YYYY-MM-DD или YYYY-MM
  const d = new Date(maturity.length === 7 ? maturity + '-01' : maturity);
  if(isNaN(d.getTime())) return null;
  const ms = d.getTime() - Date.now();
  if(ms <= 0) return 0;
  return ms / (365.25 * 24 * 3600 * 1000);
}

export const METRICS = [
  // ── облигации (фильтрация работает) ──────────────────────────────
  {
    key: 'ytm', label: 'YTM', full: 'Доходность к погашению',
    aliases: ['ytm', 'yield', 'доходность', 'дох', 'доход к погашению'],
    unit: '%', scope: 'bond',
    resolver: b => b.ytm ?? null,
  },
  {
    key: 'coupon', label: 'Купон', full: 'Купонная ставка, %',
    aliases: ['купон', 'coupon', 'купонная ставка', 'купон ставка'],
    unit: '%', scope: 'bond',
    resolver: b => b.coupon ?? null,
  },
  {
    key: 'ttm', label: 'Срок', full: 'До погашения, лет',
    aliases: ['срок', 'до погашения', 'погашение', 'ttm', 'maturity', 'мат'],
    unit: 'years', scope: 'bond',
    resolver: b => ttmYears(b.maturity),
  },
  {
    key: 'duration', label: 'Дюрация', full: 'Macaulay duration, лет',
    aliases: ['дюрация', 'duration', 'дюр'],
    unit: 'years', scope: 'bond',
    resolver: b => b.duration_days != null ? b.duration_days / 365.25 : null,
  },

  // ── эмитент: финансовые мультипликаторы ──────────────────────────
  // resolver = null означает «данные ещё не подключены»; при попытке
  // отфильтровать UI покажет «нужны отчёты, появится после миграции
  // отчётности в D1». Включены в словарь чтобы автокомплит уже работал.
  {
    key: 'nd_ebitda', label: 'ND/EBITDA', full: 'Чистый долг к EBITDA, ×',
    aliases: ['nd/ebitda', 'nd ebitda', 'долг/ebitda', 'долг ebitda', 'долговая нагрузка'],
    unit: 'x', scope: 'issuer', resolver: null,
  },
  {
    key: 'icr', label: 'ICR', full: 'Покрытие процентов EBITDA, ×',
    aliases: ['icr', 'dscr', 'покрытие процентов', 'покрытие'],
    unit: 'x', scope: 'issuer', resolver: null,
  },
  {
    key: 'de', label: 'D/E', full: 'Финансовый рычаг (долг к капиталу), ×',
    aliases: ['d/e', 'de', 'долг/капитал', 'рычаг', 'leverage'],
    unit: 'x', scope: 'issuer', resolver: null,
  },
  {
    key: 'debt_assets', label: 'Debt/Assets', full: 'Долг к активам',
    aliases: ['debt/assets', 'долг/активы', 'долг активы', 'debt ratio'],
    unit: '%', scope: 'issuer', resolver: null,
  },
  {
    key: 'ebitda', label: 'EBITDA', full: 'EBITDA, млрд ₽',
    aliases: ['ebitda', 'эбитда', 'операционная прибыль до амортизации'],
    unit: 'rub', scope: 'issuer', resolver: null,
  },
  {
    key: 'ebitda_margin', label: 'EBITDA-маржа', full: 'Операционная рентабельность',
    aliases: ['ebitda-маржа', 'ebitda маржа', 'операционная рентабельность', 'операц рентабельность'],
    unit: '%', scope: 'issuer', resolver: null,
  },
  {
    key: 'np_margin', label: 'Net Profit Margin', full: 'Чистая рентабельность',
    aliases: ['net profit margin', 'чистая рентабельность', 'чистая маржа', 'np margin'],
    unit: '%', scope: 'issuer', resolver: null,
  },
  {
    key: 'roe', label: 'ROE', full: 'Рентабельность капитала',
    aliases: ['roe', 'рентабельность капитала', 'рентабельность собственного капитала'],
    unit: '%', scope: 'issuer', resolver: null,
  },
  {
    key: 'roa', label: 'ROA', full: 'Рентабельность активов',
    aliases: ['roa', 'рентабельность активов'],
    unit: '%', scope: 'issuer', resolver: null,
  },
  {
    key: 'ros', label: 'ROS', full: 'Рентабельность продаж',
    aliases: ['ros', 'рентабельность продаж'],
    unit: '%', scope: 'issuer', resolver: null,
  },
  {
    key: 'current_ratio', label: 'Current Ratio', full: 'Коэффициент текущей ликвидности',
    aliases: ['current ratio', 'текущая ликвидность', 'тек ликвидность', 'тек. ликвидность', 'тек ликвид', 'ктл'],
    unit: 'x', scope: 'issuer', resolver: null,
  },
  {
    key: 'cash_ratio', label: 'Cash Ratio', full: 'Денежная ликвидность',
    aliases: ['cash ratio', 'денежная ликвидность', 'абсолютная ликвидность'],
    unit: 'x', scope: 'issuer', resolver: null,
  },
  {
    key: 'equity_ratio', label: 'Equity Ratio', full: 'Доля собственного капитала',
    aliases: ['equity ratio', 'доля собственного капитала', 'доля капитала', 'независимость'],
    unit: '%', scope: 'issuer', resolver: null,
  },
  {
    key: 'altman_z', label: 'Altman Z', full: 'Z-score банкротства Альтмана',
    aliases: ['altman', 'altman z', 'z-score', 'альтман'],
    unit: 'x', scope: 'issuer', resolver: null,
  },
  {
    key: 'revenue', label: 'Выручка', full: 'Выручка, млрд ₽',
    aliases: ['выручка', 'revenue', 'sales'],
    unit: 'rub', scope: 'issuer', resolver: null,
  },
  {
    key: 'net_profit', label: 'Чистая прибыль', full: 'Чистая прибыль, млрд ₽',
    aliases: ['чистая прибыль', 'net profit', 'np'],
    unit: 'rub', scope: 'issuer', resolver: null,
  },

  // ── акции ────────────────────────────────────────────────────────
  {
    key: 'price', label: 'Цена', full: 'Цена акции, ₽',
    aliases: ['цена', 'price', 'last'],
    unit: 'rub', scope: 'stock',
    resolver: s => s.price ?? null,
  },
  {
    key: 'change', label: 'Δ%', full: 'Изменение за день, %',
    aliases: ['изменение', 'change', 'δ', 'дельта', '%день'],
    unit: '%', scope: 'stock',
    resolver: s => s.changePct ?? null,
  },
];

// быстрая нормализация для поиска по aliases
const _norm = s => String(s || '').toLowerCase().replace(/[«»"']/g, '').replace(/\s+/g, ' ').trim();

// Все алиасы → metric (для парсера). Ключ — нормализованный alias.
// При совпадении используется самый длинный — поэтому сортируем по убыванию длины.
const _aliasIndex = (() => {
  const items = [];
  for(const m of METRICS){
    for(const a of m.aliases){
      items.push({ alias: _norm(a), m });
    }
  }
  items.sort((a, b) => b.alias.length - a.alias.length);
  return items;
})();

export function findMetricByAlias(text){
  const t = _norm(text);
  if(!t) return null;
  for(const it of _aliasIndex){
    if(it.alias === t) return it.m;
  }
  return null;
}

// Подсказки автокомплита: для префикса «EB» вернёт топ-N метрик у
// которых хоть один alias начинается с этого префикса. Латиница и
// кириллица сравниваются обе, без учёта регистра.
export function suggestMetrics(prefix, limit){
  const p = _norm(prefix);
  const lim = limit || 6;
  if(!p) return [];
  const seen = new Set();
  const out = [];
  for(const it of _aliasIndex){
    if(seen.has(it.m.key)) continue;
    if(it.alias.startsWith(p)){
      seen.add(it.m.key);
      out.push(it.m);
      if(out.length >= lim) break;
    }
  }
  // Если по startsWith мало — добираем по includes
  if(out.length < lim){
    for(const it of _aliasIndex){
      if(seen.has(it.m.key)) continue;
      if(it.alias.includes(p)){
        seen.add(it.m.key);
        out.push(it.m);
        if(out.length >= lim) break;
      }
    }
  }
  return out;
}

export const METRIC_BY_KEY = Object.fromEntries(METRICS.map(m => [m.key, m]));
