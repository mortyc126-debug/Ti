import { useEffect, useMemo, useState } from 'react';
import { Rnd } from 'react-rnd';
import { useWindows } from '../store/windows.js';
import { api } from '../api.js';

// Слой плавающих окон. Рендерится один раз в App.jsx поверх Outlet.
// Каркас окна + живой контент в MediumBody (вкладки Финансы/Бумаги/
// Связи/События). Данные тащатся через api.js при открытии окна;
// клиентский кеш — в localStorage через issuerCache (issuerCard,
// issuerReports, issuerAffiliations отдельно).

export default function WindowLayer(){
  const windows = useWindows(s => s.windows);
  return (
    <div className="pointer-events-none fixed inset-0 z-30">
      {windows.map(w => <FloatingWindow key={w.wid} win={w} />)}
    </div>
  );
}

function FloatingWindow({ win }){
  const { close, duplicate, focus, setMode, setTab, patch } = useWindows.getState();
  const isMicro = win.mode === 'micro';
  const isFull  = win.mode === 'full';

  // в fullscreen окно занимает почти весь экран (с отступом под шапку)
  const rndProps = isFull
    ? { size: { width: window.innerWidth - 24, height: window.innerHeight - 80 },
        position: { x: 12, y: 64 },
        disableDragging: true, enableResizing: false }
    : { size: { width: win.w, height: win.h },
        position: { x: win.x, y: win.y },
        bounds: 'window',
        // drag за любой участок окна, КРОМЕ интерактивных элементов и
        // ссылок на разделы — нужно тащить за «пустоту» поля, чтобы
        // ссылки и кнопки внутри работали как обычно.
        cancel: 'button, a, input, textarea, select, [data-no-drag]',
        minWidth: 280, minHeight: 160,
        onDragStop: (_, d) => patch(win.wid, { x: d.x, y: d.y }),
        onResizeStop: (_, __, ref, ___, pos) =>
          patch(win.wid, { w: parseInt(ref.style.width, 10), h: parseInt(ref.style.height, 10), x: pos.x, y: pos.y }) };

  return (
    <Rnd
      {...rndProps}
      style={{ zIndex: win.z, pointerEvents: 'auto' }}
      onMouseDown={() => focus(win.wid)}
    >
      <div className="w-full h-full bg-bg2 border border-border2 rounded-lg shadow-2xl flex flex-col overflow-hidden">
        {/* шапка окна — больше не единственный drag-handle: Rnd теперь
            тащит за любой не-интерактивный пиксель окна (см. cancel выше). */}
        <div className="flex items-center gap-2 px-3 h-9 bg-s2 border-b border-border cursor-move select-none">
          <span className="text-acc text-xs">●</span>
          <span className="font-mono text-text text-sm font-semibold truncate">{win.title}</span>
          {win.ticker && <span className="font-mono text-text3 text-xs">{win.ticker}</span>}
          <div className="ml-auto flex items-center gap-1">
            <HeaderBtn title="Дублировать"  onClick={() => duplicate(win.wid)}>⧉</HeaderBtn>
            {isMicro
              ? <HeaderBtn title="Развернуть" onClick={() => setMode(win.wid, 'medium')}>↕</HeaderBtn>
              : isFull
                ? <HeaderBtn title="Свернуть" onClick={() => setMode(win.wid, 'medium')}>↙</HeaderBtn>
                : <>
                    <HeaderBtn title="Свернуть до Micro" onClick={() => setMode(win.wid, 'micro')}>▭</HeaderBtn>
                    <HeaderBtn title="На весь экран"     onClick={() => setMode(win.wid, 'full')}>⛶</HeaderBtn>
                  </>}
            <HeaderBtn title="Закрыть" onClick={() => close(win.wid)}>✕</HeaderBtn>
          </div>
        </div>

        {/* содержимое */}
        {isMicro
          ? <MicroBody win={win} />
          : <MediumBody win={win} setTab={setTab} />}
      </div>
    </Rnd>
  );
}

function HeaderBtn({ title, onClick, children }){
  return (
    <button
      title={title}
      onClick={onClick}
      className="w-6 h-6 flex items-center justify-center text-text3 hover:text-text hover:bg-bg2 rounded text-xs"
    >{children}</button>
  );
}

const TABS = [
  { id: 'finances', label: 'Финансы' },
  { id: 'papers',   label: 'Бумаги' },
  { id: 'links',    label: 'Связи' },
  { id: 'events',   label: 'События' },
];

function MediumBody({ win, setTab }){
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex border-b border-border bg-bg2">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(win.wid, t.id)}
            className={`px-3 h-8 text-xs font-mono uppercase tracking-wider transition-colors ${
              win.tab === t.id
                ? 'text-acc border-b-2 border-acc -mb-px'
                : 'text-text2 hover:text-text'
            }`}
          >{t.label}</button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto p-4 text-text2 text-sm">
        <IssuerTabContent win={win} />
      </div>
    </div>
  );
}

function MicroBody({ win }){
  const { card } = useIssuerData(win.inn || win.id);
  const issuer = card?.issuer;
  const reports = card?.reports || [];
  const last = reports[0];
  return (
    <div className="flex-1 p-3 text-text2 text-xs space-y-2">
      <div className="flex justify-between text-text3 uppercase tracking-wider">
        <span>{issuer?.kind || win.kind}</span>
        <span>{issuer?.bonds_count != null ? `${issuer.bonds_count} вып.` : '—'}</span>
      </div>
      <div className="text-text font-mono text-sm">{win.title}</div>
      {last ? (
        <div className="text-text3 space-y-0.5">
          <div>{last.fy_year}: rev {fmtBn(last.rev)} · np {fmtBn(last.np)}</div>
          <div>assets {fmtBn(last.assets)} · eq {fmtBn(last.eq)}</div>
        </div>
      ) : (
        <div className="text-text3 italic">нет отчётности в БД</div>
      )}
    </div>
  );
}

// ───── Hook: тащит и кеширует issuerCard + reports + affiliations ─────
const ISSUER_CACHE = new Map(); // in-memory кеш на сессию
const ISSUER_CACHE_TTL = 5 * 60 * 1000;

function useIssuerData(inn){
  const [state, setState] = useState({ loading: !!inn, error: null, card: null, reports: null, affiliations: null });

  useEffect(() => {
    if(!inn || !/^\d{10,12}$/.test(String(inn))){
      setState({ loading: false, error: 'no-inn', card: null, reports: null, affiliations: null });
      return;
    }
    const cached = ISSUER_CACHE.get(inn);
    if(cached && Date.now() - cached.at < ISSUER_CACHE_TTL){
      setState({ loading: false, error: null, ...cached });
      return;
    }
    let cancelled = false;
    setState(s => ({ ...s, loading: true, error: null }));
    Promise.allSettled([
      api.issuerCard(inn),
      api.issuerReports(inn),
      api.issuerAffiliations(inn),
    ]).then(([cardR, repR, affR]) => {
      if(cancelled) return;
      const card = cardR.status === 'fulfilled' ? cardR.value : null;
      const reports = repR.status === 'fulfilled' ? (repR.value?.data || []) : [];
      const affiliations = affR.status === 'fulfilled' ? affR.value : null;
      const err = !card && !reports?.length && !affiliations
        ? (cardR.reason?.message || repR.reason?.message || 'no-data')
        : null;
      const data = { at: Date.now(), card, reports, affiliations };
      ISSUER_CACHE.set(inn, data);
      setState({ loading: false, error: err, ...data });
    });
    return () => { cancelled = true; };
  }, [inn]);

  return state;
}

// ───── Контент вкладок ─────────────────────────────────────────────
function IssuerTabContent({ win }){
  const inn = win.inn || (typeof win.id === 'string' && /^\d{10,12}$/.test(win.id) ? win.id : null);
  const { loading, error, card, reports, affiliations } = useIssuerData(inn);

  if(!inn){
    return <div className="text-text3 text-xs italic">У этого эмитента нет ИНН в наших данных — без него не получится подтянуть отчётность. Откройте облигацию из таблицы — там ИНН проставляется автоматически.</div>;
  }
  if(loading) return <div className="text-text3 text-xs">Загружаю данные…</div>;
  if(error === 'no-data') return <div className="text-text3 text-xs italic">По ИНН {inn} в БД пока ничего нет. Запустите сбор отчётности из admin-панели.</div>;

  switch(win.tab){
    case 'finances':  return <TabFinances card={card} reports={reports} />;
    case 'papers':    return <TabPapers card={card} />;
    case 'links':     return <TabLinks affiliations={affiliations} />;
    case 'events':    return <TabEvents card={card} />;
    default:          return <TabFinances card={card} reports={reports} />;
  }
}

function TabFinances({ card, reports }){
  const issuer = card?.issuer;
  const stock = card?.stock;
  if(!reports?.length){
    return <div className="text-text3 text-xs italic">Отчётность не собрана. В admin → 📊 Отчётность.</div>;
  }
  // Сортируем по году убыванию, берём до 5 лет
  const series = [...reports].sort((a, b) => (b.fy_year || 0) - (a.fy_year || 0)).slice(0, 5);
  return (
    <div className="space-y-3">
      {issuer && (
        <div className="text-text3 text-xs">
          <span className="text-text">{issuer.short_name || issuer.name}</span>
          {issuer.sector && <span className="ml-2">· {issuer.sector}</span>}
          {issuer.status && <span className="ml-2">· {issuer.status}</span>}
          {issuer.bonds_count != null && <span className="ml-2">· {issuer.bonds_count} вып.</span>}
          {stock?.changePct != null && (
            <span className={'ml-2 ' + (stock.changePct >= 0 ? 'text-green' : 'text-danger')}>
              · {stock.ticker} {stock.changePct >= 0 ? '+' : ''}{stock.changePct}%
            </span>
          )}
        </div>
      )}
      <div className="overflow-x-auto -mx-2">
        <table className="w-full text-xs">
          <thead className="text-text3 text-[10px] uppercase">
            <tr>
              <th className="text-left p-1.5">Метрика</th>
              {series.map(r => <th key={r.fy_year} className="text-right p-1.5">{r.fy_year}</th>)}
            </tr>
          </thead>
          <tbody className="font-mono">
            <MetricRow label="Выручка"        series={series} field="rev"      fmt={fmtBn} />
            <MetricRow label="EBIT"           series={series} field="ebit"     fmt={fmtBn} />
            <MetricRow label="Чист. прибыль"  series={series} field="np"       fmt={fmtBn} colorize />
            <MetricRow label="Активы"         series={series} field="assets"   fmt={fmtBn} />
            <MetricRow label="Капитал"        series={series} field="eq"       fmt={fmtBn} />
            <MetricRow label="Долг"           series={series} field="debt"     fmt={fmtBn} />
            <MetricRow label="Деньги"         series={series} field="cash"     fmt={fmtBn} />
            <MetricRow label="ROA, %"         series={series} field="roa_pct"  fmt={fmtPct} colorize />
            <MetricRow label="ROS, %"         series={series} field="ros_pct"  fmt={fmtPct} colorize />
            <MetricRow label="EBITDA-марж, %" series={series} field="ebitda_marg" fmt={fmtPct} />
            <MetricRow label="ND/Eq"          series={series} field="net_debt_eq" fmt={fmtX} />
          </tbody>
        </table>
      </div>
      <div className="text-text3 text-[10px]">
        Источник: {series[0]?.source || '—'} · последнее обновление {series[0]?.fetched_at?.slice(0, 10) || '—'}
      </div>
    </div>
  );
}

function MetricRow({ label, series, field, fmt, colorize }){
  return (
    <tr className="border-t border-border/40">
      <td className="p-1.5 text-text2 font-sans">{label}</td>
      {series.map(r => {
        const v = r[field];
        let cls = 'text-text';
        if(colorize && typeof v === 'number'){
          if(v < 0) cls = 'text-danger';
          else if(v > 0) cls = 'text-green';
        }
        return (
          <td key={r.fy_year} className={`p-1.5 text-right ${cls}`}>
            {v == null ? <span className="text-text3">—</span> : fmt(v)}
          </td>
        );
      })}
    </tr>
  );
}

function TabPapers({ card }){
  const bonds = card?.bonds || [];
  if(!bonds.length){
    return <div className="text-text3 text-xs italic">Нет активных бумаг (или ещё не собраны).</div>;
  }
  return (
    <div className="overflow-x-auto -mx-2">
      <table className="w-full text-xs">
        <thead className="text-text3 text-[10px] uppercase">
          <tr>
            <th className="text-left p-1.5">SECID</th>
            <th className="text-left p-1.5">Имя</th>
            <th className="text-right p-1.5">Цена</th>
            <th className="text-right p-1.5">YTM</th>
            <th className="text-right p-1.5">Купон</th>
            <th className="text-left p-1.5">Погаш.</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {bonds.map(b => (
            <tr key={b.secid} className="border-t border-border/40 hover:bg-s2/40">
              <td className="p-1.5 text-text">{b.secid}</td>
              <td className="p-1.5 text-text2">{b.shortname}</td>
              <td className="p-1.5 text-right">{b.price?.toFixed(2)}</td>
              <td className="p-1.5 text-right">{b.yield?.toFixed(2)}%</td>
              <td className="p-1.5 text-right">{b.coupon_pct ?? '—'}%</td>
              <td className="p-1.5 text-text3 text-[11px]">{b.mat_date || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TabLinks({ affiliations }){
  if(!affiliations) return <div className="text-text3 text-xs italic">Связи не собраны. В admin → 🔗 ЕГРЮЛ-связи.</div>;
  const founders = affiliations.founders || [];
  const management = affiliations.management || [];
  const children = affiliations.children || [];
  const succession = affiliations.succession || [];
  return (
    <div className="space-y-3">
      <Section title={`Учредители (${founders.length})`}>
        {founders.length === 0
          ? <div className="text-text3 italic text-[11px]">Пусто. У ПАО учредителей в ЕГРЮЛ может не быть (акционеры в реестре).</div>
          : founders.map((f, i) => (
              <LinkRow key={i} name={f.parent_name} inn={f.parent_inn} kind={f.parent_kind} share={f.share_pct} />
            ))}
      </Section>
      <Section title={`Руководство (${management.length})`}>
        {management.map((m, i) => (
          <LinkRow key={i} name={m.parent_name} inn={m.parent_inn} kind={m.parent_kind} />
        ))}
      </Section>
      {succession.length > 0 && (
        <Section title={`Реорганизации (${succession.length})`}>
          {succession.map((s, i) => (
            <LinkRow key={i} name={s.parent_name} inn={s.parent_inn} role={s.role} />
          ))}
        </Section>
      )}
      {children.length > 0 && (
        <Section title={`Дочки (${children.length})`}>
          {children.slice(0, 30).map((c, i) => (
            <LinkRow key={i} name={c.child_name || c.child_inn} inn={c.child_inn} role={c.role} share={c.share_pct} />
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }){
  return (
    <div>
      <div className="text-text3 text-[10px] uppercase tracking-wider mb-1">{title}</div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function LinkRow({ name, inn, kind, role, share }){
  return (
    <div className="flex items-baseline gap-2 text-xs">
      <span className="text-text font-mono truncate">{name || '—'}</span>
      {inn && <span className="text-text3 text-[10px] font-mono">{inn}</span>}
      {kind && <span className="text-text3 text-[10px]">[{kind}]</span>}
      {role && role !== 'founder' && <span className="text-text3 text-[10px]">{role}</span>}
      {share != null && <span className="text-acc text-[10px] ml-auto">{share}%</span>}
    </div>
  );
}

function TabEvents({ card }){
  return <div className="text-text3 text-xs italic">События — следующий коммит (TRACK C: e-disclosure / RSS / Cerebras).</div>;
}

// ───── Форматтеры ──────────────────────────────────────────────────
function fmtBn(v){
  if(v == null || !isFinite(v)) return '—';
  if(Math.abs(v) >= 1000) return (v / 1000).toFixed(1) + ' трлн';
  if(Math.abs(v) >= 1)    return v.toFixed(1) + ' млрд';
  return (v * 1000).toFixed(0) + ' млн';
}
function fmtPct(v){
  if(v == null || !isFinite(v)) return '—';
  return v.toFixed(1) + '%';
}
function fmtX(v){
  if(v == null || !isFinite(v)) return '—';
  return v.toFixed(2) + 'x';
}
