// Сопоставление эмитентов по названию. Нужно, когда бумагу выпускает
// SPV («X Финанс», «X Капитал», «ГК X»), а отчётность лежит под материнской
// компанией («X»). Нормализуем имя (режем орг-формы и SPV-суффиксы) и ищем
// вероятных кандидатов среди эмитентов с отчётностью.

// Слова, которые не несут смысла для сопоставления (орг-формы, обёртки SPV).
const STOP = new Set([
  'ооо','оао','пао','ао','зао','нао','пк','ук','нко','кб','акб','банк',
  'гк','группа','групп','холдинг','holding','group','llc','plc','ojsc','pjsc',
  'финанс','финансы','финанc','finance','капитал','капиталъ','capital',
  'инвест','инвестиции','инвестментс','лк',
]);

export function normName(s){
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"'`.,()\[\]\-–—/\\|]+/g, ' ')
    .split(/\s+/)
    .filter(w => w
      && !STOP.has(w)
      && !/^\d+$/.test(w)              // чистые числа (номера выпусков)
      && !/^\d*[рp]\d*$/i.test(w)      // 001p, бо-п и т.п.
      && !/^бо$/i.test(w))
    .join(' ')
    .trim();
}

function tokenSet(s){
  const t = normName(s).split(' ').filter(Boolean);
  return new Set(t);
}

// Кандидаты из списка эмитентов (с полем name/inn) для данного имени.
// Возвращает [{issuer, score}] по убыванию, score 0..1.
export function suggestIssuers(name, issuers, limit = 6){
  const tt = tokenSet(name);
  if(!tt.size || !Array.isArray(issuers)) return [];
  const out = [];
  const seen = new Set();
  for(const it of issuers){
    if(!it || !it.inn || seen.has(String(it.inn))) continue;
    const ct = tokenSet(it.name);
    if(!ct.size) continue;
    let inter = 0;
    for(const w of tt) if(ct.has(w)) inter++;
    if(!inter) continue;
    const uni = new Set([...tt, ...ct]).size;
    let score = inter / uni;                      // Jaccard
    if(inter === tt.size || inter === ct.size) score = Math.max(score, 0.8); // одно ⊆ другого
    seen.add(String(it.inn));
    out.push({ issuer: it, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out.filter(x => x.score >= 0.34).slice(0, limit);
}

// Лучшее совпадение эмитента для названия (для авто-джойна акций с отчётностью):
// точное → вхождение одного нормализованного имени в другое → токен-скор.
export function bestIssuerMatch(name, issuers){
  const t = normName(name);
  if(!t || !Array.isArray(issuers)) return null;
  let exact = null, contain = null;
  for(const it of issuers){
    if(!it || !it.inn) continue;
    const c = normName(it.name);
    if(!c) continue;
    if(c === t){ exact = it; break; }
    if(c.length >= 4 && t.length >= 4 && (c.includes(t) || t.includes(c))){
      if(!contain || Math.abs(c.length - t.length) < Math.abs(normName(contain.name).length - t.length)) contain = it;
    }
  }
  if(exact) return exact;
  if(contain) return contain;
  const s = suggestIssuers(name, issuers, 1);
  return (s.length && s[0].score >= 0.5) ? s[0].issuer : null;
}

// ── Подтверждённые связки имя→ИНН (localStorage) ──────────────────────
const ALIAS_KEY = 'bondan_issuer_aliases';
function _readAliases(){
  try { return JSON.parse(localStorage.getItem(ALIAS_KEY)) || {}; } catch(_){ return {}; }
}
export function aliasGet(name){
  const m = _readAliases();
  return m[normName(name)] || null;
}
export function aliasSet(name, inn){
  const m = _readAliases();
  m[normName(name)] = String(inn);
  try { localStorage.setItem(ALIAS_KEY, JSON.stringify(m)); } catch(_){}
}
export function aliasClear(name){
  const m = _readAliases();
  delete m[normName(name)];
  try { localStorage.setItem(ALIAS_KEY, JSON.stringify(m)); } catch(_){}
}
