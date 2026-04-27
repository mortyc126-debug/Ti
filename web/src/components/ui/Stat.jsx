// Карточка-метрика для KPI. Поддерживает delta (% или абсолют) и иконку.
// Цвет дельты по знаку, accent — крупное значение акцентным цветом.

export default function Stat({
  label,
  value,
  sub,
  delta,
  deltaSuffix = '%',
  icon: Icon,
  accent = false,
  size = 'md',
}){
  const sign = typeof delta === 'number' ? Math.sign(delta) : 0;
  const deltaCls = sign > 0 ? 'text-green' : sign < 0 ? 'text-danger' : 'text-text3';
  const deltaArr = sign > 0 ? '▲' : sign < 0 ? '▼' : '·';
  const valSize = size === 'sm' ? 'text-lg' : size === 'lg' ? 'text-3xl' : 'text-2xl';

  return (
    <div className="bg-s2/60 border border-border rounded-lg p-4 hover:border-border2 transition-colors">
      <div className="flex items-center justify-between gap-2">
        <div className="text-text3 text-[10px] font-mono uppercase tracking-wider truncate">{label}</div>
        {Icon && <Icon size={14} className="text-text3 shrink-0" />}
      </div>
      <div className={[valSize, 'font-mono mt-1.5', accent ? 'text-acc' : 'text-text'].join(' ')}>
        {value ?? '—'}
      </div>
      <div className="flex items-center justify-between gap-2 mt-1">
        {sub && <div className="text-text3 text-[11px] font-mono truncate">{sub}</div>}
        {delta != null && (
          <div className={[deltaCls, 'font-mono text-[11px] ml-auto'].join(' ')}>
            {deltaArr} {Math.abs(delta).toFixed(deltaSuffix === '%' ? 2 : 0)}{deltaSuffix}
          </div>
        )}
      </div>
    </div>
  );
}
