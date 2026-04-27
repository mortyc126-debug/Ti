import { useEffect, useState } from 'react';
import { Activity, Radio, Zap } from 'lucide-react';
import Card from '../components/ui/Card.jsx';
import Badge from '../components/ui/Badge.jsx';
import Button from '../components/ui/Button.jsx';

// Моковая «Live»-страница — демонстрирует визуальный язык до того, как
// подключим реальный SSE-стрим из Cloudflare Durable Object.

const TICKERS = [
  { sec: 'SBER',   name: 'Сбербанк',       price: 318.42 },
  { sec: 'GAZP',   name: 'Газпром',        price: 142.85 },
  { sec: 'LKOH',   name: 'Лукойл',         price: 7480 },
  { sec: 'YDEX',   name: 'Яндекс',         price: 4302 },
  { sec: 'ROSN',   name: 'Роснефть',       price: 564.10 },
  { sec: 'GMKN',   name: 'ГМК НорНикель',  price: 142.30 },
  { sec: 'TCSG',   name: 'TCS Group',      price: 3854 },
  { sec: 'NVTK',   name: 'Новатэк',        price: 1238 },
];

export default function Live(){
  const [rows, setRows] = useState(() => TICKERS.map(t => ({ ...t, last: t.price, prev: t.price, change: 0 })));
  const [running, setRunning] = useState(true);

  // Имитация тиков ±0.4% каждые 1.5с — pure UI demo, без бэкенда.
  useEffect(() => {
    if(!running) return;
    const id = setInterval(() => {
      setRows(prev => prev.map(r => {
        const drift = (Math.random() - 0.5) * 0.008;
        const last = +(r.last * (1 + drift)).toFixed(r.last > 1000 ? 1 : 2);
        return { ...r, prev: r.last, last, change: ((last - r.price) / r.price) * 100 };
      }));
    }, 1500);
    return () => clearInterval(id);
  }, [running]);

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Live-цены</h1>
          <p className="text-text2 text-sm mt-1">
            Демо-стрим: имитация тиков ±0.4% раз в 1.5 секунды. Реальный поток
            будет приходить через SSE из Durable Object, опрашивающего MOEX.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={running ? 'green' : 'neutral'} dot={running}>
            {running ? 'demo-стрим' : 'пауза'}
          </Badge>
          <Button
            size="sm"
            variant={running ? 'outline' : 'primary'}
            onClick={() => setRunning(v => !v)}
            icon={running ? Radio : Zap}
          >
            {running ? 'Стоп' : 'Старт'}
          </Button>
        </div>
      </div>

      <Card title="MOEX · ликвидные акции" padded={false}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-s2/60 text-text3 uppercase text-[10px]">
              <tr>
                <th className="text-left p-2 pl-5">Тикер</th>
                <th className="text-left p-2">Эмитент</th>
                <th className="text-right p-2">Цена</th>
                <th className="text-right p-2 pr-5">Δ к открытию</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const up = r.last >= r.prev;
                return (
                  <tr key={r.sec} className="border-t border-border/60 hover:bg-s2/40 transition-colors">
                    <td className="p-2 pl-5 font-mono text-text">{r.sec}</td>
                    <td className="p-2 text-text2">{r.name}</td>
                    <td className={`p-2 text-right font-mono transition-colors ${up ? 'text-green' : 'text-danger'}`}>
                      <span className="inline-flex items-center gap-1">
                        <span className={`w-1.5 h-1.5 rounded-full ${up ? 'bg-green' : 'bg-danger'} animate-pulse-dot`} />
                        {r.last.toLocaleString('ru-RU')}
                      </span>
                    </td>
                    <td className={`p-2 pr-5 text-right font-mono ${r.change >= 0 ? 'text-green' : 'text-danger'}`}>
                      {r.change >= 0 ? '▲' : '▼'} {Math.abs(r.change).toFixed(2)}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Архитектура (план)">
        <ul className="text-text2 text-sm space-y-2 leading-relaxed">
          <li className="flex gap-2"><Activity size={14} className="text-acc mt-0.5 shrink-0" />
            <span>Cloudflare Durable Object держит polling MOEX каждые 5–10 секунд и нормализует ответ.</span>
          </li>
          <li className="flex gap-2"><Activity size={14} className="text-acc mt-0.5 shrink-0" />
            <span>Подписанные клиенты получают изменения через Server-Sent Events; отвал → авто-reconnect.</span>
          </li>
          <li className="flex gap-2"><Activity size={14} className="text-acc mt-0.5 shrink-0" />
            <span>Алерты на пробой уровня и мини-графики 1-минутных баров появятся в ближайших итерациях.</span>
          </li>
        </ul>
      </Card>
    </div>
  );
}
