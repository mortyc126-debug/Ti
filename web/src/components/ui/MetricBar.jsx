// Горизонтальная шкала-светофор для финансовых коэффициентов.
//
// Принцип: пользователь задаёт диапазон осей [min..max] и две границы
// зон [warn, good] — на оси рисуются три заливки (красная/жёлтая/зелёная)
// и маркер фактического значения. higher=false инвертирует семантику зон
// (например, для Долг/EBITDA «меньше — лучше»).

const fmt = (n, digits = 2) => {
  if(n == null || !isFinite(n)) return '—';
  return Number(n).toFixed(digits).replace(/\.?0+$/, '') || '0';
};

export default function MetricBar({
  label,
  value,
  min = 0,
  max = 1,
  warn,            // граница «плохо/средне» (по value)
  good,            // граница «средне/хорошо»
  higher = true,   // true = больше лучше; false = меньше лучше
  unit = '',
  digits = 2,
  hint,
  compact = false,
}){
  const span = Math.max(max - min, 1e-9);
  const clamp = v => Math.max(min, Math.min(max, v));
  const pct = v => ((clamp(v) - min) / span) * 100;

  // Если пороги не заданы — делим на трети.
  const w = warn ?? min + span * 0.33;
  const g = good ?? min + span * 0.66;
  // Точки разреза в процентах оси, отсортированы по возрастанию.
  const cuts = [w, g].map(pct).sort((a, b) => a - b);
  const [c1, c2] = cuts;

  // Цвета зон слева→направо. higher=true: красное слева, зелёное справа.
  const left   = higher ? 'bg-danger/30' : 'bg-green/30';
  const middle = 'bg-warn/30';
  const right  = higher ? 'bg-green/30' : 'bg-danger/30';

  const valid = value != null && isFinite(value);
  const markerPct = valid ? pct(value) : 0;

  // Зона текущего значения — для подкраски числа.
  let zone = 'mid';
  if(valid){
    if(value < w) zone = higher ? 'bad' : 'good';
    else if(value > g) zone = higher ? 'good' : 'bad';
  }
  const valTone = zone === 'good' ? 'text-green' : zone === 'bad' ? 'text-danger' : 'text-warn';

  return (
    <div className={compact ? 'py-1' : 'py-1.5'}>
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <div className="text-text2 text-xs truncate" title={hint}>{label}</div>
        <div className={`font-mono text-xs ${valid ? valTone : 'text-text3'}`}>
          {valid ? fmt(value, digits) : '—'}{unit}
        </div>
      </div>
      <div className="relative h-2 rounded-sm overflow-hidden bg-s2">
        <div className={`absolute inset-y-0 left-0 ${left}`} style={{ width: `${c1}%` }} />
        <div className={`absolute inset-y-0 ${middle}`} style={{ left: `${c1}%`, width: `${Math.max(0, c2 - c1)}%` }} />
        <div className={`absolute inset-y-0 right-0 ${right}`} style={{ width: `${100 - c2}%` }} />
        {valid && (
          <div
            className="absolute top-[-2px] bottom-[-2px] w-[2px] bg-text shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
            style={{ left: `calc(${markerPct}% - 1px)` }}
            title={`${fmt(value, digits)}${unit}`}
          />
        )}
      </div>
      {!compact && (
        <div className="flex justify-between text-text3 text-[10px] font-mono mt-0.5">
          <span>{fmt(min, digits)}{unit}</span>
          <span>{fmt(max, digits)}{unit}</span>
        </div>
      )}
    </div>
  );
}
