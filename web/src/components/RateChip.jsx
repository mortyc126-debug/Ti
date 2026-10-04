// Чип ключевой ставки ЦБ в шапке — единый показ ставки на всём вебе.
// Источник — центральный стор rates.js (читает историю из модулей «Долг»/
// «Отчётность»). Клик ведёт в модуль «Долг», где ставка ведётся.
import { useNavigate } from 'react-router-dom';
import { Percent } from 'lucide-react';
import { useKeyRate } from '../store/rates.js';

export default function RateChip(){
  const { current, asOf, source } = useKeyRate();
  const navigate = useNavigate();
  if(current == null) return null;
  const d = (asOf && asOf.length === 10) ? asOf.split('-').reverse().join('.') : asOf;
  const title = `Ключевая ставка ЦБ: ${current}%`
    + (d ? ` · на ${d}` : '')
    + (source === 'macro-avg' ? ' · среднегодовая (историю заведи в «Долге»)' : '')
    + '. Клик — модуль «Долг».';
  return (
    <button
      type="button"
      onClick={() => navigate('/debt')}
      title={title}
      className="hidden sm:inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-mono text-acc bg-acc-dim hover:brightness-110 transition whitespace-nowrap shrink-0"
    >
      <Percent size={12} />
      КС {current}%
    </button>
  );
}
