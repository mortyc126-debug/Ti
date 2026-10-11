// Палитра индикаторных линий из indlab (_IL_COLOR_DEFAULTS, см. оформление.txt).
// Единый визуальный язык с остальными разделами: бирюза/лосось/голубой/фиолет/
// индиго/оранж/серый/розовый/тил. Без жёлтого — намеренно (плохо читается).
export const INDICATOR_COLORS = {
  bullish: '#52F2C9',   // позитив / «хорошо»
  bearish: '#FF4D7A',   // негатив / «плохо»
  blue:    '#3DD9FF',
  violet:  '#B45CFF',
  indigo:  '#7B61FF',
  orange:  '#FF8800',
  gray:    '#9090BB',
  pink:    '#FF2FAE',
  teal:    '#6CC9C5',
  accent:  '#FF006E',   // неоновая маджента — акцент чарт-панели
};

// Циклический набор для серий (веса по бумагам, категории) — порядок подобран
// так, чтобы соседние цвета не сливались на тонких элементах.
export const SERIES_CYCLE = [
  '#3DD9FF', '#B45CFF', '#52F2C9', '#FF8800', '#FF2FAE',
  '#7B61FF', '#6CC9C5', '#9090BB', '#FF4D7A', '#FF006E',
];
export const seriesColor = i => SERIES_CYCLE[((i % SERIES_CYCLE.length) + SERIES_CYCLE.length) % SERIES_CYCLE.length];
