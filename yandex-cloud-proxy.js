// Яндекс Cloud Function — прокси для ГИР БО (bo.nalog.ru).
//
// Зачем: Cloudflare Workers запускаются в датацентрах вне РФ
// (Финляндия/Казахстан/Турция — после ухода CF из России в 2022),
// и ФНС режет оттуда трафик (522 Connection Timed Out). Яндекс Облако
// — российская инфраструктура, bo.nalog.ru пускает нормально.
//
// Протокол тот же, что у cf-worker.js: ?u=https://bo.nalog.ru/nbo/...
// В настройках БондАналитик-а ⚡ Sync → «📡 ГИР БО — прокси» просто
// меняется URL на yandex-cloud, код приложения трогать не нужно.
//
// ═══════════════════════════════════════════════════════════════════
// ИНСТРУКЦИЯ ПО РАЗВЁРТЫВАНИЮ (15 минут, бесплатно)
// ═══════════════════════════════════════════════════════════════════
//
// 1. РЕГИСТРАЦИЯ
//    • Открой https://console.yandex.cloud/ → «Войти» → регистрация
//      через Яндекс ID (логин+пароль, без карты).
//    • При первом входе предложат создать ОБЛАКО и КАТАЛОГ (folder)
//      — соглашайся с дефолтами. Бесплатного тарифа хватит с запасом:
//      Functions → 1 млн вызовов/мес + 10 ГБ·ч вычислений. Тебе нужно
//      ~100 вызовов за сеанс работы.
//
// 2. СОЗДАТЬ ФУНКЦИЮ
//    • В консоли найди сервис «Cloud Functions» (слева в меню «Все
//      сервисы» → раздел «Serverless»).
//    • Нажми «Создать функцию».
//    • Имя: bondan-girbo  (или любое латиницей)
//    • Описание: «прокси для bo.nalog.ru» (не обязательно)
//    • Нажми «Создать».
//
// 3. СОЗДАТЬ ВЕРСИЮ (сам код)
//    • Откроется страница функции → вкладка «Редактор» → «Создать
//      в редакторе».
//    • В поле «Среда выполнения» выбери: nodejs18 (или nodejs20).
//    • В поле «Точка входа» напиши: index.handler
//    • В поле «Таймаут, с»: 30  (дефолт 5 — мало, retry не успеет)
//    • Память: 128 МБ (минимум, этого хватит).
//    • В блоке «Код»:
//        - слева должен быть файл index.js
//        - УДАЛИ весь содержимый код (Ctrl+A → Delete)
//        - СКОПИРУЙ ЦЕЛИКОМ блок ниже (всё от `exports.handler` до
//          последней `};`) и вставь.
//    • Нажми «Сохранить изменения».
//
// 4. СДЕЛАТЬ ПУБЛИЧНОЙ
//    • Перейди на вкладку «Обзор» функции.
//    • Найди раздел «Доступ» или «Настройки» → «Сделать функцию
//      публичной» (или «Публичная функция: да»).
//    • Без этого шага функция будет требовать токен и БондАналитик
//      не сможет её вызвать.
//
// 5. СКОПИРОВАТЬ URL
//    • На вкладке «Обзор» будет поле «Ссылка для вызова» вида:
//        https://functions.yandexcloud.net/d4e1234abcd5678efgh
//    • Скопируй его полностью.
//
// 6. ВПИСАТЬ В ПРИЛОЖЕНИЕ
//    • БондАналитик → ⚡ Sync → найти поле «📡 ГИР БО — прокси».
//    • Сотри старый URL (CF Worker).
//    • Вставь новый + припиши `/?u=` в конце. Должно получиться:
//        https://functions.yandexcloud.net/d4e1234abcd5678efgh/?u=
//
// 7. ПРОВЕРКА
//    • Открой в соседней вкладке браузера:
//        https://functions.yandexcloud.net/d4e.../?u=https://bo.nalog.ru/nbo/organizations/?query=7707083893
//    • Должен вернуться JSON с данными Сбербанка (много текста).
//    • Если вернулся — ура, можно запускать bulk по каталогу MOEX.
//
// ═══════════════════════════════════════════════════════════════════

exports.handler = async (event) => {
    // Я.Cloud передаёт запрос в event: queryStringParameters, httpMethod, etc.
    const qs = event.queryStringParameters || {};
    let target = qs.u;

    // Альтернатива: путь повторяет bo.nalog.ru.
    if (!target && event.path && event.path.startsWith('/nbo')) {
        const qp = Object.entries(qs).filter(([k]) => k !== 'u').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
        target = 'https://bo.nalog.ru' + event.path + (qp ? '?' + qp : '');
    }

    // Только bo.nalog.ru — ограничение безопасности. Нельзя превращать
    // прокси в general-purpose (иначе кто-то начнёт через неё DDoS'ить).
    if (!target || !/^https:\/\/bo\.nalog\.ru\//.test(target)) {
        return {
            statusCode: 400,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-store',
                'Content-Type': 'text/plain; charset=utf-8'
            },
            body: 'Allowed: bo.nalog.ru only. Pass URL via ?u=https://bo.nalog.ru/...'
        };
    }

    // CORS preflight.
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Accept',
                'Access-Control-Max-Age': '86400'
            },
            body: ''
        };
    }

    // Только чтение.
    if (event.httpMethod !== 'GET' && event.httpMethod !== 'HEAD') {
        return {
            statusCode: 405,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'text/plain; charset=utf-8'
            },
            body: 'Method not allowed'
        };
    }

    // Retry на transient 5xx — как в CF Worker. 3 попытки с паузой.
    let lastStatus = 0;
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const upstream = await fetch(target, {
                method: event.httpMethod,
                headers: {
                    'Accept': 'application/json',
                    // Чистый Chrome UA — без «Proxy», чтобы анти-бот
                    // не реагировал на наличие слова в User-Agent.
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                    'Accept-Language': 'ru-RU,ru;q=0.9'
                }
            });

            lastStatus = upstream.status;

            // Retry на 5xx; 2xx/3xx/4xx — сразу возвращаем.
            if ([502, 503, 504, 522, 524].includes(upstream.status)) {
                if (attempt < 2) {
                    await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
                    continue;
                }
            }

            // Читаем тело.
            const contentType = upstream.headers.get('content-type') || 'text/plain; charset=utf-8';
            const body = await upstream.text();

            // Кеширование: ТОЛЬКО успешные ответы. Ошибки не кешируем,
            // иначе один 522 застревал в disk cache и retry становился
            // бесполезным (клиент получал кешированный 522, не ходил в сеть).
            const cacheControl = upstream.status >= 200 && upstream.status < 300
                ? 'public, max-age=600'
                : 'no-store, no-cache, must-revalidate, max-age=0';

            return {
                statusCode: upstream.status,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Content-Type': contentType,
                    'Cache-Control': cacheControl
                },
                body: body
            };

        } catch (e) {
            lastError = e;
            if (attempt < 2) {
                await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
                continue;
            }
        }
    }

    return {
        statusCode: 502,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
            'Content-Type': 'text/plain; charset=utf-8'
        },
        body: 'Upstream unreachable after 3 attempts' + (lastError ? ': ' + (lastError.message || lastError) : '') + (lastStatus ? ' (last status: ' + lastStatus + ')' : '')
    };
};
