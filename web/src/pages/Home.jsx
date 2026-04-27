import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Wallet, Coins, Clock, TrendingUp, Server, Activity,
  ArrowUpRight, CalendarClock,
} from 'lucide-react';
import { api } from '../api.js';
import Card from '../components/ui/Card.jsx';
import Stat from '../components/ui/Stat.jsx';
import Badge from '../components/ui/Badge.jsx';
import Button from '../components/ui/Button.jsx';
import { portfolioKpi, recentEvents, featureCards } from '../data/mockHome.js';

const fmtRub = n => {
  if(n == null) return '—';
  if(Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + ' млрд';
  if(Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + ' млн';
  if(Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + ' тыс';
  return n.toLocaleString('ru-RU');
};

export default function Home(){
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let mounted = true;
    api.status()
      .then(s => mounted && setStatus(s))
      .catch(e => mounted && setError(e.message));
    return () => { mounted = false; };
  }, []);

  return (
    <div className="space-y-8">
      <Hero status={status} error={error} />
      <PortfolioToday />
      <div className="grid lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2">
          <EventsFeed />
        </div>
        <BackendCard status={status} error={error} />
      </div>
      <Features />
    </div>
  );
}

function Hero({ status, error }){
  return (
    <section className="relative overflow-hidden rounded-xl border border-border bg-gradient-to-br from-bg2 via-bg2 to-s2 px-6 py-7 sm:px-8 sm:py-9">
      <div className="absolute -right-20 -top-20 w-64 h-64 rounded-full bg-acc/10 blur-3xl pointer-events-none" />
      <div className="relative flex flex-col sm:flex-row sm:items-end sm:justify-between gap-5">
        <div className="max-w-2xl">
          <div className="flex items-center gap-2 mb-3">
            <Badge tone={error ? 'danger' : status ? 'green' : 'neutral'} dot={!!status && !error}>
              {error ? 'офлайн' : status ? 'онлайн' : 'проверка…'}
            </Badge>
            <span className="text-text3 text-[11px] font-mono">сегодня · {new Date().toLocaleDateString('ru-RU')}</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-text">
            Аналитика по российским облигациям
          </h1>
          <p className="text-text2 text-sm sm:text-base mt-2 max-w-xl">
            Портфель ВДО, отчётность эмитентов, медианы по отраслям и Live-котировки —
            в одном минималистичном рабочем столе с плавающими окнами компаний.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button as={Link} to="/portfolio" variant="primary" size="md" icon={Wallet}>Портфель</Button>
            <Button as={Link} to="/bonds"     variant="outline" size="md" icon={Coins}>Облигации</Button>
            <Button as={Link} to="/live"      variant="ghost"   size="md" icon={Activity}>Live-цены</Button>
          </div>
        </div>
        <div className="text-text3 text-[11px] font-mono shrink-0">
          <kbd className="px-1.5 py-0.5 bg-s2 border border-border rounded">/</kbd>
          <span className="ml-1.5">— фокус на поиск</span>
        </div>
      </div>
    </section>
  );
}

function PortfolioToday(){
  const k = portfolioKpi;
  return (
    <Card
      title="Сегодня по портфелю"
      subtitle="данные пока mock — заменятся на D1 после миграции localStorage"
      action={<Link to="/portfolio" className="text-text3 hover:text-acc text-xs font-mono inline-flex items-center gap-1">подробно <ArrowUpRight size={12} /></Link>}
    >
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <Stat icon={Wallet} accent label="Активы" value={fmtRub(k.navRub)} sub="₽" delta={k.navDelta} />
        <Stat icon={TrendingUp} label="Средняя YTM" value={`${k.ytmAvg.toFixed(2)}%`} sub="взвеш." delta={k.ytmDelta} />
        <Stat icon={Clock} label="Дюрация" value={`${k.durationAvg.toFixed(1)} г.`} sub="средняя" />
        <Stat icon={Coins} label="Свободно" value={fmtRub(k.cashRub)} sub="₽" />
        <Stat label="Доход YTD" value={fmtRub(k.yieldYtdRub)} sub={`${k.yieldYtdPct.toFixed(1)}%`} delta={k.yieldYtdPct} />
      </div>
    </Card>
  );
}

function EventsFeed(){
  return (
    <Card
      title="Свежие события эмитентов"
      action={<Badge tone="acc">{recentEvents.length} новых</Badge>}
      padded={false}
    >
      <ul className="divide-y divide-border/60">
        {recentEvents.map(ev => (
          <li key={ev.id} className="px-5 py-3 flex items-start gap-3 hover:bg-s2/40 transition-colors cursor-pointer">
            <CalendarClock size={14} className="text-text3 mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-text text-sm">{ev.issuer}</span>
                <Badge tone={ev.tone}>{ev.when}</Badge>
              </div>
              <div className="text-text2 text-sm mt-0.5">{ev.text}</div>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function BackendCard({ status, error }){
  return (
    <Card title="Сборщик данных" padded={false}>
      <div className="px-5 py-4 border-b border-border/60">
        <div className="flex items-center gap-2 text-sm">
          <Server size={14} className="text-text3" />
          {error && <span className="text-danger">офлайн</span>}
          {!error && !status && <span className="text-text3">проверка…</span>}
          {status && <>
            <span className="text-green">●</span>
            <span className="text-text">подключено</span>
            <span className="text-text3 font-mono text-xs">v{status.version}</span>
          </>}
        </div>
        {error && (
          <div className="text-text3 text-xs mt-2">
            {error}
          </div>
        )}
      </div>
      {status?.db && (
        <div className="px-5 py-4 grid grid-cols-2 gap-x-4 gap-y-2 text-xs font-mono">
          <Row label="Акции"     value={(status.db.stock_daily_rows ?? 0).toLocaleString('ru-RU')} />
          <Row label="Фьючерсы"  value={(status.db.futures_daily_rows ?? 0).toLocaleString('ru-RU')} />
          <Row label="Облигации" value={(status.db.bond_daily_rows ?? 0).toLocaleString('ru-RU')} />
          <Row label="TQCB"      value={(status.db.bond_unique_tqcb ?? 0).toLocaleString('ru-RU')} />
          <Row label="TQOB"      value={(status.db.bond_unique_tqob ?? 0).toLocaleString('ru-RU')} />
          <Row label="Дата"      value={status.db.bond_latest_date || '—'} />
        </div>
      )}
      {status?.recent_runs?.length > 0 && (
        <div className="px-5 py-3 border-t border-border/60">
          <div className="text-text3 text-[10px] uppercase font-mono mb-2">последние запуски</div>
          <ul className="space-y-1.5">
            {status.recent_runs.slice(0, 3).map(r => (
              <li key={r.run_id} className="flex items-center gap-2 text-xs font-mono">
                <span className={r.status === 'ok' ? 'text-green' : r.status === 'partial' ? 'text-warn' : 'text-danger'}>●</span>
                <span className="text-text2 truncate flex-1">{r.source}</span>
                <span className="text-text3">{(r.rows_inserted ?? 0).toLocaleString('ru-RU')} стр.</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function Row({ label, value }){
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border/30 py-1 last:border-0">
      <span className="text-text3">{label}</span>
      <span className="text-text">{value}</span>
    </div>
  );
}

function Features(){
  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs uppercase tracking-wider text-text3 font-mono">Что внутри</h2>
      </div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {featureCards.map(f => (
          <Card key={f.id} hoverable className="h-full">
            <div className="flex items-center gap-2 mb-2">
              <Badge tone="acc">{f.badge}</Badge>
            </div>
            <div className="text-text font-medium">{f.title}</div>
            <p className="text-text2 text-sm mt-2 leading-relaxed">{f.text}</p>
          </Card>
        ))}
      </div>
    </section>
  );
}
