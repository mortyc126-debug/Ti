// Модалка выбора эмитентов из текущего пула. Появляется при клике
// «+ добавить» в правой панели. Список — это buildPool после фильтров,
// клик по строке добавляет/убирает из selected.

import { X, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useComparison } from '../../store/comparison.js';

export default function CandidatePicker({ candidates, onClose }){
  const selected = useComparison(s => s.selected);
  const addIss   = useComparison(s => s.addIssuer);
  const [q, setQ] = useState('');

  useEffect(() => {
    const onKey = (e) => { if(e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const inSel = new Set(selected.map(s => s.id + '|' + s.kind));
  const filtered = q
    ? candidates.filter(c => c.iss.name.toLowerCase().includes(q.toLowerCase())
                          || (c.iss.ticker || '').toLowerCase().includes(q.toLowerCase()))
    : candidates;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm grid place-items-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-bg2 border border-border rounded-lg shadow-cardHover w-full max-w-lg max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <header className="px-4 py-3 border-b border-border/60 flex items-center gap-2">
          <Search size={14} className="text-text3" />
          <input
            autoFocus
            placeholder="Поиск по названию или тикеру…"
            value={q}
            onChange={e => setQ(e.target.value)}
            className="flex-1 bg-transparent text-sm font-mono outline-none"
          />
          <button onClick={onClose} className="text-text3 hover:text-text"><X size={16} /></button>
        </header>
        <div className="overflow-y-auto flex-1">
          {!filtered.length && (
            <div className="p-6 text-center text-text3 text-sm">
              {candidates.length
                ? 'По запросу ничего не нашлось.'
                : 'Пул пуст — включи источник вверху страницы.'}
            </div>
          )}
          <ul>
            {filtered.map(c => {
              const k = c.id + '|' + c.kind;
              const on = inSel.has(k);
              return (
                <li key={k} className="border-t border-border/40 first:border-t-0">
                  <button
                    type="button"
                    onClick={() => addIss(c.id, c.kind)}
                    className={[
                      'w-full text-left px-4 py-2 hover:bg-s2/60 transition-colors flex items-center gap-3',
                      on ? 'bg-acc-dim/30' : '',
                    ].join(' ')}
                  >
                    <span className={[
                      'w-3 h-3 rounded-full border',
                      on ? 'bg-acc border-acc' : 'border-border2',
                    ].join(' ')} />
                    <span className="font-mono text-sm text-text flex-1 truncate">
                      {c.iss.name}
                      {c.iss.ticker && <span className="text-text3 ml-1.5 text-[11px]">{c.iss.ticker}</span>}
                    </span>
                    <span className="text-text3 text-[10px] uppercase tracking-wider">{kindLabel(c.kind)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
        <footer className="px-4 py-2 border-t border-border/60 text-text3 text-[10px] font-mono">
          {selected.length} в радаре · {candidates.length} в пуле · Esc закрыть
        </footer>
      </div>
    </div>
  );
}

function kindLabel(k){
  return k === 'stock' ? 'акции' : k === 'bond' ? 'облиг.' : k === 'future' ? 'фьюч.' : k;
}
