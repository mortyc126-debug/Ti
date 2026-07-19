/* agree_scan.js — рейтинг «согласий»: какие методы расширения при совпадении
 * направления дают лучший edge. Гоняет РЕАЛЬНЫЕ методы signals-core.js по всем
 * тикерам candle_cache (invest-bot), меряет exp сделки при co-fire.
 *
 * Запуск (из папки tv-signals-extension):
 *   node agree_scan.js ../invest-bot/data/candle_cache --liquid
 *   node agree_scan.js <candle_dir> --take 2 --stop 1 --cost 0.05 --min-n 300 --top 25
 */
'use strict';
const fs = require('fs');
const path = require('path');
global.window = {};
require('./signals-core.js');
const SC = global.window.SignalsCore;

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : def; }
function has(name) { return process.argv.indexOf('--' + name) > 0; }

const dir = process.argv[2];
if (!dir || !fs.existsSync(dir)) { console.error('укажи путь к candle_cache'); process.exit(1); }
const TAKE = +arg('take', 2.0), STOP = +arg('stop', 1.0), COST = +arg('cost', 0.05);
const HOR = +arg('horizon', 12), MINN = +arg('min-n', 300), TOP = +arg('top', 25);
const liquid = has('liquid');
const NOOV = has('no-overlap');          // строго: одна позиция на метод/пару, без перекрытия
const SPLIT = arg('split-date', null);   // OOS: строки времени лексикографически ("YYYY-MM-DD ...")

const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.endsWith('_1m.json'));
// ликвид-терциль по медианному обороту
let use = files;
if (liquid) {
  const liq = [];
  for (const f of files) {
    try { const r = JSON.parse(fs.readFileSync(path.join(dir, f))); if (!Array.isArray(r) || r.length < 300) continue;
      const tos = r.map(x => (+x.volume) * (+x.close)).filter(x => isFinite(x) && x > 0);
      if (tos.length) { tos.sort((a, b) => a - b); liq.push([f, tos[tos.length >> 1]]); }
    } catch (e) {}
  }
  liq.sort((a, b) => a[1] - b[1]);
  const keep = new Set(liq.slice(Math.floor(liq.length * 2 / 3)).map(x => x[0]));
  use = files.filter(f => keep.has(f));
}
console.error(`тикеров: ${use.length}, брекет ${TAKE}/${STOP}, cost ${COST}, горизонт ${HOR}`);

// ── проход 1: загрузка + рыночный индекс для breadth (fade/zonefade) ──
const cache = {};
const byTs = {};
for (const f of use) {
  let rows; try { rows = JSON.parse(fs.readFileSync(path.join(dir, f))); } catch (e) { continue; }
  if (!Array.isArray(rows) || rows.length < 300) continue;
  rows.sort((a, b) => String(a.time) < String(b.time) ? -1 : 1);
  const bars = rows.map(r => ({ time: r.time, open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +r.volume }));
  cache[f] = bars;
  for (let i = 3; i < bars.length; i++) { const b = bars[i - 3].close; if (b > 0) (byTs[bars[i].time] || (byTs[bars[i].time] = [])).push(bars[i].close / b - 1); }
}
const median = a => { a = a.slice().sort((x, y) => x - y); return a[a.length >> 1]; };
const market = new Map(); const absv = [];
for (const ts in byTs) { const m = median(byTs[ts]); market.set(ts, m); absv.push(Math.abs(m)); }
const medAbs = absv.length ? median(absv) : 0;
if (SC.setBreadth) SC.setBreadth(market, medAbs);

const IDS = SC.IDS;
// аккумуляторы: single[id] / pair["a+b"] → train/test {sum, win, n}
const single = {}, pair = {};
const mk = () => ({ tr: { s: 0, w: 0, n: 0 }, te: { s: 0, w: 0, n: 0 } });
IDS.forEach(id => single[id] = mk());
const bump = (o, k, pnl, te) => { const c = o[k] || (o[k] = mk()); const g = te ? c.te : c.tr; g.s += pnl; g.w += pnl > 0 ? 1 : 0; g.n++; };

// исход одной сделки от i в направлении dir → {pnl, exit}. Тейк/стоп в ATR (стоп первым), тайм-выход.
function outcome(bars, atr, i, dir) {
  const a0 = atr[i]; if (a0 == null || a0 <= 0) return null;
  const entry = bars[i].close, tp = entry + dir * TAKE * a0, sl = entry - dir * STOP * a0;
  const lim = Math.min(i + HOR, bars.length - 1); let px = bars[lim].close, ex = lim;
  for (let j = i + 1; j <= lim; j++) {
    if (dir > 0) { if (bars[j].low <= sl) { px = sl; ex = j; break; } if (bars[j].high >= tp) { px = tp; ex = j; break; } }
    else { if (bars[j].high >= sl) { px = sl; ex = j; break; } if (bars[j].low <= tp) { px = tp; ex = j; break; } }
  }
  return { pnl: dir * (px - entry) / a0 - COST, exit: ex };
}

let nTk = 0;
for (const f in cache) {
  const bars = cache[f]; if (bars.length < 100) continue;
  const atr = SC.atr(bars, 14);
  let comp; try { comp = SC.computeAll(bars, HOR); } catch (e) { continue; }
  const ser = {}; IDS.forEach(id => ser[id] = comp[id] ? comp[id].series : null);
  nTk++;
  const n = bars.length;
  const outL = new Array(n), outS = new Array(n);
  const busy = {};                        // no-overlap: key → бар, до которого занято
  for (let i = HOR; i < n - HOR; i++) {
    const fired = [];
    for (const id of IDS) { const v = ser[id] ? ser[id][i] : 0; if (v) fired.push([id, v > 0 ? 1 : -1]); }
    if (!fired.length) continue;
    if (outL[i] === undefined) { outL[i] = outcome(bars, atr, i, 1); outS[i] = outcome(bars, atr, i, -1); }
    const get = sg => sg > 0 ? outL[i] : outS[i];
    const te = SPLIT != null && String(bars[i].time) >= SPLIT;
    const take = (o, key, r) => {                        // учесть сделку с no-overlap по ключу
      if (r == null) return;
      if (NOOV && busy[key] != null && i <= busy[key]) return;
      bump(o, key, r.pnl, te);
      if (NOOV) busy[key] = r.exit;
    };
    for (const [id, sg] of fired) take(single, id, get(sg));
    for (let x = 0; x < fired.length; x++) for (let y = x + 1; y < fired.length; y++) {
      if (fired[x][1] !== fired[y][1]) continue;         // согласие по знаку
      const k = fired[x][0] < fired[y][0] ? fired[x][0] + '+' + fired[y][0] : fired[y][0] + '+' + fired[x][0];
      take(pair, k, get(fired[x][1]));
    }
  }
}

const seg = c => (SPLIT != null ? c.te : c.tr);            // сегмент для ранжирования (TEST при сплите)
function rows(o) {
  return Object.keys(o).map(k => { const g = seg(o[k]), tr = o[k].tr;
    return { k, exp: g.n ? g.s / g.n : 0, win: g.n ? g.w / g.n : 0, n: g.n,
             tr_exp: tr.n ? tr.s / tr.n : 0, tr_n: tr.n }; })
    .filter(r => r.n >= MINN).sort((a, b) => b.exp - a.exp);
}
const fmt = r => `exp=${r.exp >= 0 ? '+' : ''}${r.exp.toFixed(4)}  win=${(100 * r.win).toFixed(1)}%  n=${r.n}` +
  (SPLIT != null ? `   (TRAIN ${r.tr_exp >= 0 ? '+' : ''}${r.tr_exp.toFixed(4)} n=${r.tr_n})` : '');
const segName = SPLIT != null ? `TEST≥${SPLIT}` : 'ВСЕ';
console.log(`\nтикеров обработано: ${nTk}  ·  ${NOOV ? 'no-overlap' : 'overlap'}  ·  сегмент ${segName}\n`);
console.log(`=== ОДИНОЧНЫЕ методы (${segName}, по убыванию exp) ===`);
for (const r of rows(single)) console.log(`  ${r.k.padEnd(16)} ${fmt(r)}`);
const pr = rows(pair);
console.log(`\n=== ТОП-${TOP} СОГЛАСИЙ пар (${segName}) ===`);
for (const r of pr.slice(0, TOP)) console.log(`  ${r.k.padEnd(34)} ${fmt(r)}`);
console.log(`\nвсего пар с n>=${MINN}: ${pr.length}. Строго: --no-overlap --split-date.`);
console.log('Согласие ценно, только если exp пары выше exp каждого метода по отдельности И держится на TRAIN и TEST.');
