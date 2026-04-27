import { useMemo, useState } from 'react';
import { Calendar, PieChart as PieIcon } from 'lucide-react';
import Card from '../ui/Card.jsx';
import Badge from '../ui/Badge.jsx';
import {
  upcomingPayments, debtLoad,
  compRatings, compDuration, compYtm,
} from '../../data/mockHomePanel.js';

// Правая панель главной — переключение «Выплаты / Состав портфеля».
// Вкладка «Выплаты» рисует календарь предстоящих событий + бар-кривую
// долговой нагрузки по месяцам. «Состав» — три горизонтальных
// распределения (рейтинг, дюрация, YTM-бакеты).

const TABS = [
  { id: 'pay',  label: 'Выплаты',          icon: Calendar },
  { id: 'mix',  label: 'Состав портфеля',  icon: PieIcon },
];

export default function RightPanel(){
  const [tab, setTab] = useState('pay');
  return (
    <Card padded={false}>
      <div className="flex border-b border-border/60">
        {TABS.map(t => {
          const active = t.id === tab;
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={[
                'flex items-center gap-1.5 px-4 py-2.5 text-[11px] font-mono uppercase tracking-wider border-b-2 -mb-px transition-colors',
                active
                  ? 'border-acc text-acc'
                  : 'border-transparent text-text2 hover:text-text',
              ].join(' ')}
            >
              <Icon size={13} />{t.label}
            </button>
          );
        })}
      </div>
      {tab === 'pay' && <PayTab />}
      {tab === 'mix' && <MixTab />}
    </Card>
  );
}

function PayTab(){
  const total = useMemo(() => upcomingPayments.reduce((s, p) => s + p.amount, 0), []);
  const peak  = useMemo(() => Math.max(...debtLoad.map(d => d.v)), []);
  return (
    <div>
      <Section title="Календарь" right={<span className="text-text3 text-[10px] font-mono">{upcomingPayments.length} событий · {fmt(total)} ₽</span>}>
        <ul className="space-y-1.5">
          {upcomingPayments.map(p => (
            <li key={p.secid + p.date} className="flex items-center gap-2 text-xs">
              <span className="font-mono text-text3 w-16 shrink-0">{shortDate(p.date)}</span>
              <KindDot kind={p.kind} />
              <span className="font-mono text-text2 truncate flex-1">{p.issuer}</span>
              <span className="font-mono text-text">{fmt(p.amount)} ₽</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Долговая нагрузка" right={<span className="text-text3 text-[10px] font-mono">пик · {peak.toFixed(1)} тыс</span>}>
        <DebtTimeline data={debtLoad} peak={peak} />
        <div className="flex items-center gap-3 mt-3 text-[10px] font-mono text-text3">
          <Legend dot="bg-acc"    label="купон" />
          <Legend dot="bg-warn"   label="оферта" />
          <Legend dot="bg-purple" label="погашение" />
        </div>
      </Section>
    </div>
  );
}

function MixTab(){
  return (
    <div>
      <Section title="Кредитный рейтинг">
        <Distribution data={compRatings} unit="%" />
      </Section>
      <Section title="Дюрация">
        <Distribution data={compDuration} unit="%" tone="purple" />
      </Section>
      <Section title="YTM, бакеты">
        <Distribution data={compYtm} unit="%" tone="green" />
      </Section>
    </div>
  );
}

function Section({ title, right, children }){
  return (
    <div className="px-5 py-4 border-b border-border/40 last:border-0">
      <div className="flex items-baseline justify-between mb-2.5">
        <div className="text-[10px] uppercase tracking-wider text-text3 font-mono">{title}</div>
        {right}
      </div>
      {children}
    </div>
  );
}

function KindDot({ kind }){
  const map = {
    coupon: { dot: 'bg-acc',    label: 'куп.' },
    offer:  { dot: 'bg-warn',   label: 'оф.'  },
    redeem: { dot: 'bg-purple', label: 'пог.' },
  };
  const m = map[kind] || { dot: 'bg-text3', label: kind };
  return (
    <span className="flex items-center gap-1 w-10 shrink-0">
      <span className={`w-1.5 h-1.5 rounded-full ${m.dot}`} />
      <span className="text-text3 text-[10px] font-mono">{m.label}</span>
    </span>
  );
}

function DebtTimeline({ data, peak }){
  return (
    <div className="flex items-end gap-1.5 h-20">
      {data.map(d => {
        const h = (d.v / peak) * 100;
        const tone = h > 75 ? 'bg-warn/70' : h > 40 ? 'bg-acc/60' : 'bg-acc/30';
        return (
          <div key={d.m} className="flex-1 flex flex-col items-center gap-1 group">
            <div className="text-[9px] font-mono text-text3 opacity-0 group-hover:opacity-100 transition-opacity">
              {d.v.toFixed(1)}
            </div>
            <div className="w-full bg-s2 rounded-sm relative" style={{ height: '70%' }}>
              <div className={`absolute bottom-0 inset-x-0 ${tone} rounded-sm transition-all`} style={{ height: `${h}%` }} />
            </div>
            <div className="text-[10px] font-mono text-text3">{d.m}</div>
          </div>
        );
      })}
    </div>
  );
}

function Distribution({ data, unit = '', tone = 'acc' }){
  const max = Math.max(...data.map(d => d.v));
  const colorMap = {
    acc:    'bg-acc/70',
    purple: 'bg-purple/70',
    green:  'bg-green/70',
  };
  const bar = colorMap[tone] || colorMap.acc;
  return (
    <ul className="space-y-2">
      {data.map(d => {
        const pct = (d.v / max) * 100;
        return (
          <li key={d.k} className="flex items-center gap-3 text-xs">
            <span className="font-mono text-text2 w-12 shrink-0">{d.k}</span>
            <div className="flex-1 h-2 bg-s2 rounded-sm overflow-hidden">
              <div className={`h-full ${bar} rounded-sm transition-all`} style={{ width: `${pct}%` }} />
            </div>
            <span className="font-mono text-text w-10 text-right">{d.v}{unit}</span>
          </li>
        );
      })}
    </ul>
  );
}

function Legend({ dot, label }){
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

function fmt(n){
  if(n >= 1000) return (n / 1000).toFixed(1) + ' тыс';
  return n.toLocaleString('ru-RU');
}

function shortDate(s){
  const [, m, d] = s.split('-');
  return `${d}.${m}`;
}
