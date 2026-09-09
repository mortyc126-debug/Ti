// Тепловая карта сравнения: строки — компании, столбцы — метрики.
// Цвет ячейки по перцентильному рангу в выборке (красный худший →
// зелёный лучший; для метрик «меньше=лучше» ранг уже инвертирован в
// buildRadarData). В ячейке — сырое значение. Наведение на строку
// синхронизируется с радаром/панелью через hoveredKey.

import { useMemo } from 'react';
import { buildRadarData } from '../../lib/comparisonSet.js';
import { shortIssuerName } from '../../lib/issuerMatch.js';

const KIND_LABEL = { stock: 'акции', bond: 'облиг.', future: 'фьюч.' };

// Ранг 0..100 → цвет: 0 красный, 50 янтарь, 100 зелёный.
function rankColor(rank){
  if(rank == null || !isFinite(rank)) return 'transparent';
  const hue = Math.max(0, Math.min(100, rank)) * 1.35;   // 0→0(red) 100→135(green)
  return `hsl(${hue.toFixed(0)} 62% 46%)`;
}

function fmtVal(v, fmt){
  if(v == null || !isFinite(v)) return '—';
  const n = Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
  return n + (fmt || '');
}

export default function ComparisonHeatmap({ selectedView, hoveredKey, onHover }){
  const visible = selectedView.filter(x => x.visible);
  const axes = useMemo(() => buildRadarData(selectedView), [selectedView]);

  if(!visible.length){
    return (
      <div className="h-[460px] grid place-items-center text-text3 text-sm">
        Нечего показывать. Добавь эмитентов из правой панели или включи источник.
      </div>
    );
  }
  if(!axes.length){
    return <div className="h-[460px] grid place-items-center text-text3 text-sm">Нет метрик с данными.</div>;
  }

  return (
    <div className="overflow-auto max-h-[520px]">
      <table className="border-collapse text-[11px] font-mono w-full">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-bg2 text-left text-text3 font-normal px-2 py-1.5 border-b border-border">
              Компания
            </th>
            {axes.map(a => (
              <th key={a.axisId} className="text-text3 font-normal px-2 py-1.5 border-b border-border whitespace-nowrap text-center">
                {a.axis}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.map(x => {
            const key = x.id + '|' + x.kind;
            const isHovered = hoveredKey === key;
            const isOther = hoveredKey != null && !isHovered;
            return (
              <tr
                key={key}
                onMouseEnter={() => onHover && onHover(key)}
                onMouseLeave={() => onHover && onHover(null)}
                style={{ opacity: isOther ? 0.4 : 1 }}
                className={isHovered ? 'ring-1 ring-acc' : ''}
              >
                <td className="sticky left-0 z-10 bg-bg2 px-2 py-1 border-b border-border/40 whitespace-nowrap max-w-[220px] truncate" title={x.iss.name}>
                  <span className="text-text">{shortIssuerName(x.iss.name)}</span>
                  {x.iss.ticker && <span className="text-text3 ml-1.5">{x.iss.ticker}</span>}
                  <span className="text-text3 ml-1.5 text-[9px] uppercase">{KIND_LABEL[x.kind] || x.kind}</span>
                </td>
                {axes.map(a => {
                  const rank = a[key];
                  const raw = a['raw|' + key];
                  const bg = rankColor(rank);
                  return (
                    <td
                      key={a.axisId}
                      className="px-2 py-1 border-b border-border/40 text-center"
                      style={{ background: bg === 'transparent' ? 'transparent' : `${bg}33` }}
                      title={`${a.axis}: ранг ${rank == null ? '—' : Math.round(rank)}`}
                    >
                      <span style={{ color: bg === 'transparent' ? '#6b7280' : bg, fontWeight: 600 }}>
                        {fmtVal(raw, a.fmt)}
                      </span>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="text-text3 text-[10px] mt-2 flex items-center gap-2">
        <span>ранг в выборке:</span>
        <span className="inline-flex items-center gap-1">
          <span className="w-3 h-3 rounded-sm inline-block" style={{ background: rankColor(5) }} />худший
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="w-3 h-3 rounded-sm inline-block" style={{ background: rankColor(50) }} />средний
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="w-3 h-3 rounded-sm inline-block" style={{ background: rankColor(100) }} />лучший
        </span>
        <span className="ml-auto">цвет — перцентиль по столбцу; в ячейке — сырое значение</span>
      </div>
    </div>
  );
}
