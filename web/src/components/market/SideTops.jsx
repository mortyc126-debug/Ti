// Сводка справа от чарта: топ-N выпусков «выше поверхности» (рынок
// требует премию) и «ниже» (рынок принимает меньшую доходность).
// Сортировка по |z|, фильтр по видимости (только не sparse).

import { useComparison } from '../../store/comparison.js';
import { useMarketSurface } from '../../store/marketSurface.js';
import { useWindows } from '../../store/windows.js';

const TOP_N = 8;

export default function SideTops({ points }){
  const setSelected = useMarketSurface(s => s.setSelected);
  const setHover    = useMarketSurface(s => s.setHover);
  const selectedId  = useMarketSurface(s => s.selectedId);
  const addToComparison = useComparison(s => s.addIssuer);
  const openWin     = useWindows(s => s.open);

  const onOpen = p => {
    setSelected(p.secid);
    openWin({ kind: 'issuer', id: p.issuer, title: p.issuer, ticker: null, mode: 'medium' });
  };

  const valid = points.filter(p => p.zscore != null && !p.sparse);
  const above = [...valid].filter(p => p.zscore > 0).sort((a, b) => b.zscore - a.zscore).slice(0, TOP_N);
  const below = [...valid].filter(p => p.zscore < 0).sort((a, b) => a.zscore - b.zscore).slice(0, TOP_N);

  return (
    <div className="space-y-3">
      <Block
        title="Выше поверхности"
        subtitle="рынок требует премию · риск либо опасения"
        tone="danger"
        items={above}
        selectedId={selectedId}
        onSelect={onOpen}
        onHover={p => setHover(p?.secid || null)}
        onAddCompare={p => addToComparison(p.issuer, 'bond')}
      />
      <Block
        title="Ниже поверхности"
        subtitle="рынок принимает меньшую доходность · дороже аналогов"
        tone="acc"
        items={below}
        selectedId={selectedId}
        onSelect={onOpen}
        onHover={p => setHover(p?.secid || null)}
        onAddCompare={p => addToComparison(p.issuer, 'bond')}
      />
    </div>
  );
}

const TONE_CLASSES = {
  danger: { border: 'border-danger/40', text: 'text-danger', bgHover: 'hover:bg-danger/10' },
  acc:    { border: 'border-acc/40',    text: 'text-acc',    bgHover: 'hover:bg-acc-dim' },
};

function Block({ title, subtitle, tone, items, selectedId, onSelect, onHover, onAddCompare }){
  const cls = TONE_CLASSES[tone] || TONE_CLASSES.acc;
  return (
    <div className="bg-bg2 border border-border rounded-lg overflow-hidden">
      <header className={`px-3 py-2 border-b ${cls.border}`}>
        <div className={`text-xs font-mono uppercase tracking-wider ${cls.text}`}>{title}</div>
        <div className="text-text3 text-[10px] font-mono leading-tight">{subtitle}</div>
      </header>
      {!items.length && (
        <div className="p-4 text-text3 text-xs">Нет точек с оценкой.</div>
      )}
      <ul>
        {items.map(p => {
          const sel = selectedId === p.secid;
          return (
            <li key={p.secid} className="border-t border-border/40 first:border-t-0">
              <div
                className={[
                  'px-3 py-1.5 flex items-center gap-2 cursor-pointer transition-colors',
                  sel ? 'bg-acc-dim/40' : cls.bgHover,
                ].join(' ')}
                onMouseEnter={() => onHover(p)}
                onMouseLeave={() => onHover(null)}
                onClick={() => onSelect(p)}
              >
                <span className="font-mono text-text text-[11px] flex-1 truncate">
                  {p.name}
                  <span className="text-text3 ml-1">· {p.issuer}</span>
                </span>
                <span className="text-[10px] font-mono text-text2 tabular-nums">
                  {p.z.toFixed(1)}%
                </span>
                <span className={`text-[10px] font-mono tabular-nums ${cls.text}`}>
                  {p.zscore >= 0 ? '+' : ''}{p.zscore.toFixed(1)}σ
                </span>
                <button
                  type="button"
                  onClick={e => { e.stopPropagation(); onAddCompare(p); }}
                  title="Добавить в Сравнение"
                  className="text-text3 hover:text-acc text-[10px] font-mono"
                >
                  +cmp
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
