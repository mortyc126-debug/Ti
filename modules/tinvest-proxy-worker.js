// Cloudflare Worker — CORS-прокси для T-Invest (T-Bank) API
//
// Поддерживает два режима:
//
// 1. Прозрачный POST-прокси (для OI Signal):
//    POST /<путь T-Invest API> — пересылает запрос как есть.
//
// 2. Высокоуровневые GET-маршруты (для Trading P&L Dashboard):
//    GET /accounts            → список счетов [{id, name}]
//    GET /sync?accountId=X&from=YYYY-MM-DD  → операции в формате entries
//
// Развёртывание:
//   1. dash.cloudflare.com → Workers & Pages → Create Worker
//   2. Edit code → вставьте этот файл → Deploy
//   3. Скопируйте URL и вставьте в поле «T-Invest прокси»

const TBASE = 'https://invest-public-api.tinkoff.ru/rest';
const WORKER_VERSION = 'v11';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400'
};
const CORS_JSON = { ...CORS, 'Content-Type': 'application/json' };

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

async function handleAccounts(auth) {
  const data = await tiPost('/tinkoff.public.invest.api.contract.v1.UsersService/GetAccounts', {}, auth);
  if (data.code || data.message) throw new Error(data.message || 'API error');
  const accounts = (data.accounts || []).map(a => ({ id: a.id, name: a.name || a.id }));
  return new Response(JSON.stringify(accounts), { status: 200, headers: CORS_JSON });
}

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

async function handleSync(url, auth) {
  const accountId = url.searchParams.get('accountId');
  if (!accountId) return new Response(JSON.stringify({ error: 'accountId required' }), { status: 400, headers: CORS_JSON });

  const fromStr = url.searchParams.get('from');
  const userFrom = fromStr ? fromStr : new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  const to = new Date().toISOString();

  // Загружаем 5 лет истории чтобы иметь FIFO-базис для позиций,
  // открытых до начала отчётного периода.
  const basisFrom = new Date(userFrom);
  basisFrom.setFullYear(basisFrom.getFullYear() - 5);
  const allItems = await fetchOps(accountId, basisFrom.toISOString().slice(0, 10) + 'T00:00:00Z', to, auth);

  allItems.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  // Типы операций
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

  // Проход 1: собираем figi фьючерсов по любому признаку.
  // Varmargin-операции приходят без instrumentType — но их figi совпадает
  // с figi BUY/SELL того же инструмента.
  const futuresFigis = new Set();
  // figi → читаемое название из BUY/SELL-операций (у varmargin name обычно пустой)
  const figiNames = {};
  for (const op of allItems) {
    const f = op.figi || op.instrumentUid || '';
    if (!f) continue;
    if (op.instrumentType === 'futures' || op.instrumentType === 'option') futuresFigis.add(f);
    if (VAR_PLUS.has(op.type || '') || VAR_MINUS.has(op.type || '')) futuresFigis.add(f);
    if (op.name && !figiNames[f]) figiNames[f] = op.name;
  }

  const longs = {}, shorts = {};
  const tradeMap = {};
  const otherEntries = [];
  const opStats = {};

  // Ключ по figi чтобы не смешивать акции и облигации одного эмитента
  function addTrade(date, name, pnl, figiKey) {
    const key = date + '|' + (figiKey || name);
    if (!tradeMap[key]) tradeMap[key] = { date, position: name, pnl: 0 };
    tradeMap[key].pnl += pnl;
  }

  function fifoConsume(queue, qty) {
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
    const rawFigi = op.figi || op.instrumentUid || '';
    const figi = rawFigi || ('_nofigi_' + opType);
    const qty = parseFloat(op.quantity || '0');
    const payment = moneyVal(op.payment);
    const opPrice = moneyVal(op.price);  // цена исполнения за единицу
    const date = op.date ? op.date.slice(0, 10) : '';
    const name = op.name || figiNames[rawFigi] || rawFigi || opType;
    const afterFrom = date >= userFrom;

    // Статистика для диагностики
    if (!opStats[opType]) opStats[opType] = { count: 0, sum: 0, instrTypes: new Set() };
    opStats[opType].count++;
    opStats[opType].sum += payment;
    opStats[opType].instrTypes.add(op.instrumentType || '?');

    // T-Invest возвращает парные settlement-компоненты: реальная сделка + adjustment
    // с payment/qty намного ниже цены исполнения. Фильтруем их из FIFO.
    if (opPrice > 0 && qty > 0 && (STOCK_BUY.has(opType) || STOCK_SELL.has(opType))) {
      const payPerUnit = Math.abs(payment) / qty;
      if (payPerUnit < opPrice * 0.6) continue;
    }

    // Вариационная маржа — реализованный P&L фьючерсов.
    // instrumentType у этих операций null, проверяем по типу операции.
    if (VAR_PLUS.has(opType) || VAR_MINUS.has(opType)) {
      // Группируем по figi если есть; иначе каждая операция отдельно (по id)
      if (afterFrom) addTrade(date, name, payment, rawFigi || op.id || (opType + '_' + op.date));

    // Фьючерсы/опционы: пропускаем BUY/SELL — реальный P&L только в varmargin.
    // Также пропускаем инструменты без figi — нельзя корректно вести FIFO.
    // Также пропускаем SELL с нулевым payment — технические операции (pre-redemption).
    } else if (futuresFigis.has(rawFigi) ||
               op.instrumentType === 'futures' || op.instrumentType === 'option' ||
               !rawFigi) {
      // skip

    } else if (STOCK_BUY.has(opType) && qty > 0) {
      if (shorts[figi] && shorts[figi].length > 0) {
        const { matched, value: proceeds } = fifoConsume(shorts[figi], qty);
        if (afterFrom && matched > 0) {
          addTrade(date, name, proceeds - Math.abs(payment) * (matched / qty), rawFigi);
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
      // Пропускаем технические продажи с нулевым payment (pre-redemption clearing)
      if (Math.abs(payment) < 0.01) continue;

      if (longs[figi] && longs[figi].length > 0) {
        const { matched, value: cost } = fifoConsume(longs[figi], qty);
        if (afterFrom && matched > 0) {
          addTrade(date, name, payment * (matched / qty) - cost, rawFigi);
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
  }

  // Сырые операции по топ-проблемным инструментам (для диагностики)
  const rawByFigi = {};
  for (const op of allItems) {
    const f = op.figi || op.instrumentUid || '';
    if (!f) continue;
    if (!rawByFigi[f]) rawByFigi[f] = [];
    rawByFigi[f].push({
      d: (op.date || '').slice(0, 10),
      t: op.type || '',
      qty: op.quantity || '0',
      pay: Math.round(moneyVal(op.payment)),
      it: op.instrumentType || '?',
      n: op.name || ''
    });
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

  let portfolioValue = null;
  try {
    const pd = await tiPost(
      '/tinkoff.public.invest.api.contract.v1.OperationsService/GetPortfolio',
      { accountId, currency: 'RUB' }, auth
    );
    portfolioValue = moneyVal(pd.totalAmountPortfolio);
  } catch (_) {}

  const debug = Object.fromEntries(
    Object.entries(opStats).map(([k, v]) => [k, {
      count: v.count, sum: Math.round(v.sum), instrTypes: [...v.instrTypes]
    }])
  );

  const sortedTrades = [...tradeEntries].sort((a, b) => a.pnl - b.pnl);
  const debugTrades = [...sortedTrades.slice(0, 5), ...sortedTrades.slice(-5)];

  // Для топ-5 худших позиций — выгружаем все сырые операции
  const worstFigis = sortedTrades.slice(0, 5).map(e => {
    const key = Object.keys(tradeMap).find(k => tradeMap[k] === Object.values(tradeMap).find(v => v.position === e.position && v.date === e.date));
    const figi = key ? key.split('|')[1] : null;
    return figi;
  }).filter(Boolean);
  const debugRaw = {};
  for (const f of worstFigis) {
    if (rawByFigi[f]) debugRaw[f] = rawByFigi[f];
  }

  return new Response(
    JSON.stringify({ entries, portfolioValue, syncedAt: new Date().toISOString(),
                     _debug: debug, _debugTrades: debugTrades, _debugRaw: debugRaw, _v: WORKER_VERSION }),
    { status: 200, headers: CORS_JSON }
  );
}

export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(req.url);
    const auth = req.headers.get('Authorization') || '';

    if (req.method === 'GET') {
      try {
        if (url.pathname === '/accounts') return await handleAccounts(auth);
        if (url.pathname === '/sync') return await handleSync(url, auth);
        return new Response('Unknown route', { status: 404, headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: CORS_JSON });
      }
    }

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
        headers: { 'Authorization': auth, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body
      });
      const respBody = await upstream.text();
      const respHeaders = new Headers(CORS);
      respHeaders.set('Content-Type', upstream.headers.get('Content-Type') || 'application/json');
      return new Response(respBody, { status: upstream.status, headers: respHeaders });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: CORS_JSON });
    }
  }
};
