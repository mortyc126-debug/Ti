import { useMemo, useState } from 'react';
import { Wallet, TrendingUp, Clock, Coins, Plus, Filter } from 'lucide-react';
import Card from '../components/ui/Card.jsx';
import Stat from '../components/ui/Stat.jsx';
import Badge from '../components/ui/Badge.jsx';
import Button from '../components/ui/Button.jsx';
import { positions, rowPnl, totals, bySector } from '../data/mockPortfolio.js';
import { INDUSTRIES } from '../data/industries.js';

const fmtRub = n => {
  if(n == null) return '—';
  if(Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + ' млн ₽';
  if(Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + ' тыс ₽';
  return Math.round(n).toLocaleString('ru-RU') + ' ₽';
};

export default function Portfolio(){
  const [filter, setFilter] = useState('');
  const rows = useMemo(
    () => positions.filter(p => !filter || p.name.toLowerCase().includes(filter.toLowerCase()) || p.issuer.toLowerCase().includes(filter.toLowerCase())),
    [filter]
  );
  const t = useMemo(() => totals(positions), []);
  const sectors = useMemo(() => bySector(positions), []);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Портфель</h1>
          <p className="text-text2 text-sm mt-1">
            Mock-данные — реальные подъедутся после миграции <code className="font-mono text-acc">localStorage.ba_v2</code> в D1.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" icon={Filter}>Импорт CSV</Button>
          <Button variant="primary" size="sm" icon={Plus}>Добавить позицию</Button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat icon={Wallet} accent label="Активы" value={fmtRub(t.navRub)} sub={`${rows.length} поз.`} delta={(t.pnlRub / Math.max(t.costRub, 1)) * 100} />
        <Stat icon={TrendingUp} label="Средняя YTM" value={`${t.ytmAvg.toFixed(2)}%`} sub="взвеш. по NAV" />
        <Stat icon={Clock} label="Дюрация" value={`${t.durAvg.toFixed(2)} г.`} sub="средняя" />
        <Stat icon={Coins} label="P&L" value={fmtRub(t.pnlRub)} sub="нереализованный" delta={(t.pnlRub / Math.max(t.costRub, 1)) * 100} />
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
                    <th className="text-right p-2">Средн.</th>
                    <th className="text-right p-2">Послед.</th>
                    <th className="text-right p-2">YTM</th>
                    <th className="text-right p-2">Дюр.</th>
                    <th className="text-right p-2 pr-5">P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(p => {
                    const pnl = rowPnl(p);
                    const pos = pnl >= 0;
                    return (
                      <tr key={p.isin} className="border-t border-border/60 hover:bg-s2/40 cursor-pointer transition-colors">
                        <td className="p-2 pl-5">
                          <div className="font-mono text-text">{p.name}</div>
                          <div className="text-text3 text-[10px] font-mono">{p.isin} · {p.issuer}</div>
                        </td>
                        <td className="p-2 text-right font-mono">{p.qty}</td>
                        <td className="p-2 text-right font-mono text-text2">{p.avg.toFixed(2)}</td>
                        <td className="p-2 text-right font-mono text-text">{p.last.toFixed(2)}</td>
                        <td className="p-2 text-right font-mono text-acc">{p.ytm.toFixed(1)}%</td>
                        <td className="p-2 text-right font-mono text-text3">{p.dur.toFixed(1)}</td>
                        <td className={`p-2 pr-5 text-right font-mono ${pos ? 'text-green' : 'text-danger'}`}>
                          {pos ? '+' : ''}{fmtRub(pnl)}
                        </td>
                      </tr>
                    );
                  })}
                  {!rows.length && (
                    <tr><td colSpan={7} className="p-8 text-center text-text3 text-sm">Ничего не нашлось</td></tr>
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
            <Badge tone="acc">{rows.length} позиций</Badge>
          </div>
        </Card>
      </div>
    </div>
  );
}

function SectorBreakdown({ sectors, nav }){
  // Группируем плоский список секторов по INDUSTRIES.groupId; внутри
  // группы — отрасли с собственным процентом от NAV.
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
