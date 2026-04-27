import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  BOND_TYPES, CURRENCIES, TRENDS, COUPON_FREQ, AMORT, OFFER,
  RATINGS, RATING_TRENDS, MULTIPLIERS,
} from '../../data/bondsCatalog.js';
import MultiplierFilter from './MultiplierFilter.jsx';

// Фильтры облигаций. Делятся на две вкладки — «Бумага» и «Эмитент».
// Все значения хранятся снаружи (state в Bonds.jsx), мы только
// рисуем UI и зовём onPatch.

export default function Filters({ value, onPatch }){
  const [tab, setTab] = useState('paper');
  return (
    <div className="bg-bg2 border border-border rounded-lg overflow-hidden">
      <div className="flex border-b border-border/60">
        <FilterTab id="paper"  label="Бумага"   active={tab} onClick={setTab} />
        <FilterTab id="issuer" label="Эмитент"  active={tab} onClick={setTab} />
        <button
          type="button"
          onClick={() => onPatch(null)}
          className="ml-auto px-3 text-[11px] font-mono uppercase tracking-wider text-text3 hover:text-danger"
          title="Сбросить все фильтры"
        >
          сброс
        </button>
      </div>
      {tab === 'paper'  && <PaperPanel  value={value} onPatch={onPatch} />}
      {tab === 'issuer' && <IssuerPanel value={value} onPatch={onPatch} />}
    </div>
  );
}

function FilterTab({ id, label, active, onClick }){
  const on = id === active;
  return (
    <button
      type="button"
      onClick={() => onClick(id)}
      className={[
        'px-4 py-2.5 text-[11px] font-mono uppercase tracking-wider border-b-2 -mb-px transition-colors',
        on ? 'border-acc text-acc' : 'border-transparent text-text2 hover:text-text',
      ].join(' ')}
    >
      {label}
    </button>
  );
}

function PaperPanel({ value, onPatch }){
  return (
    <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-5 gap-y-3">
      <Select label="Тип"      options={[{id:'any',label:'Любой'}, ...BOND_TYPES]} value={value.type}     onChange={v => onPatch({ type: v })} />
      <MultiPills label="Листинг" options={[{id:1,label:'1-й'},{id:2,label:'2-й'},{id:3,label:'3-й'}]} value={value.listing} onChange={v => onPatch({ listing: v })} />
      <MultiPills label="Валюта"  options={CURRENCIES.map(c => ({ id: c, label: c }))} value={value.currency} onChange={v => onPatch({ currency: v })} />
      <Select label="Тенденция цены" options={[{id:'any',label:'Любая'}, ...TRENDS]} value={value.trend} onChange={v => onPatch({ trend: v })} />

      <Range label="Цена, % номинала" min={value.priceMin} max={value.priceMax} onMin={v => onPatch({ priceMin: v })} onMax={v => onPatch({ priceMax: v })} step="0.5" />
      <Range label="Купон, ₽" min={value.couponMin} max={value.couponMax} onMin={v => onPatch({ couponMin: v })} onMax={v => onPatch({ couponMax: v })} />
      <Range label="YTM, %" min={value.ytmMin} max={value.ytmMax} onMin={v => onPatch({ ytmMin: v })} onMax={v => onPatch({ ytmMax: v })} step="0.5" />
      <Range label="Доходность к погашению, %" min={value.yieldMin} max={value.yieldMax} onMin={v => onPatch({ yieldMin: v })} onMax={v => onPatch({ yieldMax: v })} step="0.5" />
      <Range label="Срок, лет" min={value.durMin} max={value.durMax} onMin={v => onPatch({ durMin: v })} onMax={v => onPatch({ durMax: v })} step="0.5" />

      <CouponMode value={value} onPatch={onPatch} />

      <MultiPills label="Частота купона" options={[{id:'any',label:'Не важно'}, ...COUPON_FREQ]} value={value.freq} onChange={v => onPatch({ freq: v })} />
      <Select label="Амортизация" options={AMORT} value={value.amort} onChange={v => onPatch({ amort: v })} />
      <Select label="Оферта"      options={OFFER} value={value.offer} onChange={v => onPatch({ offer: v })} />

      <Range label="Объём выпуска, млрд ₽" min={value.volMin} max={value.volMax} onMin={v => onPatch({ volMin: v })} onMax={v => onPatch({ volMax: v })} />
    </div>
  );
}

function IssuerPanel({ value, onPatch }){
  return (
    <div className="p-4 space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-5 gap-y-3">
        <MultiPills label="Кредитный рейтинг" options={RATINGS.map(r => ({ id: r, label: r === 'none' ? 'без рейтинга' : r }))} value={value.ratings} onChange={v => onPatch({ ratings: v })} cap={9} />
        <Select label="Тенденция рейтинга" options={[{id:'any',label:'Любая'}, ...RATING_TRENDS]} value={value.ratingTrend} onChange={v => onPatch({ ratingTrend: v })} />
        <Select label="Аутсайдеры" options={[
          { id: 'off',  label: 'Не отсекать' },
          { id: 'p75',  label: 'Отсекать хуже 75% отрасли' },
          { id: 'p80',  label: 'Отсекать хуже 80% отрасли' },
          { id: 'p90',  label: 'Отсекать хуже 90% отрасли' },
          { id: 'only', label: 'Только аутсайдеры' },
        ]} value={value.outsiders} onChange={v => onPatch({ outsiders: v })} />
      </div>

      <div>
        <Label>🛡 Запас прочности (≥)</Label>
        <input
          type="number" step="5" min="0" max="100" placeholder="40"
          value={value.safetyMin}
          onChange={e => onPatch({ safetyMin: e.target.value })}
          className="bg-s2 border border-border rounded h-8 px-2 w-24 font-mono text-xs focus:border-acc outline-none"
        />
        <span className="text-text3 text-[10px] font-mono ml-2">0–100, composite по ICR/ND-EBITDA/Current/EBITDA-маржа</span>
      </div>

      <div>
        <Label>Мультипликаторы</Label>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
          {MULTIPLIERS.map(m => (
            <MultiplierFilter
              key={m.id}
              spec={m}
              value={value.mults?.[m.id]}
              onChange={x => onPatch({ mults: { ...value.mults, [m.id]: x } })}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function Label({ children }){
  return <div className="text-text3 text-[10px] uppercase tracking-wider font-mono mb-2">{children}</div>;
}

function Select({ label, options, value, onChange }){
  return (
    <label className="flex flex-col gap-1">
      <span className="text-text3 text-[10px] uppercase tracking-wider font-mono">{label}</span>
      <div className="relative">
        <select
          value={value || 'any'}
          onChange={e => onChange(e.target.value)}
          className="appearance-none w-full bg-s2 border border-border rounded h-8 pl-2 pr-7 font-mono text-xs focus:border-acc outline-none"
        >
          {options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
        <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-text3 pointer-events-none" />
      </div>
    </label>
  );
}

function Range({ label, min, max, onMin, onMax, step = 'any' }){
  return (
    <label className="flex flex-col gap-1">
      <span className="text-text3 text-[10px] uppercase tracking-wider font-mono">{label}</span>
      <div className="flex items-center gap-1">
        <input type="number" step={step} placeholder="от"
          value={min ?? ''} onChange={e => onMin(e.target.value)}
          className="bg-s2 border border-border rounded h-8 px-2 w-full font-mono text-xs focus:border-acc outline-none" />
        <span className="text-text3 text-xs">–</span>
        <input type="number" step={step} placeholder="до"
          value={max ?? ''} onChange={e => onMax(e.target.value)}
          className="bg-s2 border border-border rounded h-8 px-2 w-full font-mono text-xs focus:border-acc outline-none" />
      </div>
    </label>
  );
}

function MultiPills({ label, options, value, onChange, cap }){
  const set = new Set(value || []);
  // cap — лимит видимых пилюль; остальные «+N» под кат → разворот по клику
  const [open, setOpen] = useState(!cap);
  const visible = open ? options : options.slice(0, cap || options.length);
  const hidden = options.length - visible.length;
  const toggle = (id) => {
    const next = new Set(set);
    next.has(id) ? next.delete(id) : next.add(id);
    onChange([...next]);
  };
  return (
    <div className="flex flex-col gap-1">
      <span className="text-text3 text-[10px] uppercase tracking-wider font-mono">{label}</span>
      <div className="flex flex-wrap gap-1">
        {visible.map(o => {
          const on = set.has(o.id);
          return (
            <button
              key={o.id}
              type="button"
              onClick={() => toggle(o.id)}
              className={[
                'px-2 h-7 rounded border text-[11px] font-mono transition-colors',
                on ? 'bg-acc-dim border-acc/50 text-acc' : 'bg-s2 border-border text-text2 hover:text-text hover:border-border2',
              ].join(' ')}
            >
              {o.label}
            </button>
          );
        })}
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="px-2 h-7 rounded border border-dashed border-border text-[11px] font-mono text-text3 hover:text-text"
          >
            +{hidden}
          </button>
        )}
      </div>
    </div>
  );
}

function CouponMode({ value, onPatch }){
  return (
    <div className="flex flex-col gap-1">
      <span className="text-text3 text-[10px] uppercase tracking-wider font-mono">Купон</span>
      <div className="flex items-center gap-1">
        {[
          { id: 'any',   label: 'Любой' },
          { id: 'fix',   label: 'Фикс'    },
          { id: 'float', label: 'Флоатер' },
        ].map(o => (
          <button
            key={o.id}
            type="button"
            onClick={() => onPatch({ couponMode: o.id })}
            className={[
              'px-2 h-8 rounded border text-[11px] font-mono uppercase tracking-wider transition-colors',
              (value.couponMode || 'any') === o.id
                ? 'bg-acc-dim border-acc/50 text-acc'
                : 'bg-s2 border-border text-text2 hover:text-text',
            ].join(' ')}
          >
            {o.label}
          </button>
        ))}
        <input
          type="text"
          placeholder="спред / число"
          value={value.spreadQuery || ''}
          onChange={e => onPatch({ spreadQuery: e.target.value })}
          className="bg-s2 border border-border rounded h-8 px-2 flex-1 font-mono text-xs focus:border-acc outline-none"
          title="Поиск по строке-описанию для флоатеров: «КС+4%», «RUONIA+1.5» и т.п."
        />
      </div>
    </div>
  );
}
