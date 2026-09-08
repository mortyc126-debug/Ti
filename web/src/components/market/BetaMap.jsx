// Карта беты: положение акций по систематическому риску (β к IMOEX).
// x = бета, y = E/P (доходность прибыли, %), размер пузыря = капитализация.
// Цвет по зоне беты: <0.8 защитные, 0.8–1.2 «как рынок», >1.2 агрессивные.
// Вертикаль β=1 — рынок. Бета считается коллектором из дневных свечей
// (make_equities_cache.py) и лежит в снимке акций.

import { useMemo, useState } from 'react';
import { useStockUniverse } from '../../store/marketData.js';
import { useIssuers } from '../../store/issuers.js';
import { loadStockPoints } from '../../data/marketSurfaceData.js';

const W = 900, H = 500;
const PAD = { left: 56, right: 20, top: 20, bottom: 46 };

function betaColor(b){
  if(b < 0.8) return '#52F2C9';   // защитная — бирюза
  if(b <= 1.2) return '#A79BC9';  // как рынок — нейтраль
  return '#FF4D7A';               // агрессивная — розовая
}
function betaZone(b){
  if(b < 0.8) return 'защитная';
  if(b <= 1.2) return 'как рынок';
  return 'агрессивная';
}

export default function BetaMap(){
  useStockUniverse();            // подписка на загрузку котировок
  const allIssuers = useIssuers();  // и на винтаж/отчётность (для E/P)
  const [hover, setHover] = useState(null);

  const pts = useMemo(() => {
    return loadStockPoints({})
      .filter(p => p.beta != null && isFinite(p.beta) && p.z != null && isFinite(p.z))
      .map(p => ({ id: p.secid || p.ticker, name: p.issuer || p.name, ticker: p.ticker,
                   beta: p.beta, ep: p.z, cap: p.volumeBn || null, industry: p.industry }));
  }, [allIssuers]);

  if(!pts.length){
    return (
      <div className="h-[420px] grid place-items-center text-center text-text3 text-sm px-6">
        <div>
          Беты нет в снимке акций.<br/>
          Обнови котировки: <code className="text-text2">invest-bot/make_equities_cache.py</code> (коллектор считает бету к IMOEX из дневных свечей), затем на табе «Акции» нажми «⟳ перезагрузить».
        </div>
      </div>
    );
  }

  // домены
  const betas = pts.map(p => p.beta), eps = pts.map(p => p.ep);
  const bMin = Math.min(0, ...betas), bMax = Math.max(1.6, ...betas);
  let eMin = Math.min(...eps), eMax = Math.max(...eps);
  if(eMin === eMax){ eMin -= 1; eMax += 1; }
  const epad = (eMax - eMin) * 0.08; eMin -= epad; eMax += epad;

  const iw = W - PAD.left - PAD.right, ih = H - PAD.top - PAD.bottom;
  const sx = b => PAD.left + (b - bMin) / (bMax - bMin) * iw;
  const sy = e => PAD.top + (1 - (e - eMin) / (eMax - eMin)) * ih;

  const caps = pts.map(p => p.cap || 0);
  const capMax = Math.max(1, ...caps);
  const sr = c => 4 + Math.sqrt((c || 0) / capMax) * 16;

  const xTicks = []; for(let b = Math.ceil(bMin / 0.5) * 0.5; b <= bMax; b += 0.5) xTicks.push(+b.toFixed(2));
  const yTicks = []; const yStep = niceStep((eMax - eMin) / 5);
  for(let e = Math.ceil(eMin / yStep) * yStep; e <= eMax; e += yStep) yTicks.push(+e.toFixed(2));

  const x1 = sx(1);

  return (
    <div className="space-y-2">
      <div className="relative bg-bg2 border border-border rounded-lg p-2">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 560 }}>
          {/* зоны беты */}
          <rect x={PAD.left} y={PAD.top} width={Math.max(0, sx(0.8) - PAD.left)} height={ih} fill="#52F2C9" opacity="0.04" />
          <rect x={sx(1.2)} y={PAD.top} width={Math.max(0, PAD.left + iw - sx(1.2))} height={ih} fill="#FF4D7A" opacity="0.04" />

          {/* сетка Y */}
          {yTicks.map(t => (
            <g key={'y' + t}>
              <line x1={PAD.left} x2={W - PAD.right} y1={sy(t)} y2={sy(t)} stroke="#241638" strokeDasharray="2 4" />
              <text x={PAD.left - 6} y={sy(t) + 3} fill="#6F648F" fontSize="10" fontFamily="JetBrains Mono, monospace" textAnchor="end">{t}%</text>
            </g>
          ))}
          {/* сетка X */}
          {xTicks.map(t => (
            <g key={'x' + t}>
              <line x1={sx(t)} x2={sx(t)} y1={PAD.top} y2={PAD.top + ih} stroke="#241638" strokeDasharray="2 4" />
              <text x={sx(t)} y={PAD.top + ih + 16} fill="#6F648F" fontSize="10" fontFamily="JetBrains Mono, monospace" textAnchor="middle">{t.toFixed(1)}</text>
            </g>
          ))}

          {/* линия рынка β=1 */}
          <line x1={x1} x2={x1} y1={PAD.top} y2={PAD.top + ih} stroke="#FF006E" strokeOpacity="0.6" strokeWidth="1.4" strokeDasharray="5 3" />
          <text x={x1 + 4} y={PAD.top + 12} fill="#FF006E" fontSize="10" fontFamily="JetBrains Mono, monospace">рынок β=1</text>

          {/* точки */}
          {pts.map(p => {
            const isH = hover && hover.id === p.id;
            const c = betaColor(p.beta);
            return (
              <circle key={p.id}
                cx={sx(p.beta)} cy={sy(p.ep)} r={isH ? sr(p.cap) + 2 : sr(p.cap)}
                fill={c} fillOpacity={isH ? 0.95 : 0.5}
                stroke={isH ? '#F2F0FF' : c} strokeWidth={isH ? 1.5 : 0.8}
                style={{ cursor: 'pointer' }}
                onMouseEnter={() => setHover(p)} onMouseLeave={() => setHover(null)} />
            );
          })}

          {/* оси */}
          <text x={PAD.left + iw / 2} y={H - 6} fill="#A79BC9" fontSize="11" fontFamily="JetBrains Mono, monospace" textAnchor="middle">β — систематический риск (к IMOEX) →</text>
          <text x={14} y={PAD.top + ih / 2} fill="#A79BC9" fontSize="11" fontFamily="JetBrains Mono, monospace" textAnchor="middle" transform={`rotate(-90 14 ${PAD.top + ih / 2})`}>E/P — доходность прибыли, %</text>
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
            <div className="text-text3 font-mono">E/P {hover.ep.toFixed(1)}%{hover.cap ? ` · кап. ${Math.round(hover.cap)} млрд` : ''}</div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-4 text-[11px] text-text3 flex-wrap">
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-full inline-block" style={{ background: '#52F2C9' }} />β&lt;0.8 защитные</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-full inline-block" style={{ background: '#A79BC9' }} />0.8–1.2 как рынок</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-full inline-block" style={{ background: '#FF4D7A' }} />β&gt;1.2 агрессивные</span>
        <span className="ml-auto">размер пузыря — капитализация · {pts.length} акций с бетой</span>
      </div>
      <div className="text-text3 text-[10px] italic">
        Бета — чувствительность к рынку: β&gt;1 усиливает движения индекса (больше риск/потенциал), β&lt;1 сглаживает (защитная). Считается по дневным доходностям за ~год к IMOEX. Высокий E/P при низкой β — «дёшево и спокойно», низкий E/P при высокой β — «дорого и рискованно».
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
