# TRACK G — Frontend на реальных данных

## Цель

Заменить mock-данные в React-приложении (`web/`) на реальные вызовы
к backend API. Сейчас 95% UI читает заглушки, пользователь видит 24
mock-облигации вместо ~3000 реальных. После этой ветки сайт начинает
быть полезным.

## Зависимости

Минимум — существующие endpoint'ы (уже задеплоены):
- `/catalog` (issuers, bonds, stocks)
- `/bond/latest`, `/bond/issuer`
- `/issuer/{inn}`, `/issuer/{inn}/reports`, `/issuer/{inn}/affiliations`
- `/status`

Бонус — endpoint'ы из других треков, как только они появятся:
- TRACK B `/macro/latest`
- TRACK C `/events/feed`
- TRACK D `/issuer/{inn}/ratings`
- TRACK E `/issuer/{inn}/stress`, `/issuer/{inn}/peers`
- TRACK F `/issuer/{inn}/risk_card`

## Файлы (зона ветки)

```
web/src/
├── api.js                       # дополнить методами
├── pages/
│   ├── Bonds.jsx                # ★ убрать bondsMock, переключить на api.bondLatest()
│   ├── Home.jsx                 # ★ KPI портфеля + лента событий из /events/feed
│   ├── Live.jsx                 # стрим актуальных цен (если будет TRACK A)
│   ├── Portfolio.jsx            # P&L по реальному портфелю (свой собственный)
│   └── Issuer.jsx               # НОВАЯ — карточка эмитента (/issuer/{inn})
├── components/
│   ├── bonds/Filters.jsx        # уже есть, не трогать
│   ├── bonds/BondTable.jsx      # вынести из Bonds.jsx, на API
│   ├── issuer/                  # НОВАЯ папка
│   │   ├── IssuerHeader.jsx     # имя, статус, рейтинг, сектор
│   │   ├── ReportsChart.jsx     # ряд rev/np/eq за 5 лет
│   │   ├── AffiliationsTree.jsx # дерево учредителей
│   │   ├── EventsFeed.jsx       # лента событий по эмитенту
│   │   └── RiskCard.jsx         # композит из risk_cards
│   └── home/
│       └── EventsFeed.jsx       # УЖЕ ЕСТЬ как мок — заменить на API
└── data/
    ├── bondsCatalog.js          # УБРАТЬ bondsMock
    └── (оставить INDUSTRIES, MULTIPLIERS — это конфиг, не данные)
```

## API клиент (`web/src/api.js`)

Расширить:

```js
export const api = {
  // (уже есть)
  status, stockLatest, futuresLatest, basis, basisHistory,
  bondLatest, bondHistory, bondIssuer, catalog, issuerCard,

  // ДОБАВИТЬ
  issuerReports:       (inn)         => req(`/issuer/${inn}/reports`),
  issuerAffiliations:  (inn)         => req(`/issuer/${inn}/affiliations`),
  issuerRatings:       (inn)         => req(`/issuer/${inn}/ratings`),
  issuerStress:        (inn)         => req(`/issuer/${inn}/stress`),
  issuerPeers:         (inn, k=10)   => req(`/issuer/${inn}/peers?k=${k}`),
  issuerRiskCard:      (inn)         => req(`/issuer/${inn}/risk_card`),
  issuerEvents:        (inn)         => req(`/issuer/${inn}/events`),
  eventsFeed:          (params={})   => req(`/events/feed?${new URLSearchParams(params)}`),
  macroLatest:         ()            => req('/macro/latest'),
  ratingsRecent:       (days=30)     => req(`/ratings/recent?days=${days}`),
  reportsLatest:       (limit=50)    => req(`/reports/latest?limit=${limit}`),
};
```

## Замена мока на API в Bonds.jsx

Текущий код:
```jsx
import { bondsMock } from '../data/bondsCatalog.js';
// ...
const filtered = useMemo(() => applyFilters(bondsMock, filters), [filters]);
```

Целевой:
```jsx
import { useEffect, useState } from 'react';
import { api } from '../api.js';

const [allBonds, setAllBonds] = useState([]);
const [loading, setLoading] = useState(true);

useEffect(() => {
  api.bondLatest({ limit: 1000 }).then(({ data }) => {
    // нормализуем под старую форму (которую ждут фильтры)
    setAllBonds(data.map(normalizeBond));
    setLoading(false);
  });
}, []);

const filtered = useMemo(() =>
  applyFilters(allBonds, filters),
  [allBonds, filters]
);
```

`normalizeBond` приводит API-ответ к форме которую ожидают существующие
фильтры/multipliers (поля `secid`, `name`, `issuer`, `type`, `ytm`,
`duration_years`, `volume_bn`, `rating`, `mults`, и т.д.). Часть полей
(`mults`) пока null — фильтры по ним просто покажут все.

## Новая страница «Карточка эмитента»

Открывается из таблицы облигаций (клик на имя эмитента) или прямой URL
`/#/issuer/2460066195`.

```jsx
// web/src/pages/Issuer.jsx
function IssuerPage() {
  const { inn } = useParams();
  const [card, setCard] = useState(null);
  const [reports, setReports] = useState(null);
  const [aff, setAff] = useState(null);

  useEffect(() => {
    Promise.all([
      api.issuerCard(inn),
      api.issuerReports(inn),
      api.issuerAffiliations(inn),
    ]).then(([c, r, a]) => { setCard(c); setReports(r); setAff(a); });
  }, [inn]);

  return (
    <div className="space-y-5">
      <IssuerHeader issuer={card?.issuer} stock={card?.stock} />
      <BondsList bonds={card?.bonds} />
      <ReportsChart series={reports?.data} />
      <AffiliationsTree founders={aff?.founders} children={aff?.children} />
      <RiskCard inn={inn} />            {/* lazy-load */}
      <EventsFeed inn={inn} />          {/* lazy-load */}
    </div>
  );
}
```

В `App.jsx` (или routes config) добавить маршрут.

## Состояние и кеширование

- Все API-вызовы кешировать через **localStorage TTL 10 мин** для
  списочных endpoint'ов и 1 час для эмитент-специфичных.
- Уже есть `web/src/lib/search.js` с patterns кеширования — переиспользовать.

## Стиль и дизайн

- Не переделывать дизайн — он уже хорош (Card, Badge, MetricBar).
- Все «нет данных» рендерить через существующие компоненты
  (`<Stat label="..." value={null} />` сам покажет «—»).
- Loading-состояния — через `<SkeletonCard />` (нужно создать в
  `components/ui/`) или просто spinner внутри Card.

## Acceptance criteria

- [ ] `Bonds.jsx` показывает реальные ~3000 бумаг (filters работают).
- [ ] Клик по имени эмитента открывает `/#/issuer/{inn}` с реальными
  данными (имя, бумаги, отчётность, учредители).
- [ ] `Home.jsx` показывает реальные счётчики (`/status`) и ленту
  свежих событий (`/events/feed?limit=10` если TRACK C готов).
- [ ] CSV-экспорт работает на отфильтрованной выборке.
- [ ] Не сломан `Live.jsx` / `Portfolio.jsx` (могут остаться mock,
  это отдельный track).

## Что не делать

- Не вводить state-management библиотеку (zustand уже есть в
  `web/src/store/`, переиспользуй).
- Не делать SSR — это статический SPA на CF Pages.
- Не пере-стилизовать — Tailwind config и palette уже устаканились.
