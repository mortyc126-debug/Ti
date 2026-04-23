// Cloudflare Worker — приватный CORS-прокси для ГИР БО (bo.nalog.gov.ru)
// и API Банка России (www.cbr.ru/dataservice).
//
// Зачем: ни bo.nalog.gov.ru, ни cbr.ru не отдают Access-Control-Allow-Origin
// браузеру, поэтому БондАналитик не может напрямую запросить отчётность
// по ИНН или свежие ряды инфляции/КС. Этот Worker пересылает GET-запросы
// на разрешённые upstream-хосты и добавляет в ответ нужный CORS-заголовок.
//
// Развёртывание (бесплатно, 5 минут):
//   1. Зарегистрируйтесь на dash.cloudflare.com (без карты).
//   2. Workers & Pages → Create Worker → дайте имя, например `bondan-girbo`.
//   3. Edit code → удалите дефолтный код, вставьте этот файл целиком,
//      нажмите Deploy.
//   4. Скопируйте URL вида https://bondan-girbo.<account>.workers.dev
//   5. В БондАналитик: ⚡ Sync → 📡 ГИР БО — прокси → впишите:
//        https://bondan-girbo.<account>.workers.dev/?u=
//      (точно так, с `?u=` на конце — таково соглашение приложения).
//
// Лимиты бесплатного плана CF Workers: 100 000 запросов/сутки.
// Для ЦБ один раунд «обновить все ряды» тратит 5–10 запросов, для ГИР БО
// одно «📡 5 лет» — 6 запросов. Пользование в одиночку — заведомо внутри
// лимита.
//
// Альтернатива: БондАналитик по умолчанию использует публичный corsproxy.io.
// Свой Worker — для (а) приватности (corsproxy видит ваши запросы), (б)
// надёжности (corsproxy могут отключить), (в) поддержки API ЦБ (corsproxy
// иногда спотыкается на редиректах cbr.ru).

export default {
  async fetch(req) {
    const url = new URL(req.url);

    // Соглашение БондАналитика: target-URL передаётся через ?u=…
    let target = url.searchParams.get('u');

    // Разрешённые upstream-домены: ФНС, audit-it.ru, buxbalans.ru, API ЦБ РФ.
    const ALLOWED = [
      /^https:\/\/bo\.nalog\.gov\.ru\//,
      /^https:\/\/(www\.)?audit-it\.ru\//,
      /^https:\/\/(www\.)?buxbalans\.ru\//,
      /^https:\/\/(www\.)?cbr\.ru\/dataservice\//,
      // Прямые ссылки на XLSX/PDF документы ЦБ (статистика инфляции,
      // KeyRate и т.д.) — статические файлы под /Content/Document/File/<id>/
      /^https:\/\/(www\.)?cbr\.ru\/Content\/Document\/File\//
    ];
    const isAllowed = (u) => ALLOWED.some((re) => re.test(u));

    // Альтернатива — префикс пути определяет upstream.
    if (!target) {
      if (url.pathname.startsWith('/nbo') || url.pathname.startsWith('/advanced-search')) {
        target = 'https://bo.nalog.gov.ru' + url.pathname + url.search;
      } else if (url.pathname.startsWith('/buh_otchet') || url.pathname.startsWith('/search') || url.pathname.startsWith('/contragent')) {
        target = 'https://www.audit-it.ru' + url.pathname + url.search;
      } else if (url.pathname.startsWith('/dataservice') || url.pathname.startsWith('/Content/Document/File/')) {
        target = 'https://www.cbr.ru' + url.pathname + url.search;
      } else if (/^\/\d{10}(\d{2})?\.html$/.test(url.pathname)) {
        target = 'https://buxbalans.ru' + url.pathname + url.search;
      }
    }

    if (!target || !isAllowed(target)) {
      return new Response('Allowed: bo.nalog.gov.ru, audit-it.ru, buxbalans.ru, cbr.ru/dataservice, cbr.ru/Content/Document/File. Pass URL via ?u=https://…', {
        status: 400,
        headers: {'Access-Control-Allow-Origin': '*'}
      });
    }

    // CORS preflight.
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Accept',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    // Только чтение публичных данных.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return new Response('Method not allowed', {
        status: 405,
        headers: {'Access-Control-Allow-Origin': '*'}
      });
    }

    try {
      // Внутренний retry на уровне Worker'а: 522 (Cloudflare не установил
      // TCP-соединение с origin) часто случайный — первый SYN дропнут,
      // второй успешно дойдёт. CF-маршрутизатор для ретрая обычно выбирает
      // другой исходный IP из пула, что иногда обходит ban.
      // До 3 попыток с небольшой экспоненциальной паузой.
      let upstream = null;
      let lastStatus = 0;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          // Для cbr.ru/dataservice — это JSON API, Accept должен быть json,
          // иначе сервер может отдать HTML-страницу документации.
          const isCbrApi = target.includes('cbr.ru/dataservice');
          upstream = await fetch(target, {
            method: req.method,
            headers: {
              'Accept': isCbrApi
                ? 'application/json, */*;q=0.1'
                : 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
              'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
              'Accept-Encoding': 'gzip, deflate, br',
              // Полный браузерный фингерпринт — audit-it без Sec-* заголовков
              // отвечает anti-bot заглушкой «включите JS и cookies».
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
              'Sec-Ch-Ua': '"Google Chrome";v="126", "Chromium";v="126", "Not-A.Brand";v="99"',
              'Sec-Ch-Ua-Mobile': '?0',
              'Sec-Ch-Ua-Platform': '"Windows"',
              'Sec-Fetch-Dest': 'document',
              'Sec-Fetch-Mode': 'navigate',
              // same-origin + Referer — натуральнее для audit-it.
              'Sec-Fetch-Site': target.includes('audit-it.ru') ? 'same-origin' : 'none',
              'Sec-Fetch-User': '?1',
              'Upgrade-Insecure-Requests': '1',
              'Cache-Control': 'max-age=0',
              ...(target.includes('audit-it.ru') ? {'Referer': 'https://www.audit-it.ru/'} : {})
            },
            cf: {
              // Кэшируем ТОЛЬКО успешные ответы. Ошибки не попадают в кэш,
              // иначе один 522 застревает на 10 минут и retry бесполезен.
              cacheTtl: 600,
              cacheTtlByStatus: { '200-299': 600, '300-599': 0 }
            }
          });
          lastStatus = upstream.status;
          // Если получили 522/524/504 — повторяем попытку. 200-499 —
          // legit ответ, отдаём как есть.
          if (![502, 503, 504, 522, 524].includes(upstream.status)) break;
        } catch (_) {
          // Сетевая ошибка — тоже ретраим.
        }
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
        }
      }

      if (!upstream) {
        return new Response('Upstream unreachable after 3 attempts (last status: ' + lastStatus + ')', {
          status: 502,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'
          }
        });
      }

      const headers = new Headers(upstream.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.delete('Set-Cookie');
      headers.delete('Strict-Transport-Security');
      // Кэш в БРАУЗЕРЕ — только на успешные ответы. Ошибки не кэшируем,
      // чтобы client-side retry реально уходил в сеть.
      if (upstream.status >= 200 && upstream.status < 300) {
        headers.set('Cache-Control', 'public, max-age=600');
      } else {
        headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
        headers.set('Pragma', 'no-cache');
        headers.set('Expires', '0');
      }

      return new Response(upstream.body, {status: upstream.status, headers});
    } catch (e) {
      return new Response('Upstream error: ' + (e.message || String(e)), {
        status: 502,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'
        }
      });
    }
  }
};
