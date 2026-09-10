// Страница «Акции / Фьючерсы» — полный список из локальных снимков
// (stocks-cache / futures-cache), аналог страницы «Облигации». Поиск по
// тикеру/названию, сорт по колонке, клик — карточка эмитента, ⚖ — «Долг»,
// ⧉ — копировать тикер. Обогащение (E/P, дивдоходность, β, капитализация)
// — из loadStockPoints (джойн отчётности).

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, Download, Copy, Check, Scale } from 'lucide-react';
import Card from '../components/ui/Card.jsx';
import Button from '../components/ui/Button.jsx';
import { useStockUniverse, useFutureUniverse, reloadStocks, reloadFutures } from '../store/marketData.js';
import { useIssuers } from '../store/issuers.js';
import { loadStockPoints, loadFuturePoints } from '../data/marketSurfaceData.js';
import { useWindows } from '../store/windows.js';

export default function Stocks(){
  const [tab, setTab] = useState('stocks');   // stocks | futures
  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Акции и фьючерсы</h1>
          <p className="text-text2 text-sm mt-1">Полный список бумаг из снимка T-Invest. Поиск и сортировка на клиенте.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" icon={RefreshCw}
            onClick={() => tab === 'stocks' ? reloadStocks() : reloadFutures()}>Обновить</Button>
        </div>
      </div>

      <div className="flex border-b border-border">
        {[['stocks', 'Акции'], ['futures', 'Фьючерсы']].map(([id, lbl]) => (
          <button key={id} type="button" onClick={() => setTab(id)}
            className={['px-4 py-2 text-[11px] font-mono uppercase tracking-wider border-b-2 -mb-px transition-colors',
              tab === id ? 'border-acc text-acc' : 'border-transparent text-text2 hover:text-text'].join(' ')}>{lbl}</button>
        ))}
      </div>

      {tab === 'stocks' ? <StocksTable /> : <FuturesTable />}
    </div>
  );
}

function useSortSearch(rows, defaultSort){
  const [q, setQ] = useState('');
  const [sort, setSort] = useState(defaultSort);   // {key, dir}
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    let out = s ? rows.filter(r => (r.ticker + ' ' + (r.name || '') + ' ' + (r.issuer || '')).toLowerCase().includes(s)) : rows;
    const { key, dir } = sort;
    out = [...out].sort((a, b) => {
      const va = a[key], vb = b[key];
      if(va == null && vb == null) return 0;
      if(va == null) return 1;
      if(vb == null) return -1;
      if(typeof va === 'string') return dir * va.localeCompare(vb);
      return dir * (va - vb);
    });
    return out;
  }, [rows, q, sort]);
  const onSort = (key) => setSort(s => s.key === key ? { key, dir: -s.dir } : { key, dir: 1 });
  return { q, setQ, filtered, sort, onSort };
}

function Th({ label, k, sort, onSort, right }){
  const on = sort.key === k;
  return (
    <th className={`p-2 ${right ? 'text-right' : 'text-left'} cursor-pointer select-none hover:text-text`}
      onClick={() => onSort(k)}>
      {label}{on && <span className="text-acc ml-0.5">{sort.dir > 0 ? '▲' : '▼'}</span>}
    </th>
  );
}

function StocksTable(){
  const stocks = useStockUniverse();
  const allIssuers = useIssuers();
  const rows = useMemo(() => {
    return loadStockPoints({}).map(p => ({
      ticker: p.ticker, name: p.name, issuer: p.issuer, inn: p.inn, industry: p.industry,
      price: p.price, ep: p.z, div: p.divYield, beta: p.beta, cap: p.volumeBn, pe: p.pe,
    }));
  }, [stocks, allIssuers]);
  const { q, setQ, filtered, sort, onSort } = useSortSearch(rows, { key: 'cap', dir: -1 });

  return (
    <>
      <SearchRow q={q} setQ={setQ} count={filtered.length} total={rows.length}
        onCsv={() => exportCsv(filtered, ['ticker', 'issuer', 'inn', 'industry', 'price', 'ep', 'div', 'beta', 'cap', 'pe'], 'stocks')} />
      <Card padded={false}>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-s2/40 text-text3 uppercase text-[10px]">
              <tr>
                <Th label="Тикер" k="ticker" sort={sort} onSort={onSort} />
                <Th label="Эмитент" k="issuer" sort={sort} onSort={onSort} />
                <Th label="Цена" k="price" sort={sort} onSort={onSort} right />
                <Th label="E/P %" k="ep" sort={sort} onSort={onSort} right />
                <Th label="Дивдох %" k="div" sort={sort} onSort={onSort} right />
                <Th label="β" k="beta" sort={sort} onSort={onSort} right />
                <Th label="Кап., млрд" k="cap" sort={sort} onSort={onSort} right />
                <th className="p-2 pr-5 text-right"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => <StockRow key={r.ticker} r={r} />)}
              {!filtered.length && <tr><td colSpan={8} className="p-10 text-center text-text3">Ничего не найдено.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

function StockRow({ r }){
  const openWin = useWindows(s => s.open);
  const navigate = useNavigate();
  const openIssuer = () => openWin({ kind: 'issuer', id: r.inn || r.ticker, title: r.issuer || r.name, ticker: r.ticker, inn: r.inn || null, mode: 'medium' });
  return (
    <tr className="border-t border-border/60 hover:bg-s2/40 transition-colors">
      <td className="p-2 pl-5">
        <span className="font-mono text-text">{r.ticker}</span>
        <CopyBtn value={r.ticker} />
      </td>
      <td className="p-2">
        <button onClick={openIssuer} className="text-left font-mono text-text2 hover:text-acc transition-colors">{r.issuer || r.name}</button>
      </td>
      <td className="p-2 text-right font-mono">{fmt(r.price, 2)}</td>
      <td className="p-2 text-right font-mono">{fmt(r.ep, 1, '%')}</td>
      <td className="p-2 text-right font-mono">{fmt(r.div, 1, '%')}</td>
      <td className="p-2 text-right font-mono">{fmt(r.beta, 2)}</td>
      <td className="p-2 text-right font-mono text-text3">{r.cap != null ? Math.round(r.cap).toLocaleString('ru') : '—'}</td>
      <td className="p-2 pr-5 text-right">
        <button onClick={() => navigate('/debt?q=' + encodeURIComponent(r.ticker))} title="Долговая нагрузка"
          className="text-text3 hover:text-acc"><Scale size={13} /></button>
      </td>
    </tr>
  );
}

function FuturesTable(){
  const futures = useFutureUniverse();
  const allIssuers = useIssuers();
  const rows = useMemo(() => {
    return loadFuturePoints({}).map(p => ({
      ticker: p.ticker, name: p.name, issuer: p.issuer, baseTicker: p.baseTicker,
      basis: p.basisPp, beta: p.beta, ep: p.z,
    }));
  }, [futures, allIssuers]);
  const { q, setQ, filtered, sort, onSort } = useSortSearch(rows, { key: 'ticker', dir: 1 });

  return (
    <>
      <SearchRow q={q} setQ={setQ} count={filtered.length} total={rows.length}
        onCsv={() => exportCsv(filtered, ['ticker', 'name', 'baseTicker', 'basis', 'ep', 'beta'], 'futures')} />
      <Card padded={false}>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-s2/40 text-text3 uppercase text-[10px]">
              <tr>
                <Th label="Тикер" k="ticker" sort={sort} onSort={onSort} />
                <Th label="Название" k="name" sort={sort} onSort={onSort} />
                <Th label="Базовый" k="baseTicker" sort={sort} onSort={onSort} />
                <Th label="Базис %" k="basis" sort={sort} onSort={onSort} right />
                <Th label="E/P %" k="ep" sort={sort} onSort={onSort} right />
                <Th label="β" k="beta" sort={sort} onSort={onSort} right />
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => (
                <tr key={r.ticker} className="border-t border-border/60 hover:bg-s2/40">
                  <td className="p-2 pl-5 font-mono text-text">{r.ticker}<CopyBtn value={r.ticker} /></td>
                  <td className="p-2 font-mono text-text2">{r.name}</td>
                  <td className="p-2 font-mono text-text3">{r.baseTicker || '—'}</td>
                  <td className="p-2 text-right font-mono">{fmt(r.basis, 1, '%')}</td>
                  <td className="p-2 text-right font-mono">{fmt(r.ep, 1, '%')}</td>
                  <td className="p-2 text-right font-mono">{fmt(r.beta, 2)}</td>
                </tr>
              ))}
              {!filtered.length && <tr><td colSpan={6} className="p-10 text-center text-text3">Ничего не найдено.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

function SearchRow({ q, setQ, count, total, onCsv }){
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="Поиск: тикер / название…"
        className="flex-1 min-w-[200px] bg-bg2 border border-border rounded px-3 py-1.5 text-sm text-text" />
      <span className="text-text3 text-xs font-mono">{count} из {total}</span>
      <Button variant="outline" size="sm" icon={Download} onClick={onCsv}>CSV</Button>
    </div>
  );
}

function CopyBtn({ value }){
  const [done, setDone] = useState(false);
  return (
    <button onClick={(e) => { e.stopPropagation(); navigator.clipboard?.writeText(value).then(() => { setDone(true); setTimeout(() => setDone(false), 1000); }); }}
      title={`Скопировать ${value}`} className={`ml-1.5 inline-flex w-4 h-4 items-center justify-center ${done ? 'text-green' : 'text-text3 hover:text-acc'}`}>
      {done ? <Check size={11} /> : <Copy size={11} />}
    </button>
  );
}

function fmt(v, d, suf = ''){
  if(v == null || !isFinite(v)) return <span className="text-text3">—</span>;
  return v.toFixed(d) + suf;
}

function exportCsv(rows, cols, name){
  if(!rows?.length) return;
  const esc = v => v == null ? '' : `"${String(v).replace(/"/g, '""')}"`;
  const lines = [cols.join(',')];
  for(const r of rows) lines.push(cols.map(c => esc(r[c])).join(','));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
