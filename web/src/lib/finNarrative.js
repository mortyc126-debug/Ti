// Разбор динамики отчётности «человеческим языком»: сравниваем последний
// годовой период с предыдущим и выдаём флаги — где 🔴 тревога, 🟡 внимание,
// 🟢 хорошо, с объяснением, что это значит для бизнеса. На вход — сырые строки
// отчётов (как в снимке reports-cache: rev, np, ebitda, ebit, int_exp, assets,
// ca, cl, debt, cash, eq, tax_exp, fy_year, period, std). Единицы не важны —
// всё считается в отношениях/процентах.

import { defaultNormFor } from '../data/industryNorms.js';
import { INDUSTRIES } from '../data/industries.js';

const _n = v => (v == null || v === '' || isNaN(Number(v))) ? null : Number(v);
const _ANNUAL = new Set(['FY', 'ГОД', 'Год', 'year', 'annual', '12M', 'Y']);

// Почему у отрасли базово такие нормы — короткое объяснение по группе.
export const INDUSTRY_WHY = {
  raw:       'Сырьё и добыча: капиталоёмко, но маржа EBITDA высокая (18%+), долг умеренный. Прибыль циклична вслед за ценами на товар — смотри на средний цикл, а не один год.',
  manuf:     'Обработка: маржа средняя (10–15%), оборотный капитал большой (запасы, дебиторка) → важна ликвидность. Долг терпим до ~2.5–4.5× EBITDA.',
  energy:    'Энергетика/ЖКХ: стабильные денежные потоки и высокая маржа, но большой долг под инфраструктуру — норма ND/EBITDA выше, ICR может быть скромным.',
  build:     'Стройка/девелопмент: структурно высокий долг (проектное финансирование, эскроу) — ND/EBITDA до 4–7× это норма, а не тревога. Смотри на распроданность и покрытие эскроу.',
  trade:     'Торговля/ритейл: тонкая маржа (2–6%), но быстрый оборот. Долг высокий из-за товарных запасов; ключевое — оборачиваемость и ликвидность, а не маржа.',
  transport: 'Транспорт/логистика: капиталоёмко (флот, парк), высокий долг под технику, маржа средняя. Важны загрузка и покрытие лизинга.',
  'it-media':'IT/связь/медиа: низкий долг, высокая маржа (25%+) и рентабельность капитала, много кэша. Риски не в балансе, а в росте и оттоке клиентов.',
  finance:   'Финансы (банки/лизинг/МФО): структурно низкий equity ratio (10–15%) и высокий «долг» — это их бизнес-модель, а не слабость. Классические ND/EBITDA/ICR к ним почти неприменимы; смотри на достаточность капитала и качество активов.',
  services:  'Услуги: маржа и долг средние, мало основных средств. Ключевое — удержание выручки и рентабельность.',
  other:     'Смешанная/прочая отрасль: пороги усреднённые, оценивай с поправкой на конкретный бизнес.',
};

export function industryWhy(industryId){
  const g = INDUSTRIES[industryId]?.groupId || 'other';
  return { groupId: g, text: INDUSTRY_WHY[g] || INDUSTRY_WHY.other };
}

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

// Возвращает {year, prevYear, std, industry, flags, counts, verdict, fscore}
export function interpretPeriods(reports, industry){
  if(!Array.isArray(reports) || reports.length < 2) return null;
  const annual = reports.filter(_isAnnual).sort((a, b) => (b.fy_year || 0) - (a.fy_year || 0));
  const src = annual.length >= 2 ? annual : [...reports].sort((a, b) => (b.fy_year || 0) - (a.fy_year || 0));
  if(src.length < 2) return null;
  const cur = src[0], prev = src[1];
  const c = metrics(cur), p = metrics(prev);
  const flags = [];
  const add = (level, title, text) => flags.push({ level, title, text });
  // отраслевые пороги (если отрасль известна) — иначе дефолты
  const norm = (id) => (industry ? defaultNormFor(industry, id) : null);
  const isFin = (INDUSTRIES[industry]?.groupId === 'finance');

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

  // EBITDA-маржа: уровень (по отрасли) + динамика
  if(c.ebitdaMarg != null){
    const nn = norm('ebitdaMarg');
    if(nn && !isFin && c.ebitdaMarg < nn.red) add('red', `Маржа EBITDA ${f1(c.ebitdaMarg)}%`, `Маржа ниже красной черты отрасли (${f1(nn.red)}%) — бизнес малорентабелен на операционном уровне.`);
    else if(nn && !isFin && c.ebitdaMarg < nn.green) add('yellow', `Маржа EBITDA ${f1(c.ebitdaMarg)}%`, `Маржа ниже зелёной зоны отрасли (${f1(nn.green)}%).`);
    if(p.ebitdaMarg != null){
      const d = c.ebitdaMarg - p.ebitdaMarg;
      if(d <= -3) add('yellow', `Маржа EBITDA ${f1(d)} пп`, 'Маржа сжимается — растут издержки или падают цены. Прибыльность каждого рубля выручки снижается.');
      else if(d >= 3) add('green', `Маржа EBITDA +${f1(d)} пп`, 'Маржа расширяется — операционная эффективность растёт.');
    }
  }
  if(isFin){
    add('yellow', 'Финансовая компания', 'Классические ND/EBITDA, ICR, текущая ликвидность к банкам/лизингу/МФО почти неприменимы (их «долг» — это бизнес). Смотри на достаточность капитала, ROE и качество портфеля.');
  }

  // OPEX ↓ ≠ эффективность: расходы могли упасть вместе с масштабом бизнеса.
  // OPEX ≈ выручка − EBIT (операционные издержки). Смотрим на ДОЛЮ расходов.
  if(c.rev != null && c.ebit != null && p.rev != null && p.ebit != null && c.rev > 0 && p.rev > 0){
    const costC = c.rev - c.ebit, costP = p.rev - p.ebit;
    const ratioC = costC / c.rev, ratioP = costP / p.rev;   // доля расходов в выручке
    if(costC < costP){   // расходы в абсолюте снизились
      if(ratioC <= ratioP - 0.01) add('green', `Расходы/выручка ${f1(ratioP * 100)}→${f1(ratioC * 100)}%`, 'Расходы снизились быстрее выручки — рост операционной эффективности (доля издержек упала).');
      else if(c.rev < p.rev) add('yellow', 'Расходы упали вместе с масштабом', 'Издержки снизились, но и выручка упала, а доля расходов не улучшилась — это сжатие бизнеса, а не рост эффективности. Ставь рядом: OPEX + выручку + объёмы/активность.');
    }
  }

  // Долговая нагрузка (уровень) — пороги по отрасли, если известна
  if(c.nde != null && !isFin){
    const nn = norm('nde');   // higher=false: green ≤, red >
    const red = nn?.red ?? 4, yel = nn?.green ?? 3;
    const suf = nn ? ' (норма отрасли)' : '';
    if(c.nde > red) add('red', `Чистый долг/EBITDA ${f1(c.nde)}x`, `Высокая долговая нагрузка — выше красной черты отрасли (${f1(red)}x)${suf}. Чувствительность к ставкам и рефинансированию высокая.`);
    else if(c.nde > yel) add('yellow', `Чистый долг/EBITDA ${f1(c.nde)}x`, `Повышенная нагрузка — выше зелёной зоны отрасли (${f1(yel)}x)${suf}, но не критично.`);
  }
  // Долговая нагрузка (динамика)
  if(c.nde != null && p.nde != null && c.nde - p.nde >= 1 && !isFin) {
    add('yellow', `Долг вырос: ND/EBITDA ${f1(p.nde)}→${f1(c.nde)}x`, 'Долговая нагрузка заметно выросла год к году — либо набрали долг, либо просела EBITDA.');
  }

  // Покрытие процентов — пороги по отрасли
  if(c.icr != null && !isFin){
    const nn = norm('icr');   // higher=true: green ≥, red <
    const red = nn?.red ?? 1.5, grn = nn?.green ?? 3;
    if(c.icr < red) add('red', `Покрытие процентов ${f1(c.icr)}x`, `Операционной прибыли едва хватает на проценты (ниже ${f1(red)}x по отрасли) — при ухудшении бизнеса или росте ставок риск обслуживания долга.`);
    else if(c.icr < grn) add('yellow', `Покрытие процентов ${f1(c.icr)}x`, `Покрытие ниже комфортного уровня отрасли (${f1(grn)}x) — следи, чтобы не снижалось.`);
  }

  // Ликвидность — пороги по отрасли
  if(c.currentR != null && !isFin){
    const nn = norm('currentR');
    const red = nn?.red ?? 1, grn = nn?.green ?? 1.2;
    if(c.currentR < red) add('red', `Текущая ликвидность ${f1(c.currentR)}x`, 'Краткосрочных обязательств больше оборотных активов — риск кассовых разрывов, если не рефинансировать.');
    else if(c.currentR < grn) add('yellow', `Текущая ликвидность ${f1(c.currentR)}x`, 'Ликвидность на грани нормы отрасли — подушка тонкая.');
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

  // Piotroski F-score (адаптирован: 8 сигналов из 9 — эмиссию акций не
  // проверяем, нет истории числа акций; CFO оценивается как ЧП + амортизация,
  // амортизация ≈ EBITDA − EBIT).
  const fs = (() => {
    const daC = (c.ebitda != null && c.ebit != null) ? c.ebitda - c.ebit : null;
    const cfoC = (c.np != null && daC != null) ? c.np + daC : null;
    const roaC = c.assets ? c.np / c.assets : null, roaP = p.assets ? p.np / p.assets : null;
    const levC = c.assets ? c.debt / c.assets : null, levP = p.assets ? p.debt / p.assets : null;
    const atC = c.assets ? c.rev / c.assets : null, atP = p.assets ? p.rev / p.assets : null;
    const sig = [];
    const s = (ok, label) => sig.push({ ok: !!ok, label });
    s(c.np > 0, 'Прибыль положительна');
    s(cfoC != null && cfoC > 0, 'Операц. денежный поток > 0 (оценка)');
    s(roaC != null && roaP != null && roaC > roaP, 'ROA растёт');
    s(cfoC != null && c.np != null && cfoC > c.np, 'Денежный поток > прибыли (качество прибыли)');
    s(levC != null && levP != null && levC < levP, 'Долговая нагрузка снижается');
    s(c.currentR != null && p.currentR != null && c.currentR > p.currentR, 'Ликвидность растёт');
    s(c.ebitdaMarg != null && p.ebitdaMarg != null && c.ebitdaMarg > p.ebitdaMarg, 'Маржа растёт');
    s(atC != null && atP != null && atC > atP, 'Оборачиваемость активов растёт');
    return { value: sig.filter(x => x.ok).length, max: sig.length, signals: sig };
  })();
  if(fs.value >= 7) add('green', `F-score ${fs.value}/${fs.max}`, 'Сильный финансовый профиль по Пиотроски — прибыльность, денежный поток и структура баланса улучшаются.');
  else if(fs.value <= 3) add('red', `F-score ${fs.value}/${fs.max}`, 'Слабый профиль по Пиотроски — по большинству сигналов динамика ухудшается. Классически такие бумаги избегают.');
  else add('yellow', `F-score ${fs.value}/${fs.max}`, 'Средний профиль по Пиотроски — часть сигналов за, часть против.');

  const counts = { red: 0, yellow: 0, green: 0 };
  for(const fl of flags) counts[fl.level]++;
  let verdict;
  if(counts.red > 0) verdict = { level: 'red', text: 'Есть серьёзные тревожные сигналы — разберись до сделки.' };
  else if(counts.yellow >= 2) verdict = { level: 'yellow', text: 'Несколько моментов требуют внимания.' };
  else if(counts.yellow === 1) verdict = { level: 'yellow', text: 'В целом нормально, один момент под наблюдение.' };
  else verdict = { level: 'green', text: 'Динамика без явных тревог.' };
  if(!flags.length) add('green', 'Существенных изменений нет', 'Ключевые показатели год к году без резких движений.');

  return {
    year: cur.fy_year, prevYear: prev.fy_year, std: cur.std || prev.std || null,
    flags, counts, verdict, fscore: fs, industry: industry ? industryWhy(industry) : null,
  };
}
