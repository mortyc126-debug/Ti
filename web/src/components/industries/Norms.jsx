// Редактор норм по группам отраслей. Таблица: строка = группа,
// столбец = метрика. Каждая ячейка показывает текущую эффективную
// норму с источником (точка-цвет + tooltip), позволяет редактировать
// green/red и сбросить на дефолт.

import { useState } from 'react';
import { RotateCcw, Info } from 'lucide-react';
import { useIndustryNorms } from '../../store/industryNorms.js';
import { COMP_METRICS } from '../../data/comparisonMetrics.js';
import { NORM_GROUPS, NORM_METRICS } from '../../data/industryNorms.js';
import { normSourceLabel } from '../../lib/norms.js';

// Для редактора группы используем «представителя группы» как
// industryId, чтобы нормы 1:1 ложились в overrides. Берём первого
// эмитента из каталога с groupId — это даёт стабильный industryId.
function pickIndustryForGroup(groupId){
  // Для задач редактирования берём id == groupId для финансов и т.п.,
  // но overrides хранятся по individualId. Чтобы не плодить ad-hoc
  // мапы, делаем простую конвенцию: ключ override =
  // `__group:${groupId}/${metric}`. Резолвер норм проверяет сперва
  // обычный (industry/metric) override, потом group-override.
  return `__group:${groupId}`;
}

export default function Norms(){
  const autocalibrate = useIndustryNorms(s => s.autocalibrate);
  const setAutocal    = useIndustryNorms(s => s.setAutocalibrate);
  const quartileMode  = useIndustryNorms(s => s.quartileMode);
  const setQuartile   = useIndustryNorms(s => s.setQuartileMode);
  const overrides     = useIndustryNorms(s => s.overrides);
  const setOverride   = useIndustryNorms(s => s.setOverride);
  const clearAll      = useIndustryNorms(s => s.clearAll);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap bg-s2/40 border border-border rounded-lg px-4 py-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={autocalibrate}
            onChange={e => setAutocal(e.target.checked)}
            className="accent-acc"
          />
          <span className="text-text">Автокалибровка норм по базе</span>
        </label>
        <span className="text-text3 text-[11px] font-mono">
          (полураспад 2 года, винзоризация p2/p98, минимум 5 эмитентов)
        </span>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-text3 text-[11px] font-mono">P/E, ROA — зелёная зона:</span>
          <select
            value={quartileMode}
            onChange={e => setQuartile(e.target.value)}
            className="bg-s2 border border-border rounded px-2 h-7 text-[11px] font-mono"
          >
            <option value="top25">top 25%</option>
            <option value="top50">top 50%</option>
            <option value="medianPlus">median+</option>
          </select>
          <button
            type="button"
            onClick={clearAll}
            disabled={!Object.keys(overrides).length}
            className={[
              'inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-mono border',
              Object.keys(overrides).length
                ? 'border-border text-text2 hover:text-text hover:border-border2'
                : 'border-border text-text3/40 cursor-not-allowed',
            ].join(' ')}
            title="Сбросить все ручные правки"
          >
            <RotateCcw size={11} /> сбросить всё
          </button>
        </div>
      </div>

      <div className="bg-bg2 border border-border rounded-lg overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-s2/60 text-text3 uppercase text-[10px]">
            <tr>
              <th className="text-left p-2 pl-4 sticky left-0 bg-s2/95">Группа</th>
              {NORM_METRICS.map(m => (
                <th key={m} className="text-center p-2">
                  <div className="flex items-center justify-center gap-1">
                    {COMP_METRICS[m]?.short || m}
                    <span title={COMP_METRICS[m]?.tip} className="text-text3/70">
                      <Info size={10} />
                    </span>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {NORM_GROUPS.map(g => (
              <NormRow
                key={g.id}
                group={g}
                overrides={overrides}
                onSetOverride={setOverride}
              />
            ))}
          </tbody>
        </table>
      </div>

      <div className="text-text3 text-[11px] font-mono leading-relaxed">
        <span className="text-acc">●</span> вручную задано — переопределяет автокалибровку и дефолт ·{' '}
        <span className="text-green">●</span> авто (по реальным данным базы) ·{' '}
        <span className="text-text2">●</span> дефолт (зашит в код).
      </div>
    </div>
  );
}

function NormRow({ group, overrides, onSetOverride }){
  return (
    <tr className="border-t border-border/40">
      <td className="p-2 pl-4 sticky left-0 bg-bg2/95 font-mono text-text">
        {group.label}
      </td>
      {NORM_METRICS.map(m => (
        <NormCell
          key={m}
          groupId={group.id}
          metricId={m}
          overrides={overrides}
          onSetOverride={onSetOverride}
        />
      ))}
    </tr>
  );
}

function NormCell({ groupId, metricId, overrides, onSetOverride }){
  const [editing, setEditing] = useState(false);
  const overrideKey = pickIndustryForGroup(groupId) + '/' + metricId;
  const ov = overrides[overrideKey];
  // Дефолт берём как «как будто это эмитент группы groupId» — для
  // этого делаем виртуальный лукап: defaultNormFor по любому эмитенту
  // группы. Здесь вместо industryId передаём sentinel `__group:${id}`
  // — он не находит INDUSTRIES[...], групп резолвится в 'other'. Чтобы
  // получить нужное, дефолтную норму просто читаем из таблицы.
  const def = readGroupDefault(groupId, metricId);
  const eff = ov ? { ...ov, source: 'manual' } : def;

  if(!eff) return <td className="p-2 text-center text-text3">—</td>;

  const dot =
    eff.source === 'manual' ? 'bg-acc' :
    eff.source === 'auto'   ? 'bg-green' :
                              'bg-text3';

  if(editing){
    return (
      <td className="p-1 text-center">
        <NormEditor
          green={eff.green}
          red={eff.red}
          onCancel={() => setEditing(false)}
          onSave={v => { onSetOverride(pickIndustryForGroup(groupId), metricId, v); setEditing(false); }}
          onClear={() => { onSetOverride(pickIndustryForGroup(groupId), metricId, null); setEditing(false); }}
          isOverride={!!ov}
        />
      </td>
    );
  }

  return (
    <td
      className="p-2 text-center cursor-pointer hover:bg-s2/40"
      onClick={() => setEditing(true)}
      title={`клик — изменить · ${normSourceLabel(eff.source)}`}
    >
      <div className="inline-flex items-center gap-1.5">
        <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
        <span className="font-mono text-text">
          <span className="text-green">{fmt(eff.green)}</span>
          <span className="text-text3 mx-0.5">/</span>
          <span className="text-warn">{fmt(eff.red)}</span>
        </span>
      </div>
    </td>
  );
}

function NormEditor({ green, red, onCancel, onSave, onClear, isOverride }){
  const [g, setG] = useState(green);
  const [r, setR] = useState(red);
  return (
    <div className="inline-flex items-center gap-1 bg-bg border border-acc/40 rounded p-1">
      <input
        type="number" step="any"
        value={g}
        onChange={e => setG(parseFloat(e.target.value))}
        className="bg-bg border border-border rounded px-1 h-6 w-14 text-[11px] font-mono text-green"
        title="зелёная граница"
      />
      <span className="text-text3 text-[10px]">/</span>
      <input
        type="number" step="any"
        value={r}
        onChange={e => setR(parseFloat(e.target.value))}
        className="bg-bg border border-border rounded px-1 h-6 w-14 text-[11px] font-mono text-warn"
        title="красная граница"
      />
      <button
        onClick={() => onSave({ green: g, red: r })}
        className="px-1.5 h-6 rounded text-[10px] font-mono bg-acc text-bg hover:bg-acc/80"
      >ok</button>
      <button
        onClick={onCancel}
        className="px-1.5 h-6 rounded text-[10px] font-mono text-text3 hover:text-text"
      >×</button>
      {isOverride && (
        <button
          onClick={onClear}
          className="px-1.5 h-6 rounded text-[10px] font-mono text-warn hover:text-danger"
          title="сбросить override на дефолт"
        >↺</button>
      )}
    </div>
  );
}

function fmt(v){
  if(v == null) return '—';
  return Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1);
}

// Прямой доступ к таблице дефолтов, минуя резолвер по industryId.
import { NORMS_BY_GROUP, NORMS_UNIVERSAL, NORMS_FINANCE_OVERRIDE } from '../../data/industryNorms.js';
function readGroupDefault(groupId, metricId){
  if(NORMS_UNIVERSAL[metricId]){
    if(groupId === 'finance' && NORMS_FINANCE_OVERRIDE[metricId]){
      return { ...NORMS_FINANCE_OVERRIDE[metricId], source: 'universal-finance' };
    }
    return { ...NORMS_UNIVERSAL[metricId], source: 'universal' };
  }
  const g = NORMS_BY_GROUP[groupId];
  if(g && g[metricId]) return { ...g[metricId], source: 'group' };
  return null;
}
