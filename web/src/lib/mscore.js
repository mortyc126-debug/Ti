// Beneish M-score (модель выявления манипуляций с отчётностью).
// Из нашего снимка считаются только SGI (рост выручки), LVGI (леверидж) и
// индикативный TATA (начисления ≈ −амортизация/активы). Остальные 5 переменных
// (DSRI/GMI/AQI/DEPI/SGAI) требуют построчных данных (дебиторка, COGS, SG&A,
// ОС, амортизация) — их пользователь может ввести вручную; пока не введены,
// переменная = 1 (нейтрально), и M-score считается ИНДИКАТИВНЫМ.
//
// M = −4.84 + 0.92·DSRI + 0.528·GMI + 0.404·AQI + 0.892·SGI + 0.115·DEPI
//     − 0.172·SGAI + 4.679·TATA − 0.327·LVGI
// Порог: M > −1.78 → возможны манипуляции.

const _n = v => (v == null || v === '' || isNaN(Number(v))) ? null : Number(v);

// Доп-поля, которые нужно ввести для полного расчёта (в млн ₽, как в отчёте).
export const MSCORE_FIELDS = [
  { id: 'recv', label: 'Дебиторская задолженность' },
  { id: 'cogs', label: 'Себестоимость (COGS)' },
  { id: 'sga',  label: 'Коммерч. + управл. расходы (SG&A)' },
  { id: 'ppe',  label: 'Основные средства (ОС, нетто)' },
  { id: 'dep',  label: 'Амортизация за год' },
];

function _raw(r){
  return {
    rev: _n(r.rev), np: _n(r.np), assets: _n(r.assets), ca: _n(r.ca),
    debt: _n(r.debt), cl: _n(r.cl), ebitda: _n(r.ebitda), ebit: _n(r.ebit),
  };
}

export function computeMScore(curRow, prevRow, exC, exP){
  if(!curRow || !prevRow) return null;
  const c = _raw(curRow), p = _raw(prevRow);
  exC = exC || {}; exP = exP || {};
  const div = (a, b) => (a != null && b != null && b !== 0) ? a / b : null;

  // — считаются из снимка —
  const SGI = div(c.rev, p.rev) ?? 1;
  const levC = c.assets ? ((c.debt || 0) + (c.cl || 0)) / c.assets : null;
  const levP = p.assets ? ((p.debt || 0) + (p.cl || 0)) / p.assets : null;
  const LVGI = (levC != null && levP != null && levP !== 0) ? levC / levP : 1;
  const daC = (c.ebitda != null && c.ebit != null) ? c.ebitda - c.ebit : null;
  const TATA = (daC != null && c.assets) ? (-daC) / c.assets : 0;   // индикативный

  // — требуют ручного ввода —
  const prov = {};
  let DSRI = 1, GMI = 1, AQI = 1, DEPI = 1, SGAI = 1;
  const rrC = div(_n(exC.recv), c.rev), rrP = div(_n(exP.recv), p.rev);
  if(rrC != null && rrP != null && rrP !== 0){ DSRI = rrC / rrP; prov.DSRI = true; }
  const gmC = (_n(exC.cogs) != null && c.rev) ? (c.rev - _n(exC.cogs)) / c.rev : null;
  const gmP = (_n(exP.cogs) != null && p.rev) ? (p.rev - _n(exP.cogs)) / p.rev : null;
  if(gmC != null && gmP != null && gmC !== 0){ GMI = gmP / gmC; prov.GMI = true; }
  const aqC = (_n(exC.ppe) != null && c.assets) ? 1 - ((c.ca || 0) + _n(exC.ppe)) / c.assets : null;
  const aqP = (_n(exP.ppe) != null && p.assets) ? 1 - ((p.ca || 0) + _n(exP.ppe)) / p.assets : null;
  if(aqC != null && aqP != null && aqP !== 0){ AQI = aqC / aqP; prov.AQI = true; }
  const drC = (_n(exC.dep) != null && _n(exC.ppe) != null) ? _n(exC.dep) / (_n(exC.dep) + _n(exC.ppe)) : null;
  const drP = (_n(exP.dep) != null && _n(exP.ppe) != null) ? _n(exP.dep) / (_n(exP.dep) + _n(exP.ppe)) : null;
  if(drC != null && drP != null && drC !== 0){ DEPI = drP / drC; prov.DEPI = true; }
  const sgC = (_n(exC.sga) != null && c.rev) ? _n(exC.sga) / c.rev : null;
  const sgP = (_n(exP.sga) != null && p.rev) ? _n(exP.sga) / p.rev : null;
  if(sgC != null && sgP != null && sgP !== 0){ SGAI = sgC / sgP; prov.SGAI = true; }

  const M = -4.84 + 0.92 * DSRI + 0.528 * GMI + 0.404 * AQI + 0.892 * SGI
    + 0.115 * DEPI - 0.172 * SGAI + 4.679 * TATA - 0.327 * LVGI;

  const full = ['DSRI', 'GMI', 'AQI', 'DEPI', 'SGAI'].every(k => prov[k]);
  return { value: M, full, vars: { DSRI, GMI, AQI, SGI, DEPI, SGAI, TATA, LVGI }, provided: prov };
}

// ── Ручные доп-данные (localStorage) ──────────────────────────────────
const KEY = 'bondan_fin_extra';
function _read(){ try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch(_){ return {}; } }
function _save(m){ try { localStorage.setItem(KEY, JSON.stringify(m)); } catch(_){} }
export function extraGet(inn){ return _read()[String(inn)] || {}; }
export function extraSetField(inn, year, field, value){
  const m = _read();
  const e = m[String(inn)] || {};
  const y = { ...(e[String(year)] || {}) };
  if(value === '' || value == null) delete y[field]; else y[field] = Number(value);
  e[String(year)] = y; m[String(inn)] = e; _save(m);
}
