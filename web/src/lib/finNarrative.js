// Разбор динамики отчётности «человеческим языком»: сравниваем последний
// годовой период с предыдущим и выдаём флаги — где 🔴 тревога, 🟡 внимание,
// 🟢 хорошо, с объяснением, что это значит для бизнеса. На вход — сырые строки
// отчётов (как в снимке reports-cache: rev, np, ebitda, ebit, int_exp, assets,
// ca, cl, debt, cash, eq, tax_exp, fy_year, period, std). Единицы не важны —
// всё считается в отношениях/процентах.

const _n = v => (v == null || v === '' || isNaN(Number(v))) ? null : Number(v);
const _ANNUAL = new Set(['FY', 'ГОД', 'Год', 'year', 'annual', '12M', 'Y']);

function _isAnnual(r){
  const p = String(r.period || '').trim();
  return !p || _ANNUAL.has(p) || /год|annual|fy/i.test(p);
}

function metrics(r){
  const rev = _n(r.rev), np = _n(r.np), ebitda = _n(r.ebitda), ebit = _n(r.ebit),
        intx = _n(r.int_exp), assets = _n(r.assets), ca = _n(r.ca), cl = _n(r.cl),
        debt = _n(r.debt), cash = _n(r.cash), eq = _n(r.eq), tax = _n(r.tax_exp);
  return {
    rev, np, ebitda, ebit, debt, cash, eq, assets,
    ebitdaMarg: (rev && ebitda != null) ? ebitda / rev * 100 : null,
    nde: (ebitda && ebitda > 0 && debt != null && cash != null) ? (debt - cash) / ebitda : null,
    icr: (intx && intx > 0 && ebit != null) ? ebit / intx : null,
    currentR: (cl && cl > 0 && ca != null) ? ca / cl : null,
    roe: (eq && eq > 0 && np != null) ? np / eq * 100 : null,
  };
}

const pct = (c, p) => (c != null && p != null && p !== 0) ? (c - p) / Math.abs(p) * 100 : null;
const f1 = v => v == null ? '—' : (Math.round(v * 10) / 10).toString();

// Возвращает {year, prevYear, std, flags:[{level,title,text}], counts, verdict}
export function interpretPeriods(reports){
  if(!Array.isArray(reports) || reports.length < 2) return null;
  const annual = reports.filter(_isAnnual).sort((a, b) => (b.fy_year || 0) - (a.fy_year || 0));
  const src = annual.length >= 2 ? annual : [...reports].sort((a, b) => (b.fy_year || 0) - (a.fy_year || 0));
  if(src.length < 2) return null;
  const cur = src[0], prev = src[1];
  const c = metrics(cur), p = metrics(prev);
  const flags = [];
  const add = (level, title, text) => flags.push({ level, title, text });

  // Выручка
  const gRev = pct(c.rev, p.rev);
  if(gRev != null){
    if(gRev <= -15) add('red', `Выручка ${f1(gRev)}%`, 'Резкое падение выручки — сжатие бизнеса. Проверь причину: потеря спроса, снижение цен или выбытие сегмента.');
    else if(gRev <= -3) add('yellow', `Выручка ${f1(gRev)}%`, 'Выручка снижается. Не критично, но стоит понять, разовое это или тренд.');
    else if(gRev >= 15) add('green', `Выручка +${f1(gRev)}%`, 'Заметный рост выручки — бизнес расширяется.');
  }

  // Чистая прибыль / убыток
  if(c.np != null){
    if(c.np < 0 && (p.np == null || p.np >= 0)) add('red', 'Ушли в убыток', 'Компания получила чистый убыток после прибыльного года — сигнал разобраться, что сломалось (маржа, разовые списания, процентные расходы).');
    else if(c.np < 0) add('red', 'Убыток продолжается', 'Второй убыточный период подряд — устойчивая проблема с прибыльностью.');
    else {
      const gNp = pct(c.np, p.np);
      if(gNp != null && p.np > 0 && gNp <= -30) add('yellow', `Прибыль ${f1(gNp)}%`, 'Прибыль резко сократилась при сохранении плюса — давление на маржу или рост издержек/процентов.');
      else if(gNp != null && p.np > 0 && gNp >= 30) add('green', `Прибыль +${f1(gNp)}%`, 'Прибыль уверенно растёт.');
      else if(p.np != null && p.np < 0 && c.np > 0) add('green', 'Вышли из убытка', 'Компания вернулась к прибыли после убыточного года.');
    }
  }

  // EBITDA-маржа
  if(c.ebitdaMarg != null && p.ebitdaMarg != null){
    const d = c.ebitdaMarg - p.ebitdaMarg;
    if(d <= -3) add('yellow', `Маржа EBITDA ${f1(d)} пп`, 'Операционная маржа сжимается — растут издержки или падают цены. Прибыльность каждого рубля выручки снижается.');
    else if(d >= 3) add('green', `Маржа EBITDA +${f1(d)} пп`, 'Маржа расширяется — операционная эффективность растёт.');
  }

  // Долговая нагрузка (уровень)
  if(c.nde != null){
    if(c.nde > 4) add('red', `Чистый долг/EBITDA ${f1(c.nde)}x`, 'Высокая долговая нагрузка: годовой EBITDA не хватает покрыть и трети долга. Чувствительность к ставкам и рефинансированию высокая.');
    else if(c.nde > 3) add('yellow', `Чистый долг/EBITDA ${f1(c.nde)}x`, 'Повышенная долговая нагрузка — терпимо, но запас прочности небольшой.');
  }
  // Долговая нагрузка (динамика)
  if(c.nde != null && p.nde != null && c.nde - p.nde >= 1) {
    add('yellow', `Долг вырос: ND/EBITDA ${f1(p.nde)}→${f1(c.nde)}x`, 'Долговая нагрузка заметно выросла год к году — либо набрали долг, либо просела EBITDA.');
  }

  // Покрытие процентов
  if(c.icr != null){
    if(c.icr < 1.5) add('red', `Покрытие процентов ${f1(c.icr)}x`, 'Операционной прибыли едва хватает на проценты по долгу — при ухудшении бизнеса или росте ставок возможны проблемы с обслуживанием.');
    else if(c.icr < 3) add('yellow', `Покрытие процентов ${f1(c.icr)}x`, 'Покрытие процентов невысокое — следи, чтобы не снижалось.');
  }

  // Ликвидность
  if(c.currentR != null){
    if(c.currentR < 1) add('red', `Текущая ликвидность ${f1(c.currentR)}x`, 'Краткосрочных обязательств больше, чем оборотных активов — риск кассовых разрывов, если не рефинансировать.');
    else if(c.currentR < 1.2) add('yellow', `Текущая ликвидность ${f1(c.currentR)}x`, 'Ликвидность на грани нормы — подушка тонкая.');
  }

  // Капитал
  if(c.eq != null && c.eq < 0) add('red', 'Отрицательный капитал', 'Обязательства превышают активы — крайне тревожный признак финансовой устойчивости.');
  else {
    const gEq = pct(c.eq, p.eq);
    if(gEq != null && gEq <= -10) add('yellow', `Капитал ${f1(gEq)}%`, 'Собственный капитал сокращается — убытки или крупные дивиденды/выкуп проедают базу.');
  }

  // Денежная подушка
  const gCash = pct(c.cash, p.cash);
  if(gCash != null && gCash <= -40 && (p.cash || 0) > 0) add('yellow', `Денежные средства ${f1(gCash)}%`, 'Денежная подушка резко сократилась — проверь, на что ушли деньги (капзатраты, погашение долга, отток из операций).');

  // Долг растёт быстрее прибыли
  const gDebt = pct(c.debt, p.debt), gEbitda = pct(c.ebitda, p.ebitda);
  if(gDebt != null && gDebt >= 25 && (gEbitda == null || gDebt > gEbitda + 15)){
    add('yellow', `Долг +${f1(gDebt)}%`, 'Долг растёт заметно быстрее прибыли — если это не финансирование окупаемого роста, нагрузка будет давить.');
  }

  const counts = { red: 0, yellow: 0, green: 0 };
  for(const fl of flags) counts[fl.level]++;
  let verdict;
  if(counts.red > 0) verdict = { level: 'red', text: 'Есть серьёзные тревожные сигналы — разберись до сделки.' };
  else if(counts.yellow >= 2) verdict = { level: 'yellow', text: 'Несколько моментов требуют внимания.' };
  else if(counts.yellow === 1) verdict = { level: 'yellow', text: 'В целом нормально, один момент под наблюдение.' };
  else verdict = { level: 'green', text: 'Динамика без явных тревог.' };
  if(!flags.length) add('green', 'Существенных изменений нет', 'Ключевые показатели год к году без резких движений.');

  return { year: cur.fy_year, prevYear: prev.fy_year, std: cur.std || prev.std || null, flags, counts, verdict };
}
