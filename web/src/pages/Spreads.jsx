// Страница «Спреды к ОФЗ» (сайдбар-пункт «КС»). Ключевая ставка — крупно и
// постоянно сверху. Ниже — динамика G-спреда (доходность бумаги минус ОФЗ той
// же дюрации) за выбранный период: сужение/расширение по фиксам и флоатерам.
// Пресеты периодов + собственный выбор промежутка (встроенные date-поля).
// Данные тянутся прямо из MOEX ISS в браузере (spreadsOfz.js), бэкенд не нужен.

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Percent, CalendarDays, RefreshCw, TrendingDown, TrendingUp } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, ReferenceLine, ScatterChart, Scatter, Legend } from 'recharts';
import Card from '../components/ui/Card.jsx';
import { useKeyRate } from '../store/rates.js';
import { usePortfolioStore } from '../store/portfolio.js';
import { useBondUniverse } from '../store/marketData.js';
import { computeSpreadChange, presetRange, avgDelta } from '../lib/spreadsOfz.js';

const PRESETS = [
  { k: '1m', l: '1М' }, { k: '3m', l: '3М' }, { k: '6m', l: '6М' },
  { k: '1y', l: '1Г' }, { k: 'ytd', l: 'YTD' },
];
const C_FIX = '#4ea1ff', C_FLT = '#ffb02e';
const bp = v => v == null ? '—' : (v >= 0 ? '+' : '') + Math.round(v) + ' б.п.';
const short = s => { s = String(s || ''); return s.length > 22 ? s.slice(0, 21) + '…' : s; };

export default function Spreads(){
  const { current: keyRate, asOf, source, setCurrent } = useKeyRate();
  const [editKr, setEditKr] = useState(false);
  const [krInput, setKrInput] = useState('');
  // Ставка «устарела», если последняя запись старше ~50 дней (заседания ЦБ
  // чаще) — подсказываем обновить, а не молча показываем старое значение.
  const krStale = useMemo(() => {
    if(!asOf || asOf.length !== 10) return false;
    return (Date.now() - new Date(asOf).getTime()) > 50 * 864e5;
  }, [asOf]);
  const real   = usePortfolioStore(s => s.real);
  const loadPf = usePortfolioStore(s => s.load);
  const bonds  = useBondUniverse();
  useEffect(() => { loadPf(); }, [loadPf]);

  // Набор бумаг: сначала облигации портфеля (ОФЗ исключаем — они бенчмарк),
  // иначе — корпоративы из каталога (ограниченно, чтобы не грузить сеть).
  const scope = useMemo(() => {
    // Исключаем только ОФЗ-ПД (SU26*) — они бенчмарк. ОФЗ-ПК (SU29*, флоатеры)
    // и корпораты оставляем, чтобы флоатеры были видны.
    const isBench = s => /^SU26/i.test(String(s || ''));
    const fromPf = (real || [])
      .filter(p => /bond/.test(String(p.type || '')) && (p.moexSecid || p.isin) && !isBench(p.moexSecid || p.isin))
      .map(p => ({ secid: String(p.moexSecid || p.isin).toUpperCase(), name: p.name || p.issuerTitle, issuer: p.issuerTitle || p.name }));
    if(fromPf.length) return { src: 'портфель', list: dedupe(fromPf) };
    const corp = (bonds || [])
      .filter(b => b.type === 'corporate' && b.secid)
      .slice(0, 40)
      .map(b => ({ secid: String(b.secid).toUpperCase(), name: b.name, issuer: b.issuer }));
    return { src: 'каталог', list: dedupe(corp) };
  }, [real, bonds]);

  const [range, setRange] = useState(() => ({ ...presetRange('3m'), label: '3М' }));
  const [cFrom, setCFrom] = useState(range.from);
  const [cTill, setCTill] = useState(range.till);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState([0, 0]);
  const [res, setRes] = useState(null);
  const [err, setErr] = useState('');

  const run = useCallback(async (from, till, label) => {
    if(!scope.list.length){ setErr('нет бумаг для анализа — подключи портфель (токен в «Долге») или открой «Облигации»'); return; }
    setRunning(true); setErr(''); setProgress([0, scope.list.length]);
    try {
      const r = await computeSpreadChange(scope.list, from, till, (d, n) => setProgress([d, n]));
      setRes({ ...r, from, till, label, src: scope.src });
      if(!r.ok && r.note) setErr(r.note);
    } catch(e){ setErr(String(e && e.message || e)); }
    setRunning(false);
  }, [scope]);

  // Автозапуск один раз, когда набор бумаг готов — чтобы сразу было что смотреть.
  const [autoRan, setAutoRan] = useState(false);
  useEffect(() => {
    if(!autoRan && scope.list.length){ setAutoRan(true); run(range.from, range.till, range.label); }
  }, [autoRan, scope, range, run]);

  const applyPreset = (k, l) => { const r = presetRange(k); setRange({ ...r, label: l }); setCFrom(r.from); setCTill(r.till); run(r.from, r.till, l); };
  const applyCustom = () => { if(cFrom && cTill && cFrom < cTill){ setRange({ from: cFrom, till: cTill, label: 'период' }); run(cFrom, cTill, 'период'); } };

  const rows = res?.rows || [];
  const fixRows = rows.filter(r => !r.isFloater);
  const fltRows = rows.filter(r => r.isFloater);
  const avgFix = avgDelta(fixRows), avgFlt = avgDelta(fltRows), avgAll = avgDelta(rows);
  // Y-ось требует уникальных подписей: у эмитента часто несколько выпусков —
  // при коллизии дописываем хвост SECID.
  const _seen = {};
  const chartData = rows.map(r => {
    let nm = short(r.issuer || r.name);
    if(_seen[nm] != null){ nm = nm + ' ·' + String(r.secid).slice(-4); } else { _seen[nm] = 1; }
    return { name: nm, delta: r.delta, fl: r.isFloater };
  });
  // Данные кривой доходности: линия ОФЗ (начало/конец) + точки корп-бумаг.
  const curveEnd   = (res?.ofzCurveEnd   || []).map(p => ({ durY: p.durY, y: p.y, kind: 'ofz' }));
  const curveStart = (res?.ofzCurveStart || []).map(p => ({ durY: p.durY, y: p.y, kind: 'ofzStart' }));
  const corpPts    = rows.filter(r => r.durY > 0 && r.yEnd != null).map(r => ({ ...r, kind: 'corp' }));

  return (
    <div className="space-y-6">
      {/* КС — крупно и постоянно */}
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Спреды к ОФЗ</h1>
          <p className="text-text2 text-sm mt-1">
            G-спред = доходность бумаги − доходность ОФЗ той же дюрации. Смотрим, сузился он или расширился за период.
          </p>
        </div>
        <div className={['flex items-center gap-2 px-4 py-2 rounded-lg border', krStale ? 'bg-warn/10 border-warn/40' : 'bg-acc-dim border-acc/30'].join(' ')}>
          <Percent size={18} className={krStale ? 'text-warn' : 'text-acc'} />
          <div className="leading-tight">
            <div className="text-[10px] uppercase tracking-wider text-text3 font-mono">Ключевая ставка ЦБ</div>
            {editKr ? (
              <div className="flex items-center gap-1 mt-0.5">
                <input type="number" step="0.25" autoFocus value={krInput} onChange={e => setKrInput(e.target.value)}
                  placeholder={keyRate != null ? String(keyRate) : '16'}
                  className="bg-s2 border border-border rounded px-2 h-7 w-20 text-sm font-mono text-text" />
                <button type="button" onClick={() => { setCurrent(krInput); setEditKr(false); setKrInput(''); }}
                  className="px-2 h-7 rounded text-xs font-mono bg-acc text-bg">ok</button>
                <button type="button" onClick={() => { setEditKr(false); setKrInput(''); }}
                  className="px-2 h-7 rounded text-xs font-mono text-text3 hover:text-text">×</button>
              </div>
            ) : (
              <div className="text-xl font-semibold font-mono text-acc flex items-center gap-2">
                {keyRate != null ? keyRate + '%' : '—'}
                {asOf ? <span className="text-text3 text-[11px] font-normal">на {(asOf.length === 10 ? asOf.split('-').reverse().join('.') : asOf)}</span> : null}
                <button type="button" onClick={() => { setKrInput(keyRate != null ? String(keyRate) : ''); setEditKr(true); }}
                  title="Обновить ставку (запишется на сегодня)"
                  className="text-text3 hover:text-acc text-[11px] font-normal underline decoration-dotted">изм.</button>
              </div>
            )}
          </div>
        </div>
      </div>
      {krStale && !editKr && (
        <div className="text-[11px] text-warn font-mono -mt-3">
          Ставка от {asOf && asOf.length === 10 ? asOf.split('-').reverse().join('.') : asOf} — похоже, устарела. Нажми «изм.» и впиши актуальную (запишется на сегодня, подхватят все разделы).
        </div>
      )}
      {source === 'macro-avg' && (
        <div className="text-[11px] text-warn font-mono -mt-3">КС показана среднегодовой — впиши актуальную через «изм.».</div>
      )}

      {/* Управление периодом */}
      <Card title="Период" padded>
        <div className="flex flex-wrap items-center gap-2">
          {PRESETS.map(p => (
            <button key={p.k} type="button" onClick={() => applyPreset(p.k, p.l)} disabled={running}
              className={['px-3 py-1.5 rounded text-xs font-mono border transition-colors disabled:opacity-40',
                range.label === p.l ? 'border-acc text-acc bg-acc-dim' : 'border-border text-text2 hover:text-text hover:border-border2'].join(' ')}>
              {p.l}
            </button>
          ))}
          <span className="mx-1 w-px h-5 bg-border" />
          <CalendarDays size={14} className="text-text3" />
          <input type="date" value={cFrom} max={cTill} onChange={e => setCFrom(e.target.value)}
            className="bg-s2 border border-border rounded px-2 h-8 text-xs font-mono text-text" />
          <span className="text-text3 text-xs">—</span>
          <input type="date" value={cTill} min={cFrom} onChange={e => setCTill(e.target.value)}
            className="bg-s2 border border-border rounded px-2 h-8 text-xs font-mono text-text" />
          <button type="button" onClick={applyCustom} disabled={running || !(cFrom && cTill && cFrom < cTill)}
            className="px-3 py-1.5 rounded text-xs font-mono border border-border text-text2 hover:text-acc hover:border-acc/40 disabled:opacity-40">
            Применить
          </button>
          <span className="mx-1 w-px h-5 bg-border" />
          <button type="button" onClick={() => run(range.from, range.till, range.label)} disabled={running}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-mono border border-border bg-s2 text-text2 hover:text-acc hover:border-acc/40 disabled:opacity-40">
            <RefreshCw size={13} className={running ? 'animate-spin' : ''} /> Пересчитать
          </button>
          <span className="text-text3 text-[11px] font-mono ml-auto">
            набор: {scope.src} · {scope.list.length} бумаг
          </span>
        </div>
        {running && (
          <div className="text-text3 text-[11px] font-mono mt-3">Считаю спреды из MOEX… {progress[0]}/{progress[1]}</div>
        )}
        {err && !running && <div className="text-warn text-xs font-mono mt-3">{err}</div>}
      </Card>

      {/* Сводка сужение/расширение */}
      {res?.ok && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <SummaryTile label="Все бумаги" delta={avgAll} n={rows.length} />
          <SummaryTile label="Фиксы" delta={avgFix} n={fixRows.length} color={C_FIX} />
          <SummaryTile label="Флоатеры" delta={avgFlt} n={fltRows.length} color={C_FLT} approx />
        </div>
      )}

      {/* Интерактивная кривая доходности: ОФЗ (линия) + корп-бумаги (точки) */}
      {res?.ok && corpPts.length > 0 && curveEnd.length >= 2 && (
        <Card title={`Кривая доходности · ${res.label} (${fmtD(res.from)} → ${fmtD(res.till)})`}
          subtitle="Линия — ОФЗ по дюрации (пунктир — на начало периода). Точки — бумаги; наведи, чтобы увидеть даты, доходность, спред и его изменение.">
          <div style={{ width: '100%', height: 420 }}>
            <ResponsiveContainer>
              <ScatterChart margin={{ left: 4, right: 16, top: 8, bottom: 16 }}>
                <XAxis type="number" dataKey="durY" name="дюрация" unit=" г" domain={['dataMin', 'dataMax']}
                  tick={{ fill: '#9C90C4', fontSize: 10 }} tickFormatter={v => v.toFixed(1)}
                  label={{ value: 'дюрация, лет', position: 'insideBottom', offset: -8, fill: '#9C90C4', fontSize: 10 }} />
                <YAxis type="number" dataKey="y" name="доходность" unit="%" domain={['auto', 'auto']}
                  tick={{ fill: '#CBC2EA', fontSize: 10 }} tickFormatter={v => v.toFixed(0)}
                  label={{ value: 'доходность, %', angle: -90, position: 'insideLeft', fill: '#9C90C4', fontSize: 10 }} />
                <Tooltip content={<CurveTip />} cursor={{ strokeDasharray: '3 3', stroke: '#3A1F44' }} />
                <Legend wrapperStyle={{ fontSize: 11, fontFamily: 'monospace' }} />
                <Scatter name="ОФЗ (начало)" data={curveStart} line={{ stroke: '#52F2C9', strokeOpacity: 0.4, strokeDasharray: '5 4' }}
                  fill="#52F2C9" fillOpacity={0.4} isAnimationActive={false} />
                <Scatter name="ОФЗ (конец)" data={curveEnd} line={{ stroke: '#52F2C9' }} fill="#52F2C9" isAnimationActive={false} />
                <Scatter name="Фиксы" data={corpPts.filter(p => !p.isFloater)} fill={C_FIX} isAnimationActive={false} />
                <Scatter name="Флоатеры" data={corpPts.filter(p => p.isFloater)} fill={C_FLT} isAnimationActive={false} />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
          <div className="text-[11px] text-text3 font-mono mt-2">
            Чем выше точка над линией ОФЗ — тем больше премия за риск (спред). Сдвиг линии вниз/вверх — изменение базовых ставок за период.
          </div>
        </Card>
      )}

      {/* График Δспреда по бумагам */}
      {res?.ok && rows.length > 0 && (
        <Card title={`Изменение спреда к ОФЗ · ${res.label} (${fmtD(res.from)} → ${fmtD(res.till)})`}
          subtitle="Отрицательное — сужение (премия за риск упала), положительное — расширение.">
          <div style={{ width: '100%', height: Math.max(220, Math.min(620, rows.length * 26 + 40)) }}>
            <ResponsiveContainer>
              <BarChart data={chartData} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
                <XAxis type="number" tick={{ fill: '#9C90C4', fontSize: 10 }} tickFormatter={v => Math.round(v)} />
                <YAxis type="category" dataKey="name" width={150} tick={{ fill: '#CBC2EA', fontSize: 10 }} />
                <Tooltip
                  contentStyle={{ background: '#140A24', border: '1px solid #241638', borderRadius: 8, fontSize: 12 }}
                  formatter={v => [bp(v), 'Δспред']} labelStyle={{ color: '#CBC2EA' }} />
                <ReferenceLine x={0} stroke="#3A1F44" />
                <Bar dataKey="delta" radius={[0, 3, 3, 0]} isAnimationActive={false}>
                  {chartData.map((d, i) => <Cell key={i} fill={d.fl ? C_FLT : C_FIX} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="flex items-center gap-4 mt-2 text-[11px] font-mono text-text3">
            <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: C_FIX }} /> фикс</span>
            <span className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: C_FLT }} /> флоатер (ориентировочно)</span>
          </div>
        </Card>
      )}

      {/* Таблица по бумагам */}
      {res?.ok && rows.length > 0 && (
        <Card title="По бумагам" padded={false}>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-s2/60 text-text3 uppercase text-[10px]">
                <tr>
                  <th className="text-left p-2 pl-4">Бумага</th>
                  <th className="text-center p-2">Тип</th>
                  <th className="text-right p-2">Дюр., лет</th>
                  <th className="text-right p-2">Спред старт</th>
                  <th className="text-right p-2">Спред конец</th>
                  <th className="text-right p-2 pr-4">Δ</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const col = r.delta < -1 ? 'text-green' : r.delta > 1 ? 'text-warn' : 'text-text2';
                  return (
                    <tr key={r.secid} className="border-t border-border/40 hover:bg-s2/30">
                      <td className="p-2 pl-4">
                        <div className="text-text truncate max-w-[280px]" title={r.issuer || r.name}>{r.issuer || r.name}</div>
                        <div className="text-text3 font-mono text-[10px]">{r.secid}</div>
                      </td>
                      <td className="p-2 text-center">
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ color: r.isFloater ? C_FLT : C_FIX, background: (r.isFloater ? C_FLT : C_FIX) + '22' }}>
                          {r.isFloater ? 'флоатер' : 'фикс'}
                        </span>
                      </td>
                      <td className="p-2 text-right font-mono text-text2">{r.durY != null ? r.durY.toFixed(1) : '—'}</td>
                      <td className="p-2 text-right font-mono text-text2">{bp(r.spreadStart * 100)}</td>
                      <td className="p-2 text-right font-mono text-text2">{bp(r.spreadEnd * 100)}</td>
                      <td className={'p-2 pr-4 text-right font-mono font-semibold ' + col}>
                        <span className="inline-flex items-center gap-1 justify-end">
                          {r.delta < -1 ? <TrendingDown size={12} /> : r.delta > 1 ? <TrendingUp size={12} /> : null}
                          {bp(r.delta)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="px-4 py-3 text-[11px] text-text3 font-mono border-t border-border/40">
            Доходности и дюрация — из истории MOEX (YIELDCLOSE). Кривая ОФЗ построена из ОФЗ-ПД и интерполирована по дюрации.
            У флоатеров биржевая доходность считается к ближайшему купону/оферте — спред ориентировочный.
          </div>
        </Card>
      )}
    </div>
  );
}

function SummaryTile({ label, delta, n, color, approx }){
  const narrow = delta != null && delta < 0;
  const flat = delta == null || Math.abs(delta) <= 1;
  const word = flat ? 'без изменений' : narrow ? 'сужение' : 'расширение';
  const col = flat ? 'text-text2' : narrow ? 'text-green' : 'text-warn';
  return (
    <div className="bg-bg2 border border-border rounded-lg p-4">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-text3 font-mono">
        {color && <span className="w-2.5 h-2.5 rounded-sm" style={{ background: color }} />}
        {label} <span className="text-text3/60">· {n}</span>
      </div>
      <div className={'text-2xl font-semibold font-mono mt-1 ' + col}>{bp(delta)}</div>
      <div className={'text-xs ' + col}>{word}{approx && delta != null ? ' · ориентировочно' : ''}</div>
    </div>
  );
}

function CurveTip({ active, payload }){
  if(!active || !payload || !payload.length) return null;
  const p = payload[0].payload;
  if(!p) return null;
  const box = 'bg-bg2 border border-border rounded px-2 py-1.5 text-[11px] font-mono';
  if(p.kind === 'ofz' || p.kind === 'ofzStart'){
    return <div className={box + ' text-text2'}>ОФЗ ~{p.durY.toFixed(1)} г · {p.y.toFixed(2)}% · {p.kind === 'ofzStart' ? 'начало' : 'конец'}</div>;
  }
  const dy = (p.yEnd != null && p.yStart != null) ? (p.yEnd - p.yStart) * 100 : null;
  const dc = p.delta < 0 ? 'text-green' : p.delta > 0 ? 'text-warn' : 'text-text2';
  return (
    <div className={box + ' space-y-0.5 max-w-[250px]'}>
      <div className="text-text font-semibold truncate">{p.issuer || p.name}</div>
      <div className="text-text3">{p.secid} · {p.isFloater ? 'флоатер' : 'фикс'}</div>
      <div className="text-text2">дюрация {p.durY.toFixed(1)} г · дох. {p.yEnd.toFixed(2)}%</div>
      <div className="text-text2">ОФЗ {p.ofzEnd != null ? p.ofzEnd.toFixed(2) + '%' : '—'} · спред {bp(p.spreadEnd * 100)}</div>
      <div className={dc}>Δспред {bp(p.delta)}{dy != null ? ` · дох. ${dy >= 0 ? '+' : ''}${Math.round(dy)} б.п.` : ''}</div>
      <div className="text-text3">{fmtD(p.dStart)} → {fmtD(p.dEnd)}</div>
    </div>
  );
}

function dedupe(list){
  const seen = new Set(); const out = [];
  for(const x of list){ if(x.secid && !seen.has(x.secid)){ seen.add(x.secid); out.push(x); } }
  return out;
}
function fmtD(d){ return d && d.length === 10 ? d.split('-').reverse().join('.') : d; }
