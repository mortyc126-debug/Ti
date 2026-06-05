// Cloudflare Worker — CORS-прокси для T-Invest (T-Bank) API
//
// Зачем: браузер не может напрямую обращаться к invest-public-api.tinkoff.ru
// из-за CORS / HTTP2-ограничений. Worker пересылает POST-запросы к API
// и добавляет CORS-заголовки.
//
// Развёртывание (бесплатно, 5 минут):
//   1. dash.cloudflare.com → Workers & Pages → Create Worker
//   2. Дайте имя, например `tinvest-proxy`
//   3. Edit code → вставьте этот файл → Deploy
//   4. Скопируйте URL вида https://tinvest-proxy.<account>.workers.dev
//   5. В OI Signal вставьте этот URL в поле «T-Invest прокси»
//
// Безопасность: Worker не хранит токены. Authorization-заголовок
// передаётся напрямую от браузера → Worker → T-Invest API.

const TBASE = 'https://invest-public-api.tinkoff.ru/rest';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400'
};

export default {
  async fetch(req) {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (req.method !== 'POST') {
      return new Response('Only POST allowed', { status: 405, headers: CORS });
    }

    // Путь запроса = имя сервиса T-Invest, например:
    // /tinkoff.public.invest.api.contract.v1.MarketDataService/GetCandles
    const url = new URL(req.url);
    const target = TBASE + url.pathname;

    // Разрешаем только T-Invest API пути
    if (!url.pathname.startsWith('/tinkoff.public.invest.api.contract.v')) {
      return new Response('Only T-Invest API paths allowed', { status: 403, headers: CORS });
    }

    try {
      const body = await req.text();
      const authHeader = req.headers.get('Authorization') || '';

      const upstream = await fetch(target, {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body
      });

      const respBody = await upstream.text();
      const respHeaders = new Headers(CORS);
      respHeaders.set('Content-Type', upstream.headers.get('Content-Type') || 'application/json');

      return new Response(respBody, { status: upstream.status, headers: respHeaders });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 502,
        headers: { ...CORS, 'Content-Type': 'application/json' }
      });
    }
  }
};
