// Авто-предупреждения «на что смотреть» — контекстные подсказки, которые
// сами всплывают на карточке компании по её отрасли и по данным, чтобы не
// держать все ловушки/лаги в голове и не ходить по вкладкам.
// Расширяется правилами по мере накопления кейсов.

import { INDUSTRIES } from '../data/industries.js';

const EXPORTERS = new Set(['oil-gas', 'metals', 'chemistry', 'agro']);

// {industry, mults, payout, opexScaleTrap} → [{level:'warn'|'info', text}]
export function buildWatch({ industry, mults, payout, opexScaleTrap } = {}){
  const out = [];
  const g = INDUSTRIES[industry]?.groupId;

  // — по отрасли —
  if(g === 'finance'){
    out.push({ level: 'warn', text: 'Банк/финкомпания: рост портфеля ≠ хорошо — смотри ROE на новый капитал и Cost of Risk. Переоценка ценных бумаг может перевернуть квартал (это не операционный результат). Ставка бьёт по прибыли двумя каналами и с лагом 1–4 кв.' });
  } else if(industry === 'construction' || industry === 'realestate'){
    out.push({ level: 'warn', text: 'Девелопер: выручка признаётся по мере стройки ≠ денежный поток. Смотри эскроу/распроданность и сильную зависимость от банка-кредитора (петля обратной связи).' });
  } else if(EXPORTERS.has(industry)){
    out.push({ level: 'warn', text: 'Экспортёр: результат = цена товара × курс × объём (± дисконт и налоги). Нельзя судить по одному фактору — проверь каждый; крепкий рубль может съесть рост цены.' });
  }

  // — по данным —
  if(opexScaleTrap){
    out.push({ level: 'warn', text: 'Расходы снизились вместе с выручкой — это сжатие масштаба, а не рост эффективности. Ставь рядом OPEX + выручку + объёмы.' });
  }
  if(payout != null && payout >= 90){
    out.push({ level: 'warn', text: `Выплаты ~${Math.round(payout)}% прибыли — прибыль ≠ деньги. Проверь FCF (после CAPEX) и не финансируются ли дивиденды/buyback долгом.` });
  }
  if(mults?.nde != null && mults.nde > 4){
    out.push({ level: 'warn', text: `Высокий долг (ND/EBITDA ${mults.nde.toFixed(1)}×) — при росте ставки процентные расходы вырастут с лагом 1–4 кв.` });
  }

  // общий напоминатель про лаг — всегда последним
  out.push({ level: 'info', text: 'Лаг: эффект факторов доходит до отчёта не сразу — переоценка мгновенно, Cost of Risk 1–4 кв., отдача от CAPEX 2–8 кв. И три вопроса к любой цифре: что произошло → почему → повторится ли.' });

  return out.slice(0, 4);
}
