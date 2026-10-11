// «Шаблоны кода» — разбор реальных методов проекта кусочками: подсветка +
// пояснение каждой части + «что на выходе». Цель — понять код и уметь
// править/встраивать. Слева список по группам, справа — выбранный шаблон.
// Шаблоны встроены (codeTemplates.js), подсветка своя (highlight.js), без зависимостей.

import { useState, useMemo } from 'react';
import { Copy, Check, ChevronRight, Code2, ArrowRight } from 'lucide-react';
import Card from '../components/ui/Card.jsx';
import { TEMPLATES, TEMPLATE_GROUPS } from '../data/codeTemplates.js';
import { tokenize, TOKEN_COLOR } from '../lib/highlight.js';
import { INDICATOR_COLORS as C } from '../lib/indicatorColors.js';

const LANG_LABEL = { js: 'JS', python: 'Python', sql: 'SQL' };
const LANG_COLOR = { js: C.orange, python: C.blue, sql: C.violet };

// Подсвеченный блок кода. Токены → span'ы с цветом из палитры.
function Code({ code, lang }){
  const tokens = useMemo(() => tokenize(code, lang), [code, lang]);
  return (
    <pre className="text-[12.5px] leading-[1.55] font-mono overflow-x-auto p-3 m-0 whitespace-pre"
      style={{ background: '#0E0720', borderRadius: 8 }}>
      <code>
        {tokens.map((t, i) => (
          <span key={i} style={{ color: TOKEN_COLOR[t.type] }}>{t.value}</span>
        ))}
      </code>
    </pre>
  );
}

function CopyBtn({ text }){
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1200); } catch(_){}
  };
  return (
    <button type="button" onClick={copy} title="Скопировать фрагмент"
      className="shrink-0 text-text3 hover:text-acc transition-colors">
      {done ? <Check size={14} style={{ color: C.bullish }} /> : <Copy size={14} />}
    </button>
  );
}

export default function CodeTemplates(){
  const [activeId, setActiveId] = useState(TEMPLATES[0].id);
  const [q, setQ] = useState('');
  const active = TEMPLATES.find(t => t.id === activeId) || TEMPLATES[0];

  // Фильтр по названию/описанию; пустые группы прячем.
  const groups = useMemo(() => {
    const query = q.trim().toLowerCase();
    return TEMPLATE_GROUPS.map(g => ({
      ...g,
      items: TEMPLATES.filter(t => t.group === g.id &&
        (!query || (t.title + ' ' + t.desc).toLowerCase().includes(query))),
    })).filter(g => g.items.length);
  }, [q]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Шаблоны кода</h1>
        <p className="text-text2 text-sm mt-1 max-w-3xl">
          Разбор реальных расчётов проекта по кусочкам: каждый фрагмент подсвечен, рядом — что он
          делает простыми словами и что получится на выходе. Чтобы понять «франкенштейна» и уметь
          править/встраивать своё. Фрагменты можно копировать.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-6 items-start">
        {/* левая колонка — навигация */}
        <div className="space-y-4 lg:sticky lg:top-4">
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="поиск по шаблонам…"
            className="bg-s2 border border-border rounded px-3 h-9 w-full text-sm text-text placeholder:text-text3" />
          <div className="space-y-4">
            {groups.map(g => (
              <div key={g.id}>
                <div className="text-[11px] uppercase tracking-wider text-text3 font-mono mb-1.5 px-1">{g.label}</div>
                <div className="space-y-0.5">
                  {g.items.map(t => {
                    const on = t.id === activeId;
                    return (
                      <button key={t.id} type="button" onClick={() => setActiveId(t.id)}
                        className={['w-full flex items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] transition-colors',
                          on ? 'bg-acc-dim text-acc' : 'text-text2 hover:text-text hover:bg-s2/60'].join(' ')}>
                        <ChevronRight size={13} className="shrink-0" style={{ opacity: on ? 1 : 0.4 }} />
                        <span className="flex-1 truncate">{t.title}</span>
                        <span className="shrink-0 text-[9px] font-mono px-1 rounded"
                          style={{ color: LANG_COLOR[t.lang], background: '#0E0720' }}>{LANG_LABEL[t.lang]}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            {!groups.length && <div className="text-text3 text-xs font-mono px-1">ничего не найдено</div>}
          </div>
        </div>

        {/* правая колонка — выбранный шаблон */}
        <div className="space-y-5 min-w-0">
          <Card>
            <div className="flex items-start gap-3">
              <Code2 size={20} className="shrink-0 mt-0.5" style={{ color: LANG_COLOR[active.lang] }} />
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-lg font-semibold text-text">{active.title}</h2>
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                    style={{ color: LANG_COLOR[active.lang], background: '#0E0720' }}>{LANG_LABEL[active.lang]}</span>
                </div>
                <p className="text-text2 text-sm mt-1.5">{active.desc}</p>
              </div>
            </div>
          </Card>

          {active.chunks.map((ch, i) => (
            <div key={i} className="bg-bg2 border border-border rounded-lg overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/60">
                <span className="text-[10px] font-mono text-text3">фрагмент {i + 1} / {active.chunks.length}</span>
                <div className="flex-1" />
                <CopyBtn text={ch.code} />
              </div>
              <Code code={ch.code} lang={active.lang} />
              <div className="px-4 py-3 space-y-2.5 border-t border-border/40">
                <div className="flex gap-2">
                  <span className="shrink-0 text-[11px] font-mono mt-0.5" style={{ color: C.violet }}>что делает</span>
                  <p className="text-text2 text-[13px] leading-relaxed">{ch.note}</p>
                </div>
                {ch.out && (
                  <div className="flex gap-2">
                    <ArrowRight size={13} className="shrink-0 mt-1" style={{ color: C.bullish }} />
                    <p className="text-[12.5px] leading-relaxed font-mono whitespace-pre-wrap" style={{ color: C.teal }}>{ch.out}</p>
                  </div>
                )}
              </div>
            </div>
          ))}

          <p className="text-text3 text-[11px] font-mono">
            Цвета: <span style={{ color: C.violet }}>ключевые слова</span> ·{' '}
            <span style={{ color: C.blue }}>вызовы функций</span> ·{' '}
            <span style={{ color: C.bullish }}>строки</span> ·{' '}
            <span style={{ color: C.orange }}>числа</span> ·{' '}
            <span style={{ color: C.gray }}>комментарии</span>.
          </p>
        </div>
      </div>
    </div>
  );
}
