// Радар сравнения. Каждая видимая компания — отдельный полигон.
// При наведении (как на полигон, так и на строку в правой панели —
// hoveredKey прокидывается сверху) полигон выделяется, остальные
// уходят в фон. На вершинах выделенного — числовые значения метрик.
// В углу радара во время hover'а — карточка с именем эмитента и
// типом бумаги, чтобы было ясно «кто это» когда список длинный.

import { useMemo } from 'react';
import {
  RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar,
  ResponsiveContainer,
} from 'recharts';
import { buildRadarData } from '../../lib/comparisonSet.js';
import { colorFor, fillOpacity, strokeOpacity } from './colorPalette.js';

const KIND_LABEL = { stock: 'акции', bond: 'облиг.', future: 'фьюч.' };

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

  // Подсвеченная компания — для карточки в углу радара.
  const hoveredItem = hoveredKey
    ? visible.find(x => (x.id + '|' + x.kind) === hoveredKey)
    : null;
  const hoveredColor = hoveredItem
    ? colorFor(hoveredItem.kind, idxInKind.get(hoveredKey), totalInKind[hoveredItem.kind])
    : null;

  return (
    <div className="h-[460px] relative">
      {hoveredItem && (
        <NameCard
          item={hoveredItem}
          color={hoveredColor}
        />
      )}
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
// Выводится за вершину (~14px наружу), на одной линии с подписью оси
// — сама подпись оси отжата на 14px дальше, поэтому не сталкиваются.
function ValueLabel({ x, y, cx, cy, payload, dataKey, color }){
  if(payload == null) return null;
  const raw = payload['raw|' + dataKey];
  if(raw == null || !isFinite(raw)) return null;
  const fmt = payload.fmt || '';
  const dx = x - cx, dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;
  const k = (dist + 6) / dist;
  const text = format(raw, fmt);
  // Ширина бэйджа подгоняется под длину текста, чтобы коротые числа
  // не плавали в большом прямоугольнике.
  const w = Math.max(28, text.length * 6 + 8);
  return (
    <g pointerEvents="none">
      <rect
        x={cx + dx * k - w / 2} y={cy + dy * k - 8}
        width={w} height="15" rx="3"
        fill="#0a0e14" fillOpacity="0.92" stroke={color} strokeOpacity="0.7"
      />
      <text
        x={cx + dx * k} y={cy + dy * k + 3}
        fill={color}
        fontSize="10" fontWeight="600"
        fontFamily="JetBrains Mono, monospace"
        textAnchor="middle"
      >{text}</text>
    </g>
  );
}

// Карточка-индикатор «кто сейчас выделен» — рисуется в углу радара
// поверх SVG. Полезно когда список справа длинный и подсвеченную
// строку не видно без скролла.
function NameCard({ item, color }){
  const iss = item.iss;
  return (
    <div
      className="absolute top-2 left-2 z-10 bg-bg2/95 border rounded px-3 py-1.5 shadow-card pointer-events-none flex items-center gap-2"
      style={{ borderColor: color }}
    >
      <span
        className="w-2.5 h-2.5 rounded-full inline-block shrink-0"
        style={{ background: color }}
      />
      <span className="font-mono text-text text-sm truncate max-w-[260px]">
        {iss.name}
        {iss.ticker && <span className="text-text3 ml-1.5 text-[11px]">{iss.ticker}</span>}
      </span>
      <span className="text-[10px] uppercase tracking-wider text-text3 font-mono">
        {KIND_LABEL[item.kind] || item.kind}
      </span>
    </div>
  );
}

function format(v, fmt){
  if(v == null) return '—';
  const num = Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
  return num + (fmt || '');
}

function kindLabel(k){
  return KIND_LABEL[k] || k;
}
