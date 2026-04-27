import { ArrowUp, ArrowDown, ArrowUpDown, Info } from 'lucide-react';

// Кнопка-мультипликатор. Клик по названию метрики переключает
// направление сортировки в цикле:
//   both → best (зелёная подсветка) → worst (красная) → both
// Поля min/max — независимый фильтр (можно активировать без
// сортировки). Стрелка справа — индикатор текущего направления и
// быстрый сброс на 'both' (одно нажатие).
//
// «best» означает «от лучших к худшим», направление лучших
// определяется spec.higher.

const NEXT_DIR = { both: 'best', best: 'worst', worst: 'both' };

export default function MultiplierFilter({ spec, value, onChange }){
  const v = value || { min: '', max: '', dir: 'both' };
  const set = (patch) => onChange({ ...v, ...patch });

  const filterActive = v.min !== '' || v.max !== '';

  // Цвет фона по dir: best — зелёный, worst — красный, both — нейтральный
  // (с подсветкой acc, если задан фильтр через min/max).
  let wrapTone = 'bg-s2 border-border';
  if(v.dir === 'best')       wrapTone = 'bg-green/10 border-green/40';
  else if(v.dir === 'worst') wrapTone = 'bg-danger/10 border-danger/40';
  else if(filterActive)      wrapTone = 'bg-acc-dim/40 border-acc/30';

  return (
    <div className={`flex items-center gap-1.5 px-2 py-1.5 rounded border text-xs transition-colors hover:border-border2 ${wrapTone}`}>
      <button
        type="button"
        onClick={() => set({ dir: NEXT_DIR[v.dir] })}
        title={`${spec.tip ? spec.tip + '\n\n' : ''}клик: ${dirHint(v.dir, spec.higher)}`}
        className={[
          'flex items-center gap-1 flex-1 min-w-0 text-left',
          v.dir !== 'both' ? 'text-text' : 'text-text2 hover:text-text',
        ].join(' ')}
      >
        <span className="font-mono truncate">{spec.label}</span>
        {spec.tip && <Info size={10} className="text-text3 shrink-0" />}
      </button>

      <NumInput placeholder="min" value={v.min} onChange={x => set({ min: x })} title={`min, например ${spec.suggest}${spec.fmt}`} />
      <span className="text-text3 select-none">–</span>
      <NumInput placeholder="max" value={v.max} onChange={x => set({ max: x })} />
      <span className="text-text3 text-[10px] w-2.5 text-right select-none">{spec.fmt}</span>

      <button
        type="button"
        title={v.dir === 'both' ? 'сортировка не активна' : 'сбросить сортировку'}
        onClick={() => set({ dir: 'both' })}
        className={[
          'shrink-0 w-5 h-5 grid place-items-center rounded',
          v.dir === 'both' ? 'text-text3' : 'text-text hover:bg-bg/40',
        ].join(' ')}
      >
        {v.dir === 'both' && <ArrowUpDown size={12} />}
        {v.dir === 'best' && (spec.higher ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
        {v.dir === 'worst' && (spec.higher ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}
      </button>
    </div>
  );
}

function NumInput({ value, onChange, ...rest }){
  return (
    <input
      type="number" step="any"
      value={value}
      onChange={e => onChange(e.target.value)}
      onClick={e => e.stopPropagation()}
      className="bg-bg border border-border rounded px-1.5 h-6 w-14 font-mono text-[11px] focus:border-acc outline-none"
      {...rest}
    />
  );
}

function dirHint(dir, higher){
  if(dir === 'both')  return higher ? 'включить сортировку от лучших (по убыванию)' : 'включить сортировку от лучших (по возрастанию)';
  if(dir === 'best')  return 'переключить на «от худших»';
  return 'выключить сортировку';
}
