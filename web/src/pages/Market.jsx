// Страница «Карта». Три таба, у всех одинаковый «горизонт»-вью с
// kind-специфичным набором данных и фильтров.

import { useEffect, useState } from 'react';
import Tabs from '../components/industries/Tabs.jsx';
import Surface from '../components/market/Surface.jsx';
import MarketStatus from '../components/market/MarketStatus.jsx';
import VintageControl from '../components/industries/VintageControl.jsx';

// Облигации — реальные данные (снимок цен + отчётность). Акции/фьючерсы/спред
// пока на демо-данных (реальных котировок по акциям в снимке нет) — помечены
// плашкой «демо».
const TABS = [
  { id: 'bonds',   label: 'Облигации' },
  { id: 'stocks',  label: 'Акции' },
  { id: 'futures', label: 'Фьючерсы' },
  { id: 'spread',  label: 'Спред (акции + фьюч)' },
];
const DEMO_TABS = new Set(['stocks', 'futures', 'spread']);

function readTab(){
  const m = location.hash.match(/[?&]tab=([a-z]+)/);
  const id = m && m[1];
  return TABS.some(t => t.id === id) ? id : 'bonds';
}
function writeTab(id){
  const base = location.hash.split('?')[0] || '#/market';
  history.replaceState(null, '', `${location.pathname}${base}?tab=${id}`);
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

      {DEMO_TABS.has(tab) && (
        <div className="text-xs text-yellow border border-yellow/30 bg-yellow/5 rounded px-3 py-1.5">
          ⚠ демо-данные: реальных котировок по акциям/фьючерсам в снимке пока нет. Показана мок-выборка для проверки вида.
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
