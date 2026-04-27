import { useEffect, useState } from 'react';
import {
  Wallet, Coins, Clock, TrendingUp, Server, ArrowUpRight, CalendarClock,
} from 'lucide-react';
import { api } from '../api.js';
import Card from '../components/ui/Card.jsx';
import Stat from '../components/ui/Stat.jsx';
import Badge from '../components/ui/Badge.jsx';
import RightPanel from '../components/home/RightPanel.jsx';
import SectionsGrid from '../components/home/SectionsGrid.jsx';
import { portfolioKpi, recentEvents } from '../data/mockHome.js';

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
    <div className="space-y-6">
      <PageHead status={status} error={error} />

      <div className="grid lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 space-y-5">
          <PortfolioToday />
          <EventsFeed />
        </div>
        <div className="space-y-5">
          <RightPanel />
          <BackendStrip status={status} error={error} />
        </div>
      </div>

      <SectionsGrid />
    </div>
  );
}

function PageHead({ status, error }){
  return (
    <div className="flex items-end justify-between gap-3 flex-wrap">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Главная</h1>
        <div className="flex items-center gap-2 mt-1">
          <Badge tone={error ? 'danger' : status ? 'green' : 'neutral'} dot={!!status && !error}>
            {error ? 'офлайн' : status ? 'онлайн' : 'проверка…'}
          </Badge>
          <span className="text-text3 text-[11px] font-mono">
            {new Date().toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' })}
          </span>
        </div>
      </div>
      <div className="text-text3 text-[11px] font-mono">
        <kbd className="px-1.5 py-0.5 bg-s2 border border-border rounded">/</kbd>
        <span className="ml-1.5">фокус на поиск</span>
      </div>
    </div>
  );
}

function PortfolioToday(){
  const k = portfolioKpi;
  return (
    <Card
      title="Сегодня по портфелю"
      action={<a href="#" className="text-text3 hover:text-acc text-xs font-mono inline-flex items-center gap-1">подробно <ArrowUpRight size={12} /></a>}
    >
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-3">
        <Stat icon={Wallet} accent label="Активы"      value={fmtRub(k.navRub)}            sub="₽"           delta={k.navDelta} />
        <Stat icon={TrendingUp}     label="Средняя YTM" value={`${k.ytmAvg.toFixed(2)}%`}  sub="взвеш."     delta={k.ytmDelta} />
        <Stat icon={Clock}          label="Дюрация"    value={`${k.durationAvg.toFixed(1)} г.`} sub="средняя" />
        <Stat icon={Coins}          label="Свободно"   value={fmtRub(k.cashRub)}           sub="₽" />
        <Stat                       label="Доход YTD"  value={fmtRub(k.yieldYtdRub)}        sub={`${k.yieldYtdPct.toFixed(1)}%`} delta={k.yieldYtdPct} />
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

function BackendStrip({ status, error }){
  return (
    <div className="bg-bg2 border border-border rounded-lg px-4 py-3 flex items-center gap-3 text-xs font-mono">
      <Server size={13} className="text-text3 shrink-0" />
      {error && <span className="text-danger">офлайн</span>}
      {!error && !status && <span className="text-text3">проверка…</span>}
      {status && <>
        <span className="text-green">●</span>
        <span className="text-text2">бэкенд</span>
        <span className="text-text3">v{status.version}</span>
        {status.db?.bond_daily_rows != null && (
          <span className="ml-auto text-text3">
            бумаг · <span className="text-text">{(status.db.bond_daily_rows).toLocaleString('ru-RU')}</span>
          </span>
        )}
      </>}
    </div>
  );
}
