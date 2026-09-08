// Страница «Карта». Три таба, у всех одинаковый «горизонт»-вью с
// kind-специфичным набором данных и фильтров.

import { useEffect, useState, useMemo } from 'react';
import Tabs from '../components/industries/Tabs.jsx';
import Surface from '../components/market/Surface.jsx';
import MarketStatus from '../components/market/MarketStatus.jsx';
import VintageControl from '../components/industries/VintageControl.jsx';
import { useStockSource, reloadStocks, useFutureSource, reloadFutures } from '../store/marketData.js';
import { useIssuers } from '../store/issuers.js';
import { diagnoseStocks, diagnoseFutures } from '../data/marketSurfaceData.js';

// Облигации — реальные данные (снимок цен + отчётность). Акции/фьючерсы/спред
// пока на демо-данных (реальных котировок по акциям в снимке нет) — помечены
// плашкой «демо».
const TABS = [
  { id: 'bonds',   label: 'Облигации' },
  { id: 'stocks',  label: 'Акции' },
  { id: 'futures', label: 'Фьючерсы' },
  { id: 'spread',  label: 'Спред (акции + фьюч)' },
];

function readTab(){
  const m = location.hash.match(/[?&]tab=([a-z]+)/);
  const id = m && m[1];
  return TABS.some(t => t.id === id) ? id : 'bonds';
}
function writeTab(id){
  const base = location.hash.split('?')[0] || '#/market';
  history.replaceState(null, '', `${location.pathname}${base}?tab=${id}`);
}

function StockStatus(){
  const { source, loading, count } = useStockSource();
  const allIssuers = useIssuers();   // гарантируем загрузку отчётности + ре-рендер
  const real = source === 'live' || source === 'cache';
  const d = useMemo(() => diagnoseStocks(), [source, count, allIssuers]);
  const cls = 'bg-bg2 border border-border rounded-md px-2 py-1 text-xs text-text';
  return (
    <div className="flex items-center gap-2 flex-wrap text-xs" data-no-drag>
      <button type="button" onClick={reloadStocks} className={cls + ' hover:text-acc'}
        title="Сбросить кэш и перезагрузить котировки акций">⟳ перезагрузить</button>
      <span className={real ? 'text-green/80' : 'text-yellow'}>
        {loading ? 'загрузка акций…'
          : real ? `${count} акций T-Invest`
          : 'ДЕМО: запусти invest-bot/make_equities_cache.py и обнови'}
      </span>
      {real && (
        <span className="text-text3 font-mono">
          сматчено {d.matched}/{d.real} · с числом акций {d.withShares} · с E/P {d.withEp} · эмитентов {d.issuers}
        </span>
      )}
    </div>
  );
}

function FutureStatus(){
  const { source, loading, count } = useFutureSource();
  const allIssuers = useIssuers();
  const real = source === 'live' || source === 'cache';
  const d = useMemo(() => diagnoseFutures(), [source, count, allIssuers]);
  const cls = 'bg-bg2 border border-border rounded-md px-2 py-1 text-xs text-text';
  return (
    <div className="flex items-center gap-2 flex-wrap text-xs" data-no-drag>
      <button type="button" onClick={reloadFutures} className={cls + ' hover:text-acc'}
        title="Сбросить кэш и перезагрузить фьючерсы">⟳ перезагрузить</button>
      <span className={real ? 'text-green/80' : 'text-yellow'}>
        {loading ? 'загрузка фьючерсов…'
          : real ? `${count} фьючерсов T-Invest`
          : 'ДЕМО: запусти invest-bot/make_equities_cache.py и обнови'}
      </span>
      {real && (
        <span className="text-text3 font-mono">на карте {d.withBasis} · привязано к акции {d.matched}/{d.loaded}</span>
      )}
    </div>
  );
}

export default function Market(){
  const [tab, setTab] = useState(readTab);
  useEffect(() => { writeTab(tab); }, [tab]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Карта рынка</h1>
        <p className="text-text2 text-sm mt-1">
          Поверхность ожидаемой YTM в координатах (срок до погашения, кредитное качество). Точки выше поверхности — рынок закладывает премию за риск, ниже — дороже аналогов. Фит: гауссова kernel-регрессия, оценка z-score через локальную σ остатков.
        </p>
      </div>

      <Tabs items={TABS} value={tab} onChange={setTab} />

      {tab === 'bonds' && (
        <div className="space-y-2">
          <MarketStatus />
          <VintageControl />
        </div>
      )}

      {tab === 'stocks' && <StockStatus />}
      {(tab === 'futures' || tab === 'spread') && <FutureStatus />}

      <div className="pt-2">
        {tab === 'bonds'   && <Surface kind="bond" />}
        {tab === 'stocks'  && <Surface kind="stock" />}
        {tab === 'futures' && <Surface kind="future" />}
        {tab === 'spread'  && <Surface kind="overlay" />}
      </div>
    </div>
  );
}
