// Правая панель сравнения. Список выбранных эмитентов, сгруппированный
// по типу бумаги (акции/облигации/фьючерсы). У каждой строки:
// - цвет-чип = toggle visibility,
// - имя + тикер,
// - мини-метрики: P/E (если есть), ROA, ND/EBITDA, ICR, BQI и стресс
//   (полоски 0-100),
// - кнопка [✕] = удалить из списка.

import { X, Plus, Eye, EyeOff } from 'lucide-react';
import { useComparison } from '../../store/comparison.js';
import { useIndustryNorms } from '../../store/industryNorms.js';
import { useWindows } from '../../store/windows.js';
import { metricSpec } from '../../data/comparisonMetrics.js';
import { colorFor } from './colorPalette.js';
import { resolveNorm, classifyValue } from '../../lib/norms.js';
import { getAllIssuers } from '../../data/issuersMock.js';

const KIND_GROUPS = [
  { kind: 'stock',  title: 'Акции',         tone: 'text-green' },
  { kind: 'bond',   title: 'Облигации',     tone: 'text-acc' },
  { kind: 'future', title: 'Фьючерсы',      tone: 'text-purple' },
];

export default function CompaniesPanel({ selectedView, candidates, onShowPicker }){
  const showLayer = useComparison(s => s.showLayer);
  const toggleVis = useComparison(s => s.toggleVisible);
  const removeIss = useComparison(s => s.removeIssuer);

  const grouped = {};
  for(const x of selectedView){
    if(!grouped[x.kind]) grouped[x.kind] = [];
    grouped[x.kind].push(x);
  }
  // Индекс внутри kind — для цвета.
  const idxInKind = new Map();
  for(const k of Object.keys(grouped)){
    grouped[k].forEach((x, i) => idxInKind.set(x.id + '|' + x.kind, i));
  }

  const empty = !selectedView.length;

  return (
    <div className="bg-bg2 border border-border rounded-lg overflow-hidden flex flex-col">
      <header className="px-4 py-3 border-b border-border/60 flex items-center justify-between gap-2">
        <div className="text-text2 text-xs font-mono uppercase tracking-wider">Компании ({selectedView.length})</div>
        <button
          type="button"
          onClick={onShowPicker}
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-mono text-acc bg-acc-dim border border-acc/30 hover:bg-acc/15 transition-colors"
          title={`+${candidates.length} доступно из источников`}
        >
          <Plus size={11} />
          добавить
          <span className="text-text3 text-[10px]">({candidates.length})</span>
        </button>
      </header>

      {empty && (
        <div className="p-4 text-text3 text-xs">
          Список пуст. Нажми «добавить» — выбери из текущих источников, или примени топ-N.
        </div>
      )}

      <div className="overflow-y-auto max-h-[480px]">
        {KIND_GROUPS.map(g => {
          const items = grouped[g.kind];
          if(!items?.length) return null;
          const layerOn = showLayer[g.kind];
          return (
            <section key={g.kind} className="border-t border-border/40 first:border-t-0">
              <div className={`px-4 py-1.5 text-[10px] uppercase tracking-wider font-mono ${g.tone} bg-s2/40`}>
                {g.title} ({items.length}) {!layerOn && <span className="ml-1 text-text3">— слой скрыт</span>}
              </div>
              <ul>
                {items.map(x => (
                  <CompanyRow
                    key={x.id + '|' + x.kind}
                    item={x}
                    color={colorFor(x.kind, idxInKind.get(x.id + '|' + x.kind), items.length)}
                    layerOn={layerOn}
                    onToggleVis={() => toggleVis(x.id, x.kind)}
                    onRemove={() => removeIss(x.id, x.kind)}
                  />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function CompanyRow({ item, color, layerOn, onToggleVis, onRemove }){
  const iss = item.iss;
  const visible = item.visible && layerOn;
  const openWin = useWindows(s => s.open);
  const openIssuer = () => openWin({
    kind: 'issuer', id: iss.id, title: iss.name, ticker: iss.ticker || null, mode: 'medium',
  });
  return (
    <li
      className={[
        'px-4 py-2 border-t border-border/30 first:border-t-0',
        visible ? '' : 'opacity-50',
      ].join(' ')}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onToggleVis}
          title={visible ? 'Скрыть на радаре' : 'Показать на радаре'}
          className="w-3.5 h-3.5 rounded-full shrink-0 grid place-items-center"
          style={{
            background: visible ? color : 'transparent',
            border: `1.5px solid ${color}`,
          }}
        >
          {visible
            ? <Eye size={8} className="text-bg" />
            : <EyeOff size={8} style={{ color }} />
          }
        </button>
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={openIssuer}
            title="Открыть карточку эмитента"
            className="font-mono text-text text-sm truncate text-left hover:text-acc transition-colors w-full"
          >
            {iss.name}
            {iss.ticker && <span className="text-text3 ml-1.5 text-[11px]">{iss.ticker}</span>}
          </button>
          <MiniMetrics mults={iss.mults} industry={iss.industry} />
        </div>
        <button
          type="button"
          onClick={onRemove}
          title="Убрать из списка"
          className="text-text3 hover:text-danger transition-colors p-1 -mr-1 shrink-0"
        >
          <X size={12} />
        </button>
      </div>
    </li>
  );
}

function MiniMetrics({ mults, industry }){
  const autocal     = useIndustryNorms(s => s.autocalibrate);
  const overrides   = useIndustryNorms(s => s.overrides);
  const issuers = getAllIssuers();
  const ctx = { issuers, autocalibrate: autocal, overrides };

  const items = [
    { id: 'roa',        as: 'ROA' },
    { id: 'nde',        as: 'ND/E' },
    { id: 'icr',        as: 'ICR' },
    { id: 'ebitdaMarg', as: 'm.' },
  ];
  return (
    <div className="mt-1 flex items-center gap-3 text-[10px] font-mono text-text3 flex-wrap">
      {items.map(it => {
        const spec = metricSpec(it.id);
        const v = mults?.[it.id];
        if(v == null) return (
          <span key={it.id}><span className="text-text3">{it.as}</span> —</span>
        );
        const norm = resolveNorm(industry, it.id, ctx);
        const cls = classifyValue(v, norm, spec.higher);
        return (
          <span key={it.id}>
            <span className="text-text3">{it.as}</span>{' '}
            <span className={zoneCls(cls)}>{fmt(v, spec.fmt)}</span>
          </span>
        );
      })}
      <Bar label="BQI" v={mults?.bqi} />
      <Bar label="Стр" v={mults?.safety} />
    </div>
  );
}

function Bar({ label, v }){
  if(v == null) return <span><span className="text-text3">{label}</span> —</span>;
  const tone = v >= 70 ? 'bg-green' : v >= 40 ? 'bg-warn' : 'bg-danger';
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-text3">{label}</span>
      <span className="inline-block w-12 h-1.5 bg-border rounded overflow-hidden">
        <span className={`block h-full ${tone}`} style={{ width: `${v}%` }} />
      </span>
      <span className="text-text2">{v}</span>
    </span>
  );
}

function zoneCls(z){
  if(z === 'green')  return 'text-green';
  if(z === 'yellow') return 'text-warn';
  if(z === 'red')    return 'text-danger';
  return 'text-text2';
}

function fmt(v, suffix){
  if(v == null) return '—';
  const num = Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
  return num + (suffix || '');
}
