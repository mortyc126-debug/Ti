// Композиция страницы surface. Принимает kind ('bond' | 'stock' |
// 'future') и соответствующий useStore-hook. Загружает точки,
// делает фит, передаёт детям.

import { useMemo } from 'react';
import SurfaceFilters from './SurfaceFilters.jsx';
import SurfaceChart from './SurfaceChart.jsx';
import SideTops from './SideTops.jsx';
import { useMarketStore } from '../../store/marketSurface.js';
import { loadPointsByKind } from '../../data/marketSurfaceData.js';
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

  const fitted = useMemo(() => {
    const typeSet = types
      ? new Set(Object.entries(types).filter(([, v]) => v).map(([k]) => k))
      : null;
    const all = loadPointsByKind(kind, { yMode, typeFilter: typeSet });
    const filtered = all.filter(p => {
      // Рейтинг — общий диапазон.
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

  return (
    <div className="space-y-4">
      <SurfaceFilters kind={kind} />
      <div className="grid lg:grid-cols-[1fr_320px] gap-4">
        <div className="bg-bg2 border border-border rounded-lg overflow-hidden">
          <SurfaceChart kind={kind} fitted={fitted} />
          <Legend kind={kind} />
        </div>
        <SideTops kind={kind} points={fitted.points} />
      </div>
    </div>
  );
}

function Legend({ kind }){
  const yLabel = kind === 'bond' ? 'YTM' : 'E/P';
  const yFull  = kind === 'bond'
    ? 'фактическая YTM от ожидаемой по аналогам (kernel-регрессия по сроку и качеству)'
    : 'фактическая Earnings Yield (1/P/E) от ожидаемой по аналогам (kernel-регрессия по качеству эмитента)';
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
