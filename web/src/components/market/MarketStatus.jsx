// Плашка статуса данных «Карты» (облигации): реальные выпуски (цены +
// отчётность) или демо. Кнопка сброса кэша и перезагрузки — как на «Отраслях».

import { useBondSource, reloadBonds } from '../../store/marketData.js';

export default function MarketStatus(){
  const { source, loading, error, count } = useBondSource();
  const real = source === 'live' || source === 'cache';
  const cls = 'bg-bg2 border border-border rounded-md px-2 py-1 text-xs text-text';

  return (
    <div className="flex items-center gap-2 flex-wrap text-xs" data-no-drag>
      <button type="button" onClick={reloadBonds} className={cls + ' hover:text-acc'}
              title="Сбросить кэш и перезагрузить облигации (цены + отчётность)">
        ⟳ перезагрузить
      </button>
      <span className={real ? 'text-green/80' : 'text-yellow'}>
        {loading ? 'загрузка облигаций…'
          : real ? `${count} выпусков · цены + отчётность`
          : `ДЕМО-данные (цены не подъехали)${error ? ' · ' + error : ''}`}
      </span>
    </div>
  );
}
