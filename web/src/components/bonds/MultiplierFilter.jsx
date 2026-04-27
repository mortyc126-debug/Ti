import { ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react';

// Кнопка-мультипликатор. Состоит из:
//   - Лейбл метрики (D/EBITDA, ICR и т.д.)
//   - Поля min / max
//   - Стрелка-направление: 3 состояния
//       'both'  → не учитывать (вверх+вниз)
//       'best'  → сортировать от лучших к худшим (по higher)
//       'worst' → от худших к лучшим
// Активность фильтра определяется заполнением min/max — пользовательница
// явно сказала «одновременно может быть активно любое количество».

const NEXT_DIR = { both: 'best', best: 'worst', worst: 'both' };

export default function MultiplierFilter({ spec, value, onChange }){
  const v = value || { min: '', max: '', dir: 'both' };
  const set = (patch) => onChange({ ...v, ...patch });

  const filterActive = v.min !== '' || v.max !== '';
  const sortActive   = v.dir !== 'both';

  return (
    <div
      className={[
        'flex items-center gap-1.5 px-2 py-1.5 rounded border text-xs',
        filterActive || sortActive
          ? 'bg-acc-dim/40 border-acc/40'
          : 'bg-s2 border-border hover:border-border2',
      ].join(' ')}
    >
      <button
        type="button"
        title={`Стрелка: ${dirLabel(v.dir, spec.higher)}`}
        onClick={() => set({ dir: NEXT_DIR[v.dir] })}
        className={[
          'shrink-0 w-5 h-5 grid place-items-center rounded',
          v.dir === 'both' ? 'text-text3 hover:text-text2' : 'text-acc',
        ].join(' ')}
      >
        {v.dir === 'both' && <ArrowUpDown size={12} />}
        {v.dir === 'best' && (spec.higher ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
        {v.dir === 'worst' && (spec.higher ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}
      </button>

      <span className="font-mono text-text2 truncate w-32 select-none" title={spec.label}>
        {spec.label}
      </span>

      <NumInput
        placeholder="min"
        value={v.min}
        onChange={x => set({ min: x })}
        title={`min (например ${spec.suggest}${spec.fmt})`}
      />
      <span className="text-text3">…</span>
      <NumInput
        placeholder="max"
        value={v.max}
        onChange={x => set({ max: x })}
      />
      <span className="text-text3 text-[10px] w-2.5 text-right select-none">{spec.fmt}</span>
    </div>
  );
}

function NumInput({ value, onChange, ...rest }){
  return (
    <input
      type="number" step="any"
      value={value}
      onChange={e => onChange(e.target.value)}
      className="bg-bg border border-border rounded px-1.5 h-6 w-14 font-mono text-[11px] focus:border-acc outline-none"
      {...rest}
    />
  );
}

function dirLabel(dir, higher){
  if(dir === 'both')  return 'не учитывать';
  if(dir === 'best')  return higher ? 'от лучших к худшим (↑ больше = лучше)' : 'от лучших к худшим (↓ меньше = лучше)';
  return higher ? 'от худших к лучшим' : 'от худших к лучшим';
}
