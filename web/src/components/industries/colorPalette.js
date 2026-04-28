// Цвет компании на радаре. Hue по типу бумаги (акции/облигации/фьючерсы),
// lightness/saturation вариируется от индекса в группе, чтобы соседи в
// одном слое отличались.
//
// Группы цветов:
// - stock  : зелёная семья  (HSL hue 140-170)
// - bond   : синяя           (hue 195-220)
// - future : фиолетовая      (hue 270-290)

const HUE = {
  stock:  { from: 140, to: 175 },
  bond:   { from: 195, to: 225 },
  future: { from: 270, to: 295 },
  other:  { from: 0,   to: 30  },
};

export function colorFor(kind, idxInKind = 0, totalInKind = 1){
  const range = HUE[kind] || HUE.other;
  const t = totalInKind <= 1 ? 0.5 : (idxInKind / (totalInKind - 1));
  const hue = range.from + (range.to - range.from) * t;
  // Чередуем lightness/saturation по чётности — соседи лучше различимы.
  const sat = 60 + (idxInKind % 2) * 18;
  const lig = 55 + ((idxInKind >> 1) % 2) * 8;
  return `hsl(${hue.toFixed(0)} ${sat}% ${lig}%)`;
}

// Прозрачность для полигона на радаре. Чем больше видимых на сцене,
// тем прозрачнее каждый — иначе превращается в комок.
export function fillOpacity(visibleCount){
  if(visibleCount <= 3) return 0.32;
  if(visibleCount <= 6) return 0.22;
  if(visibleCount <= 10) return 0.14;
  if(visibleCount <= 16) return 0.09;
  return 0.06;
}

// То же для линии — чуть менее агрессивно.
export function strokeOpacity(visibleCount){
  if(visibleCount <= 6) return 1.0;
  if(visibleCount <= 12) return 0.8;
  if(visibleCount <= 20) return 0.6;
  return 0.45;
}
