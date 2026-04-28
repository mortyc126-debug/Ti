// Полноценная вкладка «Медианы». Два режима:
//   - «По отраслям» — таблица отрасль × метрика (p25 / p50 / p75 / n).
//   - «Отклонения»  — компании как строки, их значения окрашены в
//     цвет отклонения от p50 своей отрасли. Клик по имени → окно
//     эмитента, кнопка +cmp добавляет в Сравнение.

import { useMemo, useState } from 'react';
import { Factory, ChevronRight, Plus } from 'lucide-react';
import { INDUSTRIES, INDUSTRY_GROUPS } from '../../data/industries.js';
import { COMP_METRICS } from '../../data/comparisonMetrics.js';
import { getAllIssuers } from '../../data/issuersMock.js';
import { useComparison } from '../../store/comparison.js';
import { useWindows } from '../../store/windows.js';

const VIEW_METRICS = ['nde', 'icr', 'ebitdaMarg', 'currentR', 'equityR', 'roa', 'bqi', 'safety'];

// Перцентиль (linear interp) — для маленьких сэмплов нужен честный.
function percentile(sorted, q){
  if(!sorted.length) return null;
  if(sorted.length === 1) return sorted[0];
  const idx = q * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if(lo === hi) return sorted[lo];
  const t = idx - lo;
  return sorted[lo] * (1 - t) + sorted[hi] * t;
}

// Считаем перцентили p25/p50/p75/n для каждой пары (industry, metric).
function buildMedians(issuers){
  const byInd = {};
  for(const iss of issuers){
    if(!byInd[iss.industry]) byInd[iss.industry] = [];
    byInd[iss.industry].push(iss);
  }
  const out = {};
  for(const [ind, arr] of Object.entries(byInd)){
    out[ind] = {};
    for(const m of VIEW_METRICS){
      const values = arr.map(x => x.mults?.[m]).filter(v => v != null && isFinite(v));
      if(values.length < 2){
        out[ind][m] = { p25: null, p50: null, p75: null, n: values.length };
        continue;
      }
      const sorted = [...values].sort((a, b) => a - b);
      out[ind][m] = {
        p25: percentile(sorted, 0.25),
        p50: percentile(sorted, 0.50),
        p75: percentile(sorted, 0.75),
        n: sorted.length,
      };
    }
  }
  return out;
}

// Цвет ячейки по отклонению значения от медианы. higher определяет
// направление: для higher=true (ROE, ICR) выше — зелено; для
// higher=false (ND/EBITDA) ниже — зелено. Шкала от ±0.5×IQR.
function deviationColor(value, p25, p50, p75, higher){
  if(value == null || p50 == null) return null;
  const iqr = (p75 - p25);
  if(!isFinite(iqr) || iqr <= 1e-6) return null;
  const z = (value - p50) / (iqr / 2);     // ~ ±2 для крайних
  const t = Math.max(-2, Math.min(2, z)) / 2;
  // Знак t: + хорошо для higher=true, плохо для higher=false.
  const good = higher ? t > 0 : t < 0;
  const mag = Math.abs(t);
  if(mag < 0.1) return null;
  const hue = good ? 145 : 0;             // зелёный или красный
  const sat = 50 + mag * 30;
  const lig = 28 + (1 - mag) * 14;
  return `hsl(${hue} ${sat}% ${lig}%)`;
}

const VIEW_TABS = [
  { id: 'industries', label: 'По отраслям' },
  { id: 'deviations', label: 'Отклонения' },
];

export default function Medians(){
  const issuers = useMemo(() => getAllIssuers(), []);
  const medians = useMemo(() => buildMedians(issuers), [issuers]);
  const [view, setView] = useState('industries');

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div className="text-text2 text-sm flex items-center gap-2">
          <Factory size={16} className="text-acc" />
          {issuers.length} эмитентов в базе ·{' '}
          {Object.keys(medians).filter(ind => Object.values(medians[ind]).some(m => m.n >= 2)).length}{' '}
          отраслей с медианами (n ≥ 2).
        </div>
        <div className="flex gap-0.5 rounded overflow-hidden border border-border">
          {VIEW_TABS.map(t => (
            <button
              key={t.id}
              type="button"
              onClick={() => setView(t.id)}
              className={[
                'px-3 py-1 text-[11px] font-mono uppercase tracking-wider transition-colors',
                view === t.id ? 'bg-acc-dim text-acc' : 'bg-s2 text-text3 hover:text-text',
              ].join(' ')}
            >{t.label}</button>
          ))}
        </div>
      </div>

      {view === 'industries' && <IndustryTable medians={medians} issuers={issuers} />}
      {view === 'deviations' && <DeviationTable medians={medians} issuers={issuers} />}
    </div>
  );
}

function IndustryTable({ medians, issuers }){
  const issuersByInd = useMemo(() => {
    const m = new Map();
    for(const iss of issuers){
      if(!m.has(iss.industry)) m.set(iss.industry, []);
      m.get(iss.industry).push(iss);
    }
    return m;
  }, [issuers]);

  return (
    <div className="bg-bg2 border border-border rounded-lg overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="bg-s2/60 text-text3 uppercase text-[10px]">
          <tr>
            <th className="text-left p-2 pl-4 sticky left-0 bg-s2/95">Отрасль</th>
            <th className="text-right p-2">N</th>
            {VIEW_METRICS.map(m => (
              <th key={m} className="text-right p-2" title={COMP_METRICS[m]?.tip}>
                {COMP_METRICS[m]?.short || m}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {INDUSTRY_GROUPS.flatMap(g => g.items
            .filter(it => issuersByInd.has(it.id))
            .map(it => (
              <IndustryRow
                key={it.id}
                industry={it}
                groupLabel={g.label}
                med={medians[it.id]}
                companies={issuersByInd.get(it.id) || []}
              />
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function IndustryRow({ industry, groupLabel, med, companies }){
  const [open, setOpen] = useState(false);
  const total = companies.length;
  return (
    <>
      <tr
        className="border-t border-border/40 cursor-pointer hover:bg-s2/40"
        onClick={() => setOpen(v => !v)}
      >
        <td className="p-2 pl-4 sticky left-0 bg-bg2/95">
          <div className="flex items-center gap-1.5">
            <ChevronRight
              size={11}
              className={`text-text3 transition-transform ${open ? 'rotate-90' : ''}`}
            />
            <div>
              <div className="font-mono text-text">{industry.label}</div>
              <div className="text-text3 text-[10px]">{groupLabel}</div>
            </div>
          </div>
        </td>
        <td className="p-2 text-right text-text2 font-mono">{total}</td>
        {VIEW_METRICS.map(m => (
          <PercentileCell key={m} cell={med?.[m]} fmt={COMP_METRICS[m]?.fmt} />
        ))}
      </tr>
      {open && companies.map(c => (
        <CompanySubRow key={c.id} company={c} med={med} />
      ))}
    </>
  );
}

function PercentileCell({ cell, fmt }){
  if(!cell || cell.n < 2 || cell.p50 == null){
    return <td className="p-2 text-right text-text3">—</td>;
  }
  return (
    <td className="p-2 text-right" title={`p25 = ${formatNum(cell.p25, fmt)} · p75 = ${formatNum(cell.p75, fmt)} · n = ${cell.n}`}>
      <span className="font-mono text-text">{formatNum(cell.p50, fmt)}</span>
      <span className="text-text3 text-[10px] ml-1">n={cell.n}</span>
    </td>
  );
}

function CompanySubRow({ company, med }){
  const openWin = useWindows(s => s.open);
  const addCmp  = useComparison(s => s.addIssuer);
  const openIssuer = () => openWin({
    kind: 'issuer', id: company.id, title: company.name, ticker: company.ticker || null, mode: 'medium',
  });

  return (
    <tr className="border-t border-border/30 bg-s2/15">
      <td className="p-2 pl-9 sticky left-0 bg-s2/30">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={openIssuer}
            className="font-mono text-text-sm text-text hover:text-acc transition-colors text-left truncate"
            title="Открыть карточку эмитента"
          >
            {company.name}
            {company.ticker && <span className="text-text3 ml-1.5 text-[11px]">{company.ticker}</span>}
          </button>
          <button
            type="button"
            onClick={() => addCmp(company.id, company.kinds[0] || 'bond')}
            title="Добавить в Сравнение"
            className="text-text3 hover:text-acc text-[10px] font-mono inline-flex items-center"
          >
            <Plus size={10} /> cmp
          </button>
        </div>
      </td>
      <td className="p-2"></td>
      {VIEW_METRICS.map(m => (
        <DeviationCell
          key={m}
          value={company.mults?.[m]}
          cell={med?.[m]}
          higher={COMP_METRICS[m]?.higher}
          fmt={COMP_METRICS[m]?.fmt}
        />
      ))}
    </tr>
  );
}

function DeviationCell({ value, cell, higher, fmt }){
  if(value == null) return <td className="p-2 text-right text-text3">—</td>;
  const bg = cell && cell.n >= 2
    ? deviationColor(value, cell.p25, cell.p50, cell.p75, higher)
    : null;
  const dev = (cell && cell.p50 != null && cell.n >= 2)
    ? ((value - cell.p50) / Math.abs(cell.p50 || 1)) * 100
    : null;
  return (
    <td
      className="p-2 text-right relative"
      style={bg ? { background: bg + '40' } : undefined}
      title={cell?.p50 != null ? `vs p50: ${dev != null ? `${dev >= 0 ? '+' : ''}${dev.toFixed(0)}%` : '—'}` : ''}
    >
      <span className="font-mono text-text">{formatNum(value, fmt)}</span>
      {dev != null && Math.abs(dev) >= 5 && (
        <span className={`text-[10px] ml-1 ${dev >= 0 ? 'text-green' : 'text-danger'}`}>
          {dev >= 0 ? '+' : ''}{dev.toFixed(0)}%
        </span>
      )}
    </td>
  );
}

// Альтернативный режим: рассыпуха «компания × метрика», группировка
// по отрасли, цвет каждой ячейки = отклонение от медианы своей
// отрасли. Удобно искать аномалии глазами.
function DeviationTable({ medians, issuers }){
  const grouped = useMemo(() => {
    const m = new Map();
    for(const iss of issuers){
      if(!m.has(iss.industry)) m.set(iss.industry, []);
      m.get(iss.industry).push(iss);
    }
    return m;
  }, [issuers]);

  const ordered = INDUSTRY_GROUPS
    .flatMap(g => g.items.map(it => ({ ...it, group: g.label })))
    .filter(it => grouped.has(it.id));

  return (
    <div className="bg-bg2 border border-border rounded-lg overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="bg-s2/60 text-text3 uppercase text-[10px]">
          <tr>
            <th className="text-left p-2 pl-4 sticky left-0 bg-s2/95">Эмитент</th>
            {VIEW_METRICS.map(m => (
              <th key={m} className="text-right p-2" title={COMP_METRICS[m]?.tip}>
                {COMP_METRICS[m]?.short || m}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ordered.flatMap(it => {
            const med = medians[it.id];
            const companies = grouped.get(it.id) || [];
            return [
              <tr key={'h:' + it.id} className="border-t border-border/40">
                <td colSpan={VIEW_METRICS.length + 1}
                  className="p-1.5 pl-4 bg-s2/40 text-text3 font-mono text-[10px] uppercase tracking-wider">
                  {it.label} <span className="text-text3/70">· {it.group} · {companies.length} эмитент.</span>
                </td>
              </tr>,
              ...companies.map(c => (
                <CompanySubRow key={c.id + ':' + it.id} company={c} med={med} />
              )),
            ];
          })}
        </tbody>
      </table>
      <div className="border-t border-border/60 px-4 py-2 text-text3 text-[11px] font-mono">
        Цвет ячейки — отклонение от p50 отрасли (±IQR/2).{' '}
        <span className="text-green">зелёный</span> — лучше медианы,{' '}
        <span className="text-danger">красный</span> — хуже. Без цвета — данных в отрасли мало (n &lt; 2) или значение пусто.
      </div>
    </div>
  );
}

function formatNum(v, fmt){
  if(v == null || !isFinite(v)) return '—';
  let s;
  if(Math.abs(v) >= 100) s = v.toFixed(0);
  else if(Math.abs(v) >= 10) s = v.toFixed(1);
  else s = v.toFixed(2);
  return s + (fmt || '');
}
