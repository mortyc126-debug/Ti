// Карта беты: положение акций по систематическому риску (β к IMOEX).
// Источник — вся вселенная акций с бетой (не только сматченные с отчётностью),
// иначе точек мало. Вторую ось можно переключать: E/P (где есть фундамент),
// дивдоходность или «лента» (только β — показывает всю популяцию).
// Цвет по зоне беты: <0.8 защитные, 0.8–1.2 «как рынок», >1.2 агрессивные.

import { useMemo, useState } from 'react';
import { useStockUniverse, currentStocks } from '../../store/marketData.js';
import { useIssuers } from '../../store/issuers.js';
import { loadStockPoints } from '../../data/marketSurfaceData.js';
import { sectorToIndustry } from '../../data/marketReal.js';

const W = 900, H = 500;
const PAD = { left: 56, right: 20, top: 20, bottom: 46 };

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
// детерминированный джиттер по тикеру (для режима «лента»)
function jitter(str){
  let h = 0; for(let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return (Math.abs(h) % 1000) / 1000;
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

  // все акции с бетой + фундамент (E/P) там, где сматчено
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

  // точки для текущего режима оси Y
  const yKey = ymode === 'ep' ? 'ep' : ymode === 'div' ? 'div' : null;
  const pts = yKey ? base.filter(p => p[yKey] != null && isFinite(p[yKey])) : base;
  const hidden = base.length - pts.length;

  const betas = pts.map(p => p.beta);
  const bMin = Math.min(0, ...betas), bMax = Math.max(1.6, ...betas);

  let yMin = 0, yMax = 1, yLabel = '';
  if(yKey){
    const ys = pts.map(p => p[yKey]);
    yMin = Math.min(...ys); yMax = Math.max(...ys);
    if(yMin === yMax){ yMin -= 1; yMax += 1; }
    const yp = (yMax - yMin) * 0.08; yMin -= yp; yMax += yp;
    yLabel = ymode === 'ep' ? 'E/P — доходность прибыли, %' : 'Дивдоходность, %';
  }

  const iw = W - PAD.left - PAD.right, ih = H - PAD.top - PAD.bottom;
  const sx = b => PAD.left + (b - bMin) / (bMax - bMin) * iw;
  const sy = yKey
    ? (v => PAD.top + (1 - (v - yMin) / (yMax - yMin)) * ih)
    : (p => PAD.top + (0.08 + 0.84 * jitter(p.id || '')) * ih);   // лента: джиттер

  const caps = pts.map(p => p.cap || 0);
  const capMax = Math.max(1, ...caps);
  const sr = c => 4 + Math.sqrt((c || 0) / capMax) * 16;

  const xTicks = []; for(let b = Math.ceil(bMin / 0.5) * 0.5; b <= bMax; b += 0.5) xTicks.push(+b.toFixed(2));
  const yTicks = [];
  if(yKey){ const st = niceStep((yMax - yMin) / 5); for(let e = Math.ceil(yMin / st) * st; e <= yMax; e += st) yTicks.push(+e.toFixed(2)); }
  const x1 = sx(1);

  return (
    <div className="space-y-2">
      {/* переключатель оси Y */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-text3 text-xs">ось Y:</span>
        <div className="flex gap-0.5 rounded overflow-hidden border border-border w-fit">
          {Y_MODES.map(m => (
            <button key={m.id} type="button" onClick={() => setYmode(m.id)}
              className={['px-3 py-1 text-xs transition-colors',
                ymode === m.id ? 'bg-acc-dim text-acc' : 'bg-bg2 text-text3 hover:text-text'].join(' ')}>{m.label}</button>
          ))}
        </div>
        <span className="text-text3 text-[11px] font-mono ml-auto">
          {pts.length} акций{hidden > 0 ? ` · скрыто ${hidden} (нет ${ymode === 'ep' ? 'E/P' : 'дивидендов'})` : ''}
        </span>
      </div>

      <div className="relative bg-bg2 border border-border rounded-lg p-2">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 560 }}>
          <rect x={PAD.left} y={PAD.top} width={Math.max(0, sx(0.8) - PAD.left)} height={ih} fill="#52F2C9" opacity="0.04" />
          <rect x={sx(1.2)} y={PAD.top} width={Math.max(0, PAD.left + iw - sx(1.2))} height={ih} fill="#FF4D7A" opacity="0.04" />

          {yKey && yTicks.map(t => (
            <g key={'y' + t}>
              <line x1={PAD.left} x2={W - PAD.right} y1={sy(t)} y2={sy(t)} stroke="#241638" strokeDasharray="2 4" />
              <text x={PAD.left - 6} y={sy(t) + 3} fill="#6F648F" fontSize="10" fontFamily="JetBrains Mono, monospace" textAnchor="end">{t}%</text>
            </g>
          ))}
          {xTicks.map(t => (
            <g key={'x' + t}>
              <line x1={sx(t)} x2={sx(t)} y1={PAD.top} y2={PAD.top + ih} stroke="#241638" strokeDasharray="2 4" />
              <text x={sx(t)} y={PAD.top + ih + 16} fill="#6F648F" fontSize="10" fontFamily="JetBrains Mono, monospace" textAnchor="middle">{t.toFixed(1)}</text>
            </g>
          ))}

          <line x1={x1} x2={x1} y1={PAD.top} y2={PAD.top + ih} stroke="#FF006E" strokeOpacity="0.6" strokeWidth="1.4" strokeDasharray="5 3" />
          <text x={x1 + 4} y={PAD.top + 12} fill="#FF006E" fontSize="10" fontFamily="JetBrains Mono, monospace">рынок β=1</text>

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

          <text x={PAD.left + iw / 2} y={H - 6} fill="#A79BC9" fontSize="11" fontFamily="JetBrains Mono, monospace" textAnchor="middle">β — систематический риск (к IMOEX) →</text>
          {yKey && <text x={14} y={PAD.top + ih / 2} fill="#A79BC9" fontSize="11" fontFamily="JetBrains Mono, monospace" textAnchor="middle" transform={`rotate(-90 14 ${PAD.top + ih / 2})`}>{yLabel}</text>}
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
        Бета — чувствительность к рынку: β&gt;1 усиливает движения индекса (риск/потенциал), β&lt;1 сглаживает (защитная). Режим «Все (лента)» показывает всю популяцию по β (Y — джиттер для читаемости); «E/P» и «Дивдоходность» строят риск↔доходность, но показывают только акции, у которых есть эта метрика.
      </div>
    </div>
  );
}

function niceStep(raw){
  if(!(raw > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}
