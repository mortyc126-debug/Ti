// Связки метрик: как показатели относятся друг к другу и что значат
// расхождения. Считаем из mults эмитента (+ E/P рынка, если есть акция).

const f1 = v => v == null ? '—' : (Math.round(v * 10) / 10).toString();
const fx = v => v == null ? '—' : (Math.round(v * 100) / 100) + '×';

export function computeLinkages(m, ep){
  if(!m) return [];
  const out = [];
  const roe = m.roe, roic = m.roic;

  // ROE vs ROIC — эффект долга
  if(roe != null && roic != null){
    const gap = roe - roic;
    let level = 'green', text;
    if(gap > 8){ level = 'yellow'; text = `ROE (${f1(roe)}%) заметно выше ROIC (${f1(roic)}%) — высокую отдачу на капитал акционеров создаёт долг (финансовый рычаг), а не сам бизнес. Работает, пока ставки низкие; при их росте рычаг бьёт в обратную сторону.`; }
    else if(gap < -3){ level = 'yellow'; text = `ROE (${f1(roe)}%) ниже ROIC (${f1(roic)}%) — редкий случай: долг дорогой или есть убыточные/неоперационные статьи, съедающие отдачу акционерам.`; }
    else { text = `ROE (${f1(roe)}%) ≈ ROIC (${f1(roic)}%) — отдача идёт из операционной эффективности, а не из долга. Здоровая структура.`; }
    out.push({ title: 'ROE vs ROIC — откуда отдача', level, text });
  }

  // DuPont: ROE = маржа × оборот × рычаг
  const margin = m.revRaw ? m.npRaw / m.revRaw * 100 : null;                 // %
  const turnover = m.assetsRaw ? m.revRaw / m.assetsRaw : null;             // ×
  const leverage = m.eqRaw ? m.assetsRaw / m.eqRaw : null;                  // ×
  if(margin != null && turnover != null && leverage != null){
    // за счёт чего ROE: сравним вклад через нормализацию к «типовым» 1
    let driver;
    if(leverage > 3 && margin < 8) driver = 'в основном за счёт долгового рычага (маржа тонкая) — качество прибыли ниже';
    else if(margin > 15 && turnover < 0.8) driver = 'за счёт высокой маржи при медленном обороте активов (капиталоёмкий бизнес)';
    else if(turnover > 1.2 && margin < 8) driver = 'за счёт быстрого оборота при тонкой марже (ритейл-логика)';
    else driver = 'сбалансированно между маржой, оборотом и умеренным рычагом';
    out.push({
      title: 'DuPont — из чего сложился ROE',
      level: (leverage > 3 && margin < 8) ? 'yellow' : 'green',
      text: `Маржа ${f1(margin)}% × Оборот активов ${fx(turnover)} × Фин.рычаг ${fx(leverage)}. ROE ${driver}.`,
    });
  }

  // ROIC vs E/P — качество бизнеса vs цена рынка (только для акций)
  if(roic != null && ep != null){
    let level = 'green', text;
    if(roic >= 15 && ep < 8){ level = 'yellow'; text = `Сильный бизнес (ROIC ${f1(roic)}%), но рынок уже дорого его оценил (E/P ${f1(ep)}%). Качество в цене — потенциал апсайда ограничен.`; }
    else if(roic < 8 && ep > 12){ level = 'yellow'; text = `Дёшево по прибыли (E/P ${f1(ep)}%), но бизнес слабо зарабатывает на капитал (ROIC ${f1(roic)}%). Классическая ловушка стоимости — дёшево не значит хорошо.`; }
    else if(roic >= 12 && ep >= 10){ level = 'green'; text = `Качественный бизнес (ROIC ${f1(roic)}%) по разумной цене (E/P ${f1(ep)}%) — редкое сочетание, интересно.`; }
    else { text = `ROIC ${f1(roic)}% при E/P ${f1(ep)}% — оценка соответствует качеству, явного перекоса нет.`; }
    out.push({ title: 'ROIC vs E/P — качество vs цена', level, text });
  }

  return out;
}
