// Cloudflare Worker — CORS-прокси для T-Invest (T-Bank) API
//
// Поддерживает два режима:
//
// 1. Прозрачный POST-прокси (для OI Signal):
//    POST /<путь T-Invest API> — пересылает запрос как есть.
//    Пример: POST /tinkoff.public.invest.api.contract.v1.MarketDataService/GetCandles
//
// 2. Высокоуровневые GET-маршруты (для Trading P&L Dashboard):
//    GET /accounts            → список счетов [{id, name}]
//    GET /sync?accountId=X&from=YYYY-MM-DD  → операции в формате entries
//
// Развёртывание (бесплатно, 5 минут):
//   1. dash.cloudflare.com → Workers & Pages → Create Worker
//   2. Дайте имя, например `tinvest-proxy`
//   3. Edit code → вставьте этот файл → Deploy
//   4. Скопируйте URL вида https://tinvest-proxy.<account>.workers.dev
//   5. В OI Signal / Trading P&L вставьте этот URL в поле «T-Invest прокси»
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

const CORS_JSON = { ...CORS, 'Content-Type': 'application/json' };

// MoneyValue {units: string, nano: number} → number
function moneyVal(m) {
  if (!m) return 0;
  return (parseInt(m.units || '0', 10) + (m.nano || 0) / 1e9);
}

async function tiPost(path, body, auth) {
  const r = await fetch(TBASE + path, {
    method: 'POST',
    headers: { 'Authorization': auth, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body)
  });
  return r.json();
}

// GET /accounts → [{id, name}]
async function handleAccounts(auth) {
  const data = await tiPost('/tinkoff.public.invest.api.contract.v1.UsersService/GetAccounts', {}, auth);
  if (data.code || data.message) throw new Error(data.message || 'API error');
  const accounts = (data.accounts || []).map(a => ({ id: a.id, name: a.name || a.id }));
  return new Response(JSON.stringify(accounts), { status: 200, headers: CORS_JSON });
}

// Постраничный сбор операций за период
async function fetchOps(accountId, from, to, auth) {
  let cursor = '';
  let items = [];
  for (let i = 0; i < 30; i++) {
    const body = { accountId, from, to, limit: 1000 };
    if (cursor) body.cursor = cursor;
    const data = await tiPost(
      '/tinkoff.public.invest.api.contract.v1.OperationsService/GetOperationsByCursor',
      body, auth
    );
    if (data.code || data.message) throw new Error(data.message || 'API error');
    items = items.concat(data.items || []);
    if (!data.hasNext || !data.nextCursor) break;
    cursor = data.nextCursor;
  }
  return items;
}

// GET /sync?accountId=X&from=YYYY-MM-DD
// P&L считается методом FIFO: продал − себестоимость по FIFO.
// Чтобы иметь базис для позиций, открытых до from, запрашиваем BUY-историю
// на 2 года назад относительно from.
async function handleSync(url, auth) {
  const accountId = url.searchParams.get('accountId');
  if (!accountId) return new Response(JSON.stringify({ error: 'accountId required' }), { status: 400, headers: CORS_JSON });

  const fromStr = url.searchParams.get('from');
  const userFrom = fromStr ? fromStr : new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  const to = new Date().toISOString();

  const allItems = await fetchOps(accountId, userFrom + 'T00:00:00Z', to, auth);

  // Сортируем хронологически для FIFO
  allItems.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  // FIFO-очереди себестоимости: figi → [{qty, costPerUnit}]
  const positions = {};

  // Накапливаем готовые entry-записи (только для дат >= userFrom)
  const tradeMap = {};   // "date|name" → pnl (суммируем несколько sell в один день)
  const otherEntries = [];

  for (const op of allItems) {
    const opType = op.type || '';
    const figi = op.figi || op.instrumentUid || 'unknown';
    const qty = parseFloat(op.quantity || '0');
    const payment = moneyVal(op.payment);
    const date = op.date ? op.date.slice(0, 10) : '';
    const name = op.name || figi;
    const afterFrom = date >= userFrom;

    if (opType.includes('BUY') && qty > 0) {
      // Пополняем FIFO-очередь: цена покупки = |payment| / qty
      if (!positions[figi]) positions[figi] = [];
      positions[figi].push({ qty, costPerUnit: Math.abs(payment) / qty });

    } else if (opType.includes('SELL') && qty > 0) {
      // FIFO: вычитаем из очереди и считаем себестоимость
      let remaining = qty;
      let cost = 0;
      const lots = positions[figi] || [];
      while (remaining > 0 && lots.length > 0) {
        const lot = lots[0];
        const used = Math.min(lot.qty, remaining);
        cost += used * lot.costPerUnit;
        lot.qty -= used;
        remaining -= used;
        if (lot.qty <= 0) lots.shift();
      }
      // Для части без известного базиса (remaining > 0) просто не учитываем
      const matched = qty - remaining;
      if (afterFrom && matched > 0) {
        const pnl = payment * (matched / qty) - cost;
        const key = date + '|' + name;
        tradeMap[key] = (tradeMap[key] || { date, position: name, pnl: 0 });
        tradeMap[key].pnl += pnl;
      }

    } else if (afterFrom && (opType.includes('DIVIDEND') || opType.includes('COUPON') || opType.includes('BOND_REPAYMENT'))) {
      otherEntries.push({ date, position: name, pnl: payment, type: 'dividend', note: '' });

    } else if (afterFrom && (opType.includes('BROKER_FEE') || opType.includes('SERVICE_FEE') || opType.includes('MARGIN_FEE') || opType.includes('TAX'))) {
      otherEntries.push({ date, position: name, pnl: payment, type: 'fee', note: '' });
    }
  }

  let idx = 0;
  const tradeEntries = Object.values(tradeMap).map(e => ({
    id: ++idx, date: e.date, position: e.position,
    pnl: Math.round(e.pnl * 100) / 100, type: 'trade', note: ''
  }));
  const entries = [
    ...tradeEntries,
    ...otherEntries.map(e => ({ id: ++idx, ...e, pnl: Math.round(e.pnl * 100) / 100 }))
  ].sort((a, b) => a.date.localeCompare(b.date));

  // Стоимость портфеля
  let portfolioValue = null;
  try {
    const pd = await tiPost(
      '/tinkoff.public.invest.api.contract.v1.OperationsService/GetPortfolio',
      { accountId, currency: 'RUB' }, auth
    );
    portfolioValue = moneyVal(pd.totalAmountPortfolio);
  } catch (_) {}

  return new Response(
    JSON.stringify({ entries, portfolioValue, syncedAt: new Date().toISOString() }),
    { status: 200, headers: CORS_JSON }
  );
}

export default {
  async fetch(req) {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(req.url);
    const auth = req.headers.get('Authorization') || '';

    // ── Высокоуровневые GET-маршруты для Trading P&L ──────────────────────────
    if (req.method === 'GET') {
      try {
        if (url.pathname === '/accounts') return await handleAccounts(auth);
        if (url.pathname === '/sync') return await handleSync(url, auth);
        return new Response('Unknown route', { status: 404, headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: CORS_JSON });
      }
    }

    // ── POST-прокси для OI Signal (прозрачная пересылка) ──────────────────────
    if (req.method !== 'POST') {
      return new Response('Only POST or GET allowed', { status: 405, headers: CORS });
    }

    if (!url.pathname.startsWith('/tinkoff.public.invest.api.contract.v')) {
      return new Response('Only T-Invest API paths allowed', { status: 403, headers: CORS });
    }

    try {
      const body = await req.text();
      const upstream = await fetch(TBASE + url.pathname, {
        method: 'POST',
        headers: {
          'Authorization': auth,
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
        headers: CORS_JSON
      });
    }
  }
};
