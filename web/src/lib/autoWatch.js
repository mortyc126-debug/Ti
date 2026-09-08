// Авто-предупреждения «на что смотреть» — контекстные подсказки, которые
// сами всплывают на карточке компании по её отрасли и по данным, чтобы не
// держать все ловушки/лаги в голове и не ходить по вкладкам.
// Расширяется правилами по мере накопления кейсов.

import { INDUSTRIES } from '../data/industries.js';

const EXPORTERS = new Set(['oil-gas', 'metals', 'chemistry', 'agro']);
const _n = v => (v == null || v === '' || isNaN(Number(v))) ? null : Number(v);
const _ANN = new Set(['FY', 'ГОД', 'YEAR', 'ANNUAL', '12M', 'Y']);

// Динамика последнего годового периода к предыдущему — для авто-выводов.
export function annualTrends(reports){
  if(!Array.isArray(reports)) return null;
  const ann = reports.filter(r => { const p = String(r.period || '').trim(); return !p || _ANN.has(p.toUpperCase()) || /год|annual|fy/i.test(p); })
    .sort((a, b) => (b.fy_year || 0) - (a.fy_year || 0));
  const src = ann.length >= 2 ? ann : [...reports].sort((a, b) => (b.fy_year || 0) - (a.fy_year || 0));
  if(src.length < 2) return null;
  const c = src[0], p = src[1];
  const rc = _n(c.rev), rp = _n(p.rev), nc = _n(c.np), np_ = _n(p.np);
  const dc = _n(c.debt), dp = _n(p.debt);
  const icrC = (_n(c.int_exp) && _n(c.ebit) != null) ? _n(c.ebit) / _n(c.int_exp) : null;
  const icrP = (_n(p.int_exp) && _n(p.ebit) != null) ? _n(p.ebit) / _n(p.int_exp) : null;
  const ec = _n(c.ebitda), ep = _n(p.ebitda);
  const revG = (rc != null && rp != null && rp > 0) ? rc / rp - 1 : null;
  const npG = (nc != null && np_ != null && np_ > 0) ? nc / np_ - 1 : null;
  const ebitdaG = (ec != null && ep != null && ep > 0) ? ec / ep - 1 : null;
  // качество роста: выручка растёт, а прибыль/EBITDA почти нет → низкое (объём/опт);
  // прибыль растёт заметно быстрее выручки → высокое (расширение маржи)
  let growthQuality = null;
  const profitG = npG != null ? npG : ebitdaG;
  if(revG != null && revG > 0.1 && profitG != null){
    if(profitG < revG * 0.3) growthQuality = 'low';
    else if(profitG > revG * 1.5) growthQuality = 'high';
  }
  return {
    revUp: revG != null && revG > 0.03,
    npDown: (nc != null && np_ != null && np_ > 0) ? nc < np_ * 0.9 : false,
    npNeg: nc != null && nc < 0,
    debtUp: (dc != null && dp != null && dp > 0) ? dc > dp * 1.1 : false,
    icrDown: (icrC != null && icrP != null) ? icrC < icrP : false,
    netMargin: (rc && rc > 0 && nc != null) ? nc / rc * 100 : null,
    revG, npG, ebitdaG, growthQuality,
  };
}

// {industry, mults, payout, opexScaleTrap, dyn} → [{level:'warn'|'info', text}]
export function buildWatch({ industry, mults, payout, opexScaleTrap, dyn } = {}){
  const out = [];
  const g = INDUSTRIES[industry]?.groupId;

  // — по данным (динамика год-к-году): приоритет, это про конкретный отчёт —
  if(dyn){
    const pc = v => `${v >= 0 ? '+' : ''}${Math.round(v * 100)}%`;
    if(dyn.revUp && dyn.npDown){
      out.push({ level: 'warn', text: 'Выручка растёт, а прибыль падает — дело в миксе/марже, а не в объёме. Смотри структуру продаж: низкомаржинальный сегмент может давать 80% выручки и 20% прибыли.' });
    } else if(dyn.growthQuality === 'low'){
      out.push({ level: 'warn', text: `Рост низкого качества: выручка ${pc(dyn.revG)}, а прибыль/EBITDA почти не растёт${dyn.npG != null ? ` (${pc(dyn.npG)})` : ''}. Вероятно растёт низкомаржинальный/оптовый сегмент — темп выручки обманчив.` });
    } else if(dyn.growthQuality === 'high'){
      out.push({ level: 'info', text: `Качественный рост: прибыль${dyn.npG != null ? ` ${pc(dyn.npG)}` : ''} растёт быстрее выручки (${pc(dyn.revG)}) — расширение маржи, а не только объём.` });
    }
    if(dyn.npNeg){
      out.push({ level: 'warn', text: 'Убыток/слабая прибыль — нормальные дивиденды под вопросом. Иногда даже капитализация части расходов не даёт вытянуть результат в плюс.' });
    }
    if(dyn.debtUp && dyn.icrDown){
      out.push({ level: 'warn', text: 'Долг растёт, а покрытие процентов падает — риск петли: хуже метрики → ниже рейтинг → дороже фондирование → ещё больше долг.' });
    }
    if(dyn.netMargin != null && dyn.netMargin < 5 && g !== 'finance'){
      out.push({ level: 'info', text: `Тонкая чистая маржа (${dyn.netMargin.toFixed(1)}%): большая выручка ≠ большая прибыль, всё решает микс и издержки.` });
    }
  }

  // — по отрасли —
  if(g === 'finance'){
    out.push({ level: 'warn', text: 'Банк/финкомпания: рост портфеля ≠ хорошо — смотри ROE на новый капитал и Cost of Risk. Переоценка ценных бумаг может перевернуть квартал (это не операционный результат). Ставка бьёт по прибыли двумя каналами и с лагом 1–4 кв.' });
  } else if(industry === 'construction' || industry === 'realestate'){
    out.push({ level: 'warn', text: 'Девелопер: выручка признаётся по мере стройки ≠ денежный поток. Смотри эскроу/распроданность и сильную зависимость от банка-кредитора (петля обратной связи).' });
  } else if(EXPORTERS.has(industry)){
    out.push({ level: 'warn', text: 'Экспортёр: результат = цена товара × курс × объём (± дисконт и налоги). Нельзя судить по одному фактору — проверь каждый; крепкий рубль может съесть рост цены.' });
  } else if(industry === 'retail'){
    out.push({ level: 'warn', text: 'Ритейл: спрос по ставкам/доходам сильнее бьёт по премиальному сегменту. Смотри LFL-продажи, а не только общую выручку (рост за счёт новых магазинов маскирует падение LFL).' });
  }

  // — по данным (структурные) —
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

  return out.slice(0, 5);
}
