import { useEffect, useMemo, useState } from 'react';
import { Star, RefreshCw, Download, Clock, Filter as FilterIcon, Copy, Check } from 'lucide-react';
import Card from '../components/ui/Card.jsx';
import Badge from '../components/ui/Badge.jsx';
import Button from '../components/ui/Button.jsx';
import Filters from '../components/bonds/Filters.jsx';
import { DEFAULT_FILTERS, applyFilters } from '../components/bonds/applyFilters.js';
import { BOND_TYPES, safetyScore, bqiScore } from '../data/bondsCatalog.js';
import { normalizeBond } from '../data/normalizeBond.js';
import { INDUSTRIES } from '../data/industries.js';
import { useFavorites } from '../store/favorites.js';
import { useRecent } from '../store/recent.js';
import { useWindows } from '../store/windows.js';
import { api } from '../api.js';

// Страница «Облигации». Большой фильтр в две вкладки (Бумага/Эмитент)
// + таблица с цветовой индикацией YTM, бейджами рейтинга и кнопкой
// добавления эмитента в избранное. Клик по имени эмитента открывает
// плавающее окно (через useWindows). Внутри страницы три вкладки:
// Список / Избранное-просмотр-результата / Последние просмотренные.
//
// Данные тащатся из бэкенда через api.bondLatest(limit=2000). Кешируем
// в localStorage 5 минут чтобы не дёргать каждый рендер.

const TYPE_LABEL = Object.fromEntries(BOND_TYPES.map(t => [t.id, t.label]));
const CACHE_KEY = 'bonds_latest_v1';
const CACHE_TTL = 5 * 60 * 1000; // 5 минут

function loadCached(){
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if(!raw) return null;
    const { at, data } = JSON.parse(raw);
    if(Date.now() - at > CACHE_TTL) return null;
    return data;
  } catch(_){ return null; }
}
function saveCache(data){
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), data })); } catch(_){}
}

export default function Bonds(){
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [tab, setTab] = useState('list');         // list | favs | recent
  const [bonds, setBonds] = useState(() => loadCached() || []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);

  const fetchBonds = async (force = false) => {
    if(!force){
      const cached = loadCached();
      if(cached?.length){ setBonds(cached); return; }
    }
    setLoading(true);
    setError(null);
    try {
      const r = await api.bondLatest({ limit: 2000 });
      const norm = (r.data || []).map(normalizeBond);
      setBonds(norm);
      saveCache(norm);
      setUpdatedAt(new Date().toISOString());
    } catch(e){
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchBonds(false); /* eslint-disable-line */ }, []);

  const patch = (p) => setFilters(p == null ? DEFAULT_FILTERS : { ...filters, ...p });
  const filtered = useMemo(() => applyFilters(bonds, filters), [bonds, filters]);

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Облигации</h1>
          <p className="text-text2 text-sm mt-1">
            {loading && 'Загружаю свежий снимок MOEX…'}
            {error && (
              <span className="text-danger">Ошибка: {error}. Используется кеш {bonds.length ? `(${bonds.length} бумаг)` : ''}.</span>
            )}
            {!loading && !error && bonds.length > 0 && (
              <>В базе {bonds.length.toLocaleString('ru')} бумаг с MOEX. Фильтры работают на клиенте.{updatedAt && <> Обновлено {new Date(updatedAt).toLocaleTimeString('ru')}.</>}</>
            )}
            {!loading && !error && bonds.length === 0 && (
              <>Нет данных — backend не вернул результата. Попробуй обновить.</>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" icon={RefreshCw} onClick={() => fetchBonds(true)} disabled={loading}>
            {loading ? 'Загрузка…' : 'Обновить'}
          </Button>
          <Button variant="outline" size="sm" icon={Download} onClick={() => exportCsv(filtered)}>CSV</Button>
        </div>
      </div>

      <Filters value={filters} onPatch={patch} />

      <div className="flex border-b border-border">
        <ResultTab id="list"   icon={FilterIcon} label="Список" count={filtered.length} active={tab} onClick={setTab} />
        <ResultTab id="favs"   icon={Star}       label="Избранное" active={tab} onClick={setTab} />
        <ResultTab id="recent" icon={Clock}      label="Последнее" active={tab} onClick={setTab} />
      </div>

      {tab === 'list'   && <BondTable rows={filtered} loading={loading} />}
      {tab === 'favs'   && <FavsView />}
      {tab === 'recent' && <RecentView />}
    </div>
  );
}

function exportCsv(rows){
  if(!rows?.length) return;
  const cols = ['secid','isin','name','issuer','issuerInn','type','listing','price','ytm','duration_years','volume_bn','mat_date','currency','rating'];
  const esc = (v) => v == null ? '' : `"${String(v).replace(/"/g, '""')}"`;
  const lines = [cols.join(',')];
  for(const r of rows) lines.push(cols.map(c => esc(r[c])).join(','));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `bonds-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ResultTab({ id, icon: Icon, label, count, active, onClick }){
  const on = id === active;
  return (
    <button
      type="button"
      onClick={() => onClick(id)}
      className={[
        'flex items-center gap-1.5 px-4 py-2 text-[11px] font-mono uppercase tracking-wider border-b-2 -mb-px transition-colors',
        on ? 'border-acc text-acc' : 'border-transparent text-text2 hover:text-text',
      ].join(' ')}
    >
      <Icon size={13} />
      {label}
      {count != null && <span className="text-text3">· {count}</span>}
    </button>
  );
}

function BondTable({ rows, loading }){
  return (
    <Card padded={false}>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-s2/40 text-text3 uppercase text-[10px]">
            <tr>
              <th className="text-left p-2 pl-5">Тип</th>
              <th className="text-left p-2">SECID / Эмитент</th>
              <th className="text-right p-2">Цена</th>
              <th className="text-right p-2">YTM</th>
              <th className="text-right p-2">Дюр.</th>
              <th className="text-right p-2">Объём</th>
              <th className="text-left p-2">Рейтинг</th>
              <th className="text-right p-2" title="🛡 Запас прочности — composite ICR/ND-EBITDA/Current/EBITDA-маржа">🛡</th>
              <th className="text-right p-2" title="⚖ Качество баланса (BQI) — Cash/Equity/Current Ratio">⚖</th>
              <th className="text-right p-2 pr-5"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(b => <BondRow key={b.secid} b={b} />)}
            {!rows.length && !loading && (
              <tr>
                <td colSpan={10} className="p-10 text-center text-text3 text-sm">
                  По текущим фильтрам ничего не нашлось — попробуй сбросить часть условий.
                </td>
              </tr>
            )}
            {loading && !rows.length && (
              <tr>
                <td colSpan={10} className="p-10 text-center text-text3 text-sm">
                  Загружаю с сервера…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function BondRow({ b }){
  const openWin = useWindows(s => s.open);
  const addFav  = useFavorites(s => s.add);
  const pushRecent = useRecent(s => s.push);
  const safety = safetyScore(b);
  const bqi    = bqiScore(b);

  // Идентификатор окна — ИНН эмитента (если есть). Без ИНН берём имя
  // как fallback, но в этом случае WindowLayer не сможет дофетчить
  // отчётность — покажет минимум.
  const winId = b.issuerInn || b.issuer || '—';

  const openIssuer = () => {
    const item = { kind: 'issuer', refId: winId, title: b.issuer, ticker: null, ind: b.industry, inn: b.issuerInn };
    openWin({ kind: 'issuer', id: winId, title: b.issuer, ticker: null, mode: 'medium', inn: b.issuerInn });
    pushRecent(item);
  };
  const star = (e) => {
    e.stopPropagation();
    addFav({ kind: 'issuer', refId: winId, title: b.issuer, ticker: null, ind: b.industry, inn: b.issuerInn });
  };

  return (
    <tr className="border-t border-border/60 hover:bg-s2/40 transition-colors">
      <td className="p-2 pl-5">
        <Badge tone={b.type === 'ofz' ? 'green' : b.type === 'municipal' ? 'purple' : b.type === 'corporate' ? 'acc' : 'neutral'}>
          {TYPE_LABEL[b.type] ?? b.type}
        </Badge>
      </td>
      <td className="p-2">
        <div className="font-mono text-text">{b.name}</div>
        <div className="flex items-center gap-1.5 mt-0.5">
          <button onClick={openIssuer} className="text-text3 text-[10px] font-mono hover:text-acc transition-colors text-left">
            {b.secid} · {b.issuer}
          </button>
          <CopyBtn
            value={b.secid}
            onCopied={() => pushRecent({ kind: 'issuer', refId: b.issuer, title: b.issuer, ticker: null, ind: b.industry })}
          />
        </div>
      </td>
      <td className="p-2 text-right font-mono">{b.price.toFixed(2)}</td>
      <td className="p-2 text-right font-mono"><YieldCell v={b.ytm} /></td>
      <td className="p-2 text-right font-mono text-text3">{b.duration_years.toFixed(1)} г.</td>
      <td className="p-2 text-right font-mono text-text3">{b.volume_bn} млрд</td>
      <td className="p-2">
        <RatingBadge r={b.rating} t={b.ratingTrend} />
      </td>
      <td className="p-2 text-right font-mono">
        <SafetyCell s={safety} />
      </td>
      <td className="p-2 text-right font-mono">
        <SafetyCell s={bqi} />
      </td>
      <td className="p-2 pr-5 text-right">
        <button
          onClick={star}
          title="В избранное"
          className="text-text3 hover:text-warn transition-colors"
        >
          <Star size={14} />
        </button>
      </td>
    </tr>
  );
}

function CopyBtn({ value, onCopied }){
  const [done, setDone] = useState(false);
  const click = (e) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(value).then(() => {
      setDone(true);
      setTimeout(() => setDone(false), 1200);
      onCopied?.();
    });
  };
  return (
    <button
      onClick={click}
      title={done ? 'Скопировано' : `Скопировать ${value}`}
      className={[
        'inline-flex items-center justify-center w-4 h-4 rounded transition-colors',
        done ? 'text-green' : 'text-text3 hover:text-acc',
      ].join(' ')}
    >
      {done ? <Check size={11} /> : <Copy size={11} />}
    </button>
  );
}

function YieldCell({ v }){
  if(v == null) return <span className="text-text3">—</span>;
  let cls = 'text-text';
  if(v >= 25)      cls = 'text-danger';
  else if(v >= 18) cls = 'text-warn';
  else if(v >= 12) cls = 'text-green';
  return <span className={cls}>{v.toFixed(2)}%</span>;
}

function RatingBadge({ r, t }){
  if(!r || r === 'none') return <span className="text-text3 text-[10px] font-mono">—</span>;
  let tone = 'neutral';
  if(/^A/.test(r))           tone = 'green';
  else if(/^BBB/.test(r))    tone = 'acc';
  else if(/^BB/.test(r))     tone = 'warn';
  else if(/^B/.test(r))      tone = 'danger';
  else if(/^C|^D/.test(r))   tone = 'danger';
  const arr = t === 'up' ? '▲' : t === 'down' ? '▼' : '·';
  const arrCls = t === 'up' ? 'text-green' : t === 'down' ? 'text-danger' : 'text-text3';
  return (
    <span className="inline-flex items-center gap-1">
      <Badge tone={tone}>{r}</Badge>
      <span className={`font-mono text-[10px] ${arrCls}`}>{arr}</span>
    </span>
  );
}

function SafetyCell({ s }){
  if(s == null) return <span className="text-text3">—</span>;
  let cls = 'text-text';
  if(s >= 70) cls = 'text-green';
  else if(s >= 40) cls = 'text-warn';
  else cls = 'text-danger';
  return <span className={cls}>{s}</span>;
}

function FavsView(){
  const slots = useFavorites(s => s.slots);
  const filled = slots.filter(Boolean);
  if(!filled.length){
    return (
      <Card>
        <div className="text-text3 text-sm">
          Избранного пока нет. Кликни на ⭐ в строке таблицы — эмитент окажется здесь.
          <br />Полная страница с ячейками-карточками — на <a href="#/favorites" className="text-acc hover:underline">/favorites</a>.
        </div>
      </Card>
    );
  }
  return (
    <Card padded={false}>
      <ul className="divide-y divide-border/60">
        {filled.map(f => <FavRow key={`${f.kind}:${f.refId}`} f={f} />)}
      </ul>
    </Card>
  );
}

function FavRow({ f }){
  const openWin = useWindows(s => s.open);
  return (
    <li className="px-5 py-3 flex items-center gap-3">
      <Star size={14} className="text-warn shrink-0" />
      <button
        onClick={() => openWin({ kind: f.kind, id: f.refId, title: f.title, ticker: f.ticker, mode: 'medium' })}
        className="font-mono text-text hover:text-acc transition-colors"
      >
        {f.title}
      </button>
      {f.ind && f.ind !== 'none' && (
        <span className="text-text3 text-xs">{INDUSTRIES[f.ind]?.label || f.ind}</span>
      )}
    </li>
  );
}

function RecentView(){
  const items = useRecent(s => s.items);
  const clear = useRecent(s => s.clear);
  const openWin = useWindows(s => s.open);
  if(!items.length){
    return (
      <Card>
        <div className="text-text3 text-sm">
          Список пуст. Кликни на эмитента в таблице — он появится здесь.
        </div>
      </Card>
    );
  }
  return (
    <Card
      title={`${items.length} последних`}
      action={<button onClick={clear} className="text-text3 hover:text-danger text-[10px] font-mono uppercase">очистить</button>}
      padded={false}
    >
      <ul className="divide-y divide-border/60">
        {items.map(it => (
          <li key={`${it.kind}:${it.refId}:${it.at}`} className="px-5 py-2.5 flex items-center gap-3 text-xs">
            <Clock size={12} className="text-text3 shrink-0" />
            <button
              onClick={() => openWin({ kind: it.kind, id: it.refId, title: it.title, ticker: it.ticker, mode: 'medium' })}
              className="font-mono text-text hover:text-acc transition-colors"
            >
              {it.title}
            </button>
            <span className="text-text3 ml-auto font-mono">
              {new Date(it.at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
