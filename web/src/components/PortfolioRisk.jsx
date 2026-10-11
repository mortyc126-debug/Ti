// Карточка «Риск портфеля» — риск-метрики на реальном ряде стоимости из цен
// MOEX: CAGR, волатильность, Sortino (к КС), подводная и классическая просадки,
// Ulcer, худший день, VaR/CVaR 95%, + Монте-Карло устойчивости. Метрики —
// порт открытых формул из multi-model-portfolio-backtester (polytest.py).

import { useCallback, useState } from 'react';
import { ShieldAlert, RefreshCw, Info } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import Card from './ui/Card.jsx';
import { useKeyRate } from '../store/rates.js';
import { fetchPriceHistory, buildPortfolioSeries } from '../lib/moexPriceHistory.js';
import { portfolioMetrics, monteCarlo, annualToDaily } from '../lib/portfolioRisk.js';
import { optimizeAll } from '../lib/portfolioOptimize.js';
import { INDICATOR_COLORS as IC, seriesColor } from '../lib/indicatorColors.js';

const PRESETS = [{ k: 1, l: '1Г' }, { k: 2, l: '2Г' }, { k: 3, l: '3Г' }];
const pct = (x, d = 1) => x == null ? '—' : (x * 100).toFixed(d) + '%';
const num = (x, d = 2) => x == null || !isFinite(x) ? '—' : x.toFixed(d);

function range(years){
  const till = new Date(); const from = new Date(till);
  from.setFullYear(from.getFullYear() - years);
  const f = d => d.toISOString().slice(0, 10);
  return { from: f(from), till: f(till) };
}

async function pool(items, conc, worker){
  let i = 0;
  const run = async () => { while(i < items.length){ const it = items[i++]; await worker(it); } };
  await Promise.all(Array.from({ length: Math.min(conc, items.length || 1) }, run));
}

export default function PortfolioRisk({ positions }){
  const { current: keyRate } = useKeyRate();
  const [years, setYears] = useState(2);
  const [running, setRunning] = useState(false);
  const [res, setRes] = useState(null);
  const [err, setErr] = useState('');
  const [howOpen, setHowOpen] = useState(false);

  const scope = (positions || [])
    .filter(p => (p.moexSecid || p.isin) && (p.qty > 0))
    .map(p => ({
      secid: String(p.moexSecid || p.isin).toUpperCase(), qty: p.qty,
      name: p.issuerTitle || p.name || null, val: p.valRub || ((p.last || 0) * p.qty) || 0,
    }));

  const run = useCallback(async (yrs) => {
    if(!scope.length){ setErr('нет бумаг с привязкой к MOEX — подключи реальный портфель'); return; }
    setRunning(true); setErr('');
    try {
      const { from, till } = range(yrs);
      const withHist = [];
      await pool(scope, 6, async p => {
        const hist = await fetchPriceHistory(p.secid, from, till);
        if(hist.length) withHist.push({ ...p, hist });
      });
      const series = buildPortfolioSeries(withHist);
      if(series.length < 30){ setErr('мало истории цен за период (нужно ≥30 торговых дней)'); setRunning(false); return; }
      const rfDaily = annualToDaily(keyRate || 0);
      const m = portfolioMetrics(series, rfDaily);
      const mc = monteCarlo(m.returns, { stepsPerYear: m.ppy, paths: 1000, block: 10, rfDaily });
      // нормируем кривую к 100 в начале
      const base = series[0].val || 1;
      const curve = series.map(s => ({ date: s.date, v: s.val / base * 100 }));
      // оптимизация весов на тех же историях + текущие веса по стоимости
      const opt = optimizeAll(withHist, rfDaily);
      const nameBy = {}; for(const p of scope) nameBy[p.secid] = p.name || p.secid;
      const totVal = withHist.reduce((a, p) => a + (p.val || 0), 0) || 1;
      const curW = {}; for(const p of withHist) curW[p.secid] = (p.val || 0) / totVal;
      setRes({ m, mc, curve, covered: withHist.length, total: scope.length, from, till, yrs, opt, nameBy, curW });
    } catch(e){ setErr(String(e && e.message || e)); }
    setRunning(false);
  }, [scope, keyRate]);

  const m = res?.m, mc = res?.mc;
  const ddCol = v => v == null ? 'text-text2' : v <= -0.2 ? 'text-danger' : v <= -0.1 ? 'text-warn' : 'text-text';

  return (
    <Card
      title="Риск портфеля"
      subtitle="Метрики на реальном ряде стоимости (цены MOEX). Монте-Карло — блочный bootstrap, 1000 траекторий × 1 год."
      action={
        <div className="flex items-center gap-1.5">
          {PRESETS.map(p => (
            <button key={p.k} type="button" onClick={() => { setYears(p.k); run(p.k); }} disabled={running}
              className={['px-2 py-1 rounded text-[11px] font-mono border disabled:opacity-40',
                years === p.k ? 'border-acc text-acc bg-acc-dim' : 'border-border text-text2 hover:text-text'].join(' ')}>
              {p.l}
            </button>
          ))}
          <button type="button" onClick={() => run(years)} disabled={running}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-mono border border-border text-text2 hover:text-acc disabled:opacity-40">
            <RefreshCw size={12} className={running ? 'animate-spin' : ''} /> {res ? 'пересчитать' : 'посчитать'}
          </button>
        </div>
      }
    >
      {!res && !running && !err && (
        <div className="text-text3 text-sm flex items-center gap-2"><ShieldAlert size={15} /> Нажми «посчитать» — соберу риск-профиль портфеля из истории цен MOEX.</div>
      )}
      {running && <div className="text-text3 text-[12px] font-mono">Считаю риск из MOEX… ({scope.length} бумаг)</div>}
      {err && !running && <div className="text-warn text-xs font-mono">{err}</div>}

      {res && m && (
        <div className="space-y-4">
          <div className="text-[11px] text-text3 font-mono">
            период {res.from} → {res.till} · бумаг с историей: {res.covered}/{res.total} · дней: {m.n} · безрисковая (КС): {keyRate != null ? keyRate + '%' : '—'}
          </div>

          {/* Кривая стоимости */}
          <div style={{ width: '100%', height: 180 }}>
            <ResponsiveContainer>
              <LineChart data={res.curve} margin={{ left: 4, right: 8, top: 4, bottom: 4 }}>
                <XAxis dataKey="date" tick={{ fill: '#9C90C4', fontSize: 9 }} minTickGap={48} />
                <YAxis tick={{ fill: '#9C90C4', fontSize: 9 }} domain={['auto', 'auto']} width={34} />
                <Tooltip contentStyle={{ background: '#140A24', border: '1px solid #241638', borderRadius: 8, fontSize: 11 }}
                  formatter={v => [v.toFixed(1), 'индекс (старт=100)']} labelStyle={{ color: '#CBC2EA' }} />
                <ReferenceLine y={100} stroke="#3A1F44" strokeDasharray="3 3" />
                <Line type="monotone" dataKey="v" stroke={IC.accent} dot={false} strokeWidth={1.5} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Метрики */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Tile label="CAGR" val={pct(m.cagr)} col={m.cagr >= 0 ? 'text-green' : 'text-danger'} />
            <Tile label="Волатильность" val={pct(m.vol)} />
            <Tile label="Sortino (к КС)" val={num(m.sortino)} col={m.sortino >= 0 ? 'text-green' : 'text-danger'} sub="доходность/вниз-риск" />
            <Tile label="Худший день" val={num(m.maxDailyDrop, 1) + '%'} col="text-danger" />
            <Tile label="Просадка (подводная)" val={pct(m.maxDrawdown)} col={ddCol(m.maxDrawdown)} sub="ниже старта капитала" />
            <Tile label="Просадка (от пика)" val={pct(m.classicMaxDD)} col={ddCol(m.classicMaxDD)} />
            <Tile label="Ulcer index" val={num(m.ulcer, 1)} sub="глубина×длительность боли" />
            <Tile label="CVaR 95% (день)" val={pct(m.cvar95)} col="text-warn" sub={`VaR ${pct(m.var95)}`} />
          </div>

          {/* Монте-Карло */}
          {mc && (
            <div>
              <div className="text-[11px] font-mono uppercase tracking-wider text-text2 mb-2">Монте-Карло устойчивости · {mc.paths} траекторий</div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <McTile label="CAGR за год" q={mc.cagr} fmt={v => pct(v)} good="high" />
                <McTile label="Макс. просадка" q={mc.maxDrawdown} fmt={v => pct(v)} good="low" />
                <McTile label="Sortino" q={mc.sortino} fmt={v => num(v)} good="high" />
              </div>
              <div className="text-[12px] text-text2 mt-2">
                Вероятность просадки глубже −20% за год:{' '}
                <span className={mc.probDrawdown20 > 0.3 ? 'text-danger' : mc.probDrawdown20 > 0.1 ? 'text-warn' : 'text-green'}>
                  {(mc.probDrawdown20 * 100).toFixed(0)}%
                </span>
              </div>
            </div>
          )}

          {/* Оптимизация весов */}
          {res.opt && res.opt.models.length > 0 && (
            <WeightsBlock opt={res.opt} curW={res.curW} nameBy={res.nameBy} />
          )}

          <div>
            <button type="button" onClick={() => setHowOpen(v => !v)}
              className="inline-flex items-center gap-1.5 text-[11px] font-mono text-text2 hover:text-acc">
              <Info size={12} /> Как это считается {howOpen ? '▲' : '▼'}
            </button>
            {howOpen && <HowBlock />}
          </div>
        </div>
      )}
    </Card>
  );
}

function HowBlock(){
  const H = ({ c, children }) => <span style={{ color: c }}>{children}</span>;
  return (
    <div className="mt-2 text-[11px] text-text2 leading-relaxed space-y-2 border-l-2 pl-3" style={{ borderColor: IC.violet }}>
      <div><H c={IC.accent}>Ряд стоимости (мульти-актив).</H> Для каждой бумаги берётся дневная история цен MOEX; цены выравниваются по общим датам (пропуски — предыдущим значением). Стоимость портфеля в день t: <span className="font-mono">V(t) = Σ qtyᵢ·pxᵢ(t)</span> по всем бумагам. Дневная доходность <span className="font-mono">r(t) = V(t)/V(t−1) − 1</span>, винзоризуется к ±25% (глушит скачки неликвида).</div>
      <div><H c={IC.bullish}>CAGR</H> = (Π(1+r))^(1/лет) − 1 — среднегодовой рост за <b>календарный</b> срок. <H c={IC.blue}>Волатильность</H> = σ(r)·√(набл/год). <H c={IC.violet}>Sortino</H> = (CAGR − КС) / σ только <i>отрицательных</i> отклонений (падения штрафуются, рост — нет).</div>
      <div><H c={IC.bearish}>Просадка «подводная»</H> — max провал ниже стартового капитала (прибыль сверх старта не в счёт). <H c={IC.orange}>Ulcer</H> = RMS глубины×длительности просадок. <H c={IC.gray}>VaR/CVaR 95%</H>: VaR — порог 5% худших дней, CVaR — средний убыток в этом хвосте.</div>
      <div><H c={IC.accent}>Монте-Карло.</H> Реальные дневные доходности пересобираются блоками по ~10 (сохраняя автокорреляцию) в 1000 траекторий длиной «1 год» (= фактическое число наблюдений в год). По каждой считаются те же метрики → перцентили p5/p50/p95 и доля траекторий с просадкой глубже −20%.</div>
      <div><H c={IC.teal}>Веса (мульти-актив).</H> На матрице доходностей активов строится ковариация Σ (со шринкажем к диагонали). <b>1/N</b> — поровну. <b>Обр. волатильность</b> — wᵢ∝1/σᵢ. <b>Min-variance</b> — w∝Σ⁻¹·1. <b>Max-Sortino</b> — w∝Σ⁻¹·(μ−КС). <b>Min-CVaR</b> — минимизирует средний убыток 5%-хвоста (Рокафеллар–Урясев). Все long-only, ∑=1 (проекция на симплекс).</div>
      <div className="text-text3">Источник формул: multi-model-portfolio-backtester (polytest.py / benchmarks.py). Это ориентир, не инвест-рекомендация; облигационные нюансы (дюрация, оферты) модели не видят.</div>
    </div>
  );
}

function WeightsBlock({ opt, curW, nameBy }){
  const [sel, setSel] = useState('minvar');
  const model = opt.models.find(m => m.key === sel) || opt.models[0];
  // объединённый список бумаг, сортировка по весу выбранной модели
  // цвет закреплён за бумагой (стабилен между моделями) — как линии индикаторов
  const colorBy = {}; opt.assets.forEach((s, i) => { colorBy[s] = seriesColor(i); });
  const rows = opt.assets.map(secid => ({
    secid, name: nameBy[secid] || secid,
    cur: curW[secid] || 0,
    w: (model.weights.find(x => x.secid === secid) || {}).w || 0,
  })).sort((a, b) => b.w - a.w);
  const pc = x => (x * 100).toFixed(1) + '%';
  const barW = x => Math.max(0, Math.min(100, x * 100)).toFixed(1) + '%';
  return (
    <div>
      <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
        <div className="text-[11px] font-mono uppercase tracking-wider text-text2">Оптимизация весов · {opt.dates} дней</div>
        <div className="flex flex-wrap gap-1">
          {opt.models.map(m => (
            <button key={m.key} type="button" onClick={() => setSel(m.key)}
              className={['px-2 py-1 rounded text-[10px] font-mono border',
                sel === m.key ? 'border-acc text-acc bg-acc-dim' : 'border-border text-text2 hover:text-text'].join(' ')}>
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* сравнение характеристик моделей */}
      <div className="overflow-x-auto mb-3">
        <table className="w-full text-[11px]">
          <thead className="text-text3 uppercase text-[9px]">
            <tr><th className="text-left p-1.5">Модель</th><th className="text-right p-1.5">Дох. год</th><th className="text-right p-1.5">Волат.</th><th className="text-right p-1.5">Sortino</th><th className="text-right p-1.5">CVaR 95%</th></tr>
          </thead>
          <tbody>
            {opt.models.map(m => (
              <tr key={m.key} className={'border-t border-border/40 ' + (m.key === sel ? 'bg-acc-dim/40' : '')}>
                <td className="p-1.5 font-mono text-text">{m.label}</td>
                <td className={'p-1.5 text-right font-mono ' + (m.stats.retAnnual >= 0 ? 'text-green' : 'text-danger')}>{pc(m.stats.retAnnual)}</td>
                <td className="p-1.5 text-right font-mono text-text2">{pc(m.stats.vol)}</td>
                <td className="p-1.5 text-right font-mono text-text2">{isFinite(m.stats.sortino) ? m.stats.sortino.toFixed(2) : '—'}</td>
                <td className="p-1.5 text-right font-mono text-warn">{pc(m.stats.cvar)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* текущие vs предложенные веса */}
      <div className="max-h-72 overflow-y-auto border border-border/60 rounded">
        <table className="w-full text-[11px]">
          <thead className="bg-s2/60 text-text3 uppercase text-[9px] sticky top-0">
            <tr><th className="text-left p-1.5 pl-3">Бумага</th><th className="text-right p-1.5">Сейчас</th><th className="text-right p-1.5 pr-3">{model.label}</th><th className="w-[40%]" /></tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const d = r.w - r.cur;
              return (
                <tr key={r.secid} className="border-t border-border/40">
                  <td className="p-1.5 pl-3">
                    <div className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: colorBy[r.secid] }} />
                      <div className="truncate max-w-[170px] text-text" title={r.name}>{r.name}</div>
                    </div>
                    <div className="text-text3 font-mono text-[9px] pl-3.5">{r.secid}</div>
                  </td>
                  <td className="p-1.5 text-right font-mono text-text3">{pc(r.cur)}</td>
                  <td className={'p-1.5 pr-3 text-right font-mono ' + (d > 0.005 ? 'text-green' : d < -0.005 ? 'text-warn' : 'text-text')}>{pc(r.w)}</td>
                  <td className="p-1.5"><div className="h-2 rounded bg-s2 overflow-hidden"><div className="h-full" style={{ width: barW(r.w), background: colorBy[r.secid] }} /></div></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Tile({ label, val, col = 'text-text', sub }){
  return (
    <div className="bg-s2/40 border border-border rounded p-2.5">
      <div className="text-[10px] uppercase tracking-wider text-text3 font-mono truncate">{label}</div>
      <div className={'text-lg font-semibold font-mono ' + col}>{val}</div>
      {sub && <div className="text-[10px] text-text3">{sub}</div>}
    </div>
  );
}

function McTile({ label, q, fmt, good }){
  if(!q) return null;
  const medCol = good === 'low'
    ? (q.p50 <= -0.2 ? 'text-danger' : q.p50 <= -0.1 ? 'text-warn' : 'text-green')
    : (q.p50 >= 0 ? 'text-green' : 'text-danger');
  return (
    <div className="bg-s2/40 border border-border rounded p-2.5">
      <div className="text-[10px] uppercase tracking-wider text-text3 font-mono">{label}</div>
      <div className={'text-lg font-semibold font-mono ' + medCol}>{fmt(q.p50)}</div>
      <div className="text-[10px] text-text3 font-mono">худш. {fmt(q.p5)} · лучш. {fmt(q.p95)}</div>
    </div>
  );
}
