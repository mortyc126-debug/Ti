// «Карта рынка» — единственный режим «Горизонт».
// X-ось настраивается: срок / рейтинг / один мультипликатор / композит
// (с двумя режимами выборки: сумма перцентилей или последовательная
// воронка по нормам отрасли). Y = residual (отклонение от поверхности
// E[YTM] в bps). 0 = поверхность; точки выше «торчат», ниже —
// «утонули».

import { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import { useMarketStore } from '../../store/marketSurface.js';
import { useWindows } from '../../store/windows.js';
import { zScoreColor } from '../../lib/kernelSurface.js';
import { buildHorizonX, horizonXLabel } from '../../lib/horizonX.js';

const PAD = { top: 18, right: 32, bottom: 36, left: 56 };
const W = 880, H = 500;

export default function SurfaceChart({ kind = 'bond', fitted, overlayFutures, overlayPairs }){
  const useStore          = useMarketStore(kind);
  const horizonX          = useStore(s => s.horizonX);
  const horizonMultiplier = useStore(s => s.horizonMultiplier);
  const horizonMetrics    = useStore(s => s.horizonMetrics);
  const horizonMode       = useStore(s => s.horizonMode);

  const hoverId      = useStore(s => s.hoverId);
  const setHover     = useStore(s => s.setHover);
  const setSelected  = useStore(s => s.setSelected);
  const selectedId   = useStore(s => s.selectedId);
  const openWin      = useWindows(s => s.open);

  const { points: rawPoints } = fitted || { points: [] };

  const xSpec = useMemo(() => ({
    source:     horizonX,
    multiplier: horizonMultiplier,
    metrics:    horizonMetrics,
    mode:       horizonMode,
  }), [horizonX, horizonMultiplier, horizonMetrics, horizonMode]);

  const xLabel = horizonXLabel(xSpec);

  // Точки с вычисленным xH + границы X.
  const { points, xMin: xMinRaw, xMax: xMaxRaw, ticks: xTicks } = useMemo(
    () => buildHorizonX(rawPoints, xSpec),
    [rawPoints, xSpec]
  );

  // Для overlay: фьючерсы тоже прогоняем через тот же X-spec.
  const overlayFutWithX = useMemo(() => {
    if(!overlayFutures?.length) return [];
    return buildHorizonX(overlayFutures, xSpec).points;
  }, [overlayFutures, xSpec]);

  // Bbox по Y. Учитываем и фьюч-residual'ы — иначе обрежет.
  const yBbox = useMemo(() => {
    const rs = points.map(p => p.residual).filter(v => v != null && isFinite(v));
    const fr = overlayFutWithX.map(p => p.residual).filter(v => v != null && isFinite(v));
    const all = rs.concat(fr);
    const maxAbs = all.length ? Math.max(0.5, Math.max(...all.map(Math.abs)) * 1.15) : 2;
    return { yMin: -maxAbs, yMax: maxAbs };
  }, [points, overlayFutWithX]);

  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const padTop = PAD.top;

  // Полный экстент данных (сброс зума ведёт сюда).
  const full = useMemo(
    () => ({ xMin: xMinRaw, xMax: xMaxRaw, yMin: yBbox.yMin, yMax: yBbox.yMax }),
    [xMinRaw, xMaxRaw, yBbox.yMin, yBbox.yMax]
  );

  // Видимая область (зум/пан). null = весь экстент. Сбрасываем при смене
  // данных/фильтров (меняется full).
  const [view, setView] = useState(null);
  useEffect(() => { setView(null); }, [full]);
  const dom = view || full;
  const xMin = dom.xMin, xMax = dom.xMax;

  const sx = v => PAD.left + (v - xMin) / Math.max(1e-9, xMax - xMin) * innerW;
  const sy = v => padTop + (1 - (v - dom.yMin) / Math.max(1e-9, dom.yMax - dom.yMin)) * innerH;

  // client-координаты мыши → координаты данных (учёт масштаба viewBox→пиксели)
  const clientToData = useCallback((clientX, clientY) => {
    const r = svgRef.current?.getBoundingClientRect();
    if(!r) return null;
    const svgX = (clientX - r.left) / r.width * W;
    const svgY = (clientY - r.top) / r.height * H;
    return {
      x: xMin + (svgX - PAD.left) / innerW * (xMax - xMin),
      y: dom.yMin + (1 - (svgY - padTop) / innerH) * (dom.yMax - dom.yMin),
    };
  }, [xMin, xMax, dom.yMin, dom.yMax, innerW, innerH, padTop]);

  // Зум колёсиком — к точке под курсором. Слушатель нативный (passive:false),
  // чтобы можно было отменить прокрутку страницы.
  useEffect(() => {
    const el = svgRef.current;
    if(!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      const d = clientToData(e.clientX, e.clientY);
      if(!d) return;
      const f = e.deltaY < 0 ? 0.82 : 1 / 0.82;   // вверх — приблизить
      const cur = view || full;
      const nxMin = d.x - (d.x - cur.xMin) * f;
      const nxMax = d.x + (cur.xMax - d.x) * f;
      const nyMin = d.y - (d.y - cur.yMin) * f;
      const nyMax = d.y + (cur.yMax - d.y) * f;
      // не даём зумить сильнее ~50x и не разрешаем «отзумить» шире экстента
      const spanX = nxMax - nxMin, fullX = full.xMax - full.xMin;
      if(spanX >= fullX * 0.99 && f > 1){ setView(null); return; }
      setView({
        xMin: Math.max(full.xMin, nxMin), xMax: Math.min(full.xMax, nxMax),
        yMin: nyMin, yMax: nyMax,
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [clientToData, view, full]);

  // Панорама перетаскиванием фона (не по точке).
  const drag = useRef(null);
  const onBgDown = (e) => {
    drag.current = { x: e.clientX, y: e.clientY, dom: view || full, moved: false };
  };
  useEffect(() => {
    const onMove = (e) => {
      if(!drag.current) return;
      const r = svgRef.current?.getBoundingClientRect();
      if(!r) return;
      const dxData = (e.clientX - drag.current.x) / r.width * W / innerW * (xMax - xMin);
      const dyData = (e.clientY - drag.current.y) / r.height * H / innerH * (dom.yMax - dom.yMin);
      if(Math.abs(e.clientX - drag.current.x) > 3 || Math.abs(e.clientY - drag.current.y) > 3) drag.current.moved = true;
      const b = drag.current.dom;
      setView({
        xMin: b.xMin - dxData, xMax: b.xMax - dxData,
        yMin: b.yMin + dyData, yMax: b.yMax + dyData,
      });
    };
    const onUp = () => { if(drag.current){ setTimeout(() => { drag.current = null; }, 0); } };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [xMin, xMax, dom.yMin, dom.yMax, innerW, innerH]);

  const sr = (vol) => {
    if(!vol || vol <= 0) return 4;
    const t = Math.log10(vol);
    return 4 + Math.max(0, Math.min(1, t / 2.2)) * 10;
  };

  const yTicks = useMemo(() => {
    const span = (dom.yMax - dom.yMin) / 2;
    let step;
    if(span > 5) step = 2;
    else if(span > 2) step = 1;
    else if(span > 1) step = 0.5;
    else if(span > 0.4) step = 0.25;
    else step = 0.1;
    const ticks = [];
    for(let v = -20; v <= 20; v += step){
      if(v >= dom.yMin && v <= dom.yMax) ticks.push(+v.toFixed(2));
    }
    return ticks;
  }, [dom.yMin, dom.yMax]);

  // тики X, попадающие в видимую область
  const xTicksVis = useMemo(() => xTicks.filter(t => t.v >= xMin && t.v <= xMax), [xTicks, xMin, xMax]);

  const ref = useRef(null);
  const svgRef = useRef(null);
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
    if(drag.current?.moved) return;   // не открывать окно после панорамы
    setSelected(p.secid);
    openWin({ kind: 'issuer', id: p.inn || p.issuer, inn: p.inn || null,
      title: p.issuer, ticker: null, mode: 'medium', tab: 'report' });
  };
  const zoomed = view != null;

  return (
    <div className="relative" ref={ref}>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto select-none"
        style={{ cursor: 'grab' }}
        preserveAspectRatio="xMidYMid meet">

        <defs>
          <clipPath id={`plotclip-${kind}`}>
            <rect x={PAD.left} y={padTop} width={innerW} height={innerH} />
          </clipPath>
        </defs>

        {/* Фон плоскости = зона захвата для панорамы (drag). */}
        <rect x={PAD.left} y={padTop} width={innerW} height={innerH}
          fill="#0B0613" stroke="#241638" onMouseDown={onBgDown} />

        {/* Зоны над/под горизонтом — тёплый ↑ / холодный ↓. */}
        <g clipPath={`url(#plotclip-${kind})`}>
          <rect x={PAD.left} y={padTop} width={innerW} height={Math.max(0, sy(0) - padTop)}
            fill="#FF4D7A" fillOpacity="0.03" pointerEvents="none" />
          <rect x={PAD.left} y={sy(0)} width={innerW} height={Math.max(0, padTop + innerH - sy(0))}
            fill="#52F2C9" fillOpacity="0.04" pointerEvents="none" />
        </g>

        {/* Сетка */}
        {yTicks.map(t => (
          <line key={'gy' + t}
            x1={PAD.left} x2={W - PAD.right}
            y1={sy(t)} y2={sy(t)}
            stroke="#1A1030" strokeDasharray="2 4" pointerEvents="none" />
        ))}
        {xTicksVis.map(t => (
          <line key={'gx' + t.v}
            x1={sx(t.v)} x2={sx(t.v)} y1={padTop} y2={padTop + innerH}
            stroke="#1A1030" strokeDasharray="2 4" pointerEvents="none" />
        ))}

        {/* Линия горизонта */}
        <line x1={PAD.left} x2={W - PAD.right} y1={sy(0)} y2={sy(0)}
          stroke="#A79BC9" strokeOpacity="0.85" strokeWidth="1.4" />
        <text x={W - PAD.right - 4} y={sy(0) - 4}
          fill="#A79BC9" fontSize="10" fontFamily="JetBrains Mono, monospace" textAnchor="end">
          поверхность · E[{kind === 'bond' ? 'YTM' : 'E/P'}]
        </text>

        {/* Inline-подсказки направлений Y. Рисуются у правой границы
            чарта, прямо в зонах «выше / ниже горизонта» — чтобы
            не нужно было читать боковую подпись оси. */}
        <text x={W - PAD.right - 4} y={Math.max(padTop + 16, sy(0) - 24)}
          fill="#FF4D7A" fillOpacity="0.85"
          fontSize="11" fontFamily="JetBrains Mono, monospace" textAnchor="end">
          ↑ премия за риск
        </text>
        <text x={W - PAD.right - 4} y={Math.min(padTop + innerH - 6, sy(0) + 28)}
          fill="#52F2C9" fillOpacity="0.85"
          fontSize="11" fontFamily="JetBrains Mono, monospace" textAnchor="end">
          ↓ дороже аналогов
        </text>

        {/* Подписи тиков X */}
        {xTicksVis.map(t => (
          <text key={'tx' + t.v}
            x={sx(t.v)} y={padTop + innerH + 14}
            fill="#A79BC9" fontSize="10" fontFamily="JetBrains Mono, monospace" textAnchor="middle">
            {t.label}
          </text>
        ))}
        {/* Подписи тиков Y. Для бондов — bps (×100), для акций/фьюч — п.п. */}
        {yTicks.map(t => {
          const isBps = kind === 'bond';
          const val = isBps ? Math.round(t * 100) : +t.toFixed(1);
          const suffix = isBps ? 'bps' : 'пп';
          const c = val > 0 ? '#FF4D7A' : val < 0 ? '#52F2C9' : '#A79BC9';
          if(val === 0) return null;
          return (
            <text key={'ty' + t}
              x={PAD.left - 6} y={sy(t) + 3}
              fill={c} fillOpacity="0.7"
              fontSize="9" fontFamily="JetBrains Mono, monospace" textAnchor="end">
              {val > 0 ? '+' : ''}{val}{suffix}
            </text>
          );
        })}

        {/* Подписи осей. X — основная + hint направления внизу.
            Y — одна вертикальная строка с расшифровкой residual'а
            (название и единицы зависят от kind'а). */}
        <text x={W / 2} y={H - 18} fill="#F2F0FF" fontSize="12" fontFamily="JetBrains Mono, monospace" textAnchor="middle" fontWeight="500">
          {xLabel.main}
        </text>
        {xLabel.hint && (
          <text x={W / 2} y={H - 4} fill="#A79BC9" fontSize="10" fontFamily="JetBrains Mono, monospace" textAnchor="middle">
            {xLabel.hint}
          </text>
        )}
        <text x={16} y={H / 2} fill="#F2F0FF" fontSize="11" fontFamily="JetBrains Mono, monospace" fontWeight="500"
          transform={`rotate(-90 16 ${H / 2})`} textAnchor="middle">
          {kind === 'bond'
            ? 'фактическая YTM − ожидаемая (bps)'
            : 'фактическая E/P − ожидаемая (п.п.)'}
        </text>

        <g clipPath={`url(#plotclip-${kind})`}>
        {/* Соединительные линии акция↔фьюч (только в overlay).
            Рисуем под точками, чтобы не перекрывали маркеры. */}
        {kind === 'overlay' && overlayFutWithX.map(f => {
          const stk = points.find(p => p.secid === f.baseTicker);
          if(!stk || stk.xH == null || stk.residual == null) return null;
          if(f.residual == null) return null;
          const x1 = sx(stk.xH), y1 = sy(stk.residual);
          const x2 = sx(f.xH),   y2 = sy(f.residual);
          // Контанго (basis>0) → фьюч ниже стопа по Y → жёлтый;
          // бэквардация (basis<0) → фьюч выше → пурпурный.
          const c = (f.basisPp || 0) > 0 ? '#E8895A' : '#AA5AFF';
          return (
            <line key={'pair-' + f.secid}
              x1={x1} y1={y1} x2={x2} y2={y2}
              stroke={c} strokeOpacity="0.7" strokeWidth="1.6"
              strokeDasharray="3 2" pointerEvents="none" />
          );
        })}

        {/* Точки (акции/бонды/фьючерсы/overlay-stocks) */}
        {points.map(p => {
          if(p.residual == null || p.xH == null) return null;
          const r = sr(p.volumeBn);
          const xPos = sx(p.xH);
          const yPos = sy(p.residual);
          const yZero = sy(0);
          const isHover = hoverId === p.secid;
          const isSel = selectedId === p.secid;
          const above = p.residual > 0;
          const stickColor = above ? '#FF4D7A' : '#52F2C9';
          const fill = zScoreColor(p.zscore);
          const fillOpacity = above ? (p.sparse ? 0.5 : 0.95) : (p.sparse ? 0.18 : 0.4);
          const stroke = isSel ? '#FF006E' : '#0B0613';
          return (
            <g key={p.secid}
              style={{ cursor: 'pointer' }}
              onMouseEnter={e => onPointEnter(p, e)}
              onMouseMove={e => onPointEnter(p, e)}
              onMouseLeave={onPointLeave}
              onClick={() => onPointClick(p)}>
              <line x1={xPos} y1={yZero} x2={xPos} y2={yPos}
                stroke={stickColor} strokeOpacity={isHover ? 0.9 : 0.6}
                strokeWidth={isHover ? 2 : 1.2} />
              <circle cx={xPos} cy={yZero} r={Math.max(2, r * 0.4)}
                fill="#000" fillOpacity="0.25" />
              <circle cx={xPos} cy={yPos} r={isHover ? r + 2 : r}
                fill={fill} fillOpacity={fillOpacity}
                stroke={stroke} strokeWidth={isSel ? 2.5 : 1} />
            </g>
          );
        })}

        {/* Фьючерсы поверх (overlay-режим). Маркер — пустой кружок
            (hollow), чтобы отличался от акции. */}
        {kind === 'overlay' && overlayFutWithX.map(f => {
          if(f.residual == null || f.xH == null) return null;
          const r = sr(f.volumeBn);
          const xPos = sx(f.xH);
          const yPos = sy(f.residual);
          const isHover = hoverId === f.secid;
          const isSel = selectedId === f.secid;
          const fill = zScoreColor(f.zscore);
          // Слегка смещаем фьюч по X, чтобы маркер акции не перекрывал.
          const xOff = 6;
          return (
            <g key={f.secid}
              style={{ cursor: 'pointer' }}
              onMouseEnter={e => onPointEnter(f, e)}
              onMouseMove={e => onPointEnter(f, e)}
              onMouseLeave={onPointLeave}
              onClick={() => onPointClick(f)}>
              <circle cx={xPos + xOff} cy={yPos} r={isHover ? r + 1 : r * 0.85}
                fill="transparent"
                stroke={isSel ? '#FF006E' : (fill || '#A79BC9')}
                strokeWidth={isSel ? 2.5 : 1.8}
                strokeDasharray="2 2" />
            </g>
          );
        })}
        </g>
      </svg>

      {/* Управление зумом: колесо — приблизить/отдалить, перетаскивание —
          сдвиг. Кнопка сброса появляется, когда карта увеличена. */}
      <div className="absolute top-2 right-2 flex items-center gap-2" data-no-drag>
        {zoomed && (
          <button type="button" onClick={() => setView(null)}
            className="bg-bg2/90 border border-border rounded px-2 py-1 text-[10px] font-mono text-text2 hover:text-acc">
            ⤢ сбросить зум
          </button>
        )}
      </div>
      <div className="absolute bottom-2 left-16 text-[9px] font-mono text-text3 pointer-events-none">
        колесо — зум · тянуть — сдвиг
      </div>

      {tip && <PointTooltip tip={tip} kind={kind} containerWidth={containerSize.w} containerHeight={containerSize.h} xLabel={xLabel.main} />}

      {!points.length && (
        <div className="absolute inset-0 grid place-items-center text-text3 text-sm pointer-events-none">
          {horizonX === 'composite' && !horizonMetrics.length
            ? 'Выбери хотя бы одну метрику в композите.'
            : horizonX === 'composite' && horizonMode === 'sequential'
              ? 'Все бумаги отсеяны воронкой норм. Ослабь критерии или выбери меньше метрик.'
              : 'Нет точек по текущим фильтрам.'}
        </div>
      )}
    </div>
  );
}

function PointTooltip({ tip, kind = 'bond', containerWidth, containerHeight, xLabel }){
  const { p } = tip;
  const isBond = kind === 'bond';
  const TIP_W = 260, TIP_H = 165;
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
      <div className="text-text2 truncate">
        {xLabel}: <span className="text-text">{fmtX(p.xH)}</span>
      </div>
      <div className="text-text2">
        {isBond
          ? <>срок: <span className="text-text">{p.x.toFixed(2)} лет</span>{' · '}</>
          : p.volumeBn != null
            ? <>кап-ция: <span className="text-text">{fmtCap(p.volumeBn)}</span>{' · '}</>
            : null}
        качество: <span className="text-text">{Math.round(p.y)}</span>
        {p.rating && <span className="text-text3 ml-1">({p.rating})</span>}
      </div>
      <div className="text-text2">
        {isBond ? 'YTM' : 'E/P'}:{' '}
        <span className="text-text">{p.z.toFixed(2)}%</span>
        {!isBond && p.pe != null && (
          <span className="text-text3 ml-1">(P/E {p.pe.toFixed(1)})</span>
        )}
      </div>
      {p.expected != null && (
        <div className="text-text2">
          E[{isBond ? 'YTM' : 'E/P'}]:{' '}
          <span className="text-text">{p.expected.toFixed(2)}%</span>
          {' · '}
          <span className={p.residual > 0 ? 'text-danger' : 'text-acc'}>
            {p.residual >= 0 ? '+' : ''}
            {isBond ? (p.residual * 100).toFixed(0) + ' bps' : p.residual.toFixed(2) + ' пп'}
          </span>
        </div>
      )}
      {z != null && (
        <div className={zCls}>
          z = {z >= 0 ? '+' : ''}{z.toFixed(2)}σ
          {' '}
          <span className="text-text3">
            {z > 1 ? 'премия за риск' : z < -1 ? 'дороже аналогов' : 'в норме'}
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

function fmtX(v){
  if(v == null || !isFinite(v)) return '—';
  if(Math.abs(v) >= 100) return v.toFixed(0);
  if(Math.abs(v) >= 10)  return v.toFixed(1);
  return v.toFixed(2);
}

function fmtCap(bn){
  if(bn == null) return '—';
  if(bn >= 1000) return (bn / 1000).toFixed(1) + ' трлн ₽';
  return bn.toFixed(0) + ' млрд ₽';
}
