// Страница «Карта». Пока единственный таб — Облигации (поверхность).
// Акции/фьючерсы — следующая итерация.

import { useEffect, useState } from 'react';
import Tabs from '../components/industries/Tabs.jsx';
import Surface from '../components/market/Surface.jsx';

const TABS = [
  { id: 'bonds',  label: 'Облигации (поверхность)' },
  { id: 'stocks', label: 'Акции' },
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

      <div className="pt-2">
        {tab === 'bonds' && <Surface />}
        {tab === 'stocks' && (
          <div className="bg-bg2 border border-border rounded-lg p-6 text-text3 text-sm">
            Поверхность Earnings Yield для акций — следующая итерация. По акциям
            оси X (EV/EBITDA или бета) и Z (E/P) шкала иная, поэтому отдельный
            фит. Фьючерсы будут тонким слоем поверх.
          </div>
        )}
      </div>
    </div>
  );
}
