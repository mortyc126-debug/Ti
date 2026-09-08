// Реальная вселенная облигаций для «Карты». Соединяем ЦЕНЫ (живой/edge-
// кэшированный эндпоинт /bond/latest — secid, срок, YTM, рейтинг, объём) с
// ОТЧЁТНОСТЬЮ (мультипликаторы эмитента из стора issuers, снимок reports-cache)
// по ИНН. На выходе — записи в форме bondsMock, дальше loadBondPoints считает
// x/y/z как обычно. Если цен нет — вернём [] и карта останется на демо-данных.

import { api } from '../api.js';
import { currentIssuers } from '../store/issuers.js';

const _num = v => (v == null || v === '' || isNaN(Number(v))) ? null : Number(v);

// поля в ответах backend называются по-разному в зависимости от версии —
// берём первое непустое из списка кандидатов
function _pick(row, keys){
  for(const k of keys){ const v = row[k]; if(v != null && v !== '') return v; }
  return null;
}

// тип выпуска: ОФЗ по префиксу SU, муни по строке, иначе корпоратив
function _bondType(secid, raw){
  const t = (raw || '').toString().toLowerCase();
  if(/ofz|офз/.test(t)) return 'ofz';
  if(/muni|муни|обл\./.test(t)) return 'municipal';
  if(/^su\d/i.test(secid || '')) return 'ofz';
  return 'corporate';
}

// нормализуем рейтинг к нашей шкале (AAA..D); мусор → 'none'
function _normRating(r){
  if(!r) return 'none';
  const s = String(r).toUpperCase().replace(/\s+/g, '');
  const m = s.match(/(AAA|AA[+\-]?|A[+\-]?|BBB[+\-]?|BB[+\-]?|B[+\-]?|CCC|CC|C|D)/);
  return m ? m[1] : 'none';
}

// сектор эмитента → industry (как в bondsMock)
function _issuerIndustry(iss){ return (iss && iss.industry) || 'other'; }

// одна строка /bond/latest + карта фундамента по инн → запись как в bondsMock
function _mkBond(row, innMap, nameMap){
  const secid = (_pick(row, ['secid', 'SECID', 'isin', 'ISIN']) || '').toString().toUpperCase();
  if(!secid) return null;
  const inn = _pick(row, ['inn', 'issuer_inn', 'emitent_inn']);
  const rawIssuerName = _pick(row, ['issuer', 'issuer_name', 'emitent', 'org_name', 'shortname', 'name']);
  const iss = (inn && innMap.get(String(inn))) || (rawIssuerName && nameMap.get(String(rawIssuerName).toLowerCase())) || null;
  // имя эмитента предпочтительно из фундамента (снимок цен его не содержит)
  const issuerName = iss?.name || rawIssuerName || secid;

  const mat = _pick(row, ['mat_date', 'maturity_date', 'matdate', 'maturity']);
  const ytm = _num(_pick(row, ['ytm', 'yield_to_mat', 'yieldtomaturity', 'effectiveyield', 'yield']));
  // без срока/доходности точка бессмысленна; YTM>100% = битая цена дефолтной
  // бумаги (иначе один выброс растягивает всю ось Y в линию)
  if(!mat || ytm == null || ytm <= 0 || ytm > 100) return null;

  const volRaw = _num(_pick(row, ['volume_bn', 'volumebn']));
  const volAbs = _num(_pick(row, ['volume', 'issue_size', 'facevalue_total', 'turnover']));
  const volume_bn = volRaw != null ? volRaw : (volAbs != null ? volAbs / 1e9 : null);

  return {
    secid,
    name: _pick(row, ['name', 'shortname', 'secname']) || secid,
    issuer: issuerName,
    inn: inn ? String(inn) : (iss?.inn || null),
    ticker: iss?.ticker || null,
    type: _bondType(secid, _pick(row, ['type', 'sec_type', 'listlevel'])),
    rating: _normRating(_pick(row, ['rating', 'credit_rating', 'ratingval'])),
    industry: _issuerIndustry(iss),
    volume_bn: volume_bn != null ? volume_bn : 1,
    mat_date: mat,
    ytm,
    // фундамент из отчётности — если эмитент найден
    mults: iss?.mults || {},
  };
}

// локальный снимок цен (web/public/bonds-cache.json = [{secid,inn,mat_date,ytm}])
// — генерится из data/bond_dump скриптом tools/make_bonds_cache.py. Живёт офлайн,
// не зависит от деградировавшей D1. Приоритет над backend.
async function _snapshotRows(){
  try {
    const r = await fetch('/bonds-cache.json');
    if(r.ok){ const a = await r.json(); if(Array.isArray(a) && a.length) return a; }
  } catch(_){}
  return null;
}

// вытянуть все выпуски: снимок цен → иначе живой /bond/latest
export async function loadRealBonds(){
  let rows = await _snapshotRows();
  if(!rows){
    try {
      const d = await api.bondLatest({ limit: 5000 });
      rows = Array.isArray(d) ? d : (d?.data || d?.bonds || []);
    } catch(_){ return []; }
  }
  if(!Array.isArray(rows) || !rows.length) return [];

  // индексы фундамента по инн и по имени (для join'а)
  const issuers = currentIssuers();
  const innMap = new Map();
  const nameMap = new Map();
  for(const it of issuers){
    if(it.inn) innMap.set(String(it.inn), it);
    if(it.name) nameMap.set(String(it.name).toLowerCase(), it);
  }

  const out = [];
  const seen = new Set();
  for(const r of rows){
    const b = _mkBond(r, innMap, nameMap);
    if(!b || seen.has(b.secid)) continue;
    seen.add(b.secid);
    out.push(b);
  }
  return out;
}
