// Чарт поверхности с тремя видами:
//   flat    — точки на плоскости (срок × качество), цвет = z-score.
//   sticks  — стержни от плоскости до точки: длина = |residual|,
//             направление = знак, цвет = z-score.
//   horizon — взгляд от поверхности (residual=0 — горизонтальная
//             линия): X = срок (или качество), Y = residual в bps.
//             Точки выше горизонта — «торчат», ниже — «утонули».
// Изолинии поверх heatmap включаются отдельным тогглером.

import { useMemo, useRef, useState } from 'react';
import { useMarketSurface } from '../../store/marketSurface.js';
import { useWindows } from '../../store/windows.js';
import { ytmColor, zScoreColor } from '../../lib/kernelSurface.js';
import {
  ratingTier, tierColor, RATING_TICKS, ratingFromOrd,
} from '../../lib/qualityComposite.js';
import { makeProjection, marchingSquares, contourLevels } from '../../lib/surfaceGeom.js';

const PAD = { top: 16, right: 32, bottom: 36, left: 56 };
const W = 880, H = 500;
const RES_K = 10;        // px на 1% residual'а — масштаб «высоты»

export default function SurfaceChart({ fitted }){
  const viewMode = useMarketSurface(s => s.viewMode);
  // Горизонт — отдельный сценарий рендера, выходит наружу сразу.
  if(viewMode === 'horizon'){
    return <HorizonView fitted={fitted} />;
  }
  // 'iso' остался от прошлой версии в localStorage у некоторых
  // пользователей — рендерим как 'sticks' (логически ближе всего).
  return <PlanarView fitted={fitted} />;
}

function PlanarView({ fitted }){
  const showHeatmap  = useMarketSurface(s => s.showHeatmap);
  const showContours = useMarketSurface(s => s.showContours);
  const viewMode     = useMarketSurface(s => s.viewMode);
  const yMode        = useMarketSurface(s => s.yMode);
  const hoverId      = useMarketSurface(s => s.hoverId);
  const setHover     = useMarketSurface(s => s.setHover);
  const setSelected  = useMarketSurface(s => s.setSelected);
  const selectedId   = useMarketSurface(s => s.selectedId);
  const openWin      = useWindows(s => s.open);

  const { points, gridExpected } = fitted || { points: [], gridExpected: null };
  const ref = useRef(null);
  const svgRef = useRef(null);

  const bbox = useMemo(() => {
    if(!points.length) return { xMin: 0, xMax: 10, yMin: 0, yMax: 100 };
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

  // Плоский режим: всю площадь под чарт.
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const padTop = PAD.top;

  // Базовые data → screen координаты (на «полу» — до проекции).
  const sx = v => PAD.left + (v - bbox.xMin) / (bbox.xMax - bbox.xMin) * innerW;
  const sy = v => padTop + (1 - (v - bbox.yMin) / (bbox.yMax - bbox.yMin)) * innerH;
  // Обратная трансформация — для перекрестия.
  const ix = px => bbox.xMin + (px - PAD.left) / innerW * (bbox.xMax - bbox.xMin);
  const iy = py => bbox.yMin + (1 - (py - padTop) / innerH) * (bbox.yMax - bbox.yMin);

  const layout = { padTop, padLeft: PAD.left, innerW, innerH };
  const proj = useMemo(() => makeProjection(viewMode, layout), [viewMode, padTop, innerW, innerH]);

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

  // Уровни изолиний — кэшируем по сетке.
  const levels = useMemo(() => {
    if(!gridExpected) return [];
    return contourLevels(gridExpected);
  }, [gridExpected]);

  const [tip, setTip] = useState(null);
  const [crosshair, setCrosshair] = useState(null);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });

  const onPointEnter = (p, e) => {
    setHover(p.secid);
    const r = ref.current?.getBoundingClientRect();
    if(!r) return;
    setContainerSize({ w: r.width, h: r.height });
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

  const onBackgroundMove = (e) => {
    if(tip) return;
    const svg = svgRef.current;
    if(!svg) return;
    const rect = svg.getBoundingClientRect();
    const cx = (e.clientX - rect.left) / rect.width * W;
    const cy = (e.clientY - rect.top) / rect.height * H;
    if(cx < PAD.left || cx > W - PAD.right || cy < padTop || cy > H - PAD.bottom){
      setCrosshair(null);
      return;
    }
    const dataX = ix(cx);
    const dataY = iy(cy);
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
        {/* Плоскость-плашка (пол) */}
        <PlaneFrame proj={proj} sx={sx} sy={sy} bbox={bbox} />

        {showHeatmap && gridExpected && (
          <Heatmap grid={gridExpected} sx={sx} sy={sy} proj={proj} />
        )}

        {/* Сетка под точками */}
        <Gridlines xTicks={xTicks} yTicks={yTicks} sx={sx} sy={sy} bbox={bbox} proj={proj} />

        {/* Изолинии */}
        {showContours && gridExpected && (
          <Contours grid={gridExpected} levels={levels} sx={sx} sy={sy} proj={proj} />
        )}

        {/* Оси и подписи (на полу) */}
        <Axes
          xTicks={xTicks} yTicks={yTicks}
          sx={sx} sy={sy} bbox={bbox} proj={proj}
          yMode={yMode}
        />


        {/* Перекрестие */}
        {crosshair && !tip && (
          <g pointerEvents="none">
            <line x1={crosshair.x} x2={crosshair.x} y1={padTop} y2={H - PAD.bottom}
              stroke="#00d4ff" strokeOpacity="0.4" strokeDasharray="4 4" />
            <line x1={PAD.left} x2={W - PAD.right} y1={crosshair.y} y2={crosshair.y}
              stroke="#00d4ff" strokeOpacity="0.4" strokeDasharray="4 4" />
          </g>
        )}

        {/* Точки и стержни — в зависимости от режима. Сортируем
            по Y данных (от верхних к нижним), чтобы передние точки
            рисовались поверх задних в iso. */}
        {[...points]
          .sort((a, b) => (b.y - a.y))
          .map(p => (
            <PointMark
              key={p.secid}
              p={p}
              viewMode={viewMode}
              sx={sx} sy={sy}
              proj={proj}
              sr={sr}
              hoverId={hoverId}
              selectedId={selectedId}
              yMode={yMode}
              onEnter={onPointEnter}
              onLeave={onPointLeave}
              onClick={onPointClick}
            />
          ))}
      </svg>

      {tip && <PointTooltip tip={tip} containerWidth={containerSize.w} containerHeight={containerSize.h} />}
      {crosshair && !tip && (
        <CrosshairTooltip crosshair={crosshair} yMode={yMode} />
      )}

      {!points.length && (
        <div className="absolute inset-0 grid place-items-center text-text3 text-sm pointer-events-none">
          Нет точек по текущим фильтрам.
        </div>
      )}
    </div>
  );
}

// Задняя «комната» в 3D-режиме: левая и задняя стенки + потолок-каркас.
// Стенки делают ощущение объёма, на них же — горизонтальные сетки
// для шкал residual'а.
// «Рамка» плоскости.
function PlaneFrame({ proj, sx, sy, bbox }){
  const c1 = proj.project(sx(bbox.xMin), sy(bbox.yMin));
  const c2 = proj.project(sx(bbox.xMax), sy(bbox.yMin));
  const c3 = proj.project(sx(bbox.xMax), sy(bbox.yMax));
  const c4 = proj.project(sx(bbox.xMin), sy(bbox.yMax));
  const d = `M${c1[0]},${c1[1]} L${c2[0]},${c2[1]} L${c3[0]},${c3[1]} L${c4[0]},${c4[1]} Z`;
  return <path d={d} fill="#0a0e14" stroke="#222a37" />;
}

// Тепловая карта поверхности. В iso ячейка — четырёхугольник
// (после проекции). В плоском — обычный rect.
function Heatmap({ grid, sx, sy, proj }){
  const { xs, ys, z } = grid;
  const NX = xs.length, NY = ys.length;
  const cells = [];
  for(let i = 0; i < NX - 1; i++){
    for(let j = 0; j < NY - 1; j++){
      const v = avg4(z[i][j], z[i+1][j], z[i][j+1], z[i+1][j+1]);
      const p1 = proj.project(sx(xs[i]),     sy(ys[j]));
      const p2 = proj.project(sx(xs[i+1]),   sy(ys[j]));
      const p3 = proj.project(sx(xs[i+1]),   sy(ys[j+1]));
      const p4 = proj.project(sx(xs[i]),     sy(ys[j+1]));
      cells.push({
        d: `M${p1[0]},${p1[1]} L${p2[0]},${p2[1]} L${p3[0]},${p3[1]} L${p4[0]},${p4[1]} Z`,
        v,
      });
    }
  }
  return (
    <g pointerEvents="none">
      {cells.map((c, k) => (
        <path key={k} d={c.d} fill={ytmColor(c.v)} fillOpacity={0.55} />
      ))}
    </g>
  );
}

function Gridlines({ xTicks, yTicks, sx, sy, bbox, proj }){
  return (
    <g pointerEvents="none">
      {xTicks.map(t => {
        const a = proj.project(sx(t), sy(bbox.yMin));
        const b = proj.project(sx(t), sy(bbox.yMax));
        return <line key={'gx' + t}
          x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]}
          stroke="#1a212c" strokeDasharray="2 4" />;
      })}
      {yTicks.map(t => {
        const a = proj.project(sx(bbox.xMin), sy(t.v));
        const b = proj.project(sx(bbox.xMax), sy(t.v));
        return <line key={'gy' + t.v}
          x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]}
          stroke="#1a212c" strokeDasharray="2 4" />;
      })}
    </g>
  );
}

// Изолинии E[YTM] поверх heatmap — marching squares + проекция.
function Contours({ grid, levels, sx, sy, proj }){
  const segs = [];
  for(const lv of levels){
    const ms = marchingSquares(grid, lv);
    for(const s of ms){
      const a = proj.project(sx(s.x1), sy(s.y1));
      const b = proj.project(sx(s.x2), sy(s.y2));
      segs.push({ a, b, lv });
    }
  }
  return (
    <g pointerEvents="none">
      {segs.map((s, k) => (
        <line key={k}
          x1={s.a[0]} y1={s.a[1]} x2={s.b[0]} y2={s.b[1]}
          stroke="#3a4150" strokeOpacity="0.7" strokeWidth="1" />
      ))}
    </g>
  );
}

function Axes({ xTicks, yTicks, sx, sy, bbox, proj, yMode }){
  // X-ось: подписи внизу (на проекции — у нижнего края плоскости).
  return (
    <g pointerEvents="none">
      {xTicks.map(t => {
        const [tx, ty] = proj.project(sx(t), sy(bbox.yMin));
        return (
          <text key={'tx' + t}
            x={tx} y={ty + 14}
            fill="#9ba3b1" fontSize="10" fontFamily="JetBrains Mono, monospace" textAnchor="middle">
            {t}
          </text>
        );
      })}
      {yTicks.map(t => {
        const [tx, ty] = proj.project(sx(bbox.xMin), sy(t.v));
        const color = yMode === 'rating' ? (tierColor(ratingTier(t.label)) || '#9ba3b1') : '#9ba3b1';
        return (
          <text key={'ty' + t.v}
            x={tx - 8} y={ty + 3}
            fill={color}
            fontSize="10" fontFamily="JetBrains Mono, monospace" textAnchor="end">
            {t.label}
          </text>
        );
      })}
      <text x={W / 2} y={H - 6} fill="#5e6573" fontSize="10" fontFamily="JetBrains Mono, monospace" textAnchor="middle">
        срок до погашения, лет
      </text>
      <text x={14} y={H / 2} fill="#5e6573" fontSize="10" fontFamily="JetBrains Mono, monospace"
        transform={`rotate(-90 14 ${H / 2})`} textAnchor="middle">
        {yMode === 'rating' ? 'кредитный рейтинг' : yMode === 'mix' ? 'качество (микс)' : 'качество (скоринг)'}
      </text>
    </g>
  );
}

// Точка-маркер: тень на плоскости + (опционально) стержень + головка.
function PointMark({
  p, viewMode, sx, sy, proj, sr,
  hoverId, selectedId, yMode,
  onEnter, onLeave, onClick,
}){
  const r = sr(p.volumeBn);
  const fill = zScoreColor(p.zscore);
  const isHover = hoverId === p.secid;
  const isSel = selectedId === p.secid;
  const stroke = yMode === 'mix' ? tierColor(ratingTier(p.rating)) : '#0a0e14';
  const sw = isSel ? 2.5 : (yMode === 'mix' ? 1.6 : 1);
  const fillOpacity = p.sparse ? 0.4 : 0.85;

  // «Шаговая» позиция на плоскости (тень).
  const [shadowX, shadowY] = proj.project(sx(p.x), sy(p.y));
  // «Высота» точки относительно плоскости — пиксели.
  // residual в %; масштаб RES_K — px/%.
  const res = p.residual ?? 0;
  const lift = res * RES_K;

  let headX, headY;
  if(viewMode === 'flat'){
    headX = shadowX; headY = shadowY;
  } else {
    [headX, headY] = proj.lift(sx(p.x), sy(p.y), lift);
  }

  const showStick = viewMode !== 'flat' && Math.abs(lift) > 1;
  const stickColor = res > 0 ? '#ff4d6d' : '#00d4ff';

  return (
    <g
      style={{ cursor: 'pointer' }}
      onMouseEnter={e => onEnter(p, e)}
      onMouseMove={e => onEnter(p, e)}
      onMouseLeave={onLeave}
      onClick={() => onClick(p)}
    >
      {/* Тень — кружочек на плоскости (только если есть стержень) */}
      {showStick && (
        <circle cx={shadowX} cy={shadowY} r={Math.max(2, r * 0.4)}
          fill="#000" fillOpacity="0.35" stroke="#222a37" strokeOpacity="0.6" />
      )}
      {/* Стержень */}
      {showStick && (
        <line
          x1={shadowX} y1={shadowY} x2={headX} y2={headY}
          stroke={stickColor} strokeOpacity="0.75" strokeWidth={isHover ? 2 : 1.4}
        />
      )}
      {/* Головка точки */}
      <circle
        cx={headX} cy={headY} r={isHover ? r + 2 : r}
        fill={fill} fillOpacity={fillOpacity}
        stroke={isSel ? '#00d4ff' : stroke}
        strokeWidth={sw}
      />
    </g>
  );
}

// Билинейная интерполяция по сетке.
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

function avg4(a, b, c, d){
  const arr = [a, b, c, d].filter(x => x != null && isFinite(x));
  if(!arr.length) return null;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

// Tooltip — всегда pointer-events:none, чтобы курсор «проходил
// сквозь» него и не уходил с точки (иначе onMouseLeave ↔ Enter
// дёргают tooltip в петле). Клик по точке открывает окно эмитента —
// этого достаточно, ссылка из tooltip больше не нужна.
function PointTooltip({ tip, containerWidth, containerHeight }){
  const { p } = tip;
  const TIP_W = 240, TIP_H = 145;
  // Клампим к границам контейнера. Если справа не хватает — кладём
  // слева от курсора. Аналогично снизу.
  let left = tip.x + 14;
  let top  = tip.y - 8;
  if(containerWidth && left + TIP_W > containerWidth - 4){
    left = Math.max(4, tip.x - TIP_W - 14);
  }
  if(containerHeight && top + TIP_H > containerHeight - 4){
    top = Math.max(4, containerHeight - TIP_H - 4);
  }
  if(top < 4) top = 4;
  if(left < 4) left = 4;
  const z = p.zscore;
  const zCls = z == null ? 'text-text3' : z > 1 ? 'text-danger' : z < -1 ? 'text-acc' : 'text-text2';
  return (
    <div
      className="absolute pointer-events-none bg-bg2 border border-border rounded px-3 py-2 shadow-cardHover text-[11px] font-mono space-y-0.5 z-10"
      style={{ left, top, width: TIP_W }}
    >
      <div className="text-text truncate">{p.name}</div>
      <div className="text-text3 truncate">{p.secid} · {p.issuer}</div>
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
            {z > 1 ? 'премия за риск' :
             z < -1 ? 'дороже аналогов' :
             'в норме'}
          </span>
        </div>
      )}
      {p.sparse && (
        <div className="text-warn text-[10px]">⚠ сэмпл в окрестности мал — z-score не оценён</div>
      )}
      <div className="text-text3 text-[9px] mt-1 italic">клик — открыть окно эмитента</div>
    </div>
  );
}

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


// ═══════════════════════════════════════════════════════════════════
// «Горизонт» — взгляд от поверхности.
// X = срок (или качество, тогглер), Y = residual в bps.
// 0 = поверхность; точки выше — солидные, ниже — полу-прозрачные с
// диагональной штриховкой («утонули»). Идея: видна именно высота
// отклонения, а пара (срок, качество) свёрнута в одну ось.
// ═══════════════════════════════════════════════════════════════════
function HorizonView({ fitted }){
  const yMode      = useMarketSurface(s => s.yMode);
  const horizonX   = useMarketSurface(s => s.horizonX);
  const hoverId    = useMarketSurface(s => s.hoverId);
  const setHover   = useMarketSurface(s => s.setHover);
  const setSelected = useMarketSurface(s => s.setSelected);
  const selectedId = useMarketSurface(s => s.selectedId);
  const openWin    = useWindows(s => s.open);

  const { points } = fitted || { points: [] };

  // Bbox по X (срок или качество) и Y (residual в %).
  const xKey = horizonX === 'quality' ? 'y' : 'x';     // p.y = quality, p.x = maturity
  const xLabel = horizonX === 'quality'
    ? (yMode === 'rating' ? 'кредитный рейтинг' : 'качество')
    : 'срок до погашения, лет';

  const ref = useRef(null);
  const svgRef = useRef(null);

  const bbox = useMemo(() => {
    if(!points.length) return { xMin: 0, xMax: 10, yMin: -2, yMax: 2 };
    const xs = points.map(p => p[xKey]);
    let xMin = Math.min(...xs), xMax = Math.max(...xs);
    const padX = (xMax - xMin) * 0.06 + 0.2;
    xMin -= padX; xMax += padX;
    if(horizonX === 'quality'){ xMin = Math.max(0, xMin); xMax = Math.min(100, xMax); }
    // Residual в % YTM. Симметричный диапазон вокруг 0.
    const rs = points.map(p => p.residual).filter(v => v != null && isFinite(v));
    const maxAbs = rs.length ? Math.max(0.5, Math.max(...rs.map(Math.abs)) * 1.15) : 2;
    return { xMin, xMax, yMin: -maxAbs, yMax: maxAbs };
  }, [points, xKey, horizonX]);

  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const padTop = PAD.top;
  const sx = v => PAD.left + (v - bbox.xMin) / (bbox.xMax - bbox.xMin) * innerW;
  const sy = v => padTop + (1 - (v - bbox.yMin) / (bbox.yMax - bbox.yMin)) * innerH;

  const sr = (vol) => {
    if(!vol || vol <= 0) return 4;
    const t = Math.log10(vol);
    return 4 + Math.max(0, Math.min(1, t / 2.2)) * 10;
  };

  // Тики X.
  const xTicks = useMemo(() => {
    if(horizonX === 'quality' && yMode === 'rating'){
      return RATING_TICKS
        .filter(t => t.ord >= bbox.xMin && t.ord <= bbox.xMax)
        .map(t => ({ v: t.ord, label: t.label }));
    }
    if(horizonX === 'quality'){
      const out = [];
      for(let v = 0; v <= 100; v += 20){
        if(v >= bbox.xMin && v <= bbox.xMax) out.push({ v, label: String(v) });
      }
      return out;
    }
    const ticks = [];
    const start = Math.ceil(bbox.xMin), end = Math.floor(bbox.xMax);
    let step = 1;
    if(end - start > 12) step = 2;
    if(end - start > 25) step = 5;
    for(let v = start; v <= end; v += step) ticks.push({ v, label: String(v) });
    return ticks;
  }, [bbox.xMin, bbox.xMax, horizonX, yMode]);

  // Тики Y по shapely-уровням ±N bps.
  const yTicks = useMemo(() => {
    const span = (bbox.yMax - bbox.yMin) / 2;
    let step;
    if(span > 5) step = 2;
    else if(span > 2) step = 1;
    else if(span > 1) step = 0.5;
    else step = 0.25;
    const ticks = [];
    for(let v = -10; v <= 10; v += step){
      if(v >= bbox.yMin && v <= bbox.yMax) ticks.push(+v.toFixed(2));
    }
    return ticks;
  }, [bbox.yMin, bbox.yMax]);

  const [tip, setTip] = useState(null);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });

  const onPointEnter = (p, e) => {
    setHover(p.secid);
    const r = ref.current?.getBoundingClientRect();
    if(!r) return;
    setContainerSize({ w: r.width, h: r.height });
    setTip({ p, x: e.clientX - r.left, y: e.clientY - r.top });
  };
  const onPointLeave = () => { setHover(null); setTip(null); };
  const onPointClick = (p) => {
    setSelected(p.secid);
    openWin({ kind: 'issuer', id: p.issuer, title: p.issuer, ticker: null, mode: 'medium' });
  };

  return (
    <div className="relative" ref={ref}>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto select-none"
        preserveAspectRatio="xMidYMid meet">

        {/* Фон-плашка */}
        <rect x={PAD.left} y={padTop} width={innerW} height={innerH}
          fill="#0a0e14" stroke="#222a37" />

        {/* Зоны: верхняя половина (выше горизонта) — мягкий тёплый
            оттенок; нижняя — холодный. Создаёт сразу ощущение
            «небо ↑ / вода ↓». */}
        <rect x={PAD.left} y={padTop} width={innerW} height={sy(0) - padTop}
          fill="#ff4d6d" fillOpacity="0.03" pointerEvents="none" />
        <rect x={PAD.left} y={sy(0)} width={innerW} height={padTop + innerH - sy(0)}
          fill="#00d4ff" fillOpacity="0.04" pointerEvents="none" />

        {/* Горизонтальные сетки на каждом тике Y */}
        {yTicks.map(t => (
          <line key={'gy' + t}
            x1={PAD.left} x2={W - PAD.right}
            y1={sy(t)} y2={sy(t)}
            stroke="#1a212c" strokeDasharray="2 4" pointerEvents="none" />
        ))}
        {/* Вертикальные сетки */}
        {xTicks.map(t => (
          <line key={'gx' + t.v}
            x1={sx(t.v)} x2={sx(t.v)} y1={padTop} y2={padTop + innerH}
            stroke="#1a212c" strokeDasharray="2 4" pointerEvents="none" />
        ))}

        {/* Линия горизонта (residual = 0) */}
        <line x1={PAD.left} x2={W - PAD.right} y1={sy(0)} y2={sy(0)}
          stroke="#9ba3b1" strokeOpacity="0.85" strokeWidth="1.4" />
        <text x={W - PAD.right - 4} y={sy(0) - 4}
          fill="#9ba3b1" fontSize="10" fontFamily="JetBrains Mono, monospace" textAnchor="end">
          поверхность · E[YTM]
        </text>

        {/* Подписи тиков */}
        {xTicks.map(t => (
          <text key={'tx' + t.v}
            x={sx(t.v)} y={padTop + innerH + 14}
            fill="#9ba3b1" fontSize="10" fontFamily="JetBrains Mono, monospace" textAnchor="middle">
            {t.label}
          </text>
        ))}
        {yTicks.map(t => {
          const bps = Math.round(t * 100);
          const c = bps > 0 ? '#ff4d6d' : bps < 0 ? '#00d4ff' : '#9ba3b1';
          if(bps === 0) return null;
          return (
            <text key={'ty' + t}
              x={PAD.left - 6} y={sy(t) + 3}
              fill={c} fillOpacity="0.7"
              fontSize="9" fontFamily="JetBrains Mono, monospace" textAnchor="end">
              {bps > 0 ? '+' : ''}{bps}bps
            </text>
          );
        })}

        {/* Подписи осей */}
        <text x={W / 2} y={H - 6} fill="#5e6573" fontSize="10" fontFamily="JetBrains Mono, monospace" textAnchor="middle">
          {xLabel}
        </text>
        <text x={14} y={H / 2} fill="#5e6573" fontSize="10" fontFamily="JetBrains Mono, monospace"
          transform={`rotate(-90 14 ${H / 2})`} textAnchor="middle">
          residual, bps
        </text>

        {/* Точки. У каждой стержень от линии горизонта до её
            позиции — наглядно видно, насколько торчит/утонула. */}
        {points.map(p => {
          if(p.residual == null) return null;
          const r = sr(p.volumeBn);
          const xPos = sx(p[xKey]);
          const yPos = sy(p.residual);
          const yZero = sy(0);
          const isHover = hoverId === p.secid;
          const isSel = selectedId === p.secid;
          const above = p.residual > 0;
          const stickColor = above ? '#ff4d6d' : '#00d4ff';
          const fill = zScoreColor(p.zscore);
          // «Утонувшие» точки полу-прозрачные.
          const fillOpacity = above ? (p.sparse ? 0.5 : 0.95) : (p.sparse ? 0.18 : 0.4);
          const stroke = isSel ? '#00d4ff' : '#0a0e14';
          return (
            <g key={p.secid}
              style={{ cursor: 'pointer' }}
              onMouseEnter={e => onPointEnter(p, e)}
              onMouseMove={e => onPointEnter(p, e)}
              onMouseLeave={onPointLeave}
              onClick={() => onPointClick(p)}>
              {/* Стержень от поверхности до точки */}
              <line x1={xPos} y1={yZero} x2={xPos} y2={yPos}
                stroke={stickColor} strokeOpacity={isHover ? 0.9 : 0.6}
                strokeWidth={isHover ? 2 : 1.2} />
              {/* Тень-точка на горизонте */}
              <circle cx={xPos} cy={yZero} r={Math.max(2, r * 0.4)}
                fill="#000" fillOpacity="0.25" />
              {/* Сама точка */}
              <circle cx={xPos} cy={yPos} r={isHover ? r + 2 : r}
                fill={fill} fillOpacity={fillOpacity}
                stroke={stroke} strokeWidth={isSel ? 2.5 : 1} />
            </g>
          );
        })}
      </svg>

      {tip && <PointTooltip tip={tip} containerWidth={containerSize.w} containerHeight={containerSize.h} />}

      {!points.length && (
        <div className="absolute inset-0 grid place-items-center text-text3 text-sm pointer-events-none">
          Нет точек по текущим фильтрам.
        </div>
      )}
    </div>
  );
}

