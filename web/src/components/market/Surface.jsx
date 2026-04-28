// Композиция страницы surface. Принимает kind ('bond' | 'stock' |
// 'future') и соответствующий useStore-hook. Загружает точки,
// делает фит, передаёт детям.

import { useMemo } from 'react';
import SurfaceFilters from './SurfaceFilters.jsx';
import SurfaceChart from './SurfaceChart.jsx';
import SideTops from './SideTops.jsx';
import { useMarketStore } from '../../store/marketSurface.js';
import { loadPointsByKind, loadOverlayPoints } from '../../data/marketSurfaceData.js';
import { fitSurface } from '../../lib/kernelSurface.js';
import { ratingOrd } from '../../lib/qualityComposite.js';

export default function Surface({ kind = 'bond' }){
  const useStore = useMarketStore(kind);

  const yMode = useStore(s => s.yMode);
  const types = useStore(s => s.types);
  const ratingMin = useStore(s => s.ratingMin);
  const ratingMax = useStore(s => s.ratingMax);
  const matMin = useStore(s => s.matMin);
  const matMax = useStore(s => s.matMax);
  const mktCapMin = useStore(s => s.mktCapMin);
  const mktCapMax = useStore(s => s.mktCapMax);
  const bwX = useStore(s => s.bwX);
  const bwY = useStore(s => s.bwY);

  // Для overlay-режима фит делается на акциях, фьючерсы — поверх.
  const fitted = useMemo(() => {
    const typeSet = types
      ? new Set(Object.entries(types).filter(([, v]) => v).map(([k]) => k))
      : null;
    const sourceKind = kind === 'overlay' ? 'stock' : kind;
    const all = loadPointsByKind(sourceKind, { yMode, typeFilter: typeSet });
    const filtered = all.filter(p => {
      const ord = ratingOrd(p.rating);
      if(ord != null && (ord < ratingMin || ord > ratingMax)) return false;
      if(kind === 'bond'){
        if(p.x < matMin || p.x > matMax) return false;
      } else {
        if(p.volumeBn != null && (p.volumeBn < mktCapMin || p.volumeBn > mktCapMax)) return false;
      }
      return true;
    });
    return fitSurface(filtered, { bandwidth: { x: bwX, y: bwY } });
  }, [kind, yMode, types, ratingMin, ratingMax, matMin, matMax, mktCapMin, mktCapMax, bwX, bwY]);

  // Для overlay подсчитываем фьючерсы и пары; residual у фьюча
  // считаем относительно ТОЙ ЖЕ surface'а (фит на акциях).
  const overlay = useMemo(() => {
    if(kind !== 'overlay') return null;
    const { futures, pairs } = loadOverlayPoints({ yMode });
    // Прицепляем expected/residual к каждому фьючу, используя
    // соответствующий stock из fitted.points (тот же y).
    const stockBySecid = new Map(fitted.points.map(s => [s.secid, s]));
    const futWithRes = futures.map(f => {
      const stk = stockBySecid.get(f.baseTicker);
      if(!stk) return null;
      const expected = stk.expected;
      const residual = expected != null ? f.z - expected : null;
      return { ...f, expected, residual, sparse: stk.sparse };
    }).filter(Boolean);
    return { futures: futWithRes, pairs };
  }, [kind, yMode, fitted.points]);

  return (
    <div className="space-y-4">
      <SurfaceFilters kind={kind} />
      <div className="grid lg:grid-cols-[1fr_320px] gap-4">
        <div className="bg-bg2 border border-border rounded-lg overflow-hidden">
          <SurfaceChart
            kind={kind}
            fitted={fitted}
            overlayFutures={overlay?.futures}
            overlayPairs={overlay?.pairs}
          />
          <Legend kind={kind} />
        </div>
        <SideTops
          kind={kind}
          points={fitted.points}
          overlayFutures={overlay?.futures}
        />
      </div>
    </div>
  );
}

function Legend({ kind }){
  const yLabel = kind === 'bond' ? 'YTM' : 'E/P';
  const yFull  = kind === 'bond'
    ? 'фактическая YTM от ожидаемой по аналогам (kernel-регрессия по сроку и качеству)'
    : 'фактическая Earnings Yield (1/P/E) от ожидаемой по аналогам (kernel-регрессия по качеству эмитента)';

  if(kind === 'overlay'){
    return (
      <div className="px-4 py-3 border-t border-border/60 text-[11px] font-mono text-text2 space-y-1.5">
        <div className="leading-relaxed">
          <span className="text-text3">Каждая пара точек — акция + фьюч на ту же бумагу.</span>{' '}
          Поверхность E[E/P] фитим только по акциям; фьючерс — рядом, на одной X-позиции, со своим Y.
          Соединительная линия = базис (фьюч−спот, в п.п.).
        </div>
        <div className="flex items-center flex-wrap gap-3 text-[10px] text-text3">
          <span className="inline-flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-full bg-text2" /> акция (полный кружок)
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-full border border-text2" /> фьюч (пустой кружок)
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="w-3 h-0.5 bg-warn" /> контанго (фьюч дороже спота)
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="w-3 h-0.5 bg-purple" /> бэквардация (фьюч дешевле спота)
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 py-3 border-t border-border/60 text-[11px] font-mono text-text2 space-y-1.5">
      <div className="leading-relaxed">
        <span className="text-text3">Каждая точка — {kind === 'bond' ? 'облигация' : kind === 'stock' ? 'акция' : 'фьючерс'}.</span>{' '}
        <span className="text-text">Y</span> — отклонение {yFull}.{' '}
        <span className="text-text">X</span> — то, как разложить бумаги по горизонтали (настраивается выше).
      </div>
      <div className="flex items-center flex-wrap gap-3 text-[10px] text-text3">
        <span className="inline-flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-danger" /> выше горизонта — рынок требует премию ({yLabel} выше ожидания)
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-acc" /> ниже — дороже аналогов ({yLabel} ниже ожидания)
        </span>
        <span className="ml-auto">размер кружка = {kind === 'bond' ? 'объём выпуска' : 'капитализация'} (лог)</span>
      </div>
    </div>
  );
}
