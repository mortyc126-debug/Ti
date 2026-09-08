// Главный layout вкладки «Сравнение»: source-bar сверху → фильтры →
// два колонки (радар слева, панель компаний справа).

import { useEffect, useMemo, useState } from 'react';
import SourceBar from './SourceBar.jsx';
import CompFilters from './CompFilters.jsx';
import ComparisonRadar from './ComparisonRadar.jsx';
import ComparisonHeatmap from './ComparisonHeatmap.jsx';
import ComparisonBar from './ComparisonBar.jsx';
import CompaniesPanel from './CompaniesPanel.jsx';
import CandidatePicker from './CandidatePicker.jsx';
import { useComparison } from '../../store/comparison.js';
import { useIndustryNorms } from '../../store/industryNorms.js';
import { useRecent } from '../../store/recent.js';
import { useFavorites } from '../../store/favorites.js';
import {
  buildPool, applyMultFilters,
  applyTopNSum, applyTopNSequential, buildSelectedView,
} from '../../lib/comparisonSet.js';
import { useIssuers, currentIssuers } from '../../store/issuers.js';

export default function Comparison(){
  const allIssuers = useIssuers();   // реальные эмитенты под выбранный год; смена → пересчёт
  const sources         = useComparison(s => s.sources);
  const industryFilter  = useComparison(s => s.industryFilter);
  const filters         = useComparison(s => s.filters);
  const topN            = useComparison(s => s.topN);
  const selected        = useComparison(s => s.selected);
  const replaceSelected = useComparison(s => s.replaceSelected);
  const undo            = useComparison(s => s.undo);
  const redo            = useComparison(s => s.redo);

  const recentItems = useRecent(s => s.items);
  const favSlots    = useFavorites(s => s.slots);

  const autocal   = useIndustryNorms(s => s.autocalibrate);
  const overrides = useIndustryNorms(s => s.overrides);

  const [showPicker, setShowPicker] = useState(false);
  const [view, setView] = useState('radar');   // 'radar' | 'heatmap' | 'bar'
  // Транзиентное hover-состояние: какой полигон/строку сейчас выделить.
  // Локально (не в persistent store) — эфемерное.
  const [hoveredKey, setHoveredKey] = useState(null);

  // Глобальный Ctrl+Z / Ctrl+Y для undo/redo вкладки.
  useEffect(() => {
    const onKey = (e) => {
      const meta = e.ctrlKey || e.metaKey;
      if(!meta) return;
      const tag = (e.target?.tagName || '').toLowerCase();
      if(tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if(e.key === 'z' && !e.shiftKey){ e.preventDefault(); undo(); }
      else if((e.key === 'y') || (e.key === 'z' && e.shiftKey)){ e.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  // Кандидаты после фильтров (видимые в picker'е).
  const candidates = useMemo(() => {
    const pool = buildPool({
      sources, industryFilter,
      recentItems,
      favItems: favSlots,
    });
    return applyMultFilters(pool, filters);
  }, [sources, industryFilter, filters, recentItems, favSlots, allIssuers]);

  // Текущий selected → view с iss-данными (пересчёт при смене года/данных).
  const selectedView = useMemo(() => buildSelectedView(selected, false), [selected, allIssuers]);

  // Применить top-N.
  const applyTopN = () => {
    const issuers = currentIssuers();
    const ctx = { issuers, autocalibrate: autocal, overrides };
    let out;
    if(topN.mode === 'sum'){
      out = applyTopNSum(candidates, topN.metrics, topN.n);
    } else {
      out = applyTopNSequential(candidates, topN.metrics, ctx);
    }
    replaceSelected(out.map(c => ({ id: c.id, kind: c.kind })));
  };

  return (
    <div className="space-y-4">
      <SourceBar />
      <CompFilters />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={applyTopN}
          disabled={!topN.metrics.length}
          className={[
            'px-3 py-1.5 rounded text-xs font-mono uppercase tracking-wider transition-colors border',
            topN.metrics.length
              ? 'bg-acc text-bg border-acc hover:bg-acc/80'
              : 'bg-s2 text-text3 border-border cursor-not-allowed',
          ].join(' ')}
        >
          применить топ-N
        </button>
        <span className="text-text3 text-[11px] font-mono">
          → заменит текущий список из радара. Используй кнопки ↶/↷ если что.
        </span>
      </div>

      {/* переключатель вида: радар / тепловая карта / бары */}
      <div className="flex gap-0.5 rounded overflow-hidden border border-border w-fit">
        {[['radar', 'Радар'], ['heatmap', 'Тепловая'], ['bar', 'Бары']].map(([id, lbl]) => (
          <button key={id} type="button" onClick={() => setView(id)}
            className={['px-3 py-1 text-xs transition-colors',
              view === id ? 'bg-acc-dim text-acc' : 'bg-bg2 text-text3 hover:text-text'].join(' ')}>{lbl}</button>
        ))}
      </div>

      <div className="grid lg:grid-cols-[1fr_360px] gap-4">
        <div className="bg-bg2 border border-border rounded-lg p-3">
          {view === 'radar' && (
            <ComparisonRadar selectedView={selectedView} hoveredKey={hoveredKey} onHover={setHoveredKey} />
          )}
          {view === 'heatmap' && (
            <ComparisonHeatmap selectedView={selectedView} hoveredKey={hoveredKey} onHover={setHoveredKey} />
          )}
          {view === 'bar' && (
            <ComparisonBar selectedView={selectedView} hoveredKey={hoveredKey} onHover={setHoveredKey} />
          )}
        </div>
        <CompaniesPanel
          selectedView={selectedView}
          candidates={candidates}
          onShowPicker={() => setShowPicker(true)}
          hoveredKey={hoveredKey}
          onHover={setHoveredKey}
        />
      </div>

      {showPicker && (
        <CandidatePicker
          candidates={candidates}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  );
}
