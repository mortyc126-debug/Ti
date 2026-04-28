// Чарт поверхности. Фон-тепловая карта E[YTM | срок, качество] +
// scatter точек, окрашенных по z-score residual'а. Размер точки —
// объём выпуска. Клик по точке открывает окно эмитента + помечает
// выбранным. Hover показывает тултип; перекрестие на фоне — живой
// readout координат и E[YTM] в позиции курсора.

import { useMemo, useRef, useState } from 'react';
import { useMarketSurface } from '../../store/marketSurface.js';
import { useWindows } from '../../store/windows.js';
import { ytmColor, zScoreColor } from '../../lib/kernelSurface.js';
import {
  ratingTier, tierColor, RATING_TICKS, ratingFromOrd,
} from '../../lib/qualityComposite.js';

const PAD = { top: 16, right: 32, bottom: 36, left: 56 };
const W = 880, H = 480;

export default function SurfaceChart({ fitted }){
  const showHeatmap = useMarketSurface(s => s.showHeatmap);
  const yMode       = useMarketSurface(s => s.yMode);
  const hoverId     = useMarketSurface(s => s.hoverId);
  const setHover    = useMarketSurface(s => s.setHover);
  const setSelected = useMarketSurface(s => s.setSelected);
  const selectedId  = useMarketSurface(s => s.selectedId);
  const openWin     = useWindows(s => s.open);

  const { points, gridExpected } = fitted || { points: [], gridExpected: null };
  const ref = useRef(null);
  const svgRef = useRef(null);

  const bbox = useMemo(() => {
    if(!points.length){
      return { xMin: 0, xMax: 10, yMin: 0, yMax: 100 };
    }
    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    let xMin = Math.min(...xs), xMax = Math.max(...xs);
    let yMin = Math.min(...ys), yMax = Math.max(...ys);
    const padX = (xMax - xMin) * 0.08 + 0.2;
    const padY = (yMax - yMin) * 0.06 + 2;
    xMin -= padX; xMax += padX;
    yMin -= padY; yMax += padY;
    yMin = Math.max(0, yMin);
    yMax = Math.min(100, yMax);
    return { xMin, xMax, yMin, yMax };
  }, [points]);

  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const sx = v => PAD.left + (v - bbox.xMin) / (bbox.xMax - bbox.xMin) * innerW;
  const sy = v => PAD.top + (1 - (v - bbox.yMin) / (bbox.yMax - bbox.yMin)) * innerH;
  const ix = px => bbox.xMin + (px - PAD.left) / innerW * (bbox.xMax - bbox.xMin);
  const iy = py => bbox.yMin + (1 - (py - PAD.top) / innerH) * (bbox.yMax - bbox.yMin);

  const sr = (vol) => {
    if(!vol || vol <= 0) return 4;
    const t = Math.log10(vol);
    return 4 + Math.max(0, Math.min(1, t / 2.2)) * 10;
  };

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

  // Y-тики: в режиме «рейтинг» — буквенные метки (AAA, AA, A, ...),
  // иначе — каждые 20 пунктов.
  const yTicks = useMemo(() => {
    if(yMode === 'rating'){
      return RATING_TICKS
        .filter(t => t.ord >= bbox.yMin && t.ord <= bbox.yMax)
        .map(t => ({ v: t.ord, label: t.label }));
    }
    const ticks = [];
    for(let v = 0; v <= 100; v += 20){
      if(v >= bbox.yMin && v <= bbox.yMax) ticks.push({ v, label: String(v) });
    }
    return ticks;
  }, [bbox.yMin, bbox.yMax, yMode]);

  const [tip, setTip] = useState(null);
  const [crosshair, setCrosshair] = useState(null);   // { x, y, dataX, dataY, e[ytm] }

  const onPointEnter = (p, e) => {
    setHover(p.secid);
    const r = ref.current?.getBoundingClientRect();
    if(!r) return;
    setTip({ p, x: e.clientX - r.left, y: e.clientY - r.top });
    setCrosshair(null);
  };
  const onPointLeave = () => {
    setHover(null);
    setTip(null);
  };

  const onPointClick = (p) => {
    setSelected(p.secid);
    openWin({ kind: 'issuer', id: p.issuer, title: p.issuer, ticker: null, mode: 'medium' });
  };

  // Перекрестие на фоновой плоскости — пока курсор не на точке.
  const onBackgroundMove = (e) => {
    if(tip) return;            // на точке — отдельный тултип
    const svg = svgRef.current;
    if(!svg) return;
    const rect = svg.getBoundingClientRect();
    // Переводим клиентские координаты в viewBox-координаты.
    const cx = (e.clientX - rect.left) / rect.width * W;
    const cy = (e.clientY - rect.top) / rect.height * H;
    if(cx < PAD.left || cx > W - PAD.right || cy < PAD.top || cy > H - PAD.bottom){
      setCrosshair(null);
      return;
    }
    const dataX = ix(cx);
    const dataY = iy(cy);
    // E[YTM] из сетки — линейная интерполяция по 4 ближайшим узлам.
    const eytm = lerpGrid(gridExpected, dataX, dataY);
    setCrosshair({ x: cx, y: cy, dataX, dataY, eytm });
  };
  const onBackgroundLeave = () => setCrosshair(null);

  return (
    <div className="relative" ref={ref}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto select-none"
        preserveAspectRatio="xMidYMid meet"
        onMouseMove={onBackgroundMove}
        onMouseLeave={onBackgroundLeave}
      >
        <rect x={PAD.left} y={PAD.top} width={innerW} height={innerH} fill="#0a0e14" stroke="#222a37" />

        {showHeatmap && gridExpected && <Heatmap grid={gridExpected} sx={sx} sy={sy} />}

        {/* Сетка */}
        {xTicks.map(t => (
          <line key={'gx' + t}
            x1={sx(t)} x2={sx(t)} y1={PAD.top} y2={H - PAD.bottom}
            stroke="#1a212c" strokeDasharray="2 4" />
        ))}
        {yTicks.map(t => (
          <line key={'gy' + t.v}
            x1={PAD.left} x2={W - PAD.right} y1={sy(t.v)} y2={sy(t.v)}
            stroke="#1a212c" strokeDasharray="2 4" />
        ))}

        {/* Оси и подписи */}
        {xTicks.map(t => (
          <text key={'tx' + t}
            x={sx(t)} y={H - PAD.bottom + 14}
            fill="#9ba3b1" fontSize="10" fontFamily="JetBrains Mono, monospace" textAnchor="middle">
            {t}
          </text>
        ))}
        {yTicks.map(t => (
          <text key={'ty' + t.v}
            x={PAD.left - 8} y={sy(t.v) + 3}
            fill={yMode === 'rating' ? tierColor(ratingTier(t.label)) || '#9ba3b1' : '#9ba3b1'}
            fontSize="10" fontFamily="JetBrains Mono, monospace" textAnchor="end">
            {t.label}
          </text>
        ))}
        <text x={W / 2} y={H - 6} fill="#5e6573" fontSize="10" fontFamily="JetBrains Mono, monospace" textAnchor="middle">
          срок до погашения, лет
        </text>
        <text x={14} y={H / 2} fill="#5e6573" fontSize="10" fontFamily="JetBrains Mono, monospace"
          transform={`rotate(-90 14 ${H / 2})`} textAnchor="middle">
          {yMode === 'rating' ? 'кредитный рейтинг' : yMode === 'mix' ? 'качество (микс)' : 'качество (скоринг)'}
        </text>

        {/* Перекрестие */}
        {crosshair && !tip && (
          <g pointerEvents="none">
            <line x1={crosshair.x} x2={crosshair.x} y1={PAD.top} y2={H - PAD.bottom}
              stroke="#00d4ff" strokeOpacity="0.4" strokeDasharray="4 4" />
            <line x1={PAD.left} x2={W - PAD.right} y1={crosshair.y} y2={crosshair.y}
              stroke="#00d4ff" strokeOpacity="0.4" strokeDasharray="4 4" />
          </g>
        )}

        {/* Точки */}
        {points.map(p => {
          const r = sr(p.volumeBn);
          const fill = zScoreColor(p.zscore);
          const isHover = hoverId === p.secid;
          const isSel = selectedId === p.secid;
          const stroke = yMode === 'mix' ? tierColor(ratingTier(p.rating)) : '#0a0e14';
          return (
            <circle key={p.secid}
              cx={sx(p.x)} cy={sy(p.y)} r={isHover ? r + 2 : r}
              fill={fill}
              stroke={isSel ? '#00d4ff' : stroke}
              strokeWidth={isSel ? 2.5 : (yMode === 'mix' ? 1.6 : 1)}
              fillOpacity={p.sparse ? 0.4 : 0.85}
              style={{ cursor: 'pointer' }}
              onMouseEnter={e => onPointEnter(p, e)}
              onMouseMove={e => onPointEnter(p, e)}
              onMouseLeave={onPointLeave}
              onClick={() => onPointClick(p)}
            />
          );
        })}
      </svg>

      {tip && <PointTooltip tip={tip} openWin={openWin} />}
      {crosshair && !tip && <CrosshairTooltip crosshair={crosshair} yMode={yMode} />}

      {!points.length && (
        <div className="absolute inset-0 grid place-items-center text-text3 text-sm pointer-events-none">
          Нет точек по текущим фильтрам.
        </div>
      )}
    </div>
  );
}

// Билинейная интерполяция по сетке E[YTM]. Возвращает null если
// курсор вне сетки или ячейка пустая.
function lerpGrid(grid, x, y){
  if(!grid) return null;
  const { xs, ys, z } = grid;
  if(x < xs[0] || x > xs[xs.length - 1]) return null;
  if(y < ys[0] || y > ys[ys.length - 1]) return null;
  let i = 0;
  while(i + 1 < xs.length && xs[i + 1] < x) i++;
  let j = 0;
  while(j + 1 < ys.length && ys[j + 1] < y) j++;
  const tx = (x - xs[i]) / (xs[i + 1] - xs[i] || 1);
  const ty = (y - ys[j]) / (ys[j + 1] - ys[j] || 1);
  const z00 = z[i][j], z10 = z[i + 1][j];
  const z01 = z[i][j + 1], z11 = z[i + 1][j + 1];
  if(z00 == null || z10 == null || z01 == null || z11 == null) return null;
  const z0 = z00 * (1 - tx) + z10 * tx;
  const z1 = z01 * (1 - tx) + z11 * tx;
  return z0 * (1 - ty) + z1 * ty;
}

function Heatmap({ grid, sx, sy }){
  const { xs, ys, z } = grid;
  const NX = xs.length, NY = ys.length;
  const cells = [];
  for(let i = 0; i < NX - 1; i++){
    for(let j = 0; j < NY - 1; j++){
      const v = avg4(z[i][j], z[i+1][j], z[i][j+1], z[i+1][j+1]);
      const x1 = sx(xs[i]),     x2 = sx(xs[i+1]);
      const y1 = sy(ys[j+1]),   y2 = sy(ys[j]);
      cells.push({ x: x1, y: y1, w: x2 - x1, h: y2 - y1, v });
    }
  }
  return (
    <g pointerEvents="none">
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

// Тултип точки. Имя компании — кликабельная ссылка, открывает окно
// эмитента (как поиск в шапке).
function PointTooltip({ tip, openWin }){
  const { p } = tip;
  const left = Math.min(tip.x + 12, 700);
  const top  = Math.max(tip.y - 8, 8);
  const z = p.zscore;
  const zCls = z == null ? 'text-text3' : z > 1 ? 'text-danger' : z < -1 ? 'text-acc' : 'text-text2';

  return (
    <div
      className="absolute bg-bg2 border border-border rounded px-3 py-2 shadow-cardHover text-[11px] font-mono space-y-0.5 z-10"
      style={{ left, top, pointerEvents: 'auto' }}
      onMouseEnter={e => e.stopPropagation()}
    >
      <div className="text-text">{p.name}</div>
      <div>
        <button
          type="button"
          onClick={() => openWin({ kind: 'issuer', id: p.issuer, title: p.issuer, ticker: null, mode: 'medium' })}
          className="text-text3 hover:text-acc transition-colors text-left"
          title="Открыть карточку эмитента"
        >
          {p.secid} · <span className="underline-offset-2 hover:underline">{p.issuer}</span>
        </button>
      </div>
      <div className="border-t border-border/60 my-1" />
      <div className="text-text2">срок: <span className="text-text">{p.x.toFixed(2)} лет</span></div>
      <div className="text-text2">
        качество: <span className="text-text">{p.y.toFixed(0)}</span>
        {p.rating && <span className="text-text3 ml-1">({p.rating})</span>}
      </div>
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
            {z > 1 ? 'выше — премия за риск' :
             z < -1 ? 'ниже — дороже аналогов' :
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

// Тултип-readout для пустого фона: координаты курсора и E[YTM] в этой
// точке поверхности.
function CrosshairTooltip({ crosshair, yMode }){
  const { dataX, dataY, eytm } = crosshair;
  const left = Math.min(crosshair.x + 12, 720);
  const top = Math.max(crosshair.y - 8, 8);
  return (
    <div
      className="absolute pointer-events-none bg-bg2 border border-border rounded px-2.5 py-1.5 text-[10px] font-mono space-y-0.5 z-10 opacity-90"
      style={{ left, top }}
    >
      <div className="text-text2">срок: <span className="text-text">{dataX.toFixed(2)} лет</span></div>
      <div className="text-text2">
        качество: <span className="text-text">{dataY.toFixed(0)}</span>
        <span className="text-text3 ml-1">
          {yMode === 'rating' || yMode === 'mix' ? `(≈ ${ratingFromOrd(dataY)})` : ''}
        </span>
      </div>
      {eytm != null && (
        <div className="text-text2">E[YTM]: <span className="text-acc">{eytm.toFixed(2)}%</span></div>
      )}
    </div>
  );
}
