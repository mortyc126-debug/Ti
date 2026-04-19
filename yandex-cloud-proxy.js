// Яндекс Cloud Function — прокси для ГИР БО (bo.nalog.gov.ru).
//
// Зачем: Cloudflare Workers запускаются в датацентрах вне РФ
// (Финляндия/Казахстан/Турция — после ухода CF из России в 2022),
// и ФНС режет оттуда трафик (522 Connection Timed Out). Яндекс Облако
// — российская инфраструктура, bo.nalog.gov.ru пускает нормально.
//
// Протокол тот же, что у cf-worker.js: ?u=https://bo.nalog.gov.ru/nbo/...
// В настройках БондАналитик-а ⚡ Sync → «📡 ГИР БО — прокси» просто
// меняется URL на yandex-cloud, код приложения трогать не нужно.
//
// ═══════════════════════════════════════════════════════════════════
// ИНСТРУКЦИЯ ПО РАЗВЁРТЫВАНИЮ (15 минут, бесплатно)
// Названия пунктов приведены так, как они видны в русскоязычной
// консоли Яндекс Облака. Некоторые названия продуктов (Cloud
// Functions) не переводятся — это нормально.
// ═══════════════════════════════════════════════════════════════════
//
// 1. РЕГИСТРАЦИЯ
//    • Открой https://console.yandex.cloud/ → «Войти» → войти через
//      Яндекс ID (логин+пароль, без карты).
//    • При первом входе предложат создать ОБЛАКО и КАТАЛОГ (folder)
//      — соглашайся с дефолтами. Бесплатного тарифа хватит с запасом:
//      1 млн вызовов/мес + 10 ГБ·ч вычислений. Тебе нужно ~100-500
//      вызовов за сеанс работы.
//
// 2. СОЗДАТЬ ФУНКЦИЮ
//    • В консоли в левом меню выбери «Все сервисы» (если меню свёрнуто
//      — сначала открой его, иконка с тремя полосками).
//    • В списке сервисов найди раздел «Бессерверные вычисления» →
//      в нём «Cloud Functions» (латиницей — это название продукта,
//      не переводится).
//    • Нажми кнопку «Создать функцию».
//    • Имя: bondan-girbo (только латиница и дефисы — имя уникально).
//    • Описание: «Прокси для bo.nalog.gov.ru» (необязательно).
//    • Нажми «Создать».
//
// 3. СОЗДАТЬ ВЕРСИЮ (сам код)
//    • Откроется страница функции → вверху вкладки: «Обзор»,
//      «Редактор», «Тестирование», «Тriggers», «Операции».
//    • Перейди на вкладку «Редактор».
//    • Нажми «Создать в редакторе» (если есть такая кнопка) или
//      просто начни редактирование.
//    • Справа вверху поля:
//        — «Среда выполнения» → выбери из списка: nodejs18 (или nodejs20).
//        — «Таймаут, с» → поставь 30 (дефолт 5, это мало — внутренний
//          retry не успеет).
//        — «Память, МБ» → 128 (минимум, этого хватит).
//        — «Точка входа» → напиши: index.handler
//    • Слева должна быть панель с файлами, обычно один файл index.js.
//    • Кликни в окно с кодом, нажми Ctrl+A → Delete (удалит дефолт).
//    • СКОПИРУЙ ЦЕЛИКОМ код ниже (всё начиная от строки
//      `exports.handler = async (event) => {` и до самой последней
//      `};` в конце файла) и вставь в редактор.
//    • Справа внизу нажми «Сохранить изменения» (или «Создать
//      версию»).
//
// 4. СДЕЛАТЬ ФУНКЦИЮ ПУБЛИЧНОЙ
//    • Без этого шага функцию можно будет вызвать только с токеном.
//      Нам нужен открытый доступ по URL, чтобы приложение могло
//      дёргать её напрямую.
//    • Вернись на вкладку «Обзор» функции.
//    • Найди раздел «Доступ» (или «Права доступа») — обычно ближе
//      к низу страницы.
//    • Переключатель «Публичная функция» → включи. Либо кнопка
//      «Сделать публичной». После подтверждения статус изменится
//      на «Публичная: да».
//
// 5. СКОПИРОВАТЬ ССЫЛКУ
//    • На вкладке «Обзор» в блоке «Общая информация» будет поле
//      «Ссылка для вызова» (или «URL для вызова»), выглядит так:
//        https://functions.yandexcloud.net/d4e1234abcd5678efgh
//    • Нажми иконку копирования рядом (или выдели и Ctrl+C).
//
// 6. ВПИСАТЬ В ПРИЛОЖЕНИЕ БОНДАНАЛИТИК
//    • БондАналитик → сайдбар слева → «⚡ Sync (Gist)».
//    • В открывшейся модалке найди поле «📡 ГИР БО — прокси»
//      (прокрути вниз, оно в блоке про ГИР БО).
//    • Сотри старое значение (CF Worker URL).
//    • Вставь скопированный URL Яндекс-функции и ДОПИШИ на конце
//      «/?u=» (слэш, знак вопроса, буква u, знак равно). Итог:
//        https://functions.yandexcloud.net/d4e1234abcd5678efgh/?u=
//    • Закрой модалку (сохраняется автоматически).
//
// 7. ПРОВЕРКА
//    • В любой вкладке браузера открой такой адрес (подставь свой
//      идентификатор функции вместо d4e...):
//        https://functions.yandexcloud.net/d4e.../?u=https://bo.nalog.gov.ru/advanced-search/organizations/search?query=7707083893&page=0&size=20
//    • Должен вернуться JSON с данными Сбербанка (много текста
//      про ПАО Сбербанк). Если да — прокси работает, можно
//      запускать массовую подтяжку в «🏛 Каталог Мосбиржи».
//    • Если вернулся пустой ответ или ошибка «требует токен» —
//      значит шаг 4 (публичная функция) не выполнился.
//
// ═══════════════════════════════════════════════════════════════════

exports.handler = async (event) => {
    // Я.Cloud передаёт запрос в event: queryStringParameters, httpMethod, etc.
    const qs = event.queryStringParameters || {};
    let target = qs.u;

    // Разрешённые upstream-домены: ФНС (bo.nalog.gov.ru), audit-it.ru
    // (агрегатор, ручной paste), buxbalans.ru (агрегатор, серверный
    // парсинг работает — anti-bot отсутствует).
    const ALLOWED = [
        /^https:\/\/bo\.nalog\.gov\.ru\//,
        /^https:\/\/(www\.)?audit-it\.ru\//,
        /^https:\/\/(www\.)?buxbalans\.ru\//
    ];
    const isAllowed = (url) => ALLOWED.some((re) => re.test(url));

    // Альтернатива: путь повторяет upstream (/nbo/..., /advanced-search/...
    // — ФНС; /buh_otchet/..., /search/... — audit-it; /<inn>.html — buxbalans).
    // По префиксу пути выбираем целевой домен.
    if (!target && event.path) {
        const qp = Object.entries(qs).filter(([k]) => k !== 'u').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
        const suffix = event.path + (qp ? '?' + qp : '');
        if (event.path.startsWith('/nbo') || event.path.startsWith('/advanced-search')) {
            target = 'https://bo.nalog.gov.ru' + suffix;
        } else if (event.path.startsWith('/buh_otchet') || event.path.startsWith('/search') || event.path.startsWith('/contragent')) {
            target = 'https://www.audit-it.ru' + suffix;
        } else if (/^\/\d{10}(\d{2})?\.html$/.test(event.path)) {
            target = 'https://buxbalans.ru' + suffix;
        }
    }

    if (!target || !isAllowed(target)) {
        return {
            statusCode: 400,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-store',
                'Content-Type': 'text/plain; charset=utf-8'
            },
            body: 'Allowed: bo.nalog.gov.ru, audit-it.ru, buxbalans.ru. Pass URL via ?u=https://…'
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
                    // У ФНС — JSON API, у audit-it — HTML. Универсальный
                    // Accept, чтобы оба пускали.
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
                    'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
                    'Accept-Encoding': 'gzip, deflate, br',
                    // Полный браузерный фингерпринт — без Sec-Ch-Ua/Sec-Fetch-*
                    // audit-it отвечает anti-bot заглушкой «включите JS и cookies».
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                    'Sec-Ch-Ua': '"Google Chrome";v="126", "Chromium";v="126", "Not-A.Brand";v="99"',
                    'Sec-Ch-Ua-Mobile': '?0',
                    'Sec-Ch-Ua-Platform': '"Windows"',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    // same-origin + Referer на главную — как будто пользователь
                    // кликнул по внутренней ссылке. none+прямой заход audit-it
                    // отклоняет заглушкой «включите JS и cookies».
                    'Sec-Fetch-Site': target.includes('audit-it.ru') ? 'same-origin' : 'none',
                    'Sec-Fetch-User': '?1',
                    'Upgrade-Insecure-Requests': '1',
                    'Cache-Control': 'max-age=0',
                    ...(target.includes('audit-it.ru') ? {'Referer': 'https://www.audit-it.ru/'} : {})
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
