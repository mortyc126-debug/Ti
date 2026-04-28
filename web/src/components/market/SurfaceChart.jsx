// Чарт поверхности: фоновая тепловая карта E[YTM | срок, качество]
// + scatter точек, окрашенных по z-score residual'а. Размер точки —
// объём выпуска. Hover показывает тултип. Клик отмечает точку как
// selected (и потенциально открывает окно эмитента — TODO).

import { useMemo, useRef, useState } from 'react';
import { useMarketSurface } from '../../store/marketSurface.js';
import { ytmColor, zScoreColor } from '../../lib/kernelSurface.js';
import { ratingTier, tierColor } from '../../lib/qualityComposite.js';

const PAD = { top: 16, right: 32, bottom: 36, left: 48 };
const W = 880, H = 480;     // viewBox; ResponsiveContainer не нужен — используем preserveAspectRatio

export default function SurfaceChart({ fitted }){
  const showHeatmap = useMarketSurface(s => s.showHeatmap);
  const yMode       = useMarketSurface(s => s.yMode);
  const hoverId     = useMarketSurface(s => s.hoverId);
  const setHover    = useMarketSurface(s => s.setHover);
  const setSelected = useMarketSurface(s => s.setSelected);
  const selectedId  = useMarketSurface(s => s.selectedId);

  const { points, gridExpected } = fitted || { points: [], gridExpected: null };
  const ref = useRef(null);

  // Bbox для шкал (с подушкой). Если нет точек — дефолт.
  const bbox = useMemo(() => {
    if(!points.length){
      return { xMin: 0, xMax: 10, yMin: 0, yMax: 100 };
    }
    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    let xMin = Math.min(...xs), xMax = Math.max(...xs);
    let yMin = Math.min(...ys), yMax = Math.max(...ys);
    // 10% подушки.
    const padX = (xMax - xMin) * 0.08 + 0.2;
    const padY = (yMax - yMin) * 0.06 + 2;
    xMin -= padX; xMax += padX;
    yMin -= padY; yMax += padY;
    yMin = Math.max(0, yMin);
    yMax = Math.min(100, yMax);
    return { xMin, xMax, yMin, yMax };
  }, [points]);

  // Маппинг (x_data → x_screen, y_data → y_screen). Y инвертирован
  // (большее качество — выше на экране).
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const sx = v => PAD.left + (v - bbox.xMin) / (bbox.xMax - bbox.xMin) * innerW;
  const sy = v => PAD.top + (1 - (v - bbox.yMin) / (bbox.yMax - bbox.yMin)) * innerH;

  // Размер точки от объёма (мин 4, макс 14). Лог-шкала.
  const sr = (vol) => {
    if(!vol || vol <= 0) return 4;
    const t = Math.log10(vol);                   // ~0..2.2 для bn руб.
    return 4 + Math.max(0, Math.min(1, t / 2.2)) * 10;
  };

  // Тики. Срок — целые годы; Y — каждые 20 ord-пунктов.
  const xTicks = useMemo(() => {
    const ticks = [];
    const start = Math.ceil(bbox.xMin);
    const end = Math.floor(bbox.xMax);
    let step = 1;
    if(end - start > 12) step = 2;
    if(end - start > 25) step = 5;
    for(let v = start; v <= end; v += step) ticks.push(v);
    return ticks;
  }, [bbox.xMin, bbox.xMax]);

  const yTicks = useMemo(() => {
    const ticks = [];
    for(let v = 0; v <= 100; v += 20){
      if(v >= bbox.yMin && v <= bbox.yMax) ticks.push(v);
    }
    return ticks;
  }, [bbox.yMin, bbox.yMax]);

  // Hover-состояние (локальное — координаты курсора для оверлея).
  const [tip, setTip] = useState(null);

  const onPointEnter = (p, e) => {
    setHover(p.secid);
    const r = ref.current?.getBoundingClientRect();
    if(!r) return;
    setTip({
      p,
      x: e.clientX - r.left,
      y: e.clientY - r.top,
    });
  };
  const onPointLeave = () => {
    setHover(null);
    setTip(null);
  };

  return (
    <div className="relative" ref={ref}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto select-none" preserveAspectRatio="xMidYMid meet">
        {/* Фон-плашка */}
        <rect x={PAD.left} y={PAD.top} width={innerW} height={innerH} fill="#0a0e14" stroke="#222a37" />

        {/* Тепловая карта поверхности */}
        {showHeatmap && gridExpected && <Heatmap grid={gridExpected} sx={sx} sy={sy} />}

        {/* Сетка */}
        {xTicks.map(t => (
          <line key={'gx' + t}
            x1={sx(t)} x2={sx(t)} y1={PAD.top} y2={H - PAD.bottom}
            stroke="#1a212c" strokeDasharray="2 4" />
        ))}
        {yTicks.map(t => (
          <line key={'gy' + t}
            x1={PAD.left} x2={W - PAD.right} y1={sy(t)} y2={sy(t)}
            stroke="#1a212c" strokeDasharray="2 4" />
        ))}

        {/* Оси */}
        {xTicks.map(t => (
          <text key={'tx' + t}
            x={sx(t)} y={H - PAD.bottom + 14}
            fill="#9ba3b1" fontSize="10" fontFamily="JetBrains Mono, monospace" textAnchor="middle">
            {t}
          </text>
        ))}
        {yTicks.map(t => (
          <text key={'ty' + t}
            x={PAD.left - 6} y={sy(t) + 3}
            fill="#9ba3b1" fontSize="10" fontFamily="JetBrains Mono, monospace" textAnchor="end">
            {t}
          </text>
        ))}
        <text x={W / 2} y={H - 6} fill="#5e6573" fontSize="10" fontFamily="JetBrains Mono, monospace" textAnchor="middle">
          срок до погашения, лет
        </text>
        <text x={12} y={H / 2} fill="#5e6573" fontSize="10" fontFamily="JetBrains Mono, monospace"
          transform={`rotate(-90 12 ${H / 2})`} textAnchor="middle">
          качество ({yMode === 'rating' ? 'рейтинг' : yMode === 'mix' ? 'микс' : 'скоринг'})
        </text>

        {/* Точки */}
        {points.map(p => {
          const r = sr(p.volumeBn);
          const fill = zScoreColor(p.zscore);
          const isHover = hoverId === p.secid;
          const isSel = selectedId === p.secid;
          // В режиме mix — обводка цветом рейтингового tier'а.
          const stroke = yMode === 'mix' ? tierColor(ratingTier(p.rating)) : '#0a0e14';
          return (
            <circle key={p.secid}
              cx={sx(p.x)} cy={sy(p.y)} r={isHover ? r + 2 : r}
              fill={fill}
              stroke={isSel ? '#00d4ff' : stroke}
              strokeWidth={isSel ? 2.5 : (yMode === 'mix' ? 1.6 : 1)}
              fillOpacity={p.sparse ? 0.4 : 0.85}
              style={{ cursor: 'pointer', transition: 'r 0.1s' }}
              onMouseEnter={e => onPointEnter(p, e)}
              onMouseMove={e => onPointEnter(p, e)}
              onMouseLeave={onPointLeave}
              onClick={() => setSelected(p.secid)}
            />
          );
        })}
      </svg>
      {tip && <Tooltip tip={tip} />}
      {!points.length && (
        <div className="absolute inset-0 grid place-items-center text-text3 text-sm pointer-events-none">
          Нет точек по текущим фильтрам.
        </div>
      )}
    </div>
  );
}

// Фон-тепловая карта. Рисует прямоугольники по сетке. Координаты
// сетки — в data-coordinatах. Берём cell как прямоугольник между
// серединами соседей.
function Heatmap({ grid, sx, sy }){
  const { xs, ys, z } = grid;
  const NX = xs.length, NY = ys.length;
  const cells = [];
  for(let i = 0; i < NX - 1; i++){
    for(let j = 0; j < NY - 1; j++){
      // Среднее из 4 углов — мягче переход.
      const v = avg4(z[i][j], z[i+1][j], z[i][j+1], z[i+1][j+1]);
      const x1 = sx(xs[i]),     x2 = sx(xs[i+1]);
      const y1 = sy(ys[j+1]),   y2 = sy(ys[j]);    // Y инвертирован
      cells.push({ x: x1, y: y1, w: x2 - x1, h: y2 - y1, v });
    }
  }
  return (
    <g>
      {cells.map((c, k) => (
        <rect key={k}
          x={c.x} y={c.y} width={c.w + 0.5} height={c.h + 0.5}
          fill={ytmColor(c.v)} fillOpacity={0.55}
        />
      ))}
    </g>
  );
}

function avg4(a, b, c, d){
  const arr = [a, b, c, d].filter(x => x != null && isFinite(x));
  if(!arr.length) return null;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function Tooltip({ tip }){
  const { p } = tip;
  // Tooltip сдвигаем чтобы не перекрывал точку, но оставался в чарте.
  const left = Math.min(tip.x + 12, 700);
  const top  = Math.max(tip.y - 8, 8);
  const z = p.zscore;
  const zCls = z == null ? 'text-text3' : z > 1 ? 'text-danger' : z < -1 ? 'text-acc' : 'text-text2';
  return (
    <div
      className="absolute pointer-events-none bg-bg2 border border-border rounded px-3 py-2 shadow-cardHover text-[11px] font-mono space-y-0.5 z-10"
      style={{ left, top }}
    >
      <div className="text-text">{p.name}</div>
      <div className="text-text3">{p.secid} · {p.issuer}</div>
      <div className="border-t border-border/60 my-1" />
      <div className="text-text2">срок: <span className="text-text">{p.x.toFixed(2)} лет</span></div>
      <div className="text-text2">качество: <span className="text-text">{p.y.toFixed(0)}</span> ({p.rating || '—'})</div>
      <div className="text-text2">YTM: <span className="text-text">{p.z.toFixed(2)}%</span></div>
      {p.expected != null && (
        <div className="text-text2">
          E[YTM]: <span className="text-text">{p.expected.toFixed(2)}%</span>
          {' · '}
          <span className={p.residual > 0 ? 'text-danger' : 'text-acc'}>
            {p.residual >= 0 ? '+' : ''}{(p.residual * 100).toFixed(0)} bps
          </span>
        </div>
      )}
      {z != null && (
        <div className={zCls}>
          z = {z >= 0 ? '+' : ''}{z.toFixed(2)}σ
          {' '}
          <span className="text-text3">
            {z > 1 ? 'выше поверхности → премия за риск' :
             z < -1 ? 'ниже поверхности → дороже аналогов' :
             'в норме'}
          </span>
        </div>
      )}
      {p.sparse && (
        <div className="text-warn text-[10px]">⚠ сэмпл в окрестности мал — z-score не оценён</div>
      )}
    </div>
  );
}
