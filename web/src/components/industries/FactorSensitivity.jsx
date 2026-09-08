// «Драйверы»: как меняются показатели разных отраслей при изменении макро-
// фактора. Выбираешь фактор — видишь по каждой группе отраслей эффект
// (помогает/давит/нейтрально/неоднозначно), какой показатель двигается и почему.
// Можно сортировать/фильтровать по знаку эффекта.

import { useMemo, useState } from 'react';
import { FACTORS, effectsFor, factorsForGroup, EFFECT_META } from '../../lib/factorSensitivity.js';
import { NORM_GROUPS } from '../../data/industryNorms.js';
import { TRANSMISSION } from '../../lib/transmission.js';

const TONE = {
  green:  { badge: 'bg-green/15 text-green border-green/30', dot: 'text-green' },
  warn:   { badge: 'bg-warn/15 text-warn border-warn/30', dot: 'text-warn' },
  danger: { badge: 'bg-danger/15 text-danger border-danger/30', dot: 'text-danger' },
  text3:  { badge: 'bg-s2 text-text3 border-border', dot: 'text-text3' },
};
const SYM = { '+': '▲', '±': '◆', '~': '•', '-': '▼' };

export default function FactorSensitivity(){
  const [mode, setMode] = useState('factor');   // 'factor' | 'sector'
  const [factorId, setFactorId] = useState(FACTORS[0].id);
  const [groupId, setGroupId] = useState(NORM_GROUPS[0].id);
  const [filter, setFilter] = useState('all');   // all|+|±|~|-

  const factor = FACTORS.find(f => f.id === factorId);
  const group = NORM_GROUPS.find(g => g.id === groupId);

  const rows = useMemo(() => {
    const base = mode === 'factor'
      ? effectsFor(factorId).map(r => ({ ...r, key: r.groupId, title: r.groupLabel }))
      : factorsForGroup(groupId).map(r => ({ ...r, key: r.factorId, title: r.factorLabel }));
    const sorted = base.sort((a, b) => EFFECT_META[a.e].order - EFFECT_META[b.e].order);
    return filter === 'all' ? sorted : sorted.filter(r => r.e === filter);
  }, [mode, factorId, groupId, filter]);

  return (
    <div className="space-y-3">
      <p className="text-text2 text-sm">
        Один фактор по-разному бьёт по отраслям, а на одну отрасль давит сразу много факторов. Смотри в двух разрезах: «по фактору» (кому помогает/давит) или «по отрасли» (все влияния на неё сразу).
      </p>

      {/* Переключатель разреза */}
      <div className="flex gap-0.5 rounded overflow-hidden border border-border w-fit">
        {[['factor', 'По фактору'], ['sector', 'По отрасли'], ['channels', 'Каналы (лаг)']].map(([id, lbl]) => (
          <button key={id} type="button" onClick={() => { setMode(id); setFilter('all'); }}
            className={[
              'px-3 py-1 text-xs transition-colors',
              mode === id ? 'bg-acc-dim text-acc' : 'bg-bg2 text-text3 hover:text-text',
            ].join(' ')}>{lbl}</button>
        ))}
      </div>

      {mode === 'channels' && <><TransmissionTable /><RateMap /></>}

      {mode !== 'channels' && <>
      {/* Выбор фактора / отрасли */}
      <div className="flex flex-wrap gap-1.5">
        {mode === 'factor'
          ? FACTORS.map(f => (
              <button key={f.id} type="button" onClick={() => setFactorId(f.id)}
                className={['px-2.5 py-1 rounded text-xs border transition-colors',
                  f.id === factorId ? 'bg-acc-dim text-acc border-acc/40' : 'bg-bg2 text-text2 border-border hover:text-text'].join(' ')}>
                {f.label}
              </button>
            ))
          : NORM_GROUPS.map(g => (
              <button key={g.id} type="button" onClick={() => setGroupId(g.id)}
                className={['px-2.5 py-1 rounded text-xs border transition-colors',
                  g.id === groupId ? 'bg-acc-dim text-acc border-acc/40' : 'bg-bg2 text-text2 border-border hover:text-text'].join(' ')}>
                {g.label}
              </button>
            ))}
      </div>

      {mode === 'factor'
        ? <div className="text-text3 text-xs bg-s2/30 border border-border/60 rounded px-3 py-2">{factor.desc}</div>
        : <div className="text-text3 text-xs bg-s2/30 border border-border/60 rounded px-3 py-2">Как разные макро-факторы влияют на отрасль «{group.label}».</div>}

      {/* Фильтр по знаку эффекта */}
      <div className="flex items-center gap-1.5 text-xs">
        <span className="text-text3">показать:</span>
        {[['all', 'все'], ['+', 'помогает'], ['±', 'неоднозначно'], ['~', 'нейтрально'], ['-', 'давит']].map(([id, lbl]) => (
          <button key={id} type="button" onClick={() => setFilter(id)}
            className={['px-2 py-0.5 rounded border text-[11px]',
              filter === id ? 'bg-acc-dim text-acc border-acc/40' : 'bg-bg2 text-text3 border-border hover:text-text'].join(' ')}>{lbl}</button>
        ))}
      </div>

      {/* Матрица */}
      <div className="space-y-1.5">
        {rows.map(r => {
          const meta = EFFECT_META[r.e];
          const tone = TONE[meta.tone];
          return (
            <div key={r.key} className="flex items-start gap-3 bg-bg2 border border-border rounded px-3 py-2">
              <span className={`shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] font-mono ${tone.badge}`}
                    style={{ minWidth: 118 }}>
                <span>{SYM[r.e]}</span>{meta.label}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-text text-xs">
                  {r.title}
                  {r.metric && r.metric !== '—' && <span className="text-text3 ml-2 font-mono text-[10px]">→ {r.metric}</span>}
                </div>
                {r.note && <div className="text-text3 text-[11px] leading-snug mt-0.5">{r.note}</div>}
              </div>
            </div>
          );
        })}
        {!rows.length && <div className="text-text3 text-xs">Нет строк с таким эффектом.</div>}
      </div>

      <div className="text-text3 text-[10px] italic">
        Качественная оценка типовой реакции сектора, а не прогноз по конкретной компании — у отдельного эмитента может быть хедж, экспортная доля или структура долга, меняющие знак.
      </div>
      </>}
    </div>
  );
}

function TransmissionTable(){
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    if(!s) return TRANSMISSION;
    return TRANSMISSION.filter(r => (r.factor + r.channel + r.report + r.watch).toLowerCase().includes(s));
  }, [q]);
  return (
    <div className="space-y-2">
      <div className="text-text3 text-xs bg-s2/30 border border-border/60 rounded px-3 py-2">
        Как импульс доходит до цифр отчёта: фактор → канал → что меняется → типичный лаг → что смотреть. Лаг важен: между событием и цифрой в отчёте проходит время.
      </div>
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="фильтр: ставка, FX, CAPEX, дивиденды…"
        className="w-full bg-bg2 border border-border rounded px-2 py-1 text-xs text-text" />
      <div className="overflow-x-auto">
        <table className="w-full text-[11px] border-collapse">
          <thead className="text-text3 uppercase text-[10px]">
            <tr className="border-b border-border">
              <th className="text-left p-1.5">Фактор</th>
              <th className="text-left p-1.5">Канал</th>
              <th className="text-left p-1.5">В отчёте</th>
              <th className="text-left p-1.5 whitespace-nowrap">Лаг</th>
              <th className="text-left p-1.5">Что смотреть</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-border/40 align-top">
                <td className="p-1.5 text-text font-medium whitespace-nowrap">{r.factor}</td>
                <td className="p-1.5 text-text2">{r.channel}</td>
                <td className="p-1.5 text-text2 font-mono">{r.report}</td>
                <td className="p-1.5 text-text3 whitespace-nowrap">{r.lag}</td>
                <td className="p-1.5 text-text3">{r.watch}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && <div className="text-text3 text-xs">Ничего не найдено.</div>}
    </div>
  );
}

// Мастер-карта ставки ЦБ: как одно решение расходится по всей экономике.
// Ключевое — не сам уровень, а изменение траектории (forward, не spot).
function RateMap(){
  return (
    <details className="mt-3 border border-border rounded" open>
      <summary className="cursor-pointer px-3 py-2 text-text2 text-xs font-medium">
        Карта ставки ЦБ — как решение расходится по экономике
      </summary>
      <div className="px-3 pb-3 space-y-2">
        <div className="text-text3 text-[11px] leading-snug bg-s2/30 border border-border/60 rounded px-3 py-2">
          Рынок закладывает не текущую ставку, а <span className="text-text2">ожидаемую траекторию</span>. Снижение
          при ожидании ещё большего снижения — уже в цене. Смотри forward-кривую и риторику ЦБ, а не сам факт решения.
        </div>
        <pre className="text-[10.5px] leading-snug text-text2 font-mono whitespace-pre overflow-x-auto">{
`геополитика / инфляция ──► ЦБ меняет СТАВКУ и СИГНАЛ (траекторию)
        │
        ├──► БАНКИ
        │      ├─ фондирование дешевеет/дорожает ─► NIM ─► прибыль (лаг 1–3 кв.)
        │      ├─ качество заёмщиков ─► Cost of Risk ─► резервы (лаг 1–4 кв.)
        │      └─ рост портфеля ≠ хорошо ─► сколько капитала съел, какой ROE
        │
        ├──► КОМПАНИИ (долг)
        │      ├─ ставка ↓ ─► % расходы ↓ ─► Net income ↑ (лаг 1–4 кв., по мере рефинанса)
        │      └─ высокий ND/EBITDA ─► эффект сильнее и болезненнее
        │
        ├──► СПРОС
        │      ├─ кредит дешевле ─► ипотека/авто/розница ↑ (лаг 1–3 кв.)
        │      └─ премиальный сегмент чувствительнее к ставке
        │
        ├──► FX / ОБЛИГАЦИИ (реагируют ПЕРВЫМИ, почти сразу)
        │      ├─ дифференциал ставок ─► курс рубля
        │      └─ доходности ОФЗ ─► переоценка облигаций в портфелях
        │
        └──► ОЦЕНКА (ставка дисконтирования)
               └─ ставка ↓ ─► выше мультипликаторы ─► дороже акции
                              (эффект мгновенный, если траектория — новость)

петля: слабый рубль ─► инфляция ↑ ─► ЦБ держит/поднимает ставку ─► ...`
        }</pre>
        <div className="text-text3 text-[10px] italic">
          Дифференциал ставок и сигнал ЦБ двигают FX/облигации раньше, чем реальный сектор почувствует эффект в отчётах.
        </div>
      </div>
    </details>
  );
}
