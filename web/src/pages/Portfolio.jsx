import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Wallet, TrendingUp, Clock, Coins, RefreshCw } from 'lucide-react';
import { useWindows } from '../store/windows.js';
import Card from '../components/ui/Card.jsx';
import Stat from '../components/ui/Stat.jsx';
import Badge from '../components/ui/Badge.jsx';
import { positions as mockPositions } from '../data/mockPortfolio.js';
import { INDUSTRIES } from '../data/industries.js';
import { usePortfolioStore } from '../store/portfolio.js';
import { useBondUniverse } from '../store/marketData.js';
import { useIssuers } from '../store/issuers.js';
import { loadBondization, futureEvents, scheduleByMonth, computeYtm, duration } from '../lib/bondization.js';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';

const fmtRub = n => {
  if(n == null) return '—';
  if(Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + ' млн ₽';
  if(Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + ' тыс ₽';
  return Math.round(n).toLocaleString('ru-RU') + ' ₽';
};
const _PIE = ['#4ea1ff', '#ffb02e', '#49d17e', '#b07cff', '#ff6b6b', '#2dd4bf', '#f472b6', '#a3e635', '#fb923c', '#60a5fa', '#c084fc', '#34d399'];

// Человекочитаемое «когда»: только что / N мин / N ч назад / дата.
function fmtWhen(ts){
  if(!ts) return '';
  const d = Date.now() - ts, m = Math.round(d / 60000);
  if(m < 1) return 'только что';
  if(m < 60) return m + ' мин назад';
  const h = Math.round(m / 60);
  if(h < 24) return h + ' ч назад';
  return new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// Единая строка таблицы для реального и мок-портфеля.
// value — стоимость позиции, ₽; pnl — нереализованный P&L, ₽.
function realRow(p, bondByIsin, issuerByInn, bondz){
  const b = p.isin ? bondByIsin.get(String(p.isin).toUpperCase()) : null;
  // Эмитент — по ИНН (резолв через MOEX) из списка эмитентов; отрасль
  // оттуда же, иначе из облигации. Название — эмитента, иначе бумаги.
  const iss = p.inn ? issuerByInn.get(String(p.inn)) : null;
  const pnlPct = p.costRub ? p.pnlRub / p.costRub * 100 : null;
  // YTM/дюрация — точный расчёт по расписанию MOEX (bondization) против
  // грязной цены (цена+НКД за 1 бумагу). Фолбэк — из вселенной облигаций.
  const bz = bondz ? bondz[String(p.moexSecid || p.isin || '').toUpperCase()] : null;
  const dirty = (p.last || 0) + (p.nkd || 0);
  let ytm = bz ? computeYtm(bz, dirty) : null;
  if(ytm == null) ytm = b?.ytm ?? null;
  const dur = bz && ytm != null ? duration(bz, ytm / 100) : (b?.duration_years ?? null);
  return {
    key: p.isin || p.ticker || p.name,
    name: p.name || p.ticker || p.isin,
    sub: [p.issuerTitle || iss?.name, p.isin, (p.accounts || []).join('/')].filter(Boolean).join(' · '),
    issuer: iss?.name || p.issuerTitle || b?.issuer || p.ticker || null,
    ind: iss?.industry || b?.industry || null,
    qty: p.qty, avg: p.avg, last: p.last,
    ytm, dur,
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
  const openWin = useWindows(s => s.open);
  // Клик по позиции → мини-окно эмитента (вкладки Отчётность/Финансы/
  // Связи + переход в «Долг») — тот же «рабочий стол», что в «Сравнении».
  // Если ИНН не определился — запасной путь прямо в «Долг» по тикеру/ISIN.
  const openIssuer = (r) => {
    if(r.inn){
      openWin({ kind: 'issuer', id: String(r.inn), inn: String(r.inn), title: r.issuer || r.name, ticker: r.ticker || null, mode: 'medium' });
    } else {
      // Запасной путь в «Долг»: по ИМЕНИ эмитента (все его выпуски),
      // а не по ISIN одной бумаги — иначе найдётся лишь один выпуск.
      navigate('/debt?q=' + encodeURIComponent(r.issuer || r.name || r.ticker || r.isin || ''));
    }
  };

  const realPos  = usePortfolioStore(s => s.real);
  const loading  = usePortfolioStore(s => s.loading);
  const error    = usePortfolioStore(s => s.error);
  const accounts = usePortfolioStore(s => s.accounts);
  const cachedAt = usePortfolioStore(s => s.cachedAt);
  const fresh    = usePortfolioStore(s => s.fresh);
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

  // Расписание выплат (MOEX bondization) по каждому выпуску портфеля.
  const [bondz, setBondz] = useState({});
  useEffect(() => {
    if(!isReal) return;
    let alive = true;
    (async () => {
      const keys = [...new Set((realPos || []).map(p => String(p.moexSecid || p.isin || '').toUpperCase()).filter(Boolean))];
      const out = {};
      let i = 0; const CONC = 6;
      async function w(){ while(i < keys.length){ const k = keys[i++]; out[k] = await loadBondization(k); } }
      await Promise.all(Array.from({ length: CONC }, w));
      if(alive) setBondz(out);
    })();
    return () => { alive = false; };
  }, [isReal, realPos]);

  const allRows = useMemo(() => isReal
    ? realPos.map(p => realRow(p, bondByIsin, issuerByInn, bondz))
    : mockPositions.map(mockRow),
    [isReal, realPos, bondByIsin, issuerByInn, bondz]);

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if(!q) return allRows;
    return allRows.filter(r => (r.name || '').toLowerCase().includes(q) || (r.issuer || '').toLowerCase().includes(q) || (r.sub || '').toLowerCase().includes(q));
  }, [allRows, filter]);

  const t = useMemo(() => computeTotals(allRows), [allRows]);
  const sectors = useMemo(() => computeSectors(allRows), [allRows]);

  // График выплат 12 мес + ближайшие события (из bondization × количество).
  const schedule = useMemo(() => {
    if(!isReal) return { months: [], upcoming: [], sum12: 0 };
    const posForEvents = (realPos || []).map(p => ({
      secid: p.moexSecid, isin: p.isin, qty: p.qty, name: p.name,
      issuer: (p.inn && issuerByInn.get(String(p.inn))?.name) || p.issuerTitle || p.name,
    }));
    const events = futureEvents(bondz, posForEvents);
    const months = scheduleByMonth(events, 12);
    const sum12 = months.reduce((s, m) => s + m.total, 0);
    return { months, upcoming: events.slice(0, 12), sum12 };
  }, [isReal, realPos, bondz, issuerByInn]);

  // Концентрация по эмитентам (доли от стоимости).
  const concentration = useMemo(() => {
    const m = new Map();
    for(const r of allRows){ const k = r.issuer || r.name || '—'; m.set(k, (m.get(k) || 0) + (r.value || 0)); }
    const arr = [...m.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
    return arr.slice(0, 12);
  }, [allRows]);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Портфель</h1>
          <p className="text-text2 text-sm mt-1">
            {loading ? 'Обновление позиций из T-Invest…'
              : isReal ? <>Реальные позиции из T-Invest{accounts.length ? <> · счета: <span className="text-text">{accounts.join(', ')}</span></> : null}
                  {cachedAt ? <> · <span className={fresh ? 'text-text3' : 'text-warn'}>{fresh ? 'обновлено' : 'последнее сохранённое'} {fmtWhen(cachedAt)}</span></> : null}
                  {error ? <> · <span className="text-warn">{error}</span></> : null}</>
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
                    <th className="text-right p-2 pr-5">P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => {
                    const pos = (r.pnl || 0) >= 0;
                    return (
                      <tr key={r.key} className="border-t border-border/60 hover:bg-s2/40 transition-colors">
                        <td className="p-2 pl-5">
                          <button type="button" onClick={() => openIssuer(r)}
                            title="Открыть карточку эмитента (отчётность, финансы, связи, долг)"
                            className="text-left font-mono text-text hover:text-acc transition-colors">
                            {r.name}
                          </button>
                          <div className="text-text3 text-[10px] font-mono">{r.sub}</div>
                        </td>
                        <td className="p-2 text-right font-mono">{r.qty?.toLocaleString('ru-RU')}</td>
                        <td className="p-2 text-right font-mono text-text2">{r.avg != null ? r.avg.toFixed(2) : '—'}</td>
                        <td className="p-2 text-right font-mono text-text">{r.last != null ? r.last.toFixed(2) : '—'}</td>
                        <td className="p-2 text-right font-mono text-acc">{r.ytm != null ? r.ytm.toFixed(1) + '%' : '—'}</td>
                        <td className="p-2 text-right font-mono text-text2">{fmtRub(r.value)}</td>
                        <td className={`p-2 pr-5 text-right font-mono ${pos ? 'text-green' : 'text-danger'}`}>
                          {pos ? '+' : ''}{fmtRub(r.pnl)}
                          {r.pnlPct != null && <span className="text-text3 ml-1 text-[10px]">{pos ? '+' : ''}{r.pnlPct.toFixed(1)}%</span>}
                        </td>
                      </tr>
                    );
                  })}
                  {!rows.length && (
                    <tr><td colSpan={7} className="p-8 text-center text-text3 text-sm">{loading ? 'Загрузка…' : 'Ничего не нашлось'}</td></tr>
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

      {/* График выплат (12 мес) + ближайшие + концентрация — из MOEX
          bondization по каждому выпуску × количество. */}
      <div className="grid lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2">
          <Card title={`Выплаты, 12 мес${schedule.sum12 ? ' · ' + fmtRub(schedule.sum12) : ''}`}>
            {schedule.sum12 > 0 ? (
              <>
                <div style={{ width: '100%', height: 230 }}>
                  <ResponsiveContainer>
                    <BarChart data={schedule.months} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
                      <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--text3)' }} />
                      <YAxis tick={{ fontSize: 10, fill: 'var(--text3)' }} tickFormatter={v => v >= 1e6 ? (v / 1e6).toFixed(1) + 'м' : v >= 1e3 ? (v / 1e3).toFixed(0) + 'к' : v} />
                      <Tooltip formatter={(v, n) => [fmtRub(v), n === 'coupon' ? 'Купоны' : 'Амортизация/погашение']} contentStyle={{ fontSize: 11 }} />
                      <Bar dataKey="coupon" stackId="a" fill="#4ea1ff" name="coupon" />
                      <Bar dataKey="amort" stackId="a" fill="#ffb02e" name="amort" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-3 border-t border-border/60 pt-2">
                  <div className="text-text3 text-[10px] uppercase font-mono mb-1 tracking-wider">Ближайшие выплаты</div>
                  <div className="space-y-1">
                    {schedule.upcoming.map((e, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs">
                        <span className="text-text3 font-mono w-[84px] shrink-0">{e.date}</span>
                        <span className={e.type === 'coupon' ? 'text-acc' : 'text-warn'}>{e.type === 'coupon' ? 'купон' : 'аморт.'}</span>
                        <span className="flex-1 truncate text-text2">{e.issuer || e.name}</span>
                        <span className="font-mono text-text">{fmtRub(e.amount)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <div className="text-text3 text-xs py-8 text-center">
                {isReal ? 'Расписание выплат подгружается из MOEX… (или нет облигаций с расписанием)' : 'Подключи реальный портфель (токен в «Долге»), чтобы увидеть график выплат.'}
              </div>
            )}
          </Card>
        </div>

        <Card title="Концентрация по эмитентам">
          {concentration.length ? (
            <>
              <div style={{ width: '100%', height: 200 }}>
                <ResponsiveContainer>
                  <PieChart>
                    <Pie data={concentration} dataKey="value" nameKey="name" innerRadius={42} outerRadius={82} paddingAngle={1}>
                      {concentration.map((e, i) => <Cell key={i} fill={_PIE[i % _PIE.length]} />)}
                    </Pie>
                    <Tooltip formatter={(v, n) => [fmtRub(v), n]} contentStyle={{ fontSize: 11 }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-2 space-y-1 max-h-44 overflow-y-auto">
                {concentration.map((e, i) => (
                  <div key={i} className="flex items-center gap-2 text-[11px]">
                    <span style={{ width: 8, height: 8, background: _PIE[i % _PIE.length], display: 'inline-block', borderRadius: 2 }} />
                    <span className="flex-1 truncate text-text2">{e.name}</span>
                    <span className="font-mono text-text3">{t.navRub ? (e.value / t.navRub * 100).toFixed(1) + '%' : ''}</span>
                  </div>
                ))}
              </div>
            </>
          ) : <div className="text-text3 text-xs py-8 text-center">Нет позиций.</div>}
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
