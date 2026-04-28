// Полоса мультипликатор-фильтров — повторяет блок из Bonds, но
// привязан к стору сравнения. + блок «Топ-N» и кнопки undo/redo.

import { Undo2, Redo2 } from 'lucide-react';
import MultiplierFilter from '../bonds/MultiplierFilter.jsx';
import { useComparison } from '../../store/comparison.js';
import { COMP_METRICS, SEQUENTIAL_AXES } from '../../data/comparisonMetrics.js';

const FILTER_METRICS = ['safety', 'bqi', 'nde', 'icr', 'ebitdaMarg', 'currentR', 'equityR', 'roa', 'de', 'cashR'];

export default function CompFilters(){
  const filters    = useComparison(s => s.filters);
  const setFilter  = useComparison(s => s.setFilter);
  const undo       = useComparison(s => s.undo);
  const redo       = useComparison(s => s.redo);
  const cursor     = useComparison(s => s.cursor);
  const histLen    = useComparison(s => s.history.length);
  const canUndo = cursor > 0;
  const canRedo = cursor < histLen - 1;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-text3 text-[10px] uppercase tracking-wider font-mono mr-1">фильтры</span>
        <div className="flex gap-1.5 flex-wrap flex-1 min-w-0">
          {FILTER_METRICS.map(mid => {
            const spec = {
              ...COMP_METRICS[mid],
              suggest: defaultSuggest(mid),
            };
            return (
              <div key={mid} className="min-w-[180px]">
                <MultiplierFilter
                  spec={spec}
                  value={filters[mid]}
                  onChange={v => setFilter(mid, v)}
                />
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-1 ml-auto">
          <UndoBtn icon={Undo2} title="Отменить" disabled={!canUndo} onClick={undo} />
          <UndoBtn icon={Redo2} title="Вернуть"  disabled={!canRedo} onClick={redo} />
        </div>
      </div>
      <TopNBlock />
    </div>
  );
}

function UndoBtn({ icon: Icon, title, disabled, onClick }){
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={[
        'w-7 h-7 grid place-items-center rounded border transition-colors',
        disabled
          ? 'border-border text-text3/40 cursor-not-allowed'
          : 'border-border text-text2 hover:text-acc hover:border-acc/40',
      ].join(' ')}
    >
      <Icon size={13} />
    </button>
  );
}

function TopNBlock(){
  const topN = useComparison(s => s.topN);
  const setTopN = useComparison(s => s.setTopN);

  const TOP_METRICS_SUM = ['safety', 'bqi', 'icr', 'nde', 'roa', 'ebitdaMarg', 'currentR', 'equityR'];
  const TOP_METRICS_SEQ = SEQUENTIAL_AXES;
  const list = topN.mode === 'sum' ? TOP_METRICS_SUM : TOP_METRICS_SEQ;

  const toggleMetric = (mid) => {
    const next = topN.metrics.includes(mid)
      ? topN.metrics.filter(x => x !== mid)
      : [...topN.metrics, mid];
    setTopN({ metrics: next });
  };

  return (
    <div className="flex items-center flex-wrap gap-2 bg-s2/40 border border-border rounded px-3 py-2">
      <span className="text-text3 text-[10px] uppercase tracking-wider font-mono">топ-N</span>
      <div className="flex gap-0.5 rounded overflow-hidden border border-border">
        <ModeBtn on={topN.mode === 'sum'} onClick={() => setTopN({ mode: 'sum' })}>сумма перцентилей</ModeBtn>
        <ModeBtn on={topN.mode === 'sequential'} onClick={() => setTopN({ mode: 'sequential' })}>последовательно</ModeBtn>
      </div>
      <div className="flex gap-1 flex-wrap">
        {list.map(mid => {
          const on = topN.metrics.includes(mid);
          return (
            <button
              key={mid}
              type="button"
              onClick={() => toggleMetric(mid)}
              className={[
                'px-2 py-0.5 rounded text-[11px] font-mono border transition-colors',
                on
                  ? 'bg-acc-dim text-acc border-acc/40'
                  : 'bg-s2 text-text2 border-border hover:text-text',
              ].join(' ')}
            >
              {COMP_METRICS[mid]?.short || mid}
            </button>
          );
        })}
      </div>
      {topN.mode === 'sum' && (
        <label className="ml-auto flex items-center gap-2 text-[11px] font-mono text-text2">
          N=
          <input
            type="number" min="1" max="200"
            value={topN.n}
            onChange={e => setTopN({ n: parseInt(e.target.value, 10) || 0 })}
            className="bg-bg border border-border rounded px-1.5 h-6 w-14 font-mono text-[11px] focus:border-acc outline-none"
          />
        </label>
      )}
      {topN.mode === 'sequential' && (
        <span className="ml-auto text-text3 text-[10px] font-mono">
          воронка: каждый шаг режет до зелёной зоны нормы отрасли
        </span>
      )}
    </div>
  );
}

function ModeBtn({ on, onClick, children }){
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider transition-colors',
        on ? 'bg-acc-dim text-acc' : 'bg-s2 text-text3 hover:text-text',
      ].join(' ')}
    >{children}</button>
  );
}

function defaultSuggest(mid){
  const m = {
    safety: 50, bqi: 50, nde: 2.5, icr: 3, ebitdaMarg: 10,
    currentR: 1.2, equityR: 30, roa: 5, de: 3, cashR: 0.2,
  };
  return m[mid] ?? 0;
}
