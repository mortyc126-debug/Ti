// Страница «Отрасли». Три таба: Сравнение / Медианы / Нормы.
// Состояние активного таба persist в URL hash (?tab=…), чтобы
// перезагрузка не сбрасывала выбор.

import { useEffect, useState } from 'react';
import Tabs from '../components/industries/Tabs.jsx';
import Comparison from '../components/industries/Comparison.jsx';
import Medians from '../components/industries/Medians.jsx';
import Norms from '../components/industries/Norms.jsx';

const TABS = [
  { id: 'comparison', label: 'Сравнение' },
  { id: 'medians',    label: 'Медианы' },
  { id: 'norms',      label: 'Нормы' },
];

function readTab(){
  const m = location.hash.match(/[?&]tab=([a-z]+)/);
  const id = m && m[1];
  return TABS.some(t => t.id === id) ? id : 'comparison';
}

function writeTab(id){
  const base = location.hash.split('?')[0] || '#/industries';
  history.replaceState(null, '', `${location.pathname}${base}?tab=${id}`);
}

export default function Industries(){
  const [tab, setTab] = useState(readTab);

  useEffect(() => {
    writeTab(tab);
  }, [tab]);

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Отрасли</h1>
          <p className="text-text2 text-sm mt-1">
            Сравнение компаний по мультипликаторам, медианы по секторам и редактирование норм для зон зелёное/жёлтое/красное.
          </p>
        </div>
      </div>

      <Tabs items={TABS} value={tab} onChange={setTab} />

      <div className="pt-2">
        {tab === 'comparison' && <Comparison />}
        {tab === 'medians'    && <Medians />}
        {tab === 'norms'      && <Norms />}
      </div>
    </div>
  );
}
