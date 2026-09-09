import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Rnd } from 'react-rnd';
import { useWindows } from '../store/windows.js';
import { api } from '../api.js';
import { useIssuers, useIssuersStore } from '../store/issuers.js';
import { suggestIssuers, aliasGet, aliasSet } from '../lib/issuerMatch.js';
import { interpretPeriods } from '../lib/finNarrative.js';
import { useStockUniverse, useMacro } from '../store/marketData.js';
import { MULT_META, computeMultiples, valuationUniverse, cheaperThanPct, findStockForIssuer, issuerMults } from '../lib/valuation.js';
import { computeLinkages } from '../lib/finLinkages.js';
import { driversFor } from '../lib/industryDrivers.js';
import { computeMScore, MSCORE_FIELDS, extraGet, extraSetField } from '../lib/mscore.js';
import { buildWatch, annualTrends } from '../lib/autoWatch.js';

// Слой плавающих окон. Рендерится один раз в App.jsx поверх Outlet.
// Каркас окна + живой контент в MediumBody (вкладки Финансы/Бумаги/
// Связи/События). Данные тащатся через api.js при открытии окна;
// клиентский кеш — в localStorage через issuerCache (issuerCard,
// issuerReports, issuerAffiliations отдельно).

export default function WindowLayer(){
  const windows = useWindows(s => s.windows);
  const clampToViewport = useWindows(s => s.clampToViewport);

  // Возвращаем окна в кадр при загрузке и при ресайзе окна браузера —
  // чтобы шапка не оставалась вне видимой области и её всегда можно было
  // схватить (восстановление «застрявших» окон).
  useEffect(() => {
    clampToViewport();
    const onResize = () => clampToViewport();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clampToViewport]);

  return (
    <div className="pointer-events-none fixed inset-0 z-30">
      {windows.map(w => <FloatingWindow key={w.wid} win={w} />)}
    </div>
  );
}

function FloatingWindow({ win }){
  const { close, duplicate, focus, setMode, setTab, patch } = useWindows.getState();
  const navigate = useNavigate();
  const isMicro = win.mode === 'micro';
  const isFull  = win.mode === 'full';
  // «перейти в Долг» по этой бумаге/эмитенту (тикер → имя → ISIN/id)
  const goDebt = () => navigate('/debt?q=' + encodeURIComponent(win.ticker || win.title || win.id || ''));

  // react-rnd двигает окно через CSS transform (translate). iframe модуля
  // отчётности внутри transform-слоя браузер растрирует в текстуру и на
  // HiDPI/дробном масштабе Windows «мылит» шрифты. Пока окно неподвижно —
  // переносим позицию на top/left и убираем transform: нет transform-слоя →
  // iframe рисуется в нативном разрешении. На время drag/resize возвращаем
  // transform, чтобы react-rnd тащил окно как обычно.
  const rndRef = useRef(null);
  const busyRef = useRef(false);
  const posX = isFull ? 12 : win.x;
  const posY = isFull ? 64 : win.y;
  const nodeEl = () => rndRef.current?.getSelfElement?.() || null;
  // важно: не двигать элемент визуально — react-rnd в onDragStart читает
  // selfRect для offsetFromParent ДО начала перетаскивания. Ставим transform
  // на те же координаты (модель Draggable) и left/top:0, элемент остаётся на
  // месте → offset считается верно, окно не прыгает.
  const toTransformMode = () => { const n = nodeEl(); if(n){ n.style.left = '0px'; n.style.top = '0px'; n.style.transform = `translate(${posX}px, ${posY}px)`; } };
  const toCrispMode = () => { const n = nodeEl(); if(n){ n.style.transform = 'none'; n.style.left = posX + 'px'; n.style.top = posY + 'px'; } };
  useLayoutEffect(() => { if(!busyRef.current) toCrispMode(); });

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
        // на старте — режим transform (react-rnd тащит), на стопе только
        // сбрасываем флаг и коммитим позицию: useLayoutEffect после ре-рендера
        // вернёт top/left уже со свежими координатами (crisp).
        onDragStart: () => { busyRef.current = true; toTransformMode(); },
        onDragStop: (_, d) => { busyRef.current = false; patch(win.wid, { x: d.x, y: d.y }); },
        onResizeStart: () => { busyRef.current = true; toTransformMode(); },
        onResizeStop: (_, __, ref, ___, pos) => {
          busyRef.current = false;
          patch(win.wid, { w: parseInt(ref.style.width, 10), h: parseInt(ref.style.height, 10), x: pos.x, y: pos.y }); } };

  return (
    <Rnd
      ref={rndRef}
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
            <HeaderBtn title="Долговая нагрузка (перейти в «Долг»)" onClick={goDebt}>⚖</HeaderBtn>
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
  { id: 'report',   label: 'Отчётность' },
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
      <div className={win.tab === 'report'
        ? 'flex-1 min-h-0 flex flex-col'
        : 'flex-1 overflow-y-auto p-4 text-text2 text-sm'}>
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
    // Отчёты берём из локального снимка (reports-cache) — backend/D1 в лимите.
    // card/affiliations пробуем с backend best-effort (обычно пусто → null).
    const snap = fetch('/reports-cache/' + inn + '.json')
      .then(r => r.ok ? r.json() : null)
      .then(d => Array.isArray(d?.data) ? d.data : [])
      .catch(() => []);
    Promise.allSettled([
      snap,
      api.issuerCard(inn).catch(() => null),
      api.issuerReports(inn).catch(() => null),
      api.issuerAffiliations(inn).catch(() => null),
    ]).then(([snapR, cardR, repR, affR]) => {
      if(cancelled) return;
      const card = cardR.status === 'fulfilled' ? cardR.value : null;
      const snapRows = snapR.status === 'fulfilled' ? (snapR.value || []) : [];
      const beRows = repR.status === 'fulfilled' ? (repR.value?.data || []) : [];
      // приоритет — снимок; если пуст, берём backend
      const reports = snapRows.length ? snapRows : beRows;
      const affiliations = affR.status === 'fulfilled' ? affR.value : null;
      const err = !card && !reports?.length && !affiliations ? 'no-data' : null;
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
  const allIssuers = useIssuers();
  const source = useIssuersStore(s => s.source);
  const patch = useWindows(s => s.patch);

  // Универсум отчётных эмитентов готов (не мок).
  const universeReady = source !== 'mock' && allIssuers.length > 0;
  const knownInns = useMemo(
    () => new Set(allIssuers.filter(i => i.inn).map(i => String(i.inn))),
    [allIssuers]
  );

  const rawInn = win.inn || (typeof win.id === 'string' && /^\d{10,12}$/.test(win.id) ? win.id : null);
  const aliasList = aliasGet(win.title);   // массив {inn,name} или null
  // Активный ИНН: явный win.inn (переключение чипами), иначе первая связка,
  // иначе rawInn если он среди отчётных.
  let resolvedInn = null;
  if(win.inn && (!universeReady || knownInns.has(String(win.inn)))) resolvedInn = String(win.inn);
  else if(aliasList?.length) resolvedInn = String(aliasList[0].inn);
  else if(rawInn && (!universeReady || knownInns.has(String(rawInn)))) resolvedInn = String(rawInn);

  const { loading, error, card, reports, affiliations } = useIssuerData(resolvedInn);

  // Модуль отчётности (шкалы) читает данные из общего localStorage — не ждём backend.
  if(win.tab === 'report'){
    if(resolvedInn) return (
      <ReportWithLinks inn={resolvedInn} name={win.title} links={aliasList}
        onSwitch={(i) => patch(win.wid, { inn: String(i) })} />
    );
    // ИНН не сопоставлен с отчётностью — предлагаем подобрать по названию.
    return (
      <IssuerMatcher
        name={win.title} rawInn={rawInn} issuers={allIssuers}
        onPick={(list) => {
          const arr = (Array.isArray(list) ? list : [list]).map(x => ({ inn: String(x.inn), name: x.name || '' }));
          if(!arr.length) return;
          aliasSet(win.title, arr);
          patch(win.wid, { inn: arr[0].inn, tab: 'report' });
        }}
      />
    );
  }

  if(!resolvedInn){
    return <div className="text-text3 text-xs italic">У этого эмитента нет ИНН с отчётностью. Откройте вкладку «Отчётность» — там можно подобрать компанию по названию.</div>;
  }
  if(loading) return <div className="text-text3 text-xs">Загружаю данные…</div>;
  if(error === 'no-data') return <div className="text-text3 text-xs italic">По ИНН {resolvedInn} в БД пока ничего нет. Запустите сбор отчётности из admin-панели.</div>;

  const issCard = allIssuers.find(i => String(i.inn) === String(resolvedInn));
  const industry = issCard?.industry || null;

  switch(win.tab){
    case 'finances':  return <TabFinances card={card} reports={reports} industry={industry} inn={resolvedInn} issuerName={issCard?.name || win.title} />;
    case 'papers':    return <TabPapers card={card} />;
    case 'links':     return <TabLinks affiliations={affiliations} />;
    case 'events':    return <TabEvents card={card} />;
    default:          return <TabFinances card={card} reports={reports} />;
  }
}

// Отчётность + чипы переключения между связанными компаниями (если их >1).
function ReportWithLinks({ inn, name, links, onSwitch }){
  const list = Array.isArray(links) ? links.filter(l => l.inn) : [];
  return (
    <>
      {list.length > 1 && (
        <div className="flex items-center gap-1 flex-wrap px-2 py-1.5 border-b border-border bg-bg2" data-no-drag onMouseDown={e => e.stopPropagation()}>
          <span className="text-text3 text-[10px] uppercase tracking-wider mr-1">связаны:</span>
          {list.map(l => {
            const active = String(l.inn) === String(inn);
            return (
              <button key={l.inn} type="button" onClick={() => onSwitch(l.inn)}
                title={l.name ? `${l.name} · ИНН ${l.inn}` : `ИНН ${l.inn}`}
                className={`px-2 py-0.5 rounded text-[10px] font-mono border ${active ? 'bg-acc-dim text-acc border-acc/40' : 'bg-s2 text-text2 border-border hover:text-text'}`}>
                {l.name ? l.name.slice(0, 18) : l.inn}
              </button>
            );
          })}
        </div>
      )}
      <TabReportModule inn={inn} name={name} />
    </>
  );
}

// Встроенный модуль отчётности (analysiscompany.html) в embed-режиме —
// per-issuer финвид со шкалами сравнения. Данные из общего localStorage.
function TabReportModule({ inn, name }){
  return (
    <iframe
      src={`/modules/analysiscompany.html?embed=1&inn=${encodeURIComponent(inn)}${name ? '&name=' + encodeURIComponent(name) : ''}`}
      title="Отчётность эмитента"
      className="w-full"
      style={{ border: 0, display: 'block', flex: 1, minHeight: 360 }}
    />
  );
}

// Подбор материнской компании с отчётностью по названию бумаги/SPV.
// Показываем вероятных кандидатов + ручной поиск. По клику — подтверждаем
// связку (сохраняется), окно тут же открывает отчётность выбранной компании.
function IssuerMatcher({ name, rawInn, issuers, onPick }){
  const [q, setQ] = useState('');
  const [sel, setSel] = useState({});   // inn -> {inn,name}
  const suggestions = useMemo(() => suggestIssuers(name, issuers), [name, issuers]);
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if(!s) return [];
    return issuers
      .filter(i => i.inn && ((i.name || '').toLowerCase().includes(s) || String(i.inn).includes(s)))
      .slice(0, 20);
  }, [q, issuers]);

  const toggle = (it) => setSel(prev => {
    const n = { ...prev };
    if(n[it.inn]) delete n[it.inn]; else n[it.inn] = { inn: String(it.inn), name: it.name || '' };
    return n;
  });
  const selArr = Object.values(sel);
  const revBn = it => (it.mults?.revRaw != null ? Math.round(it.mults.revRaw / 1000) : null);

  const Row = ({ it, score }) => {
    const checked = !!sel[it.inn];
    const rb = revBn(it);
    return (
      <div data-no-drag onMouseDown={e => e.stopPropagation()}
        className={`flex items-center gap-2 px-2 py-1.5 rounded border ${checked ? 'border-acc/50 bg-acc-dim/30' : 'border-transparent hover:bg-acc-dim/20'}`}>
        <input type="checkbox" checked={checked} onChange={() => toggle(it)} className="shrink-0" />
        <button type="button" onClick={() => onPick([{ inn: String(it.inn), name: it.name || '' }])}
          className="flex-1 min-w-0 text-left" title="Выбрать только эту">
          <span className="text-text text-xs truncate block">{it.name}</span>
          <span className="text-text3 text-[10px] font-mono">
            ИНН {it.inn}{it.reportYear ? ` · отчёт ${it.reportYear}` : ''}{rb != null ? ` · выручка ${rb} млрд` : ''}
          </span>
        </button>
        {score != null && <span className="text-[10px] font-mono text-acc shrink-0">{Math.round(score * 100)}%</span>}
      </div>
    );
  };

  return (
    <div className="text-xs space-y-3 p-4 overflow-y-auto flex-1 min-h-0" data-no-drag onMouseDown={e => e.stopPropagation()}>
      <div className="text-text2">
        У «<span className="text-text">{name}</span>» {rawInn ? <>ИНН <span className="font-mono">{rawInn}</span> без отчётности в снимке.</> : 'нет ИНН.'}{' '}
        Часто отчётность лежит под материнской компанией. Если связанных несколько (группа) — отметьте галочками все, первой станет крупнейшая по выручке. Клик по названию — выбрать только её.
      </div>

      {selArr.length > 0 && (
        <button type="button" data-no-drag onMouseDown={e => e.stopPropagation()}
          onClick={() => {
            // порядок: по убыванию выручки → «главная» первой
            const ranked = selArr.map(s => ({ ...s, rev: issuers.find(i => String(i.inn) === s.inn)?.mults?.revRaw ?? -1 }))
              .sort((a, b) => b.rev - a.rev).map(({ inn, name }) => ({ inn, name }));
            onPick(ranked);
          }}
          className="w-full bg-acc-dim text-acc border border-acc/40 rounded px-2 py-1.5 text-xs hover:bg-acc-dim/70">
          Связать выбранные ({selArr.length})
        </button>
      )}

      {suggestions.length > 0 && (
        <div>
          <div className="text-text3 uppercase tracking-wider text-[10px] mb-1">Вероятные совпадения</div>
          <div className="space-y-0.5">
            {suggestions.map(s => <Row key={s.issuer.inn} it={s.issuer} score={s.score} />)}
          </div>
        </div>
      )}

      <div>
        <div className="text-text3 uppercase tracking-wider text-[10px] mb-1">Найти вручную</div>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="название или ИНН…"
          data-no-drag onMouseDown={e => e.stopPropagation()}
          className="w-full bg-bg2 border border-border rounded px-2 py-1 text-xs text-text" />
        {filtered.length > 0 && (
          <div className="space-y-0.5 mt-1 max-h-52 overflow-y-auto">
            {filtered.map(it => <Row key={it.inn} it={it} />)}
          </div>
        )}
        {q.trim() && !filtered.length && (
          <div className="text-text3 text-[11px] mt-1">Ничего не найдено среди {issuers.length} компаний с отчётностью.</div>
        )}
      </div>
    </div>
  );
}

function TabFinances({ card, reports, industry, inn, issuerName }){
  const issuer = card?.issuer;
  const stock = card?.stock;
  if(!reports?.length){
    return <div className="text-text3 text-xs italic">Отчётность не собрана. В admin → 📊 Отчётность.</div>;
  }
  // Сортируем по году убыванию, берём до 5 лет + досчитываем производные
  // проценты/коэффициенты, если backend/снимок их не отдал (в снимке — только
  // сырые суммы). Все отношения безразмерны, единица (млн/млрд) не важна.
  const series = [...reports]
    .sort((a, b) => (b.fy_year || 0) - (a.fy_year || 0))
    .slice(0, 5)
    .map(withDerived);
  // строки денежного потока показываем только если в данных есть ОДДС
  const hasCF = series.some(s => s.cfo != null || s.fcf != null);
  return (
    <div className="space-y-3">
      <AutoWatch inn={inn} issuerName={issuerName} industry={industry} reports={reports} />
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
              {series.map(r => (
                <th key={r.fy_year} className="text-right p-1.5">
                  {r.fy_year}
                  <div className="text-[9px] text-text3 font-normal normal-case">{normStd(r.std)}</div>
                </th>
              ))}
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
            <MetricRow label="ROIC, %"        series={series} field="roic_pct" fmt={fmtPct} colorize />
            <MetricRow label="ROE, %"         series={series} field="roe_pct"  fmt={fmtPct} colorize />
            <MetricRow label="ROS, %"         series={series} field="ros_pct"  fmt={fmtPct} colorize />
            <MetricRow label="EBITDA-марж, %" series={series} field="ebitda_marg" fmt={fmtPct} />
            <MetricRow label="ND/Eq"          series={series} field="net_debt_eq" fmt={fmtX} />
            {hasCF && <>
              <MetricRow label="CFO (операц.)"  series={series} field="cfo"     fmt={fmtBn} colorize />
              <MetricRow label="CAPEX"          series={series} field="capex"   fmt={fmtBn} />
              <MetricRow label="FCF"            series={series} field="fcf"     fmt={fmtBn} colorize />
              <MetricRow label="CFO/EBITDA, %"  series={series} field="cfoConv" fmt={fmtPct} colorize />
              <MetricRow label="Дивид./FCF, %"  series={series} field="divFcf"  fmt={fmtPct} />
            </>}
          </tbody>
        </table>
      </div>
      <div className="text-text3 text-[10px] leading-snug">
        Значения в млрд ₽. <b className="text-text2">РСБУ</b> — отчётность по российским стандартам (юрлицо), <b className="text-text2">МСФО</b> — международные (группа, консолидировано). ГИР БО/ФНС — это источник данных РСБУ, не отдельный тип.
      </div>

      <ValuationPanel inn={inn} issuerName={issuerName} />
      <MetricLinkages inn={inn} issuerName={issuerName} />
      <MScorePanel reports={reports} inn={inn} />
      <IndustryDrivers industry={industry} year={series[0]?.fy_year} prevYear={series[1]?.fy_year} />
      <PeriodNarrative reports={reports} industry={industry} />
      <AnalysisLenses />
    </div>
  );
}

// «Как читать отчёт» — универсальные линзы/ловушки анализа + мастер-цепочка.
function AnalysisLenses(){
  const lenses = [
    ['Цепочка вопроса к любой цифре', 'Изменение показателя → что его породило → какой показатель скрывается за ним → какой эффект будет через 1–4 квартала. Последние два — самые важные.'],
    ['Качество роста, а не темп выручки', 'Опт/объём: Volume ↑ → Revenue ↑↑, но EBITDA почти не меняется. Высокомаржинальный сегмент (напр. ломбард): Revenue ↑ → прибыль ↑↑. Один темп выручки без разбивки обманчив.'],
    ['OPEX ↓ ≠ эффективность', 'Расходы могут падать вместе с масштабом (закрытие офисов/сегмента), быть разовыми или перенесёнными. Всегда рядом: OPEX + выручка + объёмы/активность.'],
    ['Прибыль ≠ деньги', 'Net income → +неденежные − Δоборотный капитал − CAPEX = FCF, и только потом дивиденды/buyback. Выплаты могут превышать прибыль — значит финансируются долгом/резервами.'],
    ['Бумажная переоценка переворачивает квартал', 'У банков и особенно страховых переоценка ценных бумаг попадает в результат. Отделяй операционный результат от рыночной переоценки — иначе «прибыль упала» ≠ «бизнес ухудшился».'],
    ['Рост ≠ всегда хорошо (банки)', 'Доп. кредитный портфель → сколько капитала съел → сколько NII принёс → сколько резервов потребовал → какой ROE. Иногда отказ от роста ради капитала — разумно (или вынужденно).'],
    ['EBITDA — это bridge, а не цифра', 'Изменение EBITDA раскладывай: цена / объём / FX / себестоимость / разовые статьи / микс. Важна декомпозиция, а не сам итог.'],
    ['YoY · QoQ · YTD — три разреза', 'YoY — структурно/сезонно (к той же точке прошлого года). QoQ — динамика прямо сейчас. YTD/полугодие — контроль, не выброс ли удачный квартал.'],
    ['Выручка ≠ прибыль (микс)', 'Выручка может расти, а прибыль падать: низкомаржинальный сегмент даёт большую часть выручки и малую часть прибыли. Смотри на структуру, а не только на верхнюю строку.'],
    ['CAPEX — минус сегодня, плюс завтра', 'Инвестиции ухудшают текущий FCF, но создают будущие мощности → выручку/прибыль позже (лаг от года до нескольких). Отделяй CAPEX роста от поддерживающего.'],
    ['M&A: не суди по первому году', 'Покупка бизнеса сначала ухудшает показатели (интеграция, расходы), синергия приходит через 1–4+ кв. Оценивай сделку не по первому отчёту.'],
    ['Цена ↓ → загрузка ↑ → износ ↑', 'Снижение цены поднимает загрузку/спрос, но ускоряет износ активов → будущие расходы на ремонт/замену (хорошо видно на каршеринге/парке техники).'],
    ['Долг → рейтинг → фондирование', 'Ухудшение метрик снижает рейтинг → дороже и сложнее занимать → ещё больше долг. Возможна негативная петля — следи за ICR и стоимостью долга вместе.'],
    ['Non-cash: 4 вопроса к упавшей прибыли', 'Прибыль рухнула при живой EBITDA → это списание/переоценка/деконсолидация? Спроси: (1) cash или non-cash? (2) разовое или повторится? (3) операционное или бумажное? (4) как выглядит FCF/CFO? Часто «убыток» — бухгалтерский, а деньги пришли.'],
    ['Отложенный налог / release оборотки', 'Мечел-эффект: отложенный налог и высвобождение оборотного капитала могут дать прибыль/деньги, которых нет в операционке. Лукойл-эффект: WC release разово надувает FCF. Смотри устойчивую часть, а не разовый приток.'],
    ['Рынок труда → маржа ритейла', 'Лента/X5: дефицит кадров и рост зарплат бьёт по марже сильнее, чем видно в выручке. Операционный рычаг работает в обе стороны — при низкой марже даже небольшой рост costs съедает прибыль непропорционально.'],
    ['МФО: падение выдач = качество, не слабость', 'Займер: снижение выдач может означать ужесточение скоринга (качество портфеля ↑), а не потерю рынка. Регулирование → консолидация: слабые уходят, сильные забирают долю. Смотри одобряемость и CoR, а не только объём.'],
    ['Качество CAPEX: 4 вида', 'Полюс-логика: поддерживающий (держит мощности) · роста (новые мощности) · стратегический/соц. (лицензия на работу — дороги, посёлки, экология) · «плохой» (не даёт отдачи). FCF-на-рубль-CAPEX и загрузка новых мощностей важнее суммы CAPEX.'],
    ['Соц. расходы = условие производства', 'У добытчиков (Полюс) социальные/инфраструктурные траты — не благотворительность, а условие доступа к ресурсу. Их урезание сегодня = риск для лицензии/производства завтра. Не путай с чистой неэффективностью.'],
    ['Операционный рычаг / низкая капиталоёмкость', 'OnlyFans-тип: мало активов, почти нет CAPEX → каждый рубль выручки почти весь идёт в прибыль, но и падение выручки бьёт мгновенно. Высокий ROIC при малом капитале — норма для модели, а не подвиг.'],
    ['IPO/допэмиссия: на что деньги', 'Финансирование первичное (деньги в компанию, на рост/долг) ≠ вторичное (продажа доли старыми акционерами, компания денег не получает). Cash-in разбавляет, но развивает; cash-out — сигнал о выходе. Смотри, куда пойдут средства.'],
    ['ЦБ: важна траектория, а не сам уровень', 'Рынок закладывает не текущую ставку, а её ожидаемый путь. Снижение при ожидании ещё большего снижения — уже в цене. Дифференциал ставок и риторика ЦБ двигают FX/облигации раньше, чем сам факт решения. Смотри forward, а не spot.'],
    ['Банк: снижение ставки ≠ автоматом хорошо', 'Дешевеет фондирование, но и новые кредиты. Если активы репрайсятся быстрее пассивов, а часть пассивов уже почти бесплатна (текущие счета — дешеветь некуда), NIM сжимается: маржа 5%→1%. Смотри асимметрию репрайсинга и долю бесплатных пассивов.'],
    ['Портфель ≠ выдачи', 'Портфель = старый + выдачи − погашения − списания. Выдачи могут расти (НБКИ), а баланс банка — падать, если старые кредиты гасятся быстрее новых. «Выдачи ↑ и портфель ↓» — не противоречие. Не путай поток выдач с нетто-остатком.'],
    ['Секьюритизация высвобождает капитал', 'Выдал → упаковал → продал инвесторам → высвободил капитал/ликвидность → снова выдаёт. Нагрузка на капитал ↓, capacity to lend ↑. Но качество и структура проданного портфеля критичны — иначе стимул к чрезмерному кредитованию.'],
    ['Ценность клиента зависит от регулятора', 'Один и тот же заёмщик при росте risk-weight / макропруденциальной надбавки требует больше капитала → его экономика для банка ухудшается без изменения его поведения. Сегодня выгоден, завтра — нет, из-за смены режима, а не клиента.'],
    ['Эффект масштаба банка (cost/income)', 'Крупный банк при замедлении роста может держать прибыль лучше мелкого: масштаб позволяет отдельные команды IT/риск/UX/аналитики и оптимизацию расходов → cost/income ↓. Рост бизнеса ↓, но эффективность ↑.'],
    ['Маркетплейс vs банк — петля данных', 'У маркетплейса: транзакций много → данных много → финпродукт продавать проще → LTV ↑ → инвестиции в экосистему → клиентов ещё больше. У банка при малой базе обратная петля: cross-sell хуже → CAC ↑ → маржа ↓ → капитал ограничен → агрессивность ↓. Конкуренция: кредитка vs рассрочка vs BNPL vs маркетплейс.'],
  ];
  return (
    <details className="mt-3 border-t border-border/60 pt-3">
      <summary className="cursor-pointer text-text3 text-[10px] uppercase tracking-wider">Как читать отчёт · ловушки</summary>
      <ul className="mt-2 space-y-1.5">
        {lenses.map(([t, d], i) => (
          <li key={i}>
            <div className="text-text text-xs">{t}</div>
            <div className="text-text3 text-[11px] leading-snug">{d}</div>
          </li>
        ))}
      </ul>
      <div className="mt-2 text-text3 text-[10px] uppercase tracking-wider">Карта причин</div>
      <pre className="mt-1 text-[10.5px] leading-snug text-text2 font-mono whitespace-pre overflow-x-auto">{
`внешняя среда  (ставки · спрос · цены · курс · рейтинг)
      ↓
решения компании ──┬── PRICE ─────────► Revenue
                   ├── MIX ───────────► Revenue → Profit (качество роста)
                   └── CAPEX ─► FCF −сейчас ─► мощности ─► Revenue +потом
      ↓
Revenue → EBITDA → Cash Flow → FCF → Debt / Dividend → стоимость
      ↑                     (фин. статьи · переоценки · резервы)
ветка риска: баланс → долг → валюта долга → ставка → фин. расходы → риск`
      }</pre>
      <div className="mt-1.5 text-text3 text-[10px] uppercase tracking-wider">Лаги</div>
      <div className="text-text3 text-[11px] leading-snug">
        операц. решение → P&L: 0–1 кв. · CAPEX → мощности: кварталы/годы · долг → проценты/рефинанс: 1–4 кв. · M&A → синергия: 1–4+ кв. · износ → расходы: несколько кв. · рейтинг → стоимость долга/дефолт: постепенная петля.
      </div>
    </details>
  );
}

// Связки метрик: ROE↔ROIC, DuPont, ROIC↔E/P.
function MetricLinkages({ inn, issuerName }){
  const stockUniverse = useStockUniverse();
  const allIssuers = useIssuers();
  const links = useMemo(() => {
    const m = issuerMults(inn);
    if(!m) return [];
    const stock = findStockForIssuer(issuerName, inn);
    const ep = stock ? computeMultiples(stock.price, stock.shares, m, stock.div12m)?.ep : null;
    return computeLinkages(m, ep);
  }, [inn, issuerName, stockUniverse, allIssuers]);
  if(!links.length) return null;
  const dot = { red: 'bg-danger', yellow: 'bg-warn', green: 'bg-green' };
  return (
    <div className="mt-3 border-t border-border/60 pt-3 space-y-2">
      <div className="text-text3 text-[10px] uppercase tracking-wider">Связки метрик</div>
      <ul className="space-y-1.5">
        {links.map((l, i) => (
          <li key={i} className="flex gap-2">
            <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${dot[l.level] || 'bg-text3'}`} />
            <div className="min-w-0">
              <div className="text-text text-xs">{l.title}</div>
              <div className="text-text3 text-[11px] leading-snug">{l.text}</div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// «Макро за период» — что было с курсами/Brent/ставкой в год отчёта vs пред.
function MacroBlock({ macro, year, prevYear }){
  if(!macro || !year || !prevYear) return null;
  const Y = String(year), P = String(prevYear);
  const rows = [
    { key: 'usd', label: '₽/$', kind: 'pct' },
    { key: 'cny', label: '₽/¥', kind: 'pct' },
    { key: 'brent', label: 'Brent', kind: 'pct', suf: ' $/бр' },
    { key: 'rate', label: 'Ставка ЦБ', kind: 'pp', suf: '%' },
  ].map(r => {
    const c = macro[r.key]?.[Y], p = macro[r.key]?.[P];
    if(c == null || p == null) return null;
    const chg = r.kind === 'pct' ? (c - p) / Math.abs(p) * 100 : (c - p);
    return { ...r, c, p, chg };
  }).filter(Boolean);
  if(!rows.length) return null;
  return (
    <div className="bg-s2/30 border border-border/60 rounded px-2 py-1.5 space-y-1">
      <div className="text-text3 text-[10px]">Макро за период {P} → {Y}</div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {rows.map(r => {
          const up = r.chg >= 0;
          const tone = r.key === 'rate'
            ? (up ? 'text-warn' : 'text-green')       // рост ставки — минус для бизнеса
            : (up ? 'text-green' : 'text-danger');    // рост курса/нефти — плюс экспортёру
          const val = r.kind === 'pct'
            ? `${up ? '+' : ''}${r.chg.toFixed(0)}%`
            : `${up ? '+' : ''}${r.chg.toFixed(1)} пп`;
          return (
            <span key={r.key} className="text-[11px] font-mono">
              <span className="text-text2">{r.label}</span>{' '}
              <span className="text-text">{r.kind === 'pct' ? r.c.toFixed(r.key === 'brent' ? 1 : 2) : r.c.toFixed(1)}{r.suf || ''}</span>{' '}
              <span className={tone}>{val}</span>
            </span>
          );
        })}
      </div>
      <div className="text-text3 text-[9px] italic">Контекст к цепочкам, не раскладка прибыли. Brent — индикативно (фьючерсы), Urals не биржевой.</div>
    </div>
  );
}

// Beneish M-score — индикативный, с возможностью дозаполнить недостающие данные.
const _ANN_MS = new Set(['FY', 'ГОД', 'ГОД', 'YEAR', 'ANNUAL', '12M', 'Y']);
function MScorePanel({ reports, inn }){
  const [ver, setVer] = useState(0);   // форс-ререндер после ввода
  const [open, setOpen] = useState(false);
  const data = useMemo(() => {
    if(!Array.isArray(reports)) return null;
    const ann = reports.filter(r => { const p = String(r.period || '').trim(); return !p || _ANN_MS.has(p.toUpperCase()) || /год|annual|fy/i.test(p); })
      .sort((a, b) => (b.fy_year || 0) - (a.fy_year || 0));
    const src = ann.length >= 2 ? ann : [...reports].sort((a, b) => (b.fy_year || 0) - (a.fy_year || 0));
    if(src.length < 2) return null;
    const cur = src[0], prev = src[1];
    const ex = extraGet(inn);
    const m = computeMScore(cur, prev, ex[String(cur.fy_year)], ex[String(prev.fy_year)]);
    return { cur, prev, m };
  }, [reports, inn, ver]);
  if(!data || !data.m) return null;
  const { cur, prev, m } = data;
  const flag = m.value > -1.78;
  const tone = flag ? 'text-warn' : 'text-green';

  const varRows = [
    ['SGI', 'рост выручки', true], ['LVGI', 'леверидж', true], ['TATA', 'начисления (инд.)', true],
    ['DSRI', 'дебиторка/выручка', m.provided.DSRI], ['GMI', 'валовая маржа', m.provided.GMI],
    ['AQI', 'качество активов', m.provided.AQI], ['DEPI', 'амортизация', m.provided.DEPI],
    ['SGAI', 'SG&A/выручка', m.provided.SGAI],
  ];

  return (
    <div className="mt-3 border-t border-border/60 pt-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-text3 text-[10px] uppercase tracking-wider">M-score (Beneish)</span>
        <span className={`text-sm font-mono ${tone}`}>{m.value.toFixed(2)}</span>
        <span className="text-text3 text-[10px]">{m.full ? 'полный' : 'индикативный'}</span>
      </div>
      <div className={`text-xs ${tone}`}>
        {flag ? 'Выше −1.78 — есть статистические признаки возможных манипуляций с отчётностью. Повод копать глубже, не приговор.'
              : 'Ниже −1.78 — признаков манипуляций по модели нет.'}
      </div>
      {!m.full && (
        <div className="text-text3 text-[11px] leading-snug">
          Считается по {Object.values(m.provided).filter(Boolean).length + 3} из 8 переменных (остальные приняты нейтральными = 1). Дозаполни построчные данные за {prev.fy_year} и {cur.fy_year} — станет полным.
        </div>
      )}

      <details open={open} onToggle={e => setOpen(e.target.open)}>
        <summary className="cursor-pointer text-[11px] text-text2">Переменные и ввод недостающих данных</summary>

        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] font-mono">
          {varRows.map(([k, lbl, ok]) => (
            <span key={k} className={ok ? 'text-text2' : 'text-text3'}>
              {ok ? '✓' : '·'} {k} <span className="text-text3">{m.vars[k] != null ? m.vars[k].toFixed(2) : '—'}</span>
            </span>
          ))}
        </div>

        <div className="mt-2 overflow-x-auto">
          <table className="text-[11px]">
            <thead className="text-text3">
              <tr><th className="text-left p-1">Строка (млн ₽)</th><th className="p-1">{prev.fy_year}</th><th className="p-1">{cur.fy_year}</th></tr>
            </thead>
            <tbody>
              {MSCORE_FIELDS.map(f => (
                <tr key={f.id}>
                  <td className="p-1 text-text2">{f.label}</td>
                  {[prev, cur].map(row => {
                    const ex = extraGet(inn)[String(row.fy_year)] || {};
                    return (
                      <td key={row.fy_year} className="p-1">
                        <input type="number" defaultValue={ex[f.id] ?? ''} placeholder="—"
                          onBlur={e => { extraSetField(inn, row.fy_year, f.id, e.target.value); setVer(v => v + 1); }}
                          className="w-24 bg-bg2 border border-border rounded px-1.5 py-0.5 text-text font-mono" />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="text-text3 text-[10px] italic mt-1">
          Значения в тех же единицах, что и отчёт (млн ₽). Данные сохраняются локально. Источник построчных данных — баланс/ОПУ эмитента (ГИР БО, audit-it, годовой отчёт).
        </div>
      </details>
    </div>
  );
}

// «Что двигает результат» — драйвер-модель отрасли: цепочки + чек-лист + макро.
function IndustryDrivers({ industry, year, prevYear }){
  const d = useMemo(() => driversFor(industry), [industry]);
  const macro = useMacro();
  if(!d) return null;
  return (
    <div className="mt-3 border-t border-border/60 pt-3 space-y-2">
      <div className="text-text3 text-[10px] uppercase tracking-wider">Что двигает результат (отрасль)</div>
      <div className="text-text2 text-[11px] leading-snug">{d.summary}</div>

      <MacroBlock macro={macro} year={year} prevYear={prevYear} />
      <div className="space-y-1">
        {d.chains.map((chain, i) => (
          <div key={i} className="flex items-center flex-wrap gap-1 text-[11px]">
            {chain.map((step, j) => (
              <span key={j} className="flex items-center gap-1">
                <span className={j === chain.length - 1 ? 'text-text font-medium' : 'text-text2'}>{step}</span>
                {j < chain.length - 1 && <span className="text-acc">→</span>}
              </span>
            ))}
          </div>
        ))}
      </div>
      <details>
        <summary className="cursor-pointer text-[11px] text-text2">Чек-лист: что проверить за период</summary>
        <ul className="mt-1 space-y-0.5">
          {d.drivers.map((x, i) => (
            <li key={i} className="text-[11px] text-text3 flex gap-1.5"><span className="text-text3">□</span>{x}</li>
          ))}
        </ul>
        {d.marketWatch && (
          <div className="mt-2">
            <div className="text-[10px] uppercase tracking-wider text-text3">Для маркетплейса/экосистемы</div>
            <ul className="mt-1 space-y-0.5">
              {d.marketWatch.map((x, i) => (
                <li key={i} className="text-[11px] text-text3 flex gap-1.5"><span className="text-text3">□</span>{x}</li>
              ))}
            </ul>
          </div>
        )}
      </details>
      {d.hypotheses && (
        <details>
          <summary className="cursor-pointer text-[11px] text-text2">Гипотезы: если верна → что увидим</summary>
          <div className="mt-1 space-y-1">
            {d.hypotheses.map(([h, p], i) => (
              <div key={i} className="flex items-start gap-1.5 text-[11px] leading-snug">
                <span className="text-text2 flex-1">{h}</span>
                <span className="text-acc shrink-0">→</span>
                <span className="text-text3 flex-1">{p}</span>
              </div>
            ))}
          </div>
        </details>
      )}
      {d.caution && (
        <div className="text-warn text-[11px] leading-snug bg-warn/5 border border-warn/20 rounded px-2 py-1.5">
          ⚠ {d.caution}
        </div>
      )}
    </div>
  );
}

// Авто-плашка «на что смотреть» — контекстные предупреждения по отрасли и
// данным, всплывают сверху карточки без хождения по разделам.
function AutoWatch({ inn, issuerName, industry, reports }){
  const stockUniverse = useStockUniverse();
  const allIssuers = useIssuers();
  const items = useMemo(() => {
    const mults = issuerMults(inn);
    const stock = findStockForIssuer(issuerName, inn);
    const payout = stock ? computeMultiples(stock.price, stock.shares, mults, stock.div12m)?.payout : null;
    const nar = interpretPeriods(reports, industry);
    const opexScaleTrap = !!nar?.flags?.some(f => f.title === 'Расходы упали вместе с масштабом');
    const dyn = annualTrends(reports);
    return buildWatch({ industry, mults, payout, opexScaleTrap, dyn });
  }, [inn, issuerName, industry, reports, stockUniverse, allIssuers]);
  if(!items.length) return null;
  return (
    <div className="space-y-1">
      {items.map((it, i) => (
        <div key={i} className={[
          'text-[11px] leading-snug rounded px-2 py-1.5 border',
          it.level === 'warn' ? 'text-warn bg-warn/5 border-warn/25' : 'text-text3 bg-s2/30 border-border/60',
        ].join(' ')}>
          {it.level === 'warn' ? '⚠ ' : 'ⓘ '}{it.text}
        </div>
      ))}
    </div>
  );
}

// Мультипликаторы оценки для торгуемой акции эмитента + «дешевле X% рынка» и подвохи.
function ValuationPanel({ inn, issuerName }){
  const stockUniverse = useStockUniverse();   // триггерим загрузку + ре-рендер
  const allIssuers = useIssuers();
  const data = useMemo(() => {
    const stock = findStockForIssuer(issuerName, inn);
    if(!stock) return null;
    const m = issuerMults(inn);
    if(!m) return null;
    const mm = computeMultiples(stock.price, stock.shares, m, stock.div12m);
    if(!mm) return null;
    const uni = valuationUniverse();
    return { stock, mm, uni };
  }, [inn, issuerName, stockUniverse, allIssuers]);

  if(!data) return null;
  const { mm, uni } = data;
  const fmt = v => v == null ? '—' : (Math.round(v * 100) / 100).toString() + '×';
  return (
    <div className="mt-3 border-t border-border/60 pt-3 space-y-2">
      <div className="text-text3 text-[10px] uppercase tracking-wider">
        Оценка · кап-ция {mm.mktCapBn >= 1000 ? (mm.mktCapBn / 1000).toFixed(1) + ' трлн' : mm.mktCapBn.toFixed(0) + ' млрд ₽'}
      </div>
      <div className="space-y-1.5">
        {MULT_META.map(meta => {
          const v = mm[meta.id];
          const isEp = meta.id === 'ep' || meta.id === 'divYield';
          const pct = cheaperThanPct(v, uni.arrays[meta.id], meta.lowerCheaper);
          return (
            <details key={meta.id} className="group">
              <summary className="cursor-pointer flex items-center gap-2 text-xs">
                <span className="text-text2 w-24 shrink-0">{meta.label}</span>
                <span className="text-text font-mono w-16 shrink-0">{isEp ? (v == null ? '—' : v.toFixed(1) + '%') : fmt(v)}</span>
                {pct != null && (
                  <span className="flex-1 flex items-center gap-1.5 min-w-0">
                    <span className="flex-1 h-1.5 rounded bg-s2 overflow-hidden">
                      <span className="block h-full bg-acc" style={{ width: pct + '%' }} />
                    </span>
                    <span className="text-text3 text-[10px] shrink-0">{meta.lowerCheaper ? 'дешевле' : 'доходнее'} {pct}%</span>
                  </span>
                )}
              </summary>
              <div className="text-text3 text-[11px] leading-snug mt-1 ml-24 pl-2">{meta.pitfall}</div>
            </details>
          );
        })}
      </div>
      {mm.payout != null && (
        <div className="text-[11px] flex items-start gap-2 pt-1">
          <span className="text-text2 w-24 shrink-0">Payout</span>
          <span className="text-text font-mono w-16 shrink-0">{Math.round(mm.payout)}%</span>
          <span className="text-text3 leading-snug">
            доля прибыли на дивиденды.{' '}
            {mm.payout > 100 ? 'Платят больше, чем зарабатывают — из долга/резервов, неустойчиво.'
              : mm.payout >= 50 ? 'Щедро распределяют прибыль — меньше остаётся на рост.'
              : mm.payout > 0 ? 'Умеренная выплата, есть запас на реинвест.'
              : 'Дивиденды не платят — вся прибыль в бизнес.'}
          </span>
        </div>
      )}
      <div className="text-text3 text-[10px] italic">«дешевле X%» — доля торгуемых акций с отчётностью, которые оценены дороже (для див. доходности — доходнее) по этому показателю.</div>
    </div>
  );
}

// «Что изменилось» — разбор динамики последнего года к предыдущему + F-score.
function PeriodNarrative({ reports, industry }){
  const nar = useMemo(() => interpretPeriods(reports, industry), [reports, industry]);
  if(!nar) return null;
  const dot = { red: 'bg-danger', yellow: 'bg-warn', green: 'bg-green' };
  const vtone = { red: 'text-danger', yellow: 'text-warn', green: 'text-green' };
  const fs = nar.fscore;
  const fsTone = fs.value >= 7 ? 'text-green' : fs.value <= 3 ? 'text-danger' : 'text-warn';
  return (
    <div className="mt-3 border-t border-border/60 pt-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-text3 text-[10px] uppercase tracking-wider">Что изменилось</span>
        <span className="text-text2 text-[11px] font-mono">{nar.prevYear} → {nar.year}{nar.std ? ` · ${normStd(nar.std)}` : ''}</span>
      </div>
      <div className={`text-xs ${vtone[nar.verdict.level]}`}>{nar.verdict.text}</div>

      {nar.industry && (
        <div className="text-text3 text-[11px] leading-snug bg-s2/30 border border-border/60 rounded px-2 py-1.5">
          <span className="text-text2">Особенности отрасли:</span> {nar.industry.text}
        </div>
      )}

      <ul className="space-y-1.5">
        {nar.flags.map((f, i) => (
          <li key={i} className="flex gap-2">
            <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${dot[f.level]}`} />
            <div className="min-w-0">
              <div className="text-text text-xs">{f.title}</div>
              <div className="text-text3 text-[11px] leading-snug">{f.text}</div>
            </div>
          </li>
        ))}
      </ul>

      {/* Piotroski F-score — раскладка сигналов */}
      <details className="mt-1">
        <summary className="cursor-pointer text-[11px] text-text2">
          Piotroski F-score: <span className={fsTone}>{fs.value}/{fs.max}</span> — из чего сложился
        </summary>
        <ul className="mt-1.5 space-y-0.5">
          {fs.signals.map((s, i) => (
            <li key={i} className="text-[11px] flex gap-1.5">
              <span className={s.ok ? 'text-green' : 'text-text3'}>{s.ok ? '✓' : '·'}</span>
              <span className={s.ok ? 'text-text2' : 'text-text3'}>{s.label}</span>
            </li>
          ))}
        </ul>
        <div className="text-text3 text-[10px] mt-1 italic">
          Адаптирован (8 из 9): эмиссию акций не проверяем; денежный поток оценён как ЧП + амортизация. 7–8 — сильный, 0–3 — слабый.
        </div>
      </details>
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

// Достраивает строку отчёта: производные %/коэффициенты (если их нет) и
// перевод сумм млн→млрд (снимок хранит млн, а fmtBn ждёт млрд).
function withDerived(r){
  const num = v => (v == null || v === '' || isNaN(Number(v))) ? null : Number(v);
  const rev = num(r.rev), np = num(r.np), ebitda = num(r.ebitda), assets = num(r.assets),
        debt = num(r.debt), cash = num(r.cash), eq = num(r.eq);
  const ebit = num(r.ebit), tax = num(r.tax_exp);
  const roa_pct      = r.roa_pct      != null ? num(r.roa_pct)      : (assets ? np / assets * 100 : null);
  const ros_pct      = r.ros_pct      != null ? num(r.ros_pct)      : (rev ? np / rev * 100 : null);
  const ebitda_marg  = r.ebitda_marg  != null ? num(r.ebitda_marg)  : (rev ? ebitda / rev * 100 : null);
  const net_debt_eq  = r.net_debt_eq  != null ? num(r.net_debt_eq)  : (eq ? ((debt || 0) - (cash || 0)) / eq : null);
  const roe_pct      = r.roe_pct      != null ? num(r.roe_pct)      : (eq && eq > 0 ? np / eq * 100 : null);
  // ROIC = EBIT·(1−эфф.налог) / (капитал+долг−деньги)
  let roic_pct = num(r.roic_pct);
  if(roic_pct == null && ebit != null){
    const ic = (eq || 0) + (debt || 0) - (cash || 0);
    if(ic > 0){
      let t = 0.2;
      if(tax != null && np != null && (np + tax) > 0) t = Math.min(0.5, Math.max(0, tax / (np + tax)));
      roic_pct = ebit * (1 - t) / ic * 100;
    }
  }
  // денежный поток (короткие ключи reportsDB / возможные ключи снимка)
  const cfo = num(r.cfo) ?? num(r.cfo_ops), capex = num(r.capex), divp = num(r.divp) ?? num(r.div_paid);
  const fcf = (cfo != null && capex != null) ? cfo - capex : null;
  const cfoConv = (cfo != null && ebitda) ? cfo / ebitda * 100 : null;
  const divFcf  = (divp != null && fcf != null && fcf > 0) ? divp / fcf * 100 : null;
  const bn = v => v == null ? null : v / 1000;   // млн → млрд
  return {
    ...r,
    rev: bn(rev), ebit: bn(num(r.ebit)), np: bn(np), ebitda: bn(ebitda),
    assets: bn(assets), eq: bn(eq), debt: bn(debt), cash: bn(cash),
    roa_pct, ros_pct, roic_pct, roe_pct, ebitda_marg, net_debt_eq,
    cfo: bn(cfo), capex: bn(capex), fcf: bn(fcf), cfoConv, divFcf,
  };
}

// Тип отчётности: только РСБУ/МСФО. ГИР БО — источник, не стандарт.
function normStd(s){ return /МСФО|IFRS/i.test(String(s || '')) ? 'МСФО' : 'РСБУ'; }

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
