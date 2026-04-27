import { useEffect, useMemo, useState } from 'react';
import { Search, RefreshCw, Download } from 'lucide-react';
import { api } from '../api.js';
import Card from '../components/ui/Card.jsx';
import Badge from '../components/ui/Badge.jsx';
import Button from '../components/ui/Button.jsx';

export default function Bonds(){
  const [bonds, setBonds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [board, setBoard] = useState('TQCB');
  const [minYield, setMinYield] = useState('');
  const [q, setQ] = useState('');
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const params = { board, limit: 100 };
    if(minYield) params.min_yield = minYield;
    api.bondLatest(params)
      .then(d => setBonds(d.data || []))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [board, minYield, reloadTick]);

  const filtered = useMemo(() => {
    if(!q) return bonds;
    const s = q.toLowerCase();
    return bonds.filter(b =>
      b.secid?.toLowerCase().includes(s) ||
      b.shortname?.toLowerCase().includes(s) ||
      b.emitent_name?.toLowerCase().includes(s),
    );
  }, [bonds, q]);

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Облигации</h1>
          <p className="text-text2 text-sm mt-1">
            Свежие котировки и доходности с MOEX. Обновляются ежедневно cron-задачей бэкенда.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" icon={RefreshCw} onClick={() => setReloadTick(t => t + 1)} loading={loading}>
            Обновить
          </Button>
          <Button variant="outline" size="sm" icon={Download}>CSV</Button>
        </div>
      </div>

      <Card padded={false}>
        <div className="px-5 py-3 border-b border-border/60 flex flex-wrap items-end gap-3">
          <SegBoard value={board} onChange={setBoard} />
          <Field label="YTM, % от">
            <input
              type="number" step="0.5" placeholder="20"
              className="bg-s2 border border-border rounded px-2 h-8 text-xs font-mono w-20 focus:border-acc"
              value={minYield} onChange={e => setMinYield(e.target.value)}
            />
          </Field>
          <Field label="Поиск">
            <div className="flex items-center gap-1.5 bg-s2 border border-border rounded h-8 px-2 focus-within:border-acc">
              <Search size={12} className="text-text3" />
              <input
                type="text" placeholder="SECID / эмитент"
                className="bg-transparent outline-none text-xs font-mono w-44 placeholder-text3"
                value={q} onChange={e => setQ(e.target.value)}
              />
            </div>
          </Field>
          <div className="text-text3 text-xs ml-auto self-center font-mono">
            {loading ? 'загрузка…' : `${filtered.length} / ${bonds.length}`}
          </div>
        </div>

        {error && (
          <div className="px-5 py-4 text-danger text-sm border-b border-border/60">{error}</div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-s2/40 text-text3 uppercase text-[10px]">
              <tr>
                <th className="text-left p-2 pl-5">SECID</th>
                <th className="text-left p-2">Название</th>
                <th className="text-right p-2">Цена, %</th>
                <th className="text-right p-2">YTM, %</th>
                <th className="text-right p-2">Дюрация</th>
                <th className="text-right p-2">Оборот</th>
                <th className="text-left p-2">Погашение</th>
                <th className="text-left p-2 pr-5">Эмитент</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(b => (
                <tr key={b.secid} className="border-t border-border/60 hover:bg-s2/40 transition-colors">
                  <td className="p-2 pl-5 font-mono text-text">{b.secid}</td>
                  <td className="p-2 text-text2 truncate max-w-[220px]" title={b.shortname}>{b.shortname}</td>
                  <td className="p-2 text-right font-mono">{b.price?.toFixed(2) ?? '—'}</td>
                  <td className="p-2 text-right font-mono">
                    <YieldCell v={b.yield} />
                  </td>
                  <td className="p-2 text-right font-mono text-text3">{fmtDur(b.duration_days)}</td>
                  <td className="p-2 text-right font-mono text-text3">{fmtRub(b.volume_rub)}</td>
                  <td className="p-2 font-mono text-text3">{b.mat_date ?? '—'}</td>
                  <td className="p-2 pr-5 text-text2 truncate max-w-[200px]" title={b.emitent_name}>
                    {b.emitent_name ?? '—'}
                  </td>
                </tr>
              ))}
              {!loading && !filtered.length && (
                <tr>
                  <td colSpan={8} className="p-10 text-center text-text3 text-sm">
                    {bonds.length
                      ? 'По фильтру ничего не нашлось'
                      : <>Пусто. Запустите <code className="text-acc font-mono">POST /collect/bonds</code>.</>}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function SegBoard({ value, onChange }){
  const opts = [
    { id: 'TQCB', label: 'TQCB · корпораты' },
    { id: 'TQOB', label: 'TQOB · ОФЗ' },
  ];
  return (
    <div className="flex flex-col gap-1">
      <span className="text-text3 text-[10px] uppercase tracking-wider font-mono">Площадка</span>
      <div className="inline-flex bg-s2 border border-border rounded p-0.5 h-8">
        {opts.map(o => (
          <button
            key={o.id}
            onClick={() => onChange(o.id)}
            className={[
              'px-2.5 text-[11px] font-mono uppercase tracking-wider rounded transition-colors',
              value === o.id ? 'bg-acc-dim text-acc' : 'text-text2 hover:text-text',
            ].join(' ')}
          >{o.label}</button>
        ))}
      </div>
    </div>
  );
}

function Field({ label, children }){
  return (
    <label className="flex flex-col gap-1">
      <span className="text-text3 text-[10px] uppercase tracking-wider font-mono">{label}</span>
      {children}
    </label>
  );
}

function YieldCell({ v }){
  if(v == null) return <span className="text-text3">—</span>;
  let tone = 'neutral';
  if(v >= 25) tone = 'danger';
  else if(v >= 18) tone = 'warn';
  else if(v >= 12) tone = 'green';
  const colors = {
    neutral: 'text-text', danger: 'text-danger', warn: 'text-warn', green: 'text-green',
  };
  return <span className={colors[tone]}>{v.toFixed(2)}</span>;
}

function fmtRub(v){
  if(v == null) return '—';
  if(v >= 1e9) return (v / 1e9).toFixed(1) + ' млрд';
  if(v >= 1e6) return (v / 1e6).toFixed(1) + ' млн';
  if(v >= 1e3) return (v / 1e3).toFixed(1) + ' тыс';
  return v.toFixed(0);
}
function fmtDur(d){
  if(d == null) return '—';
  if(d >= 365) return (d / 365).toFixed(1) + ' г.';
  return d + ' д.';
}
