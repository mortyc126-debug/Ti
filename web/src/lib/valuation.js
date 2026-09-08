// Классические мультипликаторы оценки акций + перцентиль «дешевле X% рынка»
// и подвохи каждого. Считаем из цены и числа акций (снимок T-Invest) + сырья
// отчётности (mults.*Raw, обычно млн ₽). Всё приводим к рублям.

import { currentStocks } from '../store/marketData.js';
import { currentIssuers } from '../store/issuers.js';
import { bestIssuerMatch } from './issuerMatch.js';

const MLN = 1e6;   // сырьё отчётности обычно в млн ₽

// meta мультипликаторов: lowerCheaper — меньше = дешевле (для перцентиля).
export const MULT_META = [
  { id: 'pe', label: 'P/E', lowerCheaper: true,
    pitfall: 'Прибыль легко искажается разовыми статьями и налогом; при убытке P/E бессмыслен (отрицателен). Не сравнивай напрямую компании с разным долгом — долг «прячется» вне P/E.' },
  { id: 'evEbitda', label: 'EV/EBITDA', lowerCheaper: true,
    pitfall: 'Учитывает долг (EV = кап-ция + чистый долг), поэтому честнее для сравнения компаний с разным левериджем. Но EBITDA игнорирует капзатраты и износ — для капиталоёмких (транспорт, металл) занижает реальную дороговизну.' },
  { id: 'pb', label: 'P/B', lowerCheaper: true,
    pitfall: 'Балансовый капитал у IT/сервисов мал (нет тяжёлых активов) → высокий P/B ≠ дорого. Для банков, наоборот, ключевой. Низкий P/B бывает у тех, у кого активы «переоценены» на балансе.' },
  { id: 'ps', label: 'P/S', lowerCheaper: true,
    pitfall: 'Не смотрит на прибыльность вообще: дешёвый P/S при убытке или тонкой марже — классическая ловушка. Полезен для сравнения внутри одной отрасли с похожей маржой.' },
  { id: 'ep', label: 'E/P (дох-ть)', lowerCheaper: false,
    pitfall: 'Обратная к P/E доходность прибыли. Сравнивай с доходностью ОФЗ: если E/P ниже безрисковой ставки — рынок закладывает сильный рост (или переоценён).' },
  { id: 'divYield', label: 'Див. доходность', lowerCheaper: false,
    pitfall: 'За 12 мес по факту выплат. Подвохи: разовые/спецдивиденды завышают картину; будущие выплаты не гарантированы; высокая доходность часто = упавшая цена (рынок ждёт проблем).' },
];

// price, shares, сырьё m, дивиденд на акцию за 12 мес → мультипликаторы
export function computeMultiples(price, shares, m, div12m){
  if(!(price > 0) || !(shares > 0) || !m) return null;
  const mktCap = price * shares;                 // ₽
  const np = m.npRaw != null ? m.npRaw * MLN : null;
  const eq = m.eqRaw != null ? m.eqRaw * MLN : null;
  const rev = m.revRaw != null ? m.revRaw * MLN : null;
  const ebitda = m.ebitdaRaw != null ? m.ebitdaRaw * MLN : null;
  const debt = m.debtRaw != null ? m.debtRaw * MLN : 0;
  const cash = m.cashRaw != null ? m.cashRaw * MLN : 0;
  const ev = mktCap + debt - cash;
  const divTotal = (div12m != null && div12m > 0) ? div12m * shares : null;   // ₽ всего
  return {
    mktCapBn: mktCap / 1e9,
    pe: (np && np > 0) ? mktCap / np : null,
    pb: (eq && eq > 0) ? mktCap / eq : null,
    ps: (rev && rev > 0) ? mktCap / rev : null,
    evEbitda: (ebitda && ebitda > 0) ? ev / ebitda : null,
    ep: (np && np > 0) ? np / mktCap * 100 : null,
    divYield: (div12m != null && div12m > 0) ? div12m / price * 100 : null,
    payout: (divTotal != null && np && np > 0) ? divTotal / np * 100 : null,
  };
}

// Универсум мультипликаторов по всем акциям, у кого нашлась отчётность —
// для перцентиля. Возвращает { arrays:{pe:[],...}, byName:Map }.
export function valuationUniverse(){
  const stocks = currentStocks();
  const issuers = currentIssuers();
  const innMap = new Map();
  for(const it of issuers){ if(it.inn) innMap.set(String(it.inn), it); }
  const arrays = { pe: [], evEbitda: [], pb: [], ps: [], ep: [], divYield: [] };
  const byName = new Map();
  for(const s of stocks){
    if(s.price == null) continue;   // только реальные записи с ценой
    const iss = (s.inn && innMap.get(String(s.inn))) || bestIssuerMatch(s.name, issuers);
    if(!iss?.mults) continue;
    const mm = computeMultiples(s.price, s.shares, iss.mults, s.div12m);
    if(!mm) continue;
    byName.set(String(s.name).toLowerCase(), mm);
    for(const k of Object.keys(arrays)) if(mm[k] != null && isFinite(mm[k]) && mm[k] > 0) arrays[k].push(mm[k]);
  }
  for(const k of Object.keys(arrays)) arrays[k].sort((a, b) => a - b);
  return { arrays, byName };
}

// Найти торгуемую акцию эмитента (цена+акции) по инн/названию.
export function findStockForIssuer(name, inn){
  const stocks = currentStocks();
  const target = [{ inn: inn || '_', name: name || '' }];
  for(const s of stocks){
    if(s.price == null) continue;
    if(inn && s.inn && String(s.inn) === String(inn)) return s;
    if(name && bestIssuerMatch(s.name, target)) return s;
  }
  return null;
}

// mults эмитента по инн (текущий винтаж).
export function issuerMults(inn){
  if(!inn) return null;
  for(const it of currentIssuers()){
    if(String(it.inn) === String(inn)) return it.mults;
  }
  return null;
}

// «дешевле X% рынка»: доля универсума, которая дороже данного значения.
export function cheaperThanPct(value, arr, lowerCheaper){
  if(value == null || !isFinite(value) || value <= 0 || !arr?.length) return null;
  let dearer = 0;
  for(const v of arr){
    if(lowerCheaper ? v > value : v < value) dearer++;
  }
  return Math.round(dearer / arr.length * 100);
}
