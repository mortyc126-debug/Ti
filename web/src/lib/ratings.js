// Ручные кредитные рейтинги по эмитенту (localStorage). Источник добавим
// позже; пока пользователь проставляет сам. { inn: {rating, outlook, date} }.
const KEY = 'bondan_issuer_ratings';

function _load(){
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; }
}
export function ratingGet(inn){
  if(!inn) return null;
  const r = _load()[String(inn)];
  return r || null;
}
export function ratingSet(inn, rating, outlook){
  if(!inn) return;
  const db = _load();
  const r = String(rating || '').trim();
  if(!r){ delete db[String(inn)]; }
  else { db[String(inn)] = { rating: r, outlook: (outlook || '').trim() || null, date: new Date().toISOString().slice(0, 10) }; }
  try { localStorage.setItem(KEY, JSON.stringify(db)); } catch {}
}
