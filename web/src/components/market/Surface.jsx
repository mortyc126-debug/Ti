// Композиция страницы «Карта · Облигации»: фильтры → чарт + правый
// сайдбар «топы». Загружает точки, делает фит, передаёт детям.

import { useMemo } from 'react';
import SurfaceFilters from './SurfaceFilters.jsx';
import SurfaceChart from './SurfaceChart.jsx';
import SideTops from './SideTops.jsx';
import { useMarketSurface } from '../../store/marketSurface.js';
import { loadBondPoints } from '../../data/marketSurfaceData.js';
import { fitSurface } from '../../lib/kernelSurface.js';
import { ratingOrd } from '../../lib/qualityComposite.js';

export default function Surface(){
  const yMode = useMarketSurface(s => s.yMode);
  const types = useMarketSurface(s => s.types);
  const ratingMin = useMarketSurface(s => s.ratingMin);
  const ratingMax = useMarketSurface(s => s.ratingMax);
  const matMin = useMarketSurface(s => s.matMin);
  const matMax = useMarketSurface(s => s.matMax);
  const bwX = useMarketSurface(s => s.bwX);
  const bwY = useMarketSurface(s => s.bwY);

  const fitted = useMemo(() => {
    const typeSet = new Set(Object.entries(types).filter(([, v]) => v).map(([k]) => k));
    const all = loadBondPoints({ yMode, typeFilter: typeSet });
    // Применяем диапазоны рейтинга и срока. Рейтинг — через ord
    // (в любом yMode сравниваем с rating-ord, потому что фильтр
    // именно про рейтинг, а Y может быть скорингом).
    const filtered = all.filter(p => {
      if(p.x < matMin || p.x > matMax) return false;
      const ord = ratingOrd(p.rating);
      if(ord != null && (ord < ratingMin || ord > ratingMax)) return false;
      return true;
    });
    return fitSurface(filtered, { bandwidth: { x: bwX, y: bwY } });
  }, [yMode, types, ratingMin, ratingMax, matMin, matMax, bwX, bwY]);

  return (
    <div className="space-y-4">
      <SurfaceFilters />
      <div className="grid lg:grid-cols-[1fr_320px] gap-4">
        <div className="bg-bg2 border border-border rounded-lg overflow-hidden">
          <SurfaceChart fitted={fitted} />
          <Legend />
        </div>
        <SideTops points={fitted.points} />
      </div>
    </div>
  );
}

function Legend(){
  return (
    <div className="px-4 py-3 border-t border-border/60 text-[11px] font-mono text-text2 space-y-1.5">
      <div className="leading-relaxed">
        <span className="text-text3">Каждая точка — облигация.</span>{' '}
        <span className="text-text">Y</span> — насколько её фактическая YTM отличается от ожидаемой
        (поверхность E[YTM] — kernel-регрессия по сроку и качеству всех бумаг каталога).{' '}
        <span className="text-text">X</span> — то, как разложить бумаги по горизонтали (срок, рейтинг,
        мультипликатор или композит).
      </div>
      <div className="flex items-center flex-wrap gap-3 text-[10px] text-text3">
        <span className="inline-flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-danger" /> выше горизонта — рынок требует премию (риск или паника)
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-acc" /> ниже — дороже аналогов (жадный рынок или скрытое преимущество)
        </span>
        <span className="ml-auto">размер кружка = объём выпуска (лог)</span>
      </div>
    </div>
  );
}
