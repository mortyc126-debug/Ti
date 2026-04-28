// Фильтры карты, kind-aware. Bonds: типы выпуска + диапазон срока.
// Stocks/Futures: диапазон капитализации (млрд ₽). Шапка с Y-mode,
// рейтинг-диапазон, X-ось горизонта — общие.

import { useState } from 'react';
import { Sliders } from 'lucide-react';
import { Y_MODES } from '../../lib/qualityComposite.js';
import { COMP_METRICS } from '../../data/comparisonMetrics.js';
import { useMarketStore } from '../../store/marketSurface.js';

const TYPE_LIST = [
  { id: 'ofz',        label: 'ОФЗ' },
  { id: 'corporate',  label: 'Корп.' },
  { id: 'municipal',  label: 'Муни.' },
  { id: 'exchange',   label: 'Биржевые' },
];

// Какие источники X-оси показывать в зависимости от kind.
function xSourcesFor(kind){
  if(kind === 'bond'){
    return [
      { id: 'maturity',   label: 'Срок' },
      { id: 'rating',     label: 'Рейтинг' },
      { id: 'multiplier', label: '1 параметр' },
      { id: 'composite',  label: 'Композит' },
    ];
  }
  return [
    { id: 'marketCap',  label: 'Кап-ция' },
    { id: 'rating',     label: 'Рейтинг' },
    { id: 'multiplier', label: '1 параметр' },
    { id: 'composite',  label: 'Композит' },
  ];
}

const BOND_MULT_OPTIONS  = ['safety','bqi','icr','nde','de','roa','ebitdaMarg','currentR','equityR','cashR'];
const STOCK_MULT_OPTIONS = ['safety','bqi','pe','roa','icr','nde','ebitdaMarg','currentR','equityR'];

export default function SurfaceFilters({ kind = 'bond' }){
  const useStore = useMarketStore(kind);

  const yMode             = useStore(s => s.yMode);
  const setYMode          = useStore(s => s.setYMode);
  const types             = useStore(s => s.types);
  const toggleType        = useStore(s => s.toggleType);
  const ratingMin         = useStore(s => s.ratingMin);
  const ratingMax         = useStore(s => s.ratingMax);
  const matMin            = useStore(s => s.matMin);
  const matMax            = useStore(s => s.matMax);
  const mktCapMin         = useStore(s => s.mktCapMin);
  const mktCapMax         = useStore(s => s.mktCapMax);
  const bwX               = useStore(s => s.bwX);
  const bwY               = useStore(s => s.bwY);
  const setRange          = useStore(s => s.setRange);
  const setBandwidth      = useStore(s => s.setBandwidth);
  const horizonX          = useStore(s => s.horizonX);
  const setHorizonX       = useStore(s => s.setHorizonX);
  const horizonMultiplier = useStore(s => s.horizonMultiplier);
  const setHorizonMult    = useStore(s => s.setHorizonMultiplier);
  const horizonMetrics    = useStore(s => s.horizonMetrics);
  const toggleMetric      = useStore(s => s.toggleHorizonMetric);
  const horizonMode       = useStore(s => s.horizonMode);
  const setHorizonMode    = useStore(s => s.setHorizonMode);

  const [paramsOpen, setParamsOpen] = useState(false);
  const X_SOURCES   = xSourcesFor(kind);
  const MULT_LIST   = kind === 'bond' ? BOND_MULT_OPTIONS : STOCK_MULT_OPTIONS;
  const isBond      = kind === 'bond';

  return (
    <div className="space-y-2">
      {/* Y-mode + (для бондов) типы */}
      <div className="flex items-center flex-wrap gap-2">
        <span className="text-text3 text-[10px] uppercase tracking-wider font-mono mr-1">фит по Y</span>
        <div className="flex gap-0.5 rounded overflow-hidden border border-border">
          {Y_MODES.map(m => (
            <button
              key={m.id}
              type="button"
              onClick={() => setYMode(m.id)}
              title="Что считается за «качество» при фите поверхности"
              className={[
                'px-2.5 py-1 text-[11px] font-mono uppercase tracking-wider transition-colors',
                yMode === m.id ? 'bg-acc-dim text-acc' : 'bg-s2 text-text3 hover:text-text',
              ].join(' ')}
            >{m.label}</button>
          ))}
        </div>
        {isBond && types && (
          <>
            <span className="text-text3 text-[10px] uppercase tracking-wider font-mono ml-2 mr-1">типы</span>
            {TYPE_LIST.map(t => (
              <button
                key={t.id}
                type="button"
                onClick={() => toggleType(t.id)}
                className={[
                  'px-2 py-1 rounded text-[11px] font-mono border transition-colors',
                  types[t.id] ? 'bg-acc-dim text-acc border-acc/40' : 'bg-s2 text-text2 border-border hover:text-text',
                ].join(' ')}
              >{t.label}</button>
            ))}
          </>
        )}
        <button
          type="button"
          onClick={() => setParamsOpen(v => !v)}
          className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-mono border border-border bg-s2 text-text2 hover:text-text"
        >
          <Sliders size={11} /> параметры
        </button>
      </div>

      {/* Диапазоны */}
      <div className="flex items-center flex-wrap gap-3 text-[11px] font-mono">
        <RangeBlock
          label="рейтинг (ord)"
          min={ratingMin} max={ratingMax}
          absMin={0} absMax={100}
          onMin={v => setRange('ratingMin', v)}
          onMax={v => setRange('ratingMax', v)}
        />
        {isBond ? (
          <RangeBlock
            label="срок, лет"
            min={matMin} max={matMax}
            absMin={0} absMax={30}
            onMin={v => setRange('matMin', v)}
            onMax={v => setRange('matMax', v)}
          />
        ) : (
          <RangeBlock
            label="кап-ция, млрд ₽"
            min={mktCapMin} max={mktCapMax}
            absMin={0} absMax={50000}
            onMin={v => setRange('mktCapMin', v)}
            onMax={v => setRange('mktCapMax', v)}
          />
        )}
      </div>

      {/* X-ось горизонта */}
      <div className="bg-s2/30 border border-border rounded px-3 py-2 space-y-2">
        <div className="flex items-center flex-wrap gap-2">
          <span className="text-text3 text-[10px] uppercase tracking-wider font-mono">X-ось</span>
          <div className="flex gap-0.5 rounded overflow-hidden border border-border">
            {X_SOURCES.map(s => (
              <button
                key={s.id}
                type="button"
                onClick={() => setHorizonX(s.id)}
                className={[
                  'px-2.5 py-1 text-[11px] font-mono uppercase tracking-wider transition-colors',
                  horizonX === s.id ? 'bg-acc-dim text-acc' : 'bg-s2 text-text3 hover:text-text',
                ].join(' ')}
              >{s.label}</button>
            ))}
          </div>

          {horizonX === 'multiplier' && (
            <select
              value={horizonMultiplier}
              onChange={e => setHorizonMult(e.target.value)}
              className="bg-s2 border border-border rounded px-2 h-7 text-[11px] font-mono focus:border-acc"
            >
              {MULT_LIST.map(id => (
                <option key={id} value={id}>{COMP_METRICS[id]?.label || id}</option>
              ))}
            </select>
          )}

          {horizonX === 'composite' && (
            <div className="flex gap-0.5 rounded overflow-hidden border border-border ml-auto">
              <button type="button" onClick={() => setHorizonMode('sum')}
                title="Среднее по перцентилям выбранных метрик"
                className={['px-2 py-1 text-[10px] font-mono uppercase tracking-wider transition-colors',
                  horizonMode === 'sum' ? 'bg-acc-dim text-acc' : 'bg-s2 text-text3 hover:text-text'].join(' ')}>
                сумма перцентилей
              </button>
              <button type="button" onClick={() => setHorizonMode('sequential')}
                title="Воронка: оставить только в зелёной зоне нормы своей отрасли по всем метрикам"
                className={['px-2 py-1 text-[10px] font-mono uppercase tracking-wider transition-colors',
                  horizonMode === 'sequential' ? 'bg-acc-dim text-acc' : 'bg-s2 text-text3 hover:text-text'].join(' ')}>
                последовательно
              </button>
            </div>
          )}
        </div>

        {horizonX === 'composite' && (
          <div className="flex flex-wrap gap-1">
            {MULT_LIST.map(id => {
              const on = horizonMetrics.includes(id);
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => toggleMetric(id)}
                  className={[
                    'px-2 py-0.5 rounded text-[11px] font-mono border transition-colors',
                    on ? 'bg-acc-dim text-acc border-acc/40' : 'bg-s2 text-text2 border-border hover:text-text',
                  ].join(' ')}
                >
                  {COMP_METRICS[id]?.short || id}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {paramsOpen && (
        <div className="bg-s2/40 border border-border rounded px-3 py-2 flex items-center flex-wrap gap-3 text-[11px] font-mono">
          <span className="text-text3 uppercase tracking-wider text-[10px]">ядро (для фита поверхности)</span>
          {isBond && (
            <label className="flex items-center gap-2 text-text2">
              σx (срок, лет):
              <input type="number" step="0.1" min="0.2" max="6"
                value={bwX} onChange={e => setBandwidth('x', parseFloat(e.target.value) || 0.5)}
                className="bg-bg border border-border rounded px-1.5 h-6 w-16 focus:border-acc outline-none" />
            </label>
          )}
          <label className="flex items-center gap-2 text-text2">
            σy (качество, пт):
            <input type="number" step="1" min="3" max="50"
              value={bwY} onChange={e => setBandwidth('y', parseFloat(e.target.value) || 5)}
              className="bg-bg border border-border rounded px-1.5 h-6 w-16 focus:border-acc outline-none" />
          </label>
          <span className="text-text3">
            Шире ядро → глаже поверхность; уже → больше деталей, но шумит.
          </span>
        </div>
      )}
    </div>
  );
}

function RangeBlock({ label, min, max, absMin, absMax, onMin, onMax }){
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-text3 uppercase tracking-wider text-[10px]">{label}</span>
      <input type="number" step="any" min={absMin} max={absMax}
        value={min} onChange={e => onMin(parseFloat(e.target.value))}
        className="bg-bg border border-border rounded px-1.5 h-6 w-20 focus:border-acc outline-none" />
      <span className="text-text3">–</span>
      <input type="number" step="any" min={absMin} max={absMax}
        value={max} onChange={e => onMax(parseFloat(e.target.value))}
        className="bg-bg border border-border rounded px-1.5 h-6 w-20 focus:border-acc outline-none" />
    </div>
  );
}
