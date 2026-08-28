// run_signals_core.js — CLI-мост: bars(JSON, stdin) → сигналы SignalsCore →
// JSON(stdout). Единственная причина существования: чтобы Python-бэктест
// (elite_preset_validate.py) считал сигналы ТЕМИ ЖЕ формулами, что живое
// расширение (tv-signals-extension/signals-core.js), без повторного набора
// логики методов в Python — signals-core.js "чистый модуль" (комментарий в
// его шапке), завязан только на window.*, DOM не трогает.
//
// stdin: [{time,open,high,low,close,volume}, ...] по возрастанию времени.
// argv[2]: horizon (для встроенного btStats, тут не используется — Python
//   считает свой bt_stats на train/test срезах серии).
// stdout: {methodId: [score|null, ...]} — по одной серии на метод IDS.
'use strict';
global.window = global;
require(require('path').join(__dirname, '..', 'tv-signals-extension', 'signals-core.js'));

const fs = require('fs');
const bars = JSON.parse(fs.readFileSync(0, 'utf8'));
const SC = global.window.SignalsCore;
const out = {};
for (const id of SC.IDS) {
  let series;
  try { series = SC.methods[id](bars); } catch (e) { series = bars.map(() => null); }
  out[id] = series;
}
process.stdout.write(JSON.stringify(out));
