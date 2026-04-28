// Фильтры «Карты». Единственный режим — Горизонт; вместо тогглера
// видов — конфигуратор X-оси (срок / рейтинг / один мультипликатор /
// композит).

import { useState } from 'react';
import { Sliders } from 'lucide-react';
import { Y_MODES } from '../../lib/qualityComposite.js';
import { COMP_METRICS } from '../../data/comparisonMetrics.js';
import { useMarketSurface } from '../../store/marketSurface.js';

const TYPE_LIST = [
  { id: 'ofz',        label: 'ОФЗ' },
  { id: 'corporate',  label: 'Корп.' },
  { id: 'municipal',  label: 'Муни.' },
  { id: 'exchange',   label: 'Биржевые' },
];

const X_SOURCES = [
  { id: 'maturity',   label: 'Срок' },
  { id: 'rating',     label: 'Рейтинг' },
  { id: 'multiplier', label: '1 параметр' },
  { id: 'composite',  label: 'Композит' },
];

const MULT_OPTIONS = ['safety','bqi','icr','nde','de','roa','ebitdaMarg','currentR','equityR','cashR'];

export default function SurfaceFilters(){
  const yMode             = useMarketSurface(s => s.yMode);
  const setYMode          = useMarketSurface(s => s.setYMode);
  const types             = useMarketSurface(s => s.types);
  const toggleType        = useMarketSurface(s => s.toggleType);
  const ratingMin         = useMarketSurface(s => s.ratingMin);
  const ratingMax         = useMarketSurface(s => s.ratingMax);
  const matMin            = useMarketSurface(s => s.matMin);
  const matMax            = useMarketSurface(s => s.matMax);
  const bwX               = useMarketSurface(s => s.bwX);
  const bwY               = useMarketSurface(s => s.bwY);
  const setRange          = useMarketSurface(s => s.setRange);
  const setBandwidth      = useMarketSurface(s => s.setBandwidth);
  const horizonX          = useMarketSurface(s => s.horizonX);
  const setHorizonX       = useMarketSurface(s => s.setHorizonX);
  const horizonMultiplier = useMarketSurface(s => s.horizonMultiplier);
  const setHorizonMult    = useMarketSurface(s => s.setHorizonMultiplier);
  const horizonMetrics    = useMarketSurface(s => s.horizonMetrics);
  const toggleMetric      = useMarketSurface(s => s.toggleHorizonMetric);
  const horizonMode       = useMarketSurface(s => s.horizonMode);
  const setHorizonMode    = useMarketSurface(s => s.setHorizonMode);

  const [paramsOpen, setParamsOpen] = useState(false);

  return (
    <div className="space-y-2">
      {/* Y-mode + типы */}
      <div className="flex items-center flex-wrap gap-2">
        <span className="text-text3 text-[10px] uppercase tracking-wider font-mono mr-1">фит по Y</span>
        <div className="flex gap-0.5 rounded overflow-hidden border border-border">
          {Y_MODES.map(m => (
            <button
              key={m.id}
              type="button"
              onClick={() => setYMode(m.id)}
              title="Влияет на расчёт ожидаемой YTM (поверхности): qualityY(b, mode)"
              className={[
                'px-2.5 py-1 text-[11px] font-mono uppercase tracking-wider transition-colors',
                yMode === m.id ? 'bg-acc-dim text-acc' : 'bg-s2 text-text3 hover:text-text',
              ].join(' ')}
            >{m.label}</button>
          ))}
        </div>
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
        <RangeBlock
          label="срок, лет"
          min={matMin} max={matMax}
          absMin={0} absMax={30}
          onMin={v => setRange('matMin', v)}
          onMax={v => setRange('matMax', v)}
        />
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
              {MULT_OPTIONS.map(id => (
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
            {MULT_OPTIONS.map(id => {
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
          <label className="flex items-center gap-2 text-text2">
            σx (срок, лет):
            <input type="number" step="0.1" min="0.2" max="6"
              value={bwX} onChange={e => setBandwidth('x', parseFloat(e.target.value) || 0.5)}
              className="bg-bg border border-border rounded px-1.5 h-6 w-16 focus:border-acc outline-none" />
          </label>
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
        className="bg-bg border border-border rounded px-1.5 h-6 w-16 focus:border-acc outline-none" />
      <span className="text-text3">–</span>
      <input type="number" step="any" min={absMin} max={absMax}
        value={max} onChange={e => onMax(parseFloat(e.target.value))}
        className="bg-bg border border-border rounded px-1.5 h-6 w-16 focus:border-acc outline-none" />
    </div>
  );
}
