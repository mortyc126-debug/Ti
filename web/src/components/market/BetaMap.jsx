// Карта беты: положение акций по систематическому риску (β к IMOEX).
// Источник — вся вселенная акций с бетой (не только сматченные с отчётностью).
// Ось Y переключается: E/P / дивдоходность / «лента» (только β).
// Диапазон оси устойчивый (выбросы β обрезаются по перцентилям, иначе одна
// мусорная бумага растягивает всю шкалу). Есть зум колесом и панорама.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useStockUniverse, currentStocks } from '../../store/marketData.js';
import { useIssuers } from '../../store/issuers.js';
import { loadStockPoints } from '../../data/marketSurfaceData.js';
import { sectorToIndustry } from '../../data/marketReal.js';

const W = 900, H = 500;
const PAD = { left: 56, right: 20, top: 20, bottom: 46 };
const IW = W - PAD.left - PAD.right, IH = H - PAD.top - PAD.bottom;

function betaColor(b){
  if(b < 0.8) return '#52F2C9';
  if(b <= 1.2) return '#A79BC9';
  return '#FF4D7A';
}
function betaZone(b){
  if(b < 0.8) return 'защитная';
  if(b <= 1.2) return 'как рынок';
  return 'агрессивная';
}
function jitter(str){
  let h = 0; for(let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return (Math.abs(h) % 1000) / 1000;
}
function pct(sorted, p){
  if(!sorted.length) return 0;
  const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
function niceStep(raw){
  if(!(raw > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

const Y_MODES = [
  { id: 'strip', label: 'Все (лента)' },
  { id: 'ep',    label: 'E/P' },
  { id: 'div',   label: 'Дивдоходность' },
];

export default function BetaMap(){
  useStockUniverse();
  const allIssuers = useIssuers();
  const [hover, setHover] = useState(null);
  const [ymode, setYmode] = useState('strip');
  const svgRef = useRef(null);
  const drag = useRef(null);

  const base = useMemo(() => {
    const epByTicker = new Map();
    for(const p of loadStockPoints({})){
      if(p.ticker && p.z != null) epByTicker.set(String(p.ticker).toUpperCase(), p.z);
    }
    return currentStocks()
      .filter(s => s.beta != null && isFinite(s.beta))
      .map(s => {
        const cap = (s.shares && s.price) ? s.price * s.shares / 1e9 : null;
        const div = (s.div12m > 0 && s.price) ? s.div12m / s.price * 100 : null;
        return {
          id: s.ticker || s.secid, name: s.name || s.ticker, ticker: s.ticker,
          beta: s.beta, cap, div,
          ep: epByTicker.get(String(s.ticker || '').toUpperCase()) ?? null,
          industry: sectorToIndustry(s.sector),
        };
      });
  }, [allIssuers]);

  const yKey = ymode === 'ep' ? 'ep' : ymode === 'div' ? 'div' : null;
  const pts = yKey ? base.filter(p => p[yKey] != null && isFinite(p[yKey])) : base;
  const hidden = base.length - pts.length;

  // устойчивый диапазон (обрезаем хвосты по перцентилям, чтобы выбросы β
  // не растягивали шкалу); домен для Y — по метрике или 0..1 в «ленте».
  const home = useMemo(() => {
    if(!pts.length) return { x0: 0, x1: 1.6, y0: 0, y1: 1 };
    const bs = pts.map(p => p.beta).sort((a, b) => a - b);
    const x0 = Math.min(0, pct(bs, 0.02));
    const x1 = Math.max(1.6, Math.min(pct(bs, 0.98) + 0.15, 3));
    let y0 = 0, y1 = 1;
    if(yKey){
      const ys = pts.map(p => p[yKey]).sort((a, b) => a - b);
      y0 = pct(ys, 0.02); y1 = pct(ys, 0.98);
      if(y0 === y1){ y0 -= 1; y1 += 1; }
      const pd = (y1 - y0) * 0.08; y0 -= pd; y1 += pd;
    }
    return { x0, x1, y0, y1 };
  }, [pts, yKey]);

  const [view, setView] = useState(home);
  useEffect(() => { setView(home); }, [home]);

  const { x0, x1, y0, y1 } = view;
  const sx = b => PAD.left + (b - x0) / (x1 - x0) * IW;
  const sy = yKey
    ? (v => PAD.top + (1 - (v - y0) / (y1 - y0)) * IH)
    : (p => PAD.top + (0.06 + 0.88 * jitter(p.id || '')) * IH);

  const caps = pts.map(p => p.cap || 0);
  const capMax = Math.max(1, ...caps);
  const sr = c => 4 + Math.sqrt((c || 0) / capMax) * 16;

  const xTicks = []; { const st = niceStep((x1 - x0) / 8); for(let b = Math.ceil(x0 / st) * st; b <= x1; b += st) xTicks.push(+b.toFixed(2)); }
  const yTicks = [];
  if(yKey){ const st = niceStep((y1 - y0) / 5); for(let e = Math.ceil(y0 / st) * st; e <= y1; e += st) yTicks.push(+e.toFixed(2)); }
  const x1line = sx(1);
  const inView = x1line >= PAD.left && x1line <= W - PAD.right;

  // курсор → координаты данных (для зума вокруг точки под курсором)
  const dataAt = (clientX, clientY) => {
    const r = svgRef.current.getBoundingClientRect();
    const px = (clientX - r.left) / r.width * W;
    const py = (clientY - r.top) / r.height * H;
    return {
      b: x0 + (px - PAD.left) / IW * (x1 - x0),
      v: y1 - (py - PAD.top) / IH * (y1 - y0),
    };
  };
  const onWheel = (e) => {
    e.preventDefault();
    const k = e.deltaY < 0 ? 0.82 : 1.22;
    const { b, v } = dataAt(e.clientX, e.clientY);
    setView(cur => ({
      x0: b - (b - cur.x0) * k, x1: b + (cur.x1 - b) * k,
      y0: v - (v - cur.y0) * k, y1: v + (cur.y1 - v) * k,
    }));
  };
  const onDown = (e) => {
    const r = svgRef.current.getBoundingClientRect();
    drag.current = { x: e.clientX, y: e.clientY, view, rw: r.width, rh: r.height };
  };
  const onMove = (e) => {
    if(!drag.current) return;
    const d = drag.current;
    const dbx = (e.clientX - d.x) / d.rw * W / IW * (d.view.x1 - d.view.x0);
    const dby = (e.clientY - d.y) / d.rh * H / IH * (d.view.y1 - d.view.y0);
    setView({ x0: d.view.x0 - dbx, x1: d.view.x1 - dbx, y0: d.view.y0 + dby, y1: d.view.y1 + dby });
  };
  const onUp = () => { drag.current = null; };

  if(!base.length){
    return (
      <div className="h-[420px] grid place-items-center text-center text-text3 text-sm px-6">
        <div>
          Беты нет в снимке акций.<br/>
          Обнови котировки: <code className="text-text2">invest-bot/make_equities_cache.py</code>, затем на табе «Акции» нажми «⟳ перезагрузить».
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-text3 text-xs">ось Y:</span>
        <div className="flex gap-0.5 rounded overflow-hidden border border-border w-fit">
          {Y_MODES.map(m => (
            <button key={m.id} type="button" onClick={() => setYmode(m.id)}
              className={['px-3 py-1 text-xs transition-colors',
                ymode === m.id ? 'bg-acc-dim text-acc' : 'bg-bg2 text-text3 hover:text-text'].join(' ')}>{m.label}</button>
          ))}
        </div>
        <button type="button" onClick={() => setView(home)}
          className="px-2.5 py-1 text-xs rounded border border-border bg-bg2 text-text3 hover:text-text" title="Сбросить масштаб">⤢ сброс</button>
        <span className="text-text3 text-[11px] font-mono ml-auto">
          {pts.length} акций{hidden > 0 ? ` · скрыто ${hidden} (нет ${ymode === 'ep' ? 'E/P' : 'дивидендов'})` : ''} · колесо — зум, тащить — сдвиг
        </span>
      </div>

      <div className="relative bg-bg2 border border-border rounded-lg p-2">
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full select-none" style={{ maxHeight: 560, cursor: drag.current ? 'grabbing' : 'grab' }}
          onWheel={onWheel} onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}>
          <defs>
            <clipPath id="betaclip"><rect x={PAD.left} y={PAD.top} width={IW} height={IH} /></clipPath>
          </defs>

          <rect x={PAD.left} y={PAD.top} width={IW} height={IH} fill="transparent" stroke="#241638" />

          {/* сетка Y */}
          {yKey && yTicks.map(t => (
            <g key={'y' + t}>
              <line x1={PAD.left} x2={W - PAD.right} y1={sy(t)} y2={sy(t)} stroke="#241638" strokeDasharray="2 4" />
              <text x={PAD.left - 6} y={sy(t) + 3} fill="#6F648F" fontSize="10" fontFamily="JetBrains Mono, monospace" textAnchor="end">{t}%</text>
            </g>
          ))}
          {/* сетка X */}
          {xTicks.map(t => (
            <g key={'x' + t}>
              <line x1={sx(t)} x2={sx(t)} y1={PAD.top} y2={PAD.top + IH} stroke="#241638" strokeDasharray="2 4" />
              <text x={sx(t)} y={PAD.top + IH + 16} fill="#6F648F" fontSize="10" fontFamily="JetBrains Mono, monospace" textAnchor="middle">{t.toFixed(1)}</text>
            </g>
          ))}

          {/* зоны + линия рынка (в клипе) */}
          <g clipPath="url(#betaclip)">
            <rect x={PAD.left} y={PAD.top} width={Math.max(0, Math.min(sx(0.8), W - PAD.right) - PAD.left)} height={IH} fill="#52F2C9" opacity="0.04" />
            <rect x={Math.max(PAD.left, sx(1.2))} y={PAD.top} width={Math.max(0, W - PAD.right - Math.max(PAD.left, sx(1.2)))} height={IH} fill="#FF4D7A" opacity="0.04" />
            {inView && <line x1={x1line} x2={x1line} y1={PAD.top} y2={PAD.top + IH} stroke="#FF006E" strokeOpacity="0.6" strokeWidth="1.4" strokeDasharray="5 3" />}

            {pts.map(p => {
              const isH = hover && hover.id === p.id;
              const c = betaColor(p.beta);
              const cy = yKey ? sy(p[yKey]) : sy(p);
              return (
                <circle key={p.id}
                  cx={sx(p.beta)} cy={cy} r={isH ? sr(p.cap) + 2 : sr(p.cap)}
                  fill={c} fillOpacity={isH ? 0.95 : 0.5}
                  stroke={isH ? '#F2F0FF' : c} strokeWidth={isH ? 1.5 : 0.8}
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={() => setHover(p)} onMouseLeave={() => setHover(null)} />
              );
            })}
          </g>
          {inView && <text x={x1line + 4} y={PAD.top + 12} fill="#FF006E" fontSize="10" fontFamily="JetBrains Mono, monospace">рынок β=1</text>}

          <text x={PAD.left + IW / 2} y={H - 6} fill="#A79BC9" fontSize="11" fontFamily="JetBrains Mono, monospace" textAnchor="middle">β — систематический риск (к IMOEX) →</text>
          {yKey && <text x={14} y={PAD.top + IH / 2} fill="#A79BC9" fontSize="11" fontFamily="JetBrains Mono, monospace" textAnchor="middle" transform={`rotate(-90 14 ${PAD.top + IH / 2})`}>{ymode === 'ep' ? 'E/P, %' : 'Дивдоходность, %'}</text>}
        </svg>

        {hover && (
          <div className="absolute top-3 right-3 bg-bg2/95 border rounded px-3 py-2 shadow-card pointer-events-none text-xs"
               style={{ borderColor: betaColor(hover.beta) }}>
            <div className="font-mono text-text truncate max-w-[240px]">
              {hover.name}{hover.ticker && <span className="text-text3 ml-1.5">{hover.ticker}</span>}
            </div>
            <div className="text-text2 font-mono mt-0.5">
              β <b style={{ color: betaColor(hover.beta) }}>{hover.beta.toFixed(2)}</b> · {betaZone(hover.beta)}
            </div>
            <div className="text-text3 font-mono">
              {hover.ep != null ? `E/P ${hover.ep.toFixed(1)}%` : ''}
              {hover.div != null ? `${hover.ep != null ? ' · ' : ''}див ${hover.div.toFixed(1)}%` : ''}
              {hover.cap ? ` · кап. ${Math.round(hover.cap)} млрд` : ''}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-4 text-[11px] text-text3 flex-wrap">
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-full inline-block" style={{ background: '#52F2C9' }} />β&lt;0.8 защитные</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-full inline-block" style={{ background: '#A79BC9' }} />0.8–1.2 как рынок</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-full inline-block" style={{ background: '#FF4D7A' }} />β&gt;1.2 агрессивные</span>
        <span className="ml-auto">размер пузыря — капитализация</span>
      </div>
      <div className="text-text3 text-[10px] italic">
        β&gt;1 усиливает движения индекса (риск/потенциал), β&lt;1 сглаживает (защитная). Шкала обрезает единичные выбросы β — если бумага «улетела», покрути колесо/сбрось масштаб. «Все (лента)»: Y — джиттер для читаемости; «E/P»/«Дивдоходность»: риск↔доходность, только бумаги с метрикой.
      </div>
    </div>
  );
}
