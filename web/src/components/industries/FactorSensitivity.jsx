// «Драйверы»: как меняются показатели разных отраслей при изменении макро-
// фактора. Выбираешь фактор — видишь по каждой группе отраслей эффект
// (помогает/давит/нейтрально/неоднозначно), какой показатель двигается и почему.
// Можно сортировать/фильтровать по знаку эффекта.

import { useMemo, useState } from 'react';
import { FACTORS, effectsFor, EFFECT_META } from '../../lib/factorSensitivity.js';

const TONE = {
  green:  { badge: 'bg-green/15 text-green border-green/30', dot: 'text-green' },
  warn:   { badge: 'bg-warn/15 text-warn border-warn/30', dot: 'text-warn' },
  danger: { badge: 'bg-danger/15 text-danger border-danger/30', dot: 'text-danger' },
  text3:  { badge: 'bg-s2 text-text3 border-border', dot: 'text-text3' },
};
const SYM = { '+': '▲', '±': '◆', '~': '•', '-': '▼' };

export default function FactorSensitivity(){
  const [factorId, setFactorId] = useState(FACTORS[0].id);
  const [filter, setFilter] = useState('all');   // all|+|±|~|-
  const factor = FACTORS.find(f => f.id === factorId);
  const rows = useMemo(() => {
    const all = effectsFor(factorId).sort((a, b) => EFFECT_META[a.e].order - EFFECT_META[b.e].order);
    return filter === 'all' ? all : all.filter(r => r.e === filter);
  }, [factorId, filter]);

  return (
    <div className="space-y-3">
      <p className="text-text2 text-sm">
        Один фактор влияет на отрасли по-разному. Выбери фактор — увидишь, кому он помогает, кого давит, и через какой показатель. Это качественная карта причин, чтобы не судить обо всех «под одну гребёнку».
      </p>

      {/* Выбор фактора */}
      <div className="flex flex-wrap gap-1.5">
        {FACTORS.map(f => (
          <button key={f.id} type="button" onClick={() => setFactorId(f.id)}
            className={[
              'px-2.5 py-1 rounded text-xs border transition-colors',
              f.id === factorId ? 'bg-acc-dim text-acc border-acc/40' : 'bg-bg2 text-text2 border-border hover:text-text',
            ].join(' ')}>
            {f.label}
          </button>
        ))}
      </div>

      <div className="text-text3 text-xs bg-s2/30 border border-border/60 rounded px-3 py-2">{factor.desc}</div>

      {/* Фильтр по знаку эффекта */}
      <div className="flex items-center gap-1.5 text-xs">
        <span className="text-text3">показать:</span>
        {[['all', 'все'], ['+', 'помогает'], ['±', 'неоднозначно'], ['~', 'нейтрально'], ['-', 'давит']].map(([id, lbl]) => (
          <button key={id} type="button" onClick={() => setFilter(id)}
            className={[
              'px-2 py-0.5 rounded border text-[11px]',
              filter === id ? 'bg-acc-dim text-acc border-acc/40' : 'bg-bg2 text-text3 border-border hover:text-text',
            ].join(' ')}>{lbl}</button>
        ))}
      </div>

      {/* Матрица */}
      <div className="space-y-1.5">
        {rows.map(r => {
          const meta = EFFECT_META[r.e];
          const tone = TONE[meta.tone];
          return (
            <div key={r.groupId} className="flex items-start gap-3 bg-bg2 border border-border rounded px-3 py-2">
              <span className={`shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] font-mono ${tone.badge}`}
                    style={{ minWidth: 118 }}>
                <span>{SYM[r.e]}</span>{meta.label}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-text text-xs">
                  {r.groupLabel}
                  {r.metric && r.metric !== '—' && <span className="text-text3 ml-2 font-mono text-[10px]">→ {r.metric}</span>}
                </div>
                {r.note && <div className="text-text3 text-[11px] leading-snug mt-0.5">{r.note}</div>}
              </div>
            </div>
          );
        })}
        {!rows.length && <div className="text-text3 text-xs">Нет отраслей с таким эффектом для этого фактора.</div>}
      </div>

      <div className="text-text3 text-[10px] italic">
        Качественная оценка типовой реакции сектора, а не прогноз по конкретной компании — у отдельного эмитента может быть хедж, экспортная доля или структура долга, меняющие знак.
      </div>
    </div>
  );
}
