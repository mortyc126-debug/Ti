// Радар сравнения. Каждая видимая компания — отдельный полигон.
// Прозрачность снижается с ростом N (cap не нужен).

import { useMemo } from 'react';
import {
  RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar,
  ResponsiveContainer, Tooltip,
} from 'recharts';
import { buildRadarData } from '../../lib/comparisonSet.js';
import { colorFor, fillOpacity, strokeOpacity } from './colorPalette.js';

export default function ComparisonRadar({ selectedView }){
  const visible = selectedView.filter(x => x.visible);
  const data = useMemo(() => buildRadarData(selectedView), [selectedView]);

  if(!visible.length){
    return (
      <div className="h-[420px] grid place-items-center text-text3 text-sm">
        Нечего показывать. Добавь эмитентов из правой панели или включи источник.
      </div>
    );
  }

  // Считаем индекс внутри каждого kind для палитры.
  const idxInKind = new Map();
  const totalInKind = {};
  for(const x of visible) totalInKind[x.kind] = (totalInKind[x.kind] || 0) + 1;
  const counters = {};
  for(const x of visible){
    counters[x.kind] = (counters[x.kind] || 0);
    idxInKind.set(x.id + '|' + x.kind, counters[x.kind]++);
  }

  const op = fillOpacity(visible.length);
  const sop = strokeOpacity(visible.length);

  return (
    <div className="h-[440px]">
      <ResponsiveContainer>
        <RadarChart data={data} outerRadius="78%">
          <PolarGrid stroke="#222a37" />
          <PolarAngleAxis
            dataKey="axis"
            tick={{ fill: '#9ba3b1', fontSize: 11, fontFamily: 'JetBrains Mono, monospace' }}
          />
          <PolarRadiusAxis
            angle={90}
            domain={[0, 100]}
            tick={{ fill: '#5e6573', fontSize: 9 }}
            stroke="#222a37"
          />
          {visible.map(x => {
            const k = x.id + '|' + x.kind;
            const color = colorFor(x.kind, idxInKind.get(k), totalInKind[x.kind]);
            return (
              <Radar
                key={k}
                name={`${x.id} · ${kindLabel(x.kind)}`}
                dataKey={k}
                stroke={color}
                strokeOpacity={sop}
                fill={color}
                fillOpacity={op}
                isAnimationActive={false}
              />
            );
          })}
          <Tooltip
            contentStyle={{
              background: '#11161e', border: '1px solid #222a37',
              fontFamily: 'JetBrains Mono, monospace', fontSize: 11,
            }}
            labelStyle={{ color: '#9ba3b1' }}
            itemStyle={{ color: '#e6edf3' }}
            formatter={(value, name) => [`${Math.round(value)}/100`, name]}
          />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
}

function kindLabel(k){
  return k === 'stock' ? 'акции' : k === 'bond' ? 'облиг.' : k === 'future' ? 'фьюч.' : k;
}
