// Дневная история цен бумаги с MOEX ISS (для ряда стоимости портфеля).
// Тот же открытый источник, что bondization/spreadsOfz. Для облигаций берём
// LEGALCLOSEPRICE (% от номинала) или CLOSE; для акций — CLOSE. Кэш в
// localStorage (история за прошлые дни не меняется).

const ISS = 'https://iss.moex.com/iss';
const CACHE = 'ba_px_hist_v1';
const TTL = 18 * 3600e3;

function _cacheGet(){ try { return JSON.parse(localStorage.getItem(CACHE) || '{}'); } catch(_){ return {}; } }
function _cacheSet(m){ try { localStorage.setItem(CACHE, JSON.stringify(m)); } catch(_){} }
const _num = v => (v == null || v === '' || !isFinite(+v)) ? null : +v;

function _block(b){ const ci = {}; (b && b.columns || []).forEach((c, i) => { ci[c] = i; }); return { ci, rows: (b && b.data) || [] }; }

// → [{date, close}] по SECID за окно [from, till] (ISO-даты). Облигации:
// cе№ цена в % номинала (для риск-метрик важна только динамика, не масштаб).
export async function fetchPriceHistory(secid, from, till){
  const key = String(secid || '').toUpperCase();
  if(!key) return [];
  const ck = key + '|' + from + '|' + till;
  const cache = _cacheGet();
  const hit = cache[ck];
  if(hit && Date.now() - hit.ts < TTL) return hit.data;
  const url = ISS + '/history/engines/stock/markets/bonds/securities/' + encodeURIComponent(key) +
    '.json?iss.meta=off&iss.only=history&history.columns=TRADEDATE,CLOSE,LEGALCLOSEPRICE&from=' +
    from + '&till=' + till + '&limit=100&sort_column=TRADEDATE&sort_order=desc';
  try {
    let d = await (await fetch(url)).json();
    let { ci, rows } = _block(d && d.history);
    // Если на доске облигаций пусто — пробуем доску акций (вдруг это акция).
    if(!rows.length){
      const url2 = ISS + '/history/engines/stock/markets/shares/securities/' + encodeURIComponent(key) +
        '.json?iss.meta=off&iss.only=history&history.columns=TRADEDATE,CLOSE,LEGALCLOSEPRICE&from=' +
        from + '&till=' + till + '&limit=100&sort_column=TRADEDATE&sort_order=desc';
      d = await (await fetch(url2)).json(); ({ ci, rows } = _block(d && d.history));
    }
    const out = [];
    for(const r of rows){
      const date = r[ci.TRADEDATE];
      const close = _num(r[ci.LEGALCLOSEPRICE]) ?? _num(r[ci.CLOSE]);
      if(date && close != null && close > 0) out.push({ date, close });
    }
    out.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    cache[ck] = { ts: Date.now(), data: out };
    _cacheSet(cache);
    return out;
  } catch(_){ return hit ? hit.data : []; }
}

// Собрать ряд стоимости портфеля из позиций с историей цен.
// positions: [{secid, qty, hist:[{date,close}]}] → [{date, val}] по общим датам.
// Цена бумаги берётся на дату (bond close в % → множим на qty — масштаб не важен
// для метрик, важна совместная динамика). Пропуски тянем предыдущим значением.
export function buildPortfolioSeries(positions){
  const dateSet = new Set();
  for(const p of positions) for(const h of (p.hist || [])) dateSet.add(h.date);
  const dates = [...dateSet].sort();
  if(!dates.length) return [];
  // быстрый доступ: secid → map(date→close)
  const maps = positions.map(p => {
    const m = new Map(); for(const h of (p.hist || [])) m.set(h.date, h.close); return { qty: p.qty || 0, m };
  });
  const out = [];
  const last = new Array(maps.length).fill(null);
  for(const d of dates){
    let val = 0, haveAny = false;
    for(let i = 0; i < maps.length; i++){
      const c = maps[i].m.get(d);
      if(c != null) last[i] = c;
      if(last[i] != null){ val += last[i] * maps[i].qty; haveAny = true; }
    }
    if(haveAny) out.push({ date: d, val });
  }
  return out;
}
