import { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function Bonds(){
  const [bonds, setBonds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [board, setBoard] = useState('TQCB');
  const [minYield, setMinYield] = useState('');

  useEffect(() => {
    setLoading(true);
    setError(null);
    const params = { board, limit: 100 };
    if(minYield) params.min_yield = minYield;
    api.bondLatest(params)
      .then(d => setBonds(d.data || []))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [board, minYield]);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-serif">Облигации</h1>

      <div className="flex gap-3 items-end flex-wrap">
        <Field label="Площадка">
          <select className="bg-s2 border border-border rounded px-2 py-1 text-sm font-mono"
            value={board} onChange={e => setBoard(e.target.value)}>
            <option value="TQCB">TQCB (корпораты)</option>
            <option value="TQOB">TQOB (ОФЗ)</option>
          </select>
        </Field>
        <Field label="YTM, % от">
          <input type="number" step="0.5" placeholder="20"
            className="bg-s2 border border-border rounded px-2 py-1 text-sm font-mono w-24"
            value={minYield} onChange={e => setMinYield(e.target.value)} />
        </Field>
        <div className="text-text3 text-xs ml-auto self-center">
          {loading ? 'загрузка…' : `${bonds.length} бумаг`}
        </div>
      </div>

      {error && <div className="text-danger text-sm">❌ {error}</div>}

      {!loading && !error && (
        <div className="bg-bg2 border border-border rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-s2 text-text3 uppercase text-[10px]">
              <tr>
                <th className="text-left p-2">SECID</th>
                <th className="text-left p-2">Название</th>
                <th className="text-right p-2">Цена, %</th>
                <th className="text-right p-2">YTM, %</th>
                <th className="text-right p-2">Дюр., д.</th>
                <th className="text-right p-2">Оборот, ₽</th>
                <th className="text-left p-2">Погашение</th>
                <th className="text-left p-2">Эмитент</th>
              </tr>
            </thead>
            <tbody>
              {bonds.map(b => (
                <tr key={b.secid} className="border-t border-border hover:bg-s2/50">
                  <td className="p-2 font-mono">{b.secid}</td>
                  <td className="p-2">{b.shortname}</td>
                  <td className="p-2 text-right font-mono">{b.price?.toFixed(2) ?? '—'}</td>
                  <td className="p-2 text-right font-mono text-acc">{b.yield?.toFixed(2) ?? '—'}</td>
                  <td className="p-2 text-right font-mono text-text3">{b.duration_days ?? '—'}</td>
                  <td className="p-2 text-right font-mono text-text3">{fmtRub(b.volume_rub)}</td>
                  <td className="p-2 font-mono text-text3">{b.mat_date ?? '—'}</td>
                  <td className="p-2 text-text2 truncate max-w-[200px]" title={b.emitent_name}>
                    {b.emitent_name ?? '—'}
                  </td>
                </tr>
              ))}
              {!bonds.length && (
                <tr><td colSpan={8} className="p-6 text-center text-text3">
                  Пусто. Запустите <code className="text-acc">POST /collect/bonds</code>.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
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

function fmtRub(v){
  if(v == null) return '—';
  if(v >= 1e9) return (v / 1e9).toFixed(1) + ' млрд';
  if(v >= 1e6) return (v / 1e6).toFixed(1) + ' млн';
  if(v >= 1e3) return (v / 1e3).toFixed(1) + ' тыс';
  return v.toFixed(0);
}
