// Cloudflare Worker — приватный CORS-прокси для ГИР БО (bo.nalog.ru).
//
// Зачем: bo.nalog.ru не отдаёт Access-Control-Allow-Origin браузеру,
// поэтому БондАналитик не может напрямую запросить отчётность по ИНН.
// Этот Worker пересылает GET-запросы к /nbo/* на bo.nalog.ru и
// добавляет в ответ нужный CORS-заголовок. Только bo.nalog.ru —
// больше никаких хостов, никакой записи, никакой авторизации.
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

    // Альтернатива — путь повторяет /nbo/... bo.nalog.ru напрямую.
    if (!target && url.pathname.startsWith('/nbo')) {
      target = 'https://bo.nalog.ru' + url.pathname + url.search;
    }

    if (!target || !/^https:\/\/bo\.nalog\.ru\//.test(target)) {
      return new Response('Allowed: bo.nalog.ru only. Pass URL via ?u=https://bo.nalog.ru/...', {
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
      const upstream = await fetch(target, {
        method: req.method,
        headers: {
          'Accept': 'application/json',
          // Нейтральный User-Agent — иначе анти-бот может развернуть.
          'User-Agent': 'Mozilla/5.0 BondanProxy'
        },
        cf: {
          // Кэшируем ТОЛЬКО успешные ответы и только на стороне CF.
          // cacheEverything=true раньше приводил к тому, что CF кэшировал
          // и 522-ошибки тоже, а браузер получал их с Cache-Control:
          // max-age=600 и отдавал из disk cache 10 минут подряд —
          // retry на клиенте был бесполезен, мы даже в сеть не ходили.
          cacheTtl: 600,
          cacheTtlByStatus: { '200-299': 600, '300-599': 0 }
        }
      });

      const headers = new Headers(upstream.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.delete('Set-Cookie');
      headers.delete('Strict-Transport-Security');
      // Кэш в БРАУЗЕРЕ — только на успешные ответы. Ошибки (5xx, 4xx)
      // не кэшируем, чтобы каждый retry на клиенте реально уходил в сеть.
      // Иначе один 522 «застревал» на 10 минут в disk cache и казался
      // постоянной проблемой.
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
