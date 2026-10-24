// Стеммер русского языка (алгоритм Snowball/Porter для русского) и лёгкий для английского.
// Нужен поиску: «толщина», «толщину», «толщины» → одна основа, «жирный», «жирнее», «жирность» → одна основа.
// Без зависимостей.

const VOWELS = 'аеиоуыэюя';
const isV = c => VOWELS.includes(c);

// группы окончаний; need: 'ay' — перед окончанием должна стоять «а» или «я»
const E = (list, need) => list.split(' ').map(e => ({ e, need }));
const PERFECTIVE = [...E('в вши вшись', 'ay'), ...E('ив ивши ившись ыв ывши ывшись')];
const REFLEXIVE = E('ся сь');
const ADJECTIVE = E('ее ие ые ое ими ыми ей ий ый ой ем им ым ом его ого ему ому их ых ую юю ая яя ою ею');
const PARTICIPLE = [...E('ем нн вш ющ щ', 'ay'), ...E('ивш ывш ующ')];
const VERB = [...E('ла на ете йте ли й л ем н ло но ет ют ны ть ешь нно', 'ay'),
  ...E('ила ыла ена ейте уйте ите или ыли ей уй ил ыл им ым ен ило ыло ено ят ует уют ит ыт ены ить ыть ишь ую ю')];
const NOUN = E('а ев ов ие ье е иями ями ами еи ии и ией ей ой ий й иям ям ием ем ам ом о у ах иях ях ы ь ию ью ю ия ья я');
const SUPERLATIVE = E('ейш ейше');
const DERIVATIONAL = E('ост ость');

// самое длинное подходящее окончание в пределах региона (не левее lim); возвращает длину или 0
function match(w, list, lim){
  let best = null;
  for(const it of list){
    if(w.length - it.e.length < lim) continue;
    if(!w.endsWith(it.e)) continue;
    if(!best || it.e.length > best.e.length) best = it;
  }
  if(!best) return 0;
  if(best.need === 'ay'){
    const i = w.length - best.e.length - 1;
    if(i < lim || (w[i] !== 'а' && w[i] !== 'я')) return 0;   // у самого длинного совпадения не выполнено условие — вся группа не срабатывает
  }
  return best.e.length;
}

export function stemRu(word){
  let w = String(word).toLowerCase().replace(/ё/g, 'е');
  // регионы RV, R1, R2
  let rv = w.length, r1 = w.length, r2 = w.length;
  for(let i = 0; i < w.length; i++){ if(isV(w[i])){ rv = i + 1; break; } }
  if(rv >= w.length) return w;   // нет гласной — оставляем как есть
  const region = from => {
    let i = from; while(i < w.length && !isV(w[i])) i++;      // первая гласная
    while(i < w.length && isV(w[i])) i++;                      // ... пропускаем гласные
    return Math.min(w.length, i + 1);                          // после первой согласной за гласной
  };
  // R1: после первой согласной, идущей за гласной
  { let i = 0; while(i < w.length && !isV(w[i])) i++; while(i < w.length && isV(w[i])) i++; r1 = Math.min(w.length, i + 1); }
  { let i = r1; while(i < w.length && !isV(w[i])) i++; while(i < w.length && isV(w[i])) i++; r2 = Math.min(w.length, i + 1); }
  void region;

  const cut = n => { w = w.slice(0, w.length - n); };
  // шаг 1
  let n = match(w, PERFECTIVE, rv);
  if(n) cut(n);
  else {
    n = match(w, REFLEXIVE, rv); if(n) cut(n);
    let done = false;
    n = match(w, ADJECTIVE, rv);                                  // причастное/прилагательное
    if(n){ cut(n); const p = match(w, PARTICIPLE, rv); if(p) cut(p); done = true; }
    if(!done){ n = match(w, VERB, rv); if(n){ cut(n); done = true; } }
    if(!done){ n = match(w, NOUN, rv); if(n) cut(n); }
  }
  // шаг 2: «и»
  if(w.endsWith('и') && w.length - 1 >= rv) cut(1);
  // шаг 3: словообразовательные -ост/-ость в R2
  n = match(w, DERIVATIONAL, r2); if(n) cut(n);
  // шаг 4
  n = match(w, SUPERLATIVE, rv);
  if(n){ cut(n); if(w.endsWith('нн')) cut(1); }
  else if(w.endsWith('нн')) cut(1);
  else if(w.endsWith('ь')) cut(1);
  return w;
}

// Лёгкий английский стеммер: только множественное число и -ing/-ed у длинных слов.
// Для идентификаторов кода этого достаточно: fonts → font, loops → loop, looping → loop.
export function stemEn(word){
  let w = String(word).toLowerCase();
  if(w.length <= 3) return w;
  if(w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if(/(ss|us|is)$/.test(w)) return w;
  if(/(ches|shes|xes|zes|sses)$/.test(w)) return w.slice(0, -2);
  if(w.endsWith('s')) w = w.slice(0, -1);
  if(w.endsWith('ing') && w.length - 3 >= 4) { w = w.slice(0, -3); if(/([^aeiou])\1$/.test(w)) w = w.slice(0, -1); }
  else if(w.endsWith('ed') && w.length - 2 >= 4) { w = w.slice(0, -2); if(/([^aeiou])\1$/.test(w)) w = w.slice(0, -1); }
  return w;
}

export function stem(word){
  const w = String(word);
  if(/[а-яё]/i.test(w)) return stemRu(w);
  if(/^[a-z]+$/i.test(w)) return stemEn(w);
  return w.toLowerCase();
}
