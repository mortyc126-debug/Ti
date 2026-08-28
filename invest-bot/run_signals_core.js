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
// stdout: {scores: {methodId: [score|null,...]}, brackets: {methodId: [{take,stop}|null,...]}}
//   Второе поле — методы, у которых свой брекет per-signal (ema200_revert:
//   тейк подгоняется под "доехать до EMA200", дефолтный 1.5/0.75 не подходит).
'use strict';
global.window = global;
require(require('path').join(__dirname, '..', 'tv-signals-extension', 'signals-core.js'));

const fs = require('fs');
const bars = JSON.parse(fs.readFileSync(0, 'utf8'));
const SC = global.window.SignalsCore;
const scores = {}, brackets = {};
for (const id of SC.IDS) {
  const fn = SC.methods[id];
  let series;
  try { series = fn(bars); } catch (e) { series = bars.map(() => null); }
  scores[id] = series;
  if (fn.brackets) brackets[id] = fn.brackets; // метод заполняет свой брекет
}
process.stdout.write(JSON.stringify({ scores, brackets }));
