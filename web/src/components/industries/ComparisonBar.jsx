// Барный вид сравнения: одна метрика — горизонтальные бары по компаниям,
// отсортированные по рангу. Длина бара = перцентильный ранг в выборке,
// подпись — сырое значение. Цвет по типу бумаги. Наведение синхронно с
// радаром/панелью через hoveredKey.

import { useMemo, useState } from 'react';
import { buildRadarData } from '../../lib/comparisonSet.js';
import { colorFor } from './colorPalette.js';

const KIND_LABEL = { stock: 'акции', bond: 'облиг.', future: 'фьюч.' };

function fmtVal(v, fmt){
  if(v == null || !isFinite(v)) return '—';
  const n = Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
  return n + (fmt || '');
}

export default function ComparisonBar({ selectedView, hoveredKey, onHover }){
  const visible = selectedView.filter(x => x.visible);
  const axes = useMemo(() => buildRadarData(selectedView), [selectedView]);
  const [metricId, setMetricId] = useState(null);

  // Активная ось: выбранная (если ещё есть в данных) или первая.
  const axis = useMemo(() => {
    if(!axes.length) return null;
    return axes.find(a => a.axisId === metricId) || axes[0];
  }, [axes, metricId]);

  // индекс внутри kind для палитры (как на радаре).
  const { idxInKind, totalInKind } = useMemo(() => {
    const idx = new Map(); const tot = {};
    for(const x of visible) tot[x.kind] = (tot[x.kind] || 0) + 1;
    const c = {};
    for(const x of visible){ c[x.kind] = c[x.kind] || 0; idx.set(x.id + '|' + x.kind, c[x.kind]++); }
    return { idxInKind: idx, totalInKind: tot };
  }, [visible]);

  if(!visible.length){
    return (
      <div className="h-[460px] grid place-items-center text-text3 text-sm">
        Нечего показывать. Добавь эмитентов из правой панели или включи источник.
      </div>
    );
  }
  if(!axis){
    return <div className="h-[460px] grid place-items-center text-text3 text-sm">Нет метрик с данными.</div>;
  }

  // Строки, отсортированные по рангу (лучшие сверху).
  const rows = visible
    .map(x => {
      const key = x.id + '|' + x.kind;
      return { x, key, rank: axis[key] ?? 0, raw: axis['raw|' + key] };
    })
    .sort((a, b) => b.rank - a.rank);

  return (
    <div className="space-y-3">
      {/* выбор метрики */}
      <div className="flex flex-wrap gap-1.5">
        {axes.map(a => (
          <button
            key={a.axisId} type="button"
            onClick={() => setMetricId(a.axisId)}
            className={['px-2.5 py-1 rounded text-xs border transition-colors',
              a.axisId === axis.axisId ? 'bg-acc-dim text-acc border-acc/40' : 'bg-bg2 text-text2 border-border hover:text-text'].join(' ')}
          >{a.axis}</button>
        ))}
      </div>

      <div className="space-y-1">
        {rows.map(({ x, key, rank, raw }) => {
          const color = colorFor(x.kind, idxInKind.get(key), totalInKind[x.kind]);
          const isHovered = hoveredKey === key;
          const isOther = hoveredKey != null && !isHovered;
          return (
            <div
              key={key}
              onMouseEnter={() => onHover && onHover(key)}
              onMouseLeave={() => onHover && onHover(null)}
              className="flex items-center gap-2 cursor-default"
              style={{ opacity: isOther ? 0.4 : 1 }}
            >
              <div className="w-[180px] shrink-0 truncate text-[11px] font-mono text-right">
                <span className="text-text">{x.iss.name}</span>
                {x.iss.ticker && <span className="text-text3 ml-1 text-[10px]">{x.iss.ticker}</span>}
              </div>
              <div className="flex-1 h-5 bg-s2/40 rounded-sm relative overflow-hidden">
                <div
                  className="h-full rounded-sm transition-all"
                  style={{
                    width: `${Math.max(0, Math.min(100, rank))}%`,
                    background: color,
                    opacity: isHovered ? 1 : 0.72,
                    outline: isHovered ? `1px solid ${color}` : 'none',
                  }}
                />
                <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] font-mono font-semibold text-text">
                  {fmtVal(raw, axis.fmt)}
                </span>
              </div>
              <span className="w-8 shrink-0 text-[9px] font-mono text-text3 text-right">
                {Math.round(rank)}
              </span>
            </div>
          );
        })}
      </div>
      <div className="text-text3 text-[10px]">
        Длина бара — перцентильный ранг в выборке (лучший = 100); справа — сырое значение и ранг. Цвет по типу бумаги: {KIND_LABEL.stock} · {KIND_LABEL.bond} · {KIND_LABEL.future}.
      </div>
    </div>
  );
}
