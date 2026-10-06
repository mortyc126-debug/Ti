import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Wallet, TrendingUp, Clock, Coins, RefreshCw, Scale, FileText } from 'lucide-react';
import Card from '../components/ui/Card.jsx';
import Stat from '../components/ui/Stat.jsx';
import Badge from '../components/ui/Badge.jsx';
import { positions as mockPositions } from '../data/mockPortfolio.js';
import { INDUSTRIES } from '../data/industries.js';
import { usePortfolioStore } from '../store/portfolio.js';
import { useBondUniverse } from '../store/marketData.js';
import { useIssuers } from '../store/issuers.js';

const fmtRub = n => {
  if(n == null) return '—';
  if(Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + ' млн ₽';
  if(Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + ' тыс ₽';
  return Math.round(n).toLocaleString('ru-RU') + ' ₽';
};

// Единая строка таблицы для реального и мок-портфеля.
// value — стоимость позиции, ₽; pnl — нереализованный P&L, ₽.
function realRow(p, bondByIsin, issuerByInn){
  const b = p.isin ? bondByIsin.get(String(p.isin).toUpperCase()) : null;
  // Эмитент — по ИНН (резолв через MOEX) из списка эмитентов; отрасль
  // оттуда же, иначе из облигации. Название — эмитента, иначе бумаги.
  const iss = p.inn ? issuerByInn.get(String(p.inn)) : null;
  const pnlPct = p.costRub ? p.pnlRub / p.costRub * 100 : null;
  return {
    key: p.isin || p.ticker || p.name,
    name: p.name || p.ticker || p.isin,
    sub: [p.issuerTitle || iss?.name, p.isin, (p.accounts || []).join('/')].filter(Boolean).join(' · '),
    issuer: iss?.name || p.issuerTitle || b?.issuer || p.ticker || null,
    ind: iss?.industry || b?.industry || null,
    qty: p.qty, avg: p.avg, last: p.last,
    ytm: b?.ytm ?? null, dur: b?.duration_years ?? null,
    value: p.valRub, pnl: p.pnlRub, pnlPct,
    inn: p.inn || iss?.inn || null, ticker: p.ticker || null, isin: p.isin || null,
  };
}
function mockRow(p){
  const value = p.last / 100 * 1000 * p.qty;
  const cost = p.avg / 100 * 1000 * p.qty;
  return {
    key: p.isin, name: p.name, sub: `${p.isin} · ${p.issuer}`,
    issuer: p.issuer, ind: p.ind,
    qty: p.qty, avg: p.avg, last: p.last,
    ytm: p.ytm ?? null, dur: p.dur ?? null,
    value, pnl: value - cost, pnlPct: cost ? (value - cost) / cost * 100 : null,
    inn: null, ticker: null, isin: p.isin || null,
  };
}

function computeTotals(rows){
  let navRub = 0, pnlRub = 0, wy = 0, wyW = 0, wd = 0, wdW = 0;
  for(const r of rows){
    navRub += r.value || 0; pnlRub += r.pnl || 0;
    if(r.ytm != null){ wy += r.ytm * (r.value || 0); wyW += r.value || 0; }
    if(r.dur != null){ wd += r.dur * (r.value || 0); wdW += r.value || 0; }
  }
  const costRub = navRub - pnlRub;
  return {
    navRub, pnlRub, costRub,
    ytmAvg: wyW ? wy / wyW : null, durAvg: wdW ? wd / wdW : null,
    ytmCov: rows.filter(r => r.ytm != null).length,
  };
}

function computeSectors(rows){
  const m = new Map();
  for(const r of rows){
    const ind = r.ind || 'other';
    m.set(ind, (m.get(ind) || 0) + (r.value || 0));
  }
  return [...m.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
}

export default function Portfolio(){
  const [filter, setFilter] = useState('');
  const navigate = useNavigate();
  // Переходы по позиции: «Долг» (debtload по тикеру/ISIN) и «Отчётность»
  // (модуль открывается на эмитенте по ИНН/имени).
  const goDebt = (r) => navigate('/debt?q=' + encodeURIComponent(r.ticker || r.isin || r.issuer || r.name || ''));
  const goReports = (r) => {
    const qs = new URLSearchParams();
    if(r.inn) qs.set('inn', r.inn);
    if(r.issuer) qs.set('issuer', r.issuer);
    navigate('/reports' + (qs.toString() ? '?' + qs.toString() : ''));
  };

  const realPos  = usePortfolioStore(s => s.real);
  const loading  = usePortfolioStore(s => s.loading);
  const error    = usePortfolioStore(s => s.error);
  const accounts = usePortfolioStore(s => s.accounts);
  const load     = usePortfolioStore(s => s.load);
  const bonds    = useBondUniverse();
  const issuers  = useIssuers();
  useEffect(() => { load(); }, [load]);

  const bondByIsin = useMemo(() => {
    const m = new Map();
    for(const b of (bonds || [])){ if(b.secid) m.set(String(b.secid).toUpperCase(), b); }
    return m;
  }, [bonds]);
  const issuerByInn = useMemo(() => {
    const m = new Map();
    for(const it of (issuers || [])){ if(it.inn) m.set(String(it.inn), it); }
    return m;
  }, [issuers]);

  const isReal = !!(realPos && realPos.length);
  const allRows = useMemo(() => isReal
    ? realPos.map(p => realRow(p, bondByIsin, issuerByInn))
    : mockPositions.map(mockRow),
    [isReal, realPos, bondByIsin, issuerByInn]);

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if(!q) return allRows;
    return allRows.filter(r => (r.name || '').toLowerCase().includes(q) || (r.issuer || '').toLowerCase().includes(q) || (r.sub || '').toLowerCase().includes(q));
  }, [allRows, filter]);

  const t = useMemo(() => computeTotals(allRows), [allRows]);
  const sectors = useMemo(() => computeSectors(allRows), [allRows]);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Портфель</h1>
          <p className="text-text2 text-sm mt-1">
            {loading ? 'Загрузка позиций из T-Invest…'
              : isReal ? <>Реальные позиции из T-Invest{accounts.length ? <> · счета: <span className="text-text">{accounts.join(', ')}</span></> : null}</>
              : <>Показаны мок-данные{error ? <> · <span className="text-warn">{error}</span></> : <>. Токен T-API вводится в разделе «Долг».</>}</>}
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => load(true)} disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-mono border border-border bg-s2 text-text2 hover:text-acc hover:border-acc/40 disabled:opacity-40 transition-colors">
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Обновить из T-API
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat icon={Wallet} accent label="Активы" value={fmtRub(t.navRub)} sub={`${allRows.length} поз.`} delta={t.costRub ? (t.pnlRub / t.costRub) * 100 : null} />
        <Stat icon={TrendingUp} label="Средняя YTM" value={t.ytmAvg != null ? `${t.ytmAvg.toFixed(2)}%` : '—'} sub={t.ytmCov < allRows.length ? `по ${t.ytmCov} из ${allRows.length}` : 'взвеш. по стоим.'} />
        <Stat icon={Clock} label="Дюрация" value={t.durAvg != null ? `${t.durAvg.toFixed(2)} г.` : '—'} sub="средняя" />
        <Stat icon={Coins} label="P&L" value={fmtRub(t.pnlRub)} sub="нереализованный" delta={t.costRub ? (t.pnlRub / t.costRub) * 100 : null} />
      </div>

      <div className="grid lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2">
          <Card
            title="Позиции"
            action={(
              <input
                type="text"
                placeholder="Фильтр…"
                className="bg-s2 border border-border rounded px-2 py-1 text-xs font-mono w-32 focus:border-acc"
                value={filter}
                onChange={e => setFilter(e.target.value)}
              />
            )}
            padded={false}
          >
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-s2/60 text-text3 uppercase text-[10px]">
                  <tr>
                    <th className="text-left p-2 pl-5">Бумага</th>
                    <th className="text-right p-2">Кол-во</th>
                    <th className="text-right p-2">Ср. цена</th>
                    <th className="text-right p-2">Тек. цена</th>
                    <th className="text-right p-2">YTM</th>
                    <th className="text-right p-2">Стоим.</th>
                    <th className="text-right p-2">P&L</th>
                    <th className="text-right p-2 pr-5"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => {
                    const pos = (r.pnl || 0) >= 0;
                    return (
                      <tr key={r.key} className="border-t border-border/60 hover:bg-s2/40 transition-colors">
                        <td className="p-2 pl-5">
                          <div className="font-mono text-text">{r.name}</div>
                          <div className="text-text3 text-[10px] font-mono">{r.sub}</div>
                        </td>
                        <td className="p-2 text-right font-mono">{r.qty?.toLocaleString('ru-RU')}</td>
                        <td className="p-2 text-right font-mono text-text2">{r.avg != null ? r.avg.toFixed(2) : '—'}</td>
                        <td className="p-2 text-right font-mono text-text">{r.last != null ? r.last.toFixed(2) : '—'}</td>
                        <td className="p-2 text-right font-mono text-acc">{r.ytm != null ? r.ytm.toFixed(1) + '%' : '—'}</td>
                        <td className="p-2 text-right font-mono text-text2">{fmtRub(r.value)}</td>
                        <td className={`p-2 text-right font-mono ${pos ? 'text-green' : 'text-danger'}`}>
                          {pos ? '+' : ''}{fmtRub(r.pnl)}
                          {r.pnlPct != null && <span className="text-text3 ml-1 text-[10px]">{pos ? '+' : ''}{r.pnlPct.toFixed(1)}%</span>}
                        </td>
                        <td className="p-2 pr-5 text-right whitespace-nowrap">
                          <button type="button" onClick={() => goDebt(r)} title="Долговая нагрузка эмитента"
                            className="inline-flex items-center justify-center w-6 h-6 rounded border border-border text-text3 hover:text-acc hover:border-acc/40 transition-colors">
                            <Scale size={13} />
                          </button>
                          <button type="button" onClick={() => goReports(r)} title="Отчётность эмитента"
                            className="inline-flex items-center justify-center w-6 h-6 rounded border border-border text-text3 hover:text-acc hover:border-acc/40 transition-colors ml-1">
                            <FileText size={13} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {!rows.length && (
                    <tr><td colSpan={8} className="p-8 text-center text-text3 text-sm">{loading ? 'Загрузка…' : 'Ничего не нашлось'}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        <Card title="Структура по отраслям" padded={false}>
          <SectorBreakdown sectors={sectors} nav={t.navRub} />
          <div className="px-5 py-3 border-t border-border/60 flex items-center justify-between">
            <span className="text-text3 text-[11px] font-mono">всего</span>
            <Badge tone="acc">{allRows.length} позиций</Badge>
          </div>
        </Card>
      </div>
    </div>
  );
}

function SectorBreakdown({ sectors, nav }){
  // Группируем плоский список секторов по INDUSTRIES.groupId; внутри
  // группы — отрасли с собственным процентом от NAV.
  if(!nav){
    return <div className="px-5 py-6 text-text3 text-xs">Нет данных для разбивки.</div>;
  }
  const groups = new Map();
  for(const s of sectors){
    const meta = INDUSTRIES[s.name] || { groupId: 'other', groupLabel: 'Прочее', label: s.name };
    if(!groups.has(meta.groupId)){
      groups.set(meta.groupId, { id: meta.groupId, label: meta.groupLabel, total: 0, items: [] });
    }
    const g = groups.get(meta.groupId);
    g.total += s.value;
    g.items.push({ id: s.name, label: meta.label, value: s.value });
  }
  const list = [...groups.values()].sort((a, b) => b.total - a.total);

  return (
    <div className="px-5 py-4 space-y-4">
      {list.map(g => {
        const gPct = (g.total / nav) * 100;
        return (
          <div key={g.id}>
            <div className="flex items-baseline justify-between text-xs mb-1">
              <span className="text-text2 uppercase tracking-wider text-[10px] font-mono">{g.label}</span>
              <span className="font-mono text-text">{gPct.toFixed(1)}%</span>
            </div>
            <div className="space-y-1.5 pl-5 mt-1.5">
              {g.items.map(it => {
                const pct = (it.value / nav) * 100;
                return (
                  <div key={it.id}>
                    <div className="flex items-baseline justify-between text-[11px]">
                      <span className="text-text3 truncate">{it.label}</span>
                      <span className="font-mono text-text2">{pct.toFixed(1)}%</span>
                    </div>
                    <div className="relative h-1 bg-s2 rounded mt-0.5 overflow-hidden">
                      <div className="absolute inset-y-0 left-0 bg-acc/70 rounded" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
