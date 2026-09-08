// Страница «Карта». Три таба, у всех одинаковый «горизонт»-вью с
// kind-специфичным набором данных и фильтров.

import { useEffect, useState, useMemo } from 'react';
import Tabs from '../components/industries/Tabs.jsx';
import Surface from '../components/market/Surface.jsx';
import MarketStatus from '../components/market/MarketStatus.jsx';
import VintageControl from '../components/industries/VintageControl.jsx';
import { useStockSource, reloadStocks } from '../store/marketData.js';
import { useIssuers } from '../store/issuers.js';
import { diagnoseStocks } from '../data/marketSurfaceData.js';

// Облигации — реальные данные (снимок цен + отчётность). Акции/фьючерсы/спред
// пока на демо-данных (реальных котировок по акциям в снимке нет) — помечены
// плашкой «демо».
const TABS = [
  { id: 'bonds',   label: 'Облигации' },
  { id: 'stocks',  label: 'Акции' },
  { id: 'futures', label: 'Фьючерсы' },
  { id: 'spread',  label: 'Спред (акции + фьюч)' },
];
// Фьючерсы/спред пока на демо (нужна логика базиса против спота).
const DEMO_TABS = new Set(['futures', 'spread']);

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

      {DEMO_TABS.has(tab) && (
        <div className="text-xs text-yellow border border-yellow/30 bg-yellow/5 rounded px-3 py-1.5">
          ⚠ демо-данные: {tab === 'futures'
            ? 'реальные котировки фьючерсов есть в снимке, но карта фьючерсов ещё требует расчёта базиса против спота.'
            : 'спред акция↔фьюч требует расчёта базиса — пока мок.'}
        </div>
      )}

      <div className="pt-2">
        {tab === 'bonds'   && <Surface kind="bond" />}
        {tab === 'stocks'  && <Surface kind="stock" />}
        {tab === 'futures' && <Surface kind="future" />}
        {tab === 'spread'  && <Surface kind="overlay" />}
      </div>
    </div>
  );
}
