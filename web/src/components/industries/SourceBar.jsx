// Панель источников — какие подмножества эмитентов вообще видны для
// добавления в радар. Чек-боксы комбинируются. industry — отдельным
// dropdown'ом, активна когда чек-бокс «отрасль» включён.

import { Eye } from 'lucide-react';
import { useComparison } from '../../store/comparison.js';
import { INDUSTRY_GROUPS } from '../../data/industries.js';

const SOURCES = [
  { id: 'recent',     label: 'Просмотренные' },
  { id: 'portfolio',  label: 'Портфель' },
  { id: 'favorites',  label: 'Избранное' },
  { id: 'industry',   label: 'Отрасль' },
  { id: 'all',        label: 'Все' },
];

export default function SourceBar(){
  const sources       = useComparison(s => s.sources);
  const setSource     = useComparison(s => s.setSource);
  const industryFilter = useComparison(s => s.industryFilter);
  const setInd        = useComparison(s => s.setIndustryFilter);

  return (
    <div className="flex items-center flex-wrap gap-2">
      <span className="text-text3 text-[10px] uppercase tracking-wider font-mono mr-1">источник</span>
      {SOURCES.map(src => {
        const on = !!sources[src.id];
        return (
          <button
            key={src.id}
            type="button"
            onClick={() => setSource(src.id, !on)}
            className={[
              'px-2.5 py-1 rounded text-xs font-mono border transition-colors',
              on
                ? 'bg-acc-dim text-acc border-acc/40'
                : 'bg-s2 text-text2 border-border hover:text-text hover:border-border2',
            ].join(' ')}
          >
            {src.label}
          </button>
        );
      })}
      {sources.industry && (
        <select
          value={industryFilter || ''}
          onChange={e => setInd(e.target.value || null)}
          className="bg-s2 border border-border rounded px-2 h-7 text-[11px] font-mono focus:border-acc"
        >
          <option value="">— выбрать отрасль —</option>
          {INDUSTRY_GROUPS.map(g => (
            <optgroup key={g.id} label={g.label}>
              {g.items.map(it => (
                <option key={it.id} value={it.id}>{it.label}</option>
              ))}
            </optgroup>
          ))}
        </select>
      )}
      <div className="ml-auto flex items-center gap-1 text-text3 text-[10px] font-mono">
        <Eye size={11} /> слои:
        <LayerToggle kind="stock"  label="Акции" />
        <LayerToggle kind="bond"   label="Облиг." />
        <LayerToggle kind="future" label="Фьюч." />
      </div>
    </div>
  );
}

// Цветовые токены под три слоя — повторяют colorPalette.js. Tailwind
// JIT не подхватывает динамически собранные имена, поэтому пишем
// полные классы статикой.
const LAYER_ON = {
  stock:  'border-green/40 text-green bg-green/10',
  bond:   'border-acc/40 text-acc bg-acc-dim/40',
  future: 'border-purple/40 text-purple bg-purple/10',
};

function LayerToggle({ kind, label }){
  const on = useComparison(s => s.showLayer[kind]);
  const toggle = useComparison(s => s.toggleLayer);
  return (
    <button
      type="button"
      onClick={() => toggle(kind)}
      className={[
        'px-1.5 py-0.5 rounded border',
        on ? LAYER_ON[kind] : 'border-border text-text3',
      ].join(' ')}
    >{label}</button>
  );
}
