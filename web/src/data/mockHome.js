// Mock-данные для главной — портфельные KPI, события эмитентов, фичи.
// Заменятся на реальные через api.js после миграции localStorage в D1.

export const portfolioKpi = {
  navRub:        2_847_320,
  navDelta:      0.42,        // %, день
  cashRub:       183_400,
  positionsN:    24,
  ytmAvg:        21.8,        // средняя YTM по портфелю
  ytmDelta:      0.15,
  durationAvg:   1.7,         // лет
  yieldYtdRub:   148_730,
  yieldYtdPct:   5.6,
};

export const recentEvents = [
  { id: 'e1', when: '2026-04-26', tone: 'warn',   issuer: 'ПГК',         text: 'Купон по 001Р-04 — выплата 11.50₽/бум.' },
  { id: 'e2', when: '2026-04-25', tone: 'acc',    issuer: 'Сегежа',      text: 'Опубликована МСФО за 2025: выручка +12%' },
  { id: 'e3', when: '2026-04-24', tone: 'danger', issuer: 'РОЛЬФ',       text: 'Снижение рейтинга АКРА: BBB+ → BBB' },
  { id: 'e4', when: '2026-04-23', tone: 'green',  issuer: 'М.Видео',     text: 'Оферта по 001P-03: выкуп по 100%' },
  { id: 'e5', when: '2026-04-22', tone: 'neutral',issuer: 'Делимобиль',  text: 'Размещение нового выпуска 002P-01, ставка 22.5%' },
];

export const featureCards = [
  {
    id: 'finance',
    badge: 'Окна',
    title: 'Финансы эмитента',
    text: 'Клик по компании в поиске — плавающее окно с радар-картой коэффициентов, MSFО/РСБУ-сравнением и аудитом баланса.',
  },
  {
    id: 'bonds',
    badge: 'TQCB · TQOB',
    title: 'База облигаций',
    text: 'Свежие котировки и YTM по всем корпоратам и ОФЗ. Фильтры по доходности, дюрации и сектору эмитента.',
  },
  {
    id: 'live',
    badge: 'Realtime',
    title: 'Live-цены',
    text: 'WebSocket-стрим из MOEX через Cloudflare Durable Object. Алёрты на пробои, мини-графики 1-минутных баров.',
  },
];
