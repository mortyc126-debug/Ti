// Чарт поверхности с тремя видами:
//   flat   — точки на плоскости, цвет = z-score (исходный 2D-вид).
//   sticks — стержни от плоскости до точки: длина = |residual|,
//            направление = знак, цвет = z-score. Видна высота
//            отклонения каждой бумаги от ожидаемой YTM.
//   iso    — псевдо-3D: плоскость уезжает в перспективу
//            (axonometric), точки парят над/под на residual'е.
//            Wow-эффект «горы» поверхности.
// Изолинии поверх heatmap включаются отдельным тогглером.

import { useMemo, useRef, useState } from 'react';
import { useMarketSurface } from '../../store/marketSurface.js';
import { useWindows } from '../../store/windows.js';
import { ytmColor, zScoreColor } from '../../lib/kernelSurface.js';
import {
  ratingTier, tierColor, RATING_TICKS, ratingFromOrd,
} from '../../lib/qualityComposite.js';
import { makeProjection, marchingSquares, contourLevels, ISO_ROOM_HEIGHT } from '../../lib/surfaceGeom.js';

const PAD = { top: 16, right: 32, bottom: 36, left: 56 };
const W = 880, H = 520;
const RES_K = 10;        // px на 1% residual'а — масштаб «высоты»

export default function SurfaceChart({ fitted }){
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

  // В iso-режиме оставляем сверху место под «комнату» (высоту парящих
  // точек) и справа — под Z-ось (residual).
  const reservedTop = viewMode === 'iso' ? ISO_ROOM_HEIGHT : 0;
  const reservedRight = viewMode === 'iso' ? 64 : 0;
  const innerW = W - PAD.left - PAD.right - reservedRight;
  const innerH = H - PAD.top - PAD.bottom - reservedTop;
  const padTop = PAD.top + reservedTop;

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
    if(viewMode === 'iso'){ setCrosshair(null); return; }   // в перспективе перекрестие путает
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
        {/* В 3D — задние стенки комнаты (рендерятся ПОД полом, чтобы
            пол накладывался). В плоских режимах не рисуются. */}
        {proj.isIso && (
          <RoomBack proj={proj} sx={sx} sy={sy} bbox={bbox}
            yTicks={yTicks} xTicks={xTicks} yMode={yMode} />
        )}

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

        {/* В 3D — Z-ось residual'а на правой стенке: вертикальная
            шкала «отклонение от поверхности» с делениями. */}
        {proj.isIso && (
          <ResidualAxis proj={proj} sx={sx} sy={sy} bbox={bbox} resK={RES_K} />
        )}

        {/* Перекрестие (только в плоских режимах) */}
        {crosshair && !tip && viewMode !== 'iso' && (
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
      {crosshair && !tip && viewMode !== 'iso' && (
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
function RoomBack({ proj, sx, sy, bbox, yTicks, xTicks, yMode }){
  // 4 угла пола.
  const fbl = proj.project(sx(bbox.xMin), sy(bbox.yMin));    // front-bottom-left (передний-низ-лево)
  const fbr = proj.project(sx(bbox.xMax), sy(bbox.yMin));    // front-bottom-right
  const ftr = proj.project(sx(bbox.xMax), sy(bbox.yMax));    // back-right
  const ftl = proj.project(sx(bbox.xMin), sy(bbox.yMax));    // back-left

  // 4 угла потолка (поднятые на ISO_ROOM_HEIGHT).
  const tbl = [fbl[0], fbl[1] - ISO_ROOM_HEIGHT];
  const tbr = [fbr[0], fbr[1] - ISO_ROOM_HEIGHT];
  const ttr = [ftr[0], ftr[1] - ISO_ROOM_HEIGHT];
  const ttl = [ftl[0], ftl[1] - ISO_ROOM_HEIGHT];

  // Задняя стенка (между ftl-ftr и ttl-ttr).
  const backD = `M${ftl[0]},${ftl[1]} L${ftr[0]},${ftr[1]} L${ttr[0]},${ttr[1]} L${ttl[0]},${ttl[1]} Z`;
  // Левая стенка (между fbl-ftl и tbl-ttl).
  const leftD = `M${fbl[0]},${fbl[1]} L${ftl[0]},${ftl[1]} L${ttl[0]},${ttl[1]} L${tbl[0]},${tbl[1]} Z`;

  return (
    <g pointerEvents="none">
      {/* Стенки — очень слабая заливка градиентом для ощущения тени */}
      <defs>
        <linearGradient id="wallGradLeft" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"  stopColor="#0e1320" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#0a0e14" stopOpacity="0.10" />
        </linearGradient>
        <linearGradient id="wallGradBack" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"  stopColor="#0e1320" stopOpacity="0.45" />
          <stop offset="100%" stopColor="#0a0e14" stopOpacity="0.15" />
        </linearGradient>
      </defs>
      <path d={leftD} fill="url(#wallGradLeft)" stroke="#222a37" strokeWidth="1" />
      <path d={backD} fill="url(#wallGradBack)" stroke="#222a37" strokeWidth="1" />

      {/* Горизонтальные направляющие на задней стенке —
          горизонты residual'а 0/+50/−50/+100/−100/... bps. */}
      {[-200, -100, -50, 0, 50, 100, 200].map(bps => {
        const lift = bps / 100 * 10;     // RES_K = 10 px / 1%
        const a = [ftl[0], ftl[1] - lift];
        const b = [ftr[0], ftr[1] - lift];
        const isZero = bps === 0;
        return (
          <g key={bps}>
            <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]}
              stroke={isZero ? '#3a4150' : '#1a212c'}
              strokeWidth={isZero ? 1.4 : 1}
              strokeDasharray={isZero ? '0' : '2 4'} />
          </g>
        );
      })}

      {/* Линии-направляющие от углов пола к потолку — «опоры комнаты». */}
      <line x1={fbl[0]} y1={fbl[1]} x2={tbl[0]} y2={tbl[1]} stroke="#222a37" strokeOpacity="0.6" />
      <line x1={fbr[0]} y1={fbr[1]} x2={tbr[0]} y2={tbr[1]} stroke="#222a37" strokeOpacity="0.6" />
      <line x1={ftr[0]} y1={ftr[1]} x2={ttr[0]} y2={ttr[1]} stroke="#222a37" strokeOpacity="0.4" />
      <line x1={ftl[0]} y1={ftl[1]} x2={ttl[0]} y2={ttl[1]} stroke="#222a37" strokeOpacity="0.4" />
    </g>
  );
}

// Z-ось — residual в bps на правой задней грани комнаты.
function ResidualAxis({ proj, sx, sy, bbox, resK }){
  const ftr = proj.project(sx(bbox.xMax), sy(bbox.yMax));
  const lvls = [-200, -100, -50, 0, 50, 100, 200];
  return (
    <g pointerEvents="none">
      {/* Сама ось вверх. */}
      <line
        x1={ftr[0]} y1={ftr[1]}
        x2={ftr[0]} y2={ftr[1] - 200 / 100 * resK - 6}
        stroke="#3a4150" strokeWidth="1"
      />
      {lvls.map(bps => {
        const lift = bps / 100 * resK;
        const y = ftr[1] - lift;
        const c = bps > 0 ? '#ff4d6d' : bps < 0 ? '#00d4ff' : '#9ba3b1';
        return (
          <g key={bps}>
            <line x1={ftr[0] - 3} y1={y} x2={ftr[0] + 3} y2={y} stroke={c} strokeOpacity="0.9" />
            <text x={ftr[0] + 8} y={y + 3}
              fill={c} fillOpacity="0.85"
              fontSize="9" fontFamily="JetBrains Mono, monospace" textAnchor="start">
              {bps > 0 ? '+' : ''}{bps}{bps !== 0 ? 'bps' : ''}
            </text>
          </g>
        );
      })}
      <text x={ftr[0] + 8} y={ftr[1] - 200 / 100 * resK - 12}
        fill="#5e6573" fontSize="9" fontFamily="JetBrains Mono, monospace" textAnchor="start">
        residual
      </text>
    </g>
  );
}

// «Рамка» плоскости. В iso рисуем как трапецию (4 угла после скоса).
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
        <path key={k} d={c.d} fill={ytmColor(c.v)} fillOpacity={proj.isIso ? 0.7 : 0.55} />
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
