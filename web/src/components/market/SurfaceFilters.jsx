// Полоса фильтров для surface-чарта. Тогглер Y-режима, чек-боксы
// типов выпусков, диапазон рейтинга/срока, тогглер фоновой тепловой
// карты. Полоса ядра — в свернутом блоке «параметры».

import { useState } from 'react';
import { Sliders, Map, Layers, Square, BarChart3, Waves } from 'lucide-react';
import { Y_MODES } from '../../lib/qualityComposite.js';
import { useMarketSurface } from '../../store/marketSurface.js';

const VIEW_MODES = [
  { id: 'flat',    label: 'Плоский',  icon: Square,    tip: 'Точки на 2D-плоскости (срок × качество), цвет = z-score. Высота отклонения только цветом.' },
  { id: 'sticks',  label: 'Стержни',  icon: BarChart3, tip: 'Стержень от поверхности до точки: длина и цвет показывают величину и знак residual\'а.' },
  { id: 'horizon', label: 'Горизонт', icon: Waves,     tip: 'Взгляд от поверхности: X = срок (или качество), Y = residual в bps. Точки выше горизонта — «торчат», ниже — «утонули».' },
];

const TYPE_LIST = [
  { id: 'ofz',        label: 'ОФЗ' },
  { id: 'corporate',  label: 'Корп.' },
  { id: 'municipal',  label: 'Муни.' },
  { id: 'exchange',   label: 'Биржевые' },
];

export default function SurfaceFilters(){
  const yMode = useMarketSurface(s => s.yMode);
  const setYMode = useMarketSurface(s => s.setYMode);
  const types = useMarketSurface(s => s.types);
  const toggleType = useMarketSurface(s => s.toggleType);
  const ratingMin = useMarketSurface(s => s.ratingMin);
  const ratingMax = useMarketSurface(s => s.ratingMax);
  const matMin = useMarketSurface(s => s.matMin);
  const matMax = useMarketSurface(s => s.matMax);
  const bwX = useMarketSurface(s => s.bwX);
  const bwY = useMarketSurface(s => s.bwY);
  const showHeatmap = useMarketSurface(s => s.showHeatmap);
  const showContours = useMarketSurface(s => s.showContours);
  const viewMode = useMarketSurface(s => s.viewMode);
  const setViewMode = useMarketSurface(s => s.setViewMode);
  const horizonX = useMarketSurface(s => s.horizonX);
  const setHorizonX = useMarketSurface(s => s.setHorizonX);
  const setRange = useMarketSurface(s => s.setRange);
  const setBandwidth = useMarketSurface(s => s.setBandwidth);
  const toggleHeatmap = useMarketSurface(s => s.toggleHeatmap);
  const toggleContours = useMarketSurface(s => s.toggleContours);

  const [paramsOpen, setParamsOpen] = useState(false);

  return (
    <div className="space-y-2">
      <div className="flex items-center flex-wrap gap-2">
        <span className="text-text3 text-[10px] uppercase tracking-wider font-mono mr-1">ось Y</span>
        <div className="flex gap-0.5 rounded overflow-hidden border border-border">
          {Y_MODES.map(m => (
            <button
              key={m.id}
              type="button"
              onClick={() => setYMode(m.id)}
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
              types[t.id]
                ? 'bg-acc-dim text-acc border-acc/40'
                : 'bg-s2 text-text2 border-border hover:text-text',
            ].join(' ')}
          >{t.label}</button>
        ))}

        <div className="ml-auto flex items-center gap-1">
          <span className="text-text3 text-[10px] uppercase tracking-wider font-mono mr-1">вид</span>
          <div className="flex gap-0.5 rounded overflow-hidden border border-border">
            {VIEW_MODES.map(m => {
              const Icon = m.icon;
              return (
                <button
                  key={m.id}
                  type="button"
                  title={m.tip}
                  onClick={() => setViewMode(m.id)}
                  className={[
                    'inline-flex items-center gap-1 px-2 py-1 text-[11px] font-mono uppercase tracking-wider transition-colors',
                    viewMode === m.id ? 'bg-acc-dim text-acc' : 'bg-s2 text-text3 hover:text-text',
                  ].join(' ')}
                >
                  <Icon size={11} /> {m.label}
                </button>
              );
            })}
          </div>
          {viewMode === 'horizon' && (
            <div className="ml-1 flex gap-0.5 rounded overflow-hidden border border-border" title="По чему развернуть горизонт">
              <button type="button" onClick={() => setHorizonX('maturity')}
                className={['px-2 py-1 text-[10px] font-mono uppercase tracking-wider transition-colors',
                  horizonX === 'maturity' ? 'bg-acc-dim text-acc' : 'bg-s2 text-text3 hover:text-text'].join(' ')}>
                по сроку
              </button>
              <button type="button" onClick={() => setHorizonX('quality')}
                className={['px-2 py-1 text-[10px] font-mono uppercase tracking-wider transition-colors',
                  horizonX === 'quality' ? 'bg-acc-dim text-acc' : 'bg-s2 text-text3 hover:text-text'].join(' ')}>
                по качеству
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={toggleHeatmap}
            title="Фон — поле E[YTM | срок, качество]"
            className={[
              'ml-1 inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-mono border transition-colors',
              showHeatmap ? 'bg-acc-dim text-acc border-acc/40' : 'bg-s2 text-text2 border-border hover:text-text',
            ].join(' ')}
          >
            <Map size={11} /> заливка
          </button>
          <button
            type="button"
            onClick={toggleContours}
            title="Изолинии равной E[YTM] поверх поверхности"
            className={[
              'inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-mono border transition-colors',
              showContours ? 'bg-acc-dim text-acc border-acc/40' : 'bg-s2 text-text2 border-border hover:text-text',
            ].join(' ')}
          >
            <Layers size={11} /> изолинии
          </button>
          <button
            type="button"
            onClick={() => setParamsOpen(v => !v)}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-mono border border-border bg-s2 text-text2 hover:text-text"
          >
            <Sliders size={11} /> параметры
          </button>
        </div>
      </div>

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

      {paramsOpen && (
        <div className="bg-s2/40 border border-border rounded px-3 py-2 flex items-center flex-wrap gap-3 text-[11px] font-mono">
          <span className="text-text3 uppercase tracking-wider text-[10px]">ядро</span>
          <label className="flex items-center gap-2 text-text2">
            σx (срок, лет):
            <input
              type="number" step="0.1" min="0.2" max="6"
              value={bwX}
              onChange={e => setBandwidth('x', parseFloat(e.target.value) || 0.5)}
              className="bg-bg border border-border rounded px-1.5 h-6 w-16 focus:border-acc outline-none"
            />
          </label>
          <label className="flex items-center gap-2 text-text2">
            σy (качество, пт):
            <input
              type="number" step="1" min="3" max="50"
              value={bwY}
              onChange={e => setBandwidth('y', parseFloat(e.target.value) || 5)}
              className="bg-bg border border-border rounded px-1.5 h-6 w-16 focus:border-acc outline-none"
            />
          </label>
          <span className="text-text3">
            Шире ядро → глаже поверхность, но детали смазываются.
            Уже → видно локальные премии, но шумит.
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
      <input
        type="number" step="any" min={absMin} max={absMax}
        value={min}
        onChange={e => onMin(parseFloat(e.target.value))}
        className="bg-bg border border-border rounded px-1.5 h-6 w-16 focus:border-acc outline-none"
      />
      <span className="text-text3">–</span>
      <input
        type="number" step="any" min={absMin} max={absMax}
        value={max}
        onChange={e => onMax(parseFloat(e.target.value))}
        className="bg-bg border border-border rounded px-1.5 h-6 w-16 focus:border-acc outline-none"
      />
    </div>
  );
}
