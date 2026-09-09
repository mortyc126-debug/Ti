// What-if: как шок по ставке и выручке двигает EBITDA / ND-EBITDA / ICR / FCF.
// Модель простая и честная (допущения видны в UI):
//   • рост ставки бьёт по процентным расходам на ПЛАВАЮЩЕЙ части долга;
//   • изменение выручки доходит до EBITDA через «дроп-тру» (% прохождения);
//   • текущие проценты выводим из ICR (проценты = EBITDA / ICR).
// Единицы raw-полей сокращаются в отношениях; EBITDA/FCF показываем как есть.

export function computeScenario(m, opts = {}){
  if(!m) return null;
  const { rateShock = 0, floatShare = 50, revShock = 0, dropthrough = 60 } = opts;
  const ebitda = m.ebitdaRaw, debt = m.debtRaw, cash = m.cashRaw, rev = m.revRaw, fcf = m.fcfRaw;
  if(ebitda == null || ebitda <= 0) return null;

  const int0 = (m.icr && m.icr > 0) ? ebitda / m.icr : null;    // текущие проценты
  const dEbitda = (rev != null) ? rev * (revShock / 100) * (dropthrough / 100) : 0;
  const ebitda1 = ebitda + dEbitda;
  const extraInt = (debt != null) ? debt * (floatShare / 100) * (rateShock / 100) : 0;
  const int1 = int0 != null ? int0 + extraInt : null;

  return {
    ebitda0: ebitda, ebitda1,
    nde0: (debt != null && cash != null) ? (debt - cash) / ebitda : null,
    nde1: (debt != null && cash != null) ? (debt - cash) / ebitda1 : null,
    icr0: m.icr ?? null,
    icr1: (int1 != null && int1 > 0) ? ebitda1 / int1 : null,
    fcf0: fcf ?? null,
    fcf1: fcf != null ? fcf + dEbitda - extraInt : null,
    extraInt, dEbitda,
    hasDebt: debt != null, hasFcf: fcf != null, hasInt: int0 != null,
  };
}
