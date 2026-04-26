import { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function Home(){
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    api.status()
      .then(s => mounted && setStatus(s))
      .catch(e => mounted && setError(e.message))
      .finally(() => mounted && setLoading(false));
    return () => { mounted = false; };
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-serif">Главная</h1>
        <p className="text-text2 text-sm mt-1">
          Новый интерфейс БондАналитика. Бэкенд — наш Cloudflare Worker, БД — D1 «coldline».
        </p>
      </div>

      <Card title="Статус подключения к бэкенду">
        {loading && <div className="text-text3">проверяю…</div>}
        {error && (
          <div className="text-danger">
            ❌ {error}
            <div className="text-text3 text-xs mt-1">
              Проверьте что Worker отвечает: <a className="text-acc hover:underline" href="https://bondan-backend.marginacall.workers.dev/status" target="_blank" rel="noreferrer">/status</a>
            </div>
          </div>
        )}
        {status && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-green text-lg">●</span>
              <span className="text-text">подключено</span>
              <span className="text-text3 font-mono text-xs">v{status.version}</span>
            </div>
            <Stats db={status.db} />
            <Runs runs={status.recent_runs || []} />
          </div>
        )}
      </Card>
    </div>
  );
}

function Card({ title, children }){
  return (
    <div className="bg-bg2 border border-border rounded-lg p-5">
      <div className="text-xs uppercase tracking-wider text-text3 mb-3 font-mono">{title}</div>
      {children}
    </div>
  );
}

function Stats({ db }){
  if(!db) return null;
  const items = [
    { label: 'Акции',          n: db.stock_daily_rows,      sub: db.stock_latest_date  },
    { label: 'Фьючерсы',       n: db.futures_daily_rows,    sub: db.futures_latest_date },
    { label: 'Облигации',      n: db.bond_daily_rows ?? 0,  sub: db.bond_latest_date },
    { label: 'TQCB бумаг',     n: db.bond_unique_tqcb ?? 0, sub: 'корпораты' },
    { label: 'TQOB бумаг',     n: db.bond_unique_tqob ?? 0, sub: 'ОФЗ' },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
      {items.map(it => (
        <div key={it.label} className="bg-s2 border border-border rounded p-3">
          <div className="text-text3 text-xs font-mono uppercase">{it.label}</div>
          <div className="text-2xl text-acc font-mono mt-1">{(it.n ?? 0).toLocaleString('ru-RU')}</div>
          <div className="text-text3 text-xs font-mono mt-1">{it.sub || '—'}</div>
        </div>
      ))}
    </div>
  );
}

function Runs({ runs }){
  if(!runs.length) return <div className="text-text3 text-xs">cron ещё не запускался</div>;
  return (
    <div>
      <div className="text-text3 text-xs uppercase font-mono mb-2">Последние запуски сбора</div>
      <table className="w-full text-xs">
        <thead className="text-text3 text-[10px] uppercase">
          <tr>
            <th className="text-left py-1">Источник</th>
            <th className="text-left py-1">Когда</th>
            <th className="text-right py-1">Строк</th>
            <th className="text-right py-1">Длит.</th>
            <th className="text-left py-1 pl-3">Статус</th>
          </tr>
        </thead>
        <tbody>
          {runs.map(r => (
            <tr key={r.run_id} className="border-t border-border">
              <td className="py-1.5 font-mono">{r.source}</td>
              <td className="py-1.5 text-text2 font-mono text-[11px]">{r.started_at?.replace('T', ' ').slice(0, 19)}</td>
              <td className="py-1.5 text-right font-mono">{r.rows_inserted?.toLocaleString('ru-RU')}</td>
              <td className="py-1.5 text-right font-mono text-text3">{(r.duration_ms / 1000).toFixed(1)}s</td>
              <td className="py-1.5 pl-3">
                <span className={r.status === 'ok' ? 'text-green' : r.status === 'partial' ? 'text-warn' : 'text-danger'}>
                  {r.status}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
