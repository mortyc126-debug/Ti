// Сводка справа от чарта: топ-N выпусков «выше поверхности» (рынок
// требует премию) и «ниже» (рынок принимает меньшую доходность).
// Сортировка по |z|, фильтр по видимости (только не sparse).

import { useComparison } from '../../store/comparison.js';
import { useMarketStore } from '../../store/marketSurface.js';
import { useWindows } from '../../store/windows.js';

const TOP_N = 8;

export default function SideTops({ kind = 'bond', points, overlayFutures }){
  const useStore = useMarketStore(kind);
  const setSelected = useStore(s => s.setSelected);
  const setHover    = useStore(s => s.setHover);
  const selectedId  = useStore(s => s.selectedId);
  const addToComparison = useComparison(s => s.addIssuer);
  const openWin     = useWindows(s => s.open);

  const onOpen = p => {
    setSelected(p.secid);
    openWin({ kind: 'issuer', id: p.issuer, title: p.issuer, ticker: p.ticker || null, mode: 'medium' });
  };

  // В overlay-режиме показываем топы контанго / бэквардации
  // вместо обычных «выше/ниже поверхности».
  if(kind === 'overlay' && overlayFutures){
    const valid = overlayFutures.filter(f => f.basisPp != null);
    const cont = [...valid].filter(f => f.basisPp > 0).sort((a, b) => b.basisPp - a.basisPp).slice(0, TOP_N);
    const back = [...valid].filter(f => f.basisPp < 0).sort((a, b) => a.basisPp - b.basisPp).slice(0, TOP_N);
    return (
      <div className="space-y-3">
        <BasisBlock title="Контанго" subtitle="фьюч дороже спота" tone="warn" items={cont}
          selectedId={selectedId} onSelect={onOpen} onHover={p => setHover(p?.secid || null)} />
        <BasisBlock title="Бэквардация" subtitle="фьюч дешевле спота" tone="purple" items={back}
          selectedId={selectedId} onSelect={onOpen} onHover={p => setHover(p?.secid || null)} />
      </div>
    );
  }

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
        onAddCompare={p => addToComparison(p.issuer, kind)}
      />
      <Block
        title="Ниже поверхности"
        subtitle="рынок принимает меньшую доходность · дороже аналогов"
        tone="acc"
        items={below}
        selectedId={selectedId}
        onSelect={onOpen}
        onHover={p => setHover(p?.secid || null)}
        onAddCompare={p => addToComparison(p.issuer, kind)}
      />
    </div>
  );
}

const TONE_CLASSES = {
  danger: { border: 'border-danger/40', text: 'text-danger', bgHover: 'hover:bg-danger/10' },
  acc:    { border: 'border-acc/40',    text: 'text-acc',    bgHover: 'hover:bg-acc-dim' },
  warn:   { border: 'border-warn/40',   text: 'text-warn',   bgHover: 'hover:bg-warn/10' },
  purple: { border: 'border-purple/40', text: 'text-purple', bgHover: 'hover:bg-purple/10' },
};

function BasisBlock({ title, subtitle, tone, items, selectedId, onSelect, onHover }){
  const cls = TONE_CLASSES[tone] || TONE_CLASSES.acc;
  return (
    <div className="bg-bg2 border border-border rounded-lg overflow-hidden">
      <header className={`px-3 py-2 border-b ${cls.border}`}>
        <div className={`text-xs font-mono uppercase tracking-wider ${cls.text}`}>{title}</div>
        <div className="text-text3 text-[10px] font-mono leading-tight">{subtitle}</div>
      </header>
      {!items.length && (
        <div className="p-4 text-text3 text-xs">Нет фьючерсов в этой группе.</div>
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
                onClick={() => onSelect(p)}>
                <span className="font-mono text-text text-[11px] flex-1 truncate">
                  {p.name}
                  <span className="text-text3 ml-1">· {p.baseTicker}</span>
                </span>
                <span className={`text-[10px] font-mono tabular-nums ${cls.text}`}>
                  {p.basisPp >= 0 ? '+' : ''}{p.basisPp.toFixed(1)}пп
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

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
