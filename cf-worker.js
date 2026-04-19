// Cloudflare Worker — приватный CORS-прокси для ГИР БО (bo.nalog.gov.ru).
//
// Зачем: bo.nalog.gov.ru не отдаёт Access-Control-Allow-Origin браузеру,
// поэтому БондАналитик не может напрямую запросить отчётность по ИНН.
// Этот Worker пересылает GET-запросы к /nbo/* и /advanced-search/* на
// bo.nalog.gov.ru и добавляет в ответ нужный CORS-заголовок. Только
// bo.nalog.gov.ru — больше никаких хостов, никакой записи, никакой
// авторизации.
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
// Лимиты бесплатного плана CF Workers: 100 000 запросов/сутки
// (одно нажатие «📡 5 лет» тратит ~6 запросов). Этого хватит на
// тысячи компаний в день — заведомо больше, чем понадобится.
//
// Альтернатива: можно ничего не разворачивать, БондАналитик по умол-
// чанию использует публичный corsproxy.io. Свой Worker — для тех,
// кому важно (а) приватность (corsproxy видит ваши запросы), (б)
// надёжность (corsproxy могут отключить).

export default {
  async fetch(req) {
    const url = new URL(req.url);

    // Соглашение БондАналитика: target-URL передаётся через ?u=…
    let target = url.searchParams.get('u');

    // Альтернатива — путь повторяет /nbo/... или /advanced-search/...
    // bo.nalog.gov.ru напрямую.
    if (!target && (url.pathname.startsWith('/nbo') || url.pathname.startsWith('/advanced-search'))) {
      target = 'https://bo.nalog.gov.ru' + url.pathname + url.search;
    }

    if (!target || !/^https:\/\/bo\.nalog\.gov\.ru\//.test(target)) {
      return new Response('Allowed: bo.nalog.gov.ru only. Pass URL via ?u=https://bo.nalog.gov.ru/...', {
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
          upstream = await fetch(target, {
            method: req.method,
            headers: {
              'Accept': 'application/json',
              // Чистый Chrome UA — на случай если origin реагирует на слово
              // «Proxy» в User-Agent. Самый нейтральный фингерпринт.
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
              'Accept-Language': 'ru-RU,ru;q=0.9'
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
