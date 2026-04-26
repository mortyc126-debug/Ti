# Web — Cloudflare Pages frontend

Новый интерфейс БондАналитика. Vite + React + Tailwind + React Router.
Бэкенд (D1, MOEX-сборщики) — отдельный репозиторий-сосед `backend/`.

## Локальная разработка

```sh
cd web
npm install
npm run dev
```

Откроется http://localhost:5173. Vite-прокси прокидывает `/api/*` →
production-Worker (`bondan-backend.marginacall.workers.dev`), так что
видите реальные данные сразу, без локального бэкенда.

Hot-reload — любое изменение `.jsx` мгновенно отражается в браузере.

## Деплой

Происходит автоматически при `git push` в основную ветку:

1. Cloudflare Pages подключён к GitHub-репо
2. Build command: `npm install && npm run build`
3. Build output: `dist`
4. Root directory: `web`
5. После сборки — доступно на `bondan-app.pages.dev`

## Структура

```
src/
├── main.jsx               — точка входа React
├── App.jsx                — маршрутизация
├── api.js                 — клиент к Worker'у (BACKEND_URL)
├── index.css              — Tailwind + база
├── components/
│   └── Layout.jsx         — шапка + навигация
└── pages/
    ├── Home.jsx           — статус подключения, сводка БД
    ├── Portfolio.jsx      — миграция из ba_v2 (TODO)
    ├── Bonds.jsx          — каталог облигаций из bond_daily
    └── Live.jsx           — real-time котировки (TODO)
```

## Переменные окружения

Для production-сборки можно установить `VITE_BACKEND_URL` через
Cloudflare Pages → Settings → Environment Variables. По умолчанию
используется `/api` (что для Pages — относительный путь и не сработает,
поэтому переменная нужна).

Production-значение:
```
VITE_BACKEND_URL=https://bondan-backend.marginacall.workers.dev
```
