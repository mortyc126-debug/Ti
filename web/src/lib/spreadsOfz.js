// Спред корпоративных бумаг к ОФЗ (G-spread) и его динамика за период:
// сужение/расширение. Всё считается в браузере из открытого MOEX ISS
// (CORS ок, тот же источник, что bondization.js) — бэкенд не нужен.
//
// Идея: спред = доходность бумаги − доходность ОФЗ той же дюрации. ОФЗ-кривую
// на дату строим из реальных ОФЗ-ПД (их YIELDCLOSE/DURATION), интерполируя по
// дюрации. Берём две точки — начало и конец выбранного окна — и смотрим, как
// изменился спред (в базисных пунктах). Δ<0 — сужение (рынок доверяет больше),
// Δ>0 — расширение (риск-премия выросла).

import { loadBondization } from './bondization.js';

const ISS = 'https://iss.moex.com/iss';

// columns[]/data[] → {ci:{col:idx}, rows:[...]}  (как _block в bondization.js)
function _block(b){
  const ci = {}; (b && b.columns || []).forEach((c, i) => { ci[c] = i; });
  return { ci, rows: (b && b.data) || [] };
}
const _num = v => (v == null || v === '' || !isFinite(+v)) ? null : +v;

// ── Кэш истории доходностей (меняется раз в день) ─────────────────────
const HIST_CACHE = 'ba_ofz_spread_hist_v1';
const HIST_TTL = 18 * 3600e3;   // ~день
function _histCacheGet(){ try { return JSON.parse(localStorage.getItem(HIST_CACHE) || '{}'); } catch(_){ return {}; } }
function _histCacheSet(m){ try { localStorage.setItem(HIST_CACHE, JSON.stringify(m)); } catch(_){} }

// История [{date, y (доходность %), dur (дюрация, дни)}] по SECID за окно.
// Один эндпоинт на всё — и для ОФЗ, и для корпоратов (единый разбор).
async function fetchYieldHistory(secid, from, till){
  const key = String(secid || '').toUpperCase();
  if(!key) return [];
  const ck = key + '|' + from + '|' + till;
  const cache = _histCacheGet();
  const hit = cache[ck];
  if(hit && Date.now() - hit.ts < HIST_TTL) return hit.data;
  const url = ISS + '/history/engines/stock/markets/bonds/securities/' + encodeURIComponent(key) +
    '.json?iss.meta=off&iss.only=history&history.columns=TRADEDATE,YIELDCLOSE,DURATION&from=' +
    from + '&till=' + till + '&limit=100&sort_column=TRADEDATE&sort_order=desc';
  try {
    const r = await fetch(url);
    if(!r.ok) return [];
    const d = await r.json();
    const { ci, rows } = _block(d && d.history);
    const out = [];
    for(const row of rows){
      const date = row[ci.TRADEDATE];
      const y = _num(row[ci.YIELDCLOSE]);
      const dur = _num(row[ci.DURATION]);
      if(date && y != null && y > 0 && dur != null && dur > 0) out.push({ date, y, dur });
    }
    out.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    cache[ck] = { ts: Date.now(), data: out };
    _histCacheSet(cache);
    return out;
  } catch(_){ return []; }
}

// Первая и последняя валидная точки в окне [from, till].
function _firstLast(series, from, till){
  const inWin = series.filter(p => p.date >= from && p.date <= till);
  if(inWin.length < 1) return null;
  return { start: inWin[0], end: inWin[inWin.length - 1] };
}

// ── Список эталонных ОФЗ-ПД (фикс) с биржи ────────────────────────────
// Берём живые SECID с доски ОФЗ (TQOB), а не хардкодим суффиксы RMFSx.
// Только ОФЗ-ПД (SU26*) — постоянный купон; флоатеры (SU29*) и линкеры
// (SU52*) в бенчмарк не годятся.
let _ofzListCache = null;
async function fetchOfzList(){
  if(_ofzListCache) return _ofzListCache;
  try {
    const r = await fetch(ISS + '/engines/stock/markets/bonds/boards/TQOB/securities.json' +
      '?iss.meta=off&iss.only=securities&securities.columns=SECID,SECNAME,MATDATE');
    if(!r.ok) return [];
    const d = await r.json();
    const { ci, rows } = _block(d && d.securities);
    const list = rows.map(row => ({
      secid: String(row[ci.SECID] || '').toUpperCase(),
      mat: row[ci.MATDATE] || null,
    })).filter(x => /^SU26/.test(x.secid));
    // Прорежаем по сроку погашения, чтобы кривая покрывала весь диапазон
    // (до 12 эталонов хватает для интерполяции и не грузит сеть).
    list.sort((a, b) => String(a.mat) < String(b.mat) ? -1 : 1);
    const N = 12, step = Math.max(1, Math.floor(list.length / N));
    const pick = []; for(let i = 0; i < list.length && pick.length < N; i += step) pick.push(list[i]);
    _ofzListCache = pick;
    return pick;
  } catch(_){ return []; }
}

// Линейная интерполяция доходности ОФЗ по дюрации из набора точек
// [{dur, y}] (дюрация в тех же единицах, что у бумаги — днях MOEX).
function _interpYield(points, dur){
  const pts = points.filter(p => p.dur != null && p.y != null).sort((a, b) => a.dur - b.dur);
  if(pts.length < 2) return pts.length === 1 ? pts[0].y : null;
  if(dur <= pts[0].dur) return pts[0].y;
  if(dur >= pts[pts.length - 1].dur) return pts[pts.length - 1].y;
  for(let i = 1; i < pts.length; i++){
    if(dur <= pts[i].dur){
      const a = pts[i - 1], b = pts[i];
      const t = (dur - a.dur) / (b.dur - a.dur);
      return a.y + t * (b.y - a.y);
    }
  }
  return pts[pts.length - 1].y;
}

// Точка ОФЗ-кривой на конкретную дату из историй эталонов: у каждого ОФЗ
// берём запись с датой, ближайшей на эту дату или раньше.
function _ofzCurveAt(ofzSeriesList, date){
  const pts = [];
  for(const s of ofzSeriesList){
    let best = null;
    for(const p of s){ if(p.date <= date){ best = p; } else break; }
    if(!best && s.length) best = s[0];   // окно начинается до первой торговли — берём первую
    if(best) pts.push({ dur: best.dur, y: best.y });
  }
  return pts;
}

// Классификатор фикс/флоатер через bondization: у флоатера будущие купоны
// ещё не определены (rate=null). Используем общий кэш loadBondization.
async function classifyFloater(secid){
  try {
    const b = await loadBondization(secid);
    if(!b || !b.events) return false;
    const today = new Date().toISOString().slice(0, 10);
    const future = b.events.filter(e => e.type === 'coupon' && e.date > today);
    if(future.length < 2) return false;
    const unknown = future.filter(e => e.rate == null).length;
    return unknown >= 2;   // ≥2 неизвестных будущих купона → плавающий
  } catch(_){ return false; }
}

// ── Главный расчёт ────────────────────────────────────────────────────
// bonds: [{secid, name, issuer}] — корпоративные бумаги (ОФЗ исключать).
// Возвращает { ok, rows, ofzPointsStart, ofzPointsEnd, note }.
// row: {secid,name,issuer,isFloater,durY,yStart,yEnd,ofzStart,ofzEnd,
//       spreadStart,spreadEnd,delta}  (доходности/спреды в % ; delta в б.п.)
export async function computeSpreadChange(bonds, from, till, onProgress){
  const out = { ok: false, rows: [], note: '' };
  const ofzMeta = await fetchOfzList();
  if(!ofzMeta.length){ out.note = 'не удалось получить список ОФЗ с биржи'; return out; }

  // Истории ОФЗ-эталонов (пул).
  const ofzSeries = [];
  await _pool(ofzMeta, 6, async m => {
    const s = await fetchYieldHistory(m.secid, from, till);
    if(s.length) ofzSeries.push(s);
  });
  if(ofzSeries.length < 2){ out.note = 'мало данных по ОФЗ за период для построения кривой'; return out; }

  const ptsStart = _ofzCurveAt(ofzSeries, from);
  const ptsEnd = _ofzCurveAtLatest(ofzSeries, from, till);
  out.ofzPointsStart = ptsStart.length; out.ofzPointsEnd = ptsEnd.length;

  // Корпоративные бумаги.
  let done = 0;
  const rows = [];
  await _pool(bonds, 6, async b => {
    const secid = String(b.secid || '').toUpperCase();
    if(secid){
      const hist = await fetchYieldHistory(secid, from, till);
      const fl = _firstLast(hist, from, till);
      if(fl){
        const isFloater = await classifyFloater(secid);
        const ofzStart = _interpYield(ptsStart, fl.start.dur);
        const ofzEnd   = _interpYield(ptsEnd, fl.end.dur);
        if(ofzStart != null && ofzEnd != null){
          const spreadStart = fl.start.y - ofzStart;
          const spreadEnd   = fl.end.y - ofzEnd;
          rows.push({
            secid, name: b.name || secid, issuer: b.issuer || '',
            isFloater,
            durY: fl.end.dur / 365,
            yStart: fl.start.y, yEnd: fl.end.y,
            ofzStart, ofzEnd,
            spreadStart, spreadEnd,
            delta: (spreadEnd - spreadStart) * 100,   // в базисных пунктах
            dStart: fl.start.date, dEnd: fl.end.date,
          });
        }
      }
    }
    done++; if(onProgress) try { onProgress(done, bonds.length); } catch(_){}
  });

  rows.sort((a, b) => a.delta - b.delta);   // сужения сверху
  out.ok = rows.length > 0;
  out.rows = rows;
  if(!rows.length) out.note = 'нет бумаг с историей доходности за выбранный период';
  return out;
}

// Кривая ОФЗ на конец окна: у каждого эталона берём последнюю запись в окне.
function _ofzCurveAtLatest(ofzSeriesList, from, till){
  const pts = [];
  for(const s of ofzSeriesList){
    let best = null;
    for(const p of s){ if(p.date >= from && p.date <= till) best = p; }
    if(best) pts.push({ dur: best.dur, y: best.y });
  }
  return pts;
}

// Простой пул ограниченной конкурентности.
async function _pool(items, conc, worker){
  let i = 0;
  async function run(){ while(i < items.length){ const it = items[i++]; await worker(it); } }
  await Promise.all(Array.from({ length: Math.min(conc, items.length || 1) }, run));
}

// Пресеты периодов → {from, till} (till = сегодня).
export function presetRange(key){
  const till = new Date();
  const from = new Date(till);
  if(key === '1m') from.setMonth(from.getMonth() - 1);
  else if(key === '3m') from.setMonth(from.getMonth() - 3);
  else if(key === '6m') from.setMonth(from.getMonth() - 6);
  else if(key === '1y') from.setFullYear(from.getFullYear() - 1);
  else if(key === 'ytd'){ from.setMonth(0); from.setDate(1); }
  const fmt = d => d.toISOString().slice(0, 10);
  return { from: fmt(from), till: fmt(till) };
}

// Средний Δспреда (б.п.) по группе — для сводки сужение/расширение.
export function avgDelta(rows){
  const v = rows.map(r => r.delta).filter(x => isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
