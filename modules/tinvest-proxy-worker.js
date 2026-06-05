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

  // Точные типы операций (объявляем здесь — используются и в проходе 1, и в проходе 2)
  const STOCK_BUY  = new Set(['OPERATION_TYPE_BUY', 'OPERATION_TYPE_BUY_CARD', 'OPERATION_TYPE_BUY_MARGIN']);
  const STOCK_SELL = new Set(['OPERATION_TYPE_SELL', 'OPERATION_TYPE_SELL_CARD', 'OPERATION_TYPE_SELL_MARGIN']);
  const VAR_PLUS   = new Set(['OPERATION_TYPE_ACCRUING_VARMARGIN', 'OPERATION_TYPE_ACCRUING_VARMARGIN_DELIVERY']);
  const VAR_MINUS  = new Set(['OPERATION_TYPE_WRITING_OFF_VARMARGIN', 'OPERATION_TYPE_WRITING_OFF_VARMARGIN_DELIVERY']);
  const INCOME     = new Set(['OPERATION_TYPE_DIVIDEND', 'OPERATION_TYPE_COUPON',
                               'OPERATION_TYPE_BOND_REPAYMENT', 'OPERATION_TYPE_BOND_REPAYMENT_FULL',
                               'OPERATION_TYPE_DIV_EXT', 'OPERATION_TYPE_DIVIDEND_TRANSFER']);
  const FEE_TYPES  = new Set(['OPERATION_TYPE_BROKER_FEE', 'OPERATION_TYPE_SERVICE_FEE',
                               'OPERATION_TYPE_MARGIN_FEE', 'OPERATION_TYPE_OVERNIGHT',
                               'OPERATION_TYPE_BROKER_FEE_PROGRESSIVE', 'OPERATION_TYPE_SERVICE_FEE_PROGRESSIVE']);

  // Проход 1: собираем figi фьючерсов/опционов по любому признаку.
  // Varmargin-операции приходят без instrumentType — определяем фьючерс по наличию
  // varmargin-записи для того же figi, либо по явному instrumentType.
  const futuresFigis = new Set();
  for (const op of allItems) {
    const f = op.figi || op.instrumentUid || '';
    if (!f) continue;
    if (op.instrumentType === 'futures' || op.instrumentType === 'option') futuresFigis.add(f);
    if (VAR_PLUS.has(op.type || '') || VAR_MINUS.has(op.type || '')) futuresFigis.add(f);
  }

  // Два FIFO-стека на инструмент: длинные позиции и короткие
  // longs[figi]  = [{qty, costPerUnit}]   — себестоимость лонга
  // shorts[figi] = [{qty, procPerUnit}]   — выручка при открытии шорта
  const longs = {}, shorts = {};

  const tradeMap = {};  // "date|name" → {date,position,pnl}
  const otherEntries = [];
  const opStats = {};   // opType → {count, sum, instrTypes} — только для диагностики

  function addTrade(date, name, pnl) {
    const key = date + '|' + name;
    if (!tradeMap[key]) tradeMap[key] = { date, position: name, pnl: 0 };
    tradeMap[key].pnl += pnl;
  }

  function fifoConsume(queue, qty) {
    // Списывает qty лотов из FIFO, возвращает {matched, valuePerUnit}
    let remaining = qty, value = 0;
    while (remaining > 0 && queue.length > 0) {
      const lot = queue[0];
      const used = Math.min(lot.qty, remaining);
      value += used * (lot.costPerUnit || lot.procPerUnit || 0);
      lot.qty -= used;
      remaining -= used;
      if (lot.qty <= 0) queue.shift();
    }
    return { matched: qty - remaining, value };
  }


  for (const op of allItems) {
    const opType = op.type || '';
    const figi = op.figi || op.instrumentUid || 'unknown';
    const qty = parseFloat(op.quantity || '0');
    const payment = moneyVal(op.payment);
    const date = op.date ? op.date.slice(0, 10) : '';
    const name = op.name || figi;
    const afterFrom = date >= userFrom;
    // Вариационная маржа — реализованный P&L фьючерсов (instrumentType=null у этих операций)
    if (VAR_PLUS.has(opType) || VAR_MINUS.has(opType)) {
      if (afterFrom) addTrade(date, name, payment);

    // Фьючерсы/опционы: BUY/SELL пропускаем — payment там ≠ реальная стоимость сделки.
    // Проверяем по futuresFigis (собранных на проходе 1), т.к. instrumentType может быть null.
    } else if (futuresFigis.has(figi)) {
      // skip

    } else if (STOCK_BUY.has(opType) && qty > 0) {
      // Акции/облигации/ETF: FIFO — открываем лонг или закрываем шорт
      if (shorts[figi] && shorts[figi].length > 0) {
        const { matched, value: proceeds } = fifoConsume(shorts[figi], qty);
        if (afterFrom && matched > 0) {
          addTrade(date, name, proceeds - Math.abs(payment) * (matched / qty));
        }
        const longQty = qty - matched;
        if (longQty > 0) {
          if (!longs[figi]) longs[figi] = [];
          longs[figi].push({ qty: longQty, costPerUnit: Math.abs(payment) / qty });
        }
      } else {
        if (!longs[figi]) longs[figi] = [];
        longs[figi].push({ qty, costPerUnit: Math.abs(payment) / qty });
      }

    } else if (STOCK_SELL.has(opType) && qty > 0) {
      // Акции/облигации/ETF: FIFO — закрываем лонг или открываем шорт
      if (longs[figi] && longs[figi].length > 0) {
        const { matched, value: cost } = fifoConsume(longs[figi], qty);
        if (afterFrom && matched > 0) {
          addTrade(date, name, payment * (matched / qty) - cost);
        }
        const shortQty = qty - matched;
        if (shortQty > 0) {
          if (!shorts[figi]) shorts[figi] = [];
          shorts[figi].push({ qty: shortQty, procPerUnit: payment / qty });
        }
      } else {
        if (!shorts[figi]) shorts[figi] = [];
        shorts[figi].push({ qty, procPerUnit: payment / qty });
      }

    } else if (afterFrom && INCOME.has(opType)) {
      otherEntries.push({ date, position: name, pnl: payment, type: 'dividend', note: '' });

    } else if (afterFrom && FEE_TYPES.has(opType)) {
      otherEntries.push({ date, position: name, pnl: payment, type: 'fee', note: '' });
    }

    // Собираем статистику по типам для диагностики
    if (!opStats[opType]) opStats[opType] = { count: 0, sum: 0, instrTypes: new Set() };
    opStats[opType].count++;
    opStats[opType].sum += payment;
    opStats[opType].instrTypes.add(op.instrumentType || '?');
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

  // Сериализуем opStats (Set → Array для JSON)
  const debug = Object.fromEntries(
    Object.entries(opStats).map(([k, v]) => [k, {
      count: v.count,
      sum: Math.round(v.sum),
      instrTypes: [...v.instrTypes]
    }])
  );

  return new Response(
    JSON.stringify({ entries, portfolioValue, syncedAt: new Date().toISOString(), _debug: debug }),
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
