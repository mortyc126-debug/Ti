// Радар сравнения. Каждая видимая компания — отдельный полигон.
// При наведении (как на полигон, так и на строку в правой панели —
// hoveredKey прокидывается сверху) полигон выделяется, остальные
// уходят в фон. На вершинах выделенного — числовые значения метрик.

import { useMemo } from 'react';
import {
  RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar,
  ResponsiveContainer,
} from 'recharts';
import { buildRadarData } from '../../lib/comparisonSet.js';
import { colorFor, fillOpacity, strokeOpacity } from './colorPalette.js';

export default function ComparisonRadar({ selectedView, hoveredKey, onHover }){
  const visible = selectedView.filter(x => x.visible);
  const data = useMemo(() => buildRadarData(selectedView), [selectedView]);

  if(!visible.length){
    return (
      <div className="h-[460px] grid place-items-center text-text3 text-sm">
        Нечего показывать. Добавь эмитентов из правой панели или включи источник.
      </div>
    );
  }

  // Индекс внутри kind для палитры.
  const idxInKind = new Map();
  const totalInKind = {};
  for(const x of visible) totalInKind[x.kind] = (totalInKind[x.kind] || 0) + 1;
  const counters = {};
  for(const x of visible){
    counters[x.kind] = (counters[x.kind] || 0);
    idxInKind.set(x.id + '|' + x.kind, counters[x.kind]++);
  }

  const baseFill = fillOpacity(visible.length);
  const baseStroke = strokeOpacity(visible.length);

  return (
    <div className="h-[460px]">
      <ResponsiveContainer>
        <RadarChart data={data} outerRadius="72%" margin={{ top: 22, right: 70, bottom: 16, left: 70 }}>
          <PolarGrid stroke="#222a37" />
          <PolarAngleAxis
            dataKey="axis"
            tick={(props) => <AxisTick {...props} />}
          />
          <PolarRadiusAxis
            angle={90}
            domain={[0, 100]}
            tick={{ fill: '#3a4150', fontSize: 9 }}
            stroke="#222a37"
            tickCount={5}
          />
          {visible.map(x => {
            const k = x.id + '|' + x.kind;
            const color = colorFor(x.kind, idxInKind.get(k), totalInKind[x.kind]);
            const isHovered = hoveredKey === k;
            const isOther   = hoveredKey != null && !isHovered;

            const fOp = isHovered ? 0.55 : (isOther ? 0.04 : baseFill);
            const sOp = isHovered ? 1    : (isOther ? 0.18 : baseStroke);
            const sw  = isHovered ? 2.4  : 1.2;

            return (
              <Radar
                key={k}
                name={`${x.id} · ${kindLabel(x.kind)}`}
                dataKey={k}
                stroke={color}
                strokeOpacity={sOp}
                strokeWidth={sw}
                fill={color}
                fillOpacity={fOp}
                isAnimationActive={false}
                onMouseEnter={() => onHover && onHover(k)}
                onMouseLeave={() => onHover && onHover(null)}
                label={isHovered ? (props) => <ValueLabel {...props} dataKey={k} color={color} /> : false}
              />
            );
          })}
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
}

// Подпись оси (метрика). Чуть подальше от полигона, чтобы не липло
// к линиям; цвет — приглушённый, hover-эффектами не управляем.
function AxisTick({ x, y, cx, cy, payload }){
  const dx = x - cx, dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;
  // 14px дальше от центра.
  const k = (dist + 14) / dist;
  const tx = cx + dx * k, ty = cy + dy * k;
  return (
    <text
      x={tx} y={ty}
      fill="#9ba3b1"
      fontSize="11"
      fontFamily="JetBrains Mono, monospace"
      textAnchor="middle"
      dominantBaseline="middle"
    >{payload.value}</text>
  );
}

// Числовая метка сырого значения на вершине выделенного полигона.
// Выводится за вершину (~10px наружу).
function ValueLabel({ x, y, cx, cy, payload, dataKey, color }){
  if(payload == null) return null;
  const raw = payload['raw|' + dataKey];
  if(raw == null || !isFinite(raw)) return null;
  const fmt = payload.fmt || '';
  const dx = x - cx, dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;
  const k = (dist + 10) / dist;
  return (
    <g pointerEvents="none">
      <rect
        x={cx + dx * k - 14} y={cy + dy * k - 7}
        width="28" height="13" rx="2"
        fill="#0a0e14" fillOpacity="0.85" stroke={color} strokeOpacity="0.5"
      />
      <text
        x={cx + dx * k} y={cy + dy * k + 3}
        fill={color}
        fontSize="9"
        fontFamily="JetBrains Mono, monospace"
        textAnchor="middle"
      >{format(raw, fmt)}</text>
    </g>
  );
}

function format(v, fmt){
  if(v == null) return '—';
  const num = Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
  return num + (fmt || '');
}

function kindLabel(k){
  return k === 'stock' ? 'акции' : k === 'bond' ? 'облиг.' : k === 'future' ? 'фьюч.' : k;
}
