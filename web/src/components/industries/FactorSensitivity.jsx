// «Драйверы»: как меняются показатели разных отраслей при изменении макро-
// фактора. Выбираешь фактор — видишь по каждой группе отраслей эффект
// (помогает/давит/нейтрально/неоднозначно), какой показатель двигается и почему.
// Можно сортировать/фильтровать по знаку эффекта.

import { useMemo, useState } from 'react';
import { FACTORS, effectsFor, factorsForGroup, EFFECT_META } from '../../lib/factorSensitivity.js';
import { NORM_GROUPS } from '../../data/industryNorms.js';

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
        {[['factor', 'По фактору'], ['sector', 'По отрасли']].map(([id, lbl]) => (
          <button key={id} type="button" onClick={() => { setMode(id); setFilter('all'); }}
            className={[
              'px-3 py-1 text-xs transition-colors',
              mode === id ? 'bg-acc-dim text-acc' : 'bg-bg2 text-text3 hover:text-text',
            ].join(' ')}>{lbl}</button>
        ))}
      </div>

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
    </div>
  );
}
