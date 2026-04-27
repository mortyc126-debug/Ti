import { useEffect, useMemo, useRef, useState } from 'react';
import { searchCatalog, findIssuerByTicker, subscribeCatalog } from '../lib/search.js';
import { suggestMetrics } from '../lib/metrics.js';
import { parseQuery, applyConditions, trailingAlias } from '../lib/queryParser.js';
import { useWindows } from '../store/windows.js';

// Глобальный поиск в шапке. Работает в трёх режимах:
//   1. Пусто/буквы           → fuzzy по названию (Компании / Облигации / Акции).
//   2. Префикс метрики (EB)  → дропдаун подсказок шаблонов условий
//                              (EBITDA > __, ND/EBITDA < __, ...).
//   3. Запрос с условиями    → парсер вытаскивает условия (YTM > 20%,
//                              срок < 2 лет), фильтрует каталог,
//                              остаток строки идёт в fuzzy.
// Шорткат «/» — фокус на поиск из любого места.

const fmtNum = n => n == null ? '—' : n.toFixed(2);

export default function SearchBar(){
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);
  const openWin = useWindows(s => s.open);

  // парсер строки + результаты — пересчитываются по q. useMemo чтобы
  // не делать debounce: операции лёгкие (regex + fuse, 1мс на ввод).
  const view = useMemo(() => buildView(q), [q]);

  // когда каталог обновится с бэка — форсируем re-render через q-trick.
  // (изменяем не сам q, а форсируем перерасчёт через subscribeCatalog).
  const [, setTick] = useState(0);
  useEffect(() => subscribeCatalog(() => setTick(t => t + 1)), []);

  // закрытие по клику вне дропдауна
  useEffect(() => {
    function onDoc(e){
      if(!wrapRef.current) return;
      if(!wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  // глобальный шорткат «/» фокусит поиск
  useEffect(() => {
    function onKey(e){
      if(e.key === '/' && document.activeElement?.tagName !== 'INPUT'
                       && document.activeElement?.tagName !== 'TEXTAREA'){
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
      if(e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  function applySuggestion(metric){
    // вставляем шаблон условия на место «хвостового» алиаса. Например,
    // строка «нло EB» → «нло EBITDA > ». Курсор в конец.
    const trimmed = q.replace(/\s+$/, '');
    const tail = trailingAlias(trimmed);
    const head = tail ? trimmed.slice(0, trimmed.length - tail.alias.length).trimEnd() : trimmed;
    const opSuggest = pickDefaultOp(metric);
    const unitSuffix = metric.unit === '%' ? ' %' : (metric.unit === 'years' ? ' лет' : '');
    const next = (head ? head + ' ' : '') + metric.label + ` ${opSuggest} `;
    setQ(next + unitSuffix);
    setOpen(true);
    inputRef.current?.focus();
    // курсор перед суффиксом единицы
    requestAnimationFrame(() => {
      const el = inputRef.current; if(!el) return;
      const pos = next.length;
      try { el.setSelectionRange(pos, pos); } catch(_){}
    });
  }

  function openIssuer(iss){
    openWin({ kind: 'issuer', id: iss.inn, title: iss.name || iss.short_name, ticker: iss.ticker, mode: 'medium' });
    setOpen(false);
  }
  function openBond(b){
    openWin({ kind: 'bond', id: b.isin, title: b.name, mode: 'medium', tab: 'overview' });
    setOpen(false);
  }
  function openStock(s){
    const iss = findIssuerByTicker(s.ticker);
    if(iss) openWin({ kind: 'issuer', id: iss.inn, title: iss.name, ticker: s.ticker, mode: 'medium', tab: 'papers' });
    else    openWin({ kind: 'stock', id: s.ticker, title: s.name, ticker: s.ticker, mode: 'medium' });
    setOpen(false);
  }

  return (
    <div ref={wrapRef} className="relative flex-1 max-w-xl">
      <div className="flex items-center gap-2 bg-bg2 border border-border rounded px-3 h-9 focus-within:border-acc">
        <span className="text-text3 text-sm">🔍</span>
        <input
          ref={inputRef}
          type="text"
          placeholder="Поиск: компания, тикер, или фильтр (YTM > 20%, ICR < 1.5)…   /"
          className="flex-1 bg-transparent outline-none text-sm text-text placeholder-text3"
          value={q}
          onChange={e => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
        />
        {view.activeConditions.length > 0 && (
          <span className="text-acc font-mono text-[10px] uppercase tracking-wider whitespace-nowrap">
            {view.activeConditions.length} фильтр{plural(view.activeConditions.length, 'а', 'ов', '')}
          </span>
        )}
        {q && (
          <button
            className="text-text3 hover:text-text text-sm"
            onClick={() => { setQ(''); inputRef.current?.focus(); }}
            title="Очистить"
          >✕</button>
        )}
      </div>

      {open && (
        <div className="absolute left-0 right-0 mt-1 bg-bg2 border border-border rounded shadow-2xl z-50 max-h-[75vh] overflow-y-auto">
          {/* предложения метрик — показываем когда юзер начал набирать */}
          {view.suggestions.length > 0 && (
            <Group title="Подставить условие">
              {view.suggestions.map(m => (
                <Row key={m.key} onClick={() => applySuggestion(m)}>
                  <span className="text-text3">{m.scope === 'issuer' ? '📊' : m.scope === 'stock' ? '📈' : '📄'}</span>
                  <span className="font-mono text-text">{m.label}</span>
                  <span className="text-text3 text-xs flex-1 truncate">— {m.full}</span>
                  <span className="text-text2 font-mono text-[10px] uppercase tracking-wider">
                    {pickDefaultOp(m)} {m.unit ? unitHint(m.unit) : ''}
                  </span>
                </Row>
              ))}
            </Group>
          )}

          {/* активные условия (бейджи) */}
          {view.activeConditions.length > 0 && (
            <div className="px-3 py-2 bg-bg border-b border-border flex flex-wrap gap-1.5">
              {view.activeConditions.map((c, i) => (
                <span key={i} className="font-mono text-[11px] px-2 py-0.5 rounded bg-acc-dim text-acc">
                  {c.metric.label} {c.op} {fmtCondValue(c)}
                </span>
              ))}
              {view.unsupportedConds.length > 0 && (
                <span className="font-mono text-[11px] px-2 py-0.5 rounded bg-warn/20 text-warn">
                  ⚠ {view.unsupportedConds.length} услов{plural(view.unsupportedConds.length, 'ие', 'ий', 'ия')} ждут отчётов
                </span>
              )}
            </div>
          )}

          {/* нет результатов */}
          {!view.suggestions.length && !view.hasAny && (
            <div className="px-4 py-3 text-text3 text-sm">Ничего не найдено</div>
          )}

          {/* группы результатов */}
          {view.results.issuers.length > 0 && (
            <Group title={`Компании · ${view.results.issuers.length}`}>
              {view.results.issuers.map(iss => (
                <Row key={iss.inn} onClick={() => openIssuer(iss)}>
                  <span className="text-text3">🏢</span>
                  <span className="flex-1 text-text truncate">{iss.short_name || iss.name}</span>
                  {iss.ticker && <span className="text-text2 font-mono text-xs">{iss.ticker}</span>}
                  <ActionBtn onClick={(e) => { e.stopPropagation(); /* TODO compare */ }} title="Добавить в сравнение">⚖</ActionBtn>
                </Row>
              ))}
            </Group>
          )}

          {view.results.bonds.length > 0 && (
            <Group title={`Облигации · ${view.results.bonds.length}`}>
              {view.results.bonds.map(b => (
                <Row key={b.isin} onClick={() => openBond(b)}>
                  <span className="text-text3">📄</span>
                  <span className="flex-1 text-text truncate">{b.name}</span>
                  <span className="text-text3 font-mono text-xs">{b.isin}</span>
                  {b.ytm != null && <span className="text-acc font-mono text-xs w-12 text-right">{b.ytm.toFixed(1)}%</span>}
                  <ActionBtn onClick={(e) => { e.stopPropagation(); /* TODO add to portfolio */ }} title="В портфель">＋</ActionBtn>
                </Row>
              ))}
            </Group>
          )}

          {view.results.stocks.length > 0 && (
            <Group title={`Акции · ${view.results.stocks.length}`}>
              {view.results.stocks.map(s => (
                <Row key={s.ticker} onClick={() => openStock(s)}>
                  <span className="text-text3">📈</span>
                  <span className="font-mono text-text2 text-xs w-12">{s.ticker}</span>
                  <span className="flex-1 text-text truncate">{s.name}</span>
                  <span className="font-mono text-text text-xs w-16 text-right">{fmtNum(s.price)}</span>
                  {s.changePct != null && (
                    <span className={`font-mono text-xs w-16 text-right ${s.changePct >= 0 ? 'text-green' : 'text-danger'}`}>
                      {s.changePct >= 0 ? '▲' : '▼'} {Math.abs(s.changePct).toFixed(2)}%
                    </span>
                  )}
                </Row>
              ))}
            </Group>
          )}
        </div>
      )}
    </div>
  );
}

// Сборка состояния выпадашки на основе текста запроса. Один проход:
//   1. парсим запрос → {conditions, freeText}.
//   2. строим suggestions из freeText (или из «хвостового» слова если
//      нет полного матча).
//   3. fuzzy по freeText → results.
//   4. фильтруем bonds/stocks по conditions (только реализованные scope).
function buildView(q){
  const trimmed = (q || '').trim();
  const { conditions, freeText } = parseQuery(trimmed);

  // 1) Подсказки метрик: показываем если есть «недописанный» алиас в
  //    конце или freeText короткий и не нашёл результатов
  let suggestions = [];
  const tail = trailingAlias(trimmed);
  if(tail){
    // если хвост — точный алиас, предложим шаблоны условий для этой метрики
    suggestions = [tail.metric, ...suggestMetrics(tail.alias, 5).filter(m => m.key !== tail.metric.key)].slice(0, 6);
  } else if(freeText && freeText.length >= 2 && !/\d/.test(freeText)){
    // префикс типа «EB» или «лик» — ищем по началу алиасов
    const lastWord = freeText.split(/[\s,;]+/).pop();
    if(lastWord && lastWord.length >= 2){
      suggestions = suggestMetrics(lastWord, 6);
    }
  }
  // не предлагаем подсказки если уже есть готовые условия (юзер закончил)
  if(conditions.length > 0 && !tail) suggestions = [];

  // 2) Базовые fuzzy-результаты по тексту
  const baseQuery = freeText && !suggestions.length ? freeText : (freeText || '');
  const base = searchCatalog(baseQuery, 12);

  // 3) Применяем условия. Для issuers пока нет resolver'ов → они
  //    остаются в unsupportedConds, фильтр не применяется.
  const bondsR  = applyConditions(base.bonds,  conditions.filter(c => c.metric.scope === 'bond'));
  const stocksR = applyConditions(base.stocks, conditions.filter(c => c.metric.scope === 'stock'));

  // если нет freeText но есть условия — берём весь каталог под фильтр
  let issuers = base.issuers, bonds = bondsR.matched, stocks = stocksR.matched;
  if(!baseQuery && conditions.length){
    const all = searchCatalog('', 1000);
    bonds  = applyConditions(all.bonds,  conditions.filter(c => c.metric.scope === 'bond')).matched;
    stocks = applyConditions(all.stocks, conditions.filter(c => c.metric.scope === 'stock')).matched;
    issuers = all.issuers;
  }

  // ограничим по 8 строк в выводе
  bonds  = bonds.slice(0, 8);
  stocks = stocks.slice(0, 8);
  issuers = issuers.slice(0, 6);

  // unsupported = метрики эмитентов без resolver (issuer-scope ещё нет в данных)
  const unsupportedConds = conditions.filter(c => c.metric.scope === 'issuer');

  return {
    suggestions,
    activeConditions: conditions,
    unsupportedConds,
    results: { issuers, bonds, stocks },
    hasAny: issuers.length || bonds.length || stocks.length,
  };
}

function pickDefaultOp(m){
  // эвристика: для % и x по умолчанию ставим > если это «хорошая» метрика,
  // < для «плохой» (ND/EBITDA, D/E). Не всегда угадывает — но для
  // 90% случаев человек дальше может поправить < на > одной клавишей.
  const lowerIsBetter = ['nd_ebitda', 'de', 'debt_assets', 'ttm', 'cash_ratio'].includes(m.key);
  return lowerIsBetter ? '<' : '>';
}

function unitHint(unit){
  if(unit === '%') return '__%';
  if(unit === 'x') return '__×';
  if(unit === 'years') return '__ лет';
  if(unit === 'days') return '__ дней';
  if(unit === 'rub') return '__ млрд';
  return '__';
}

function fmtCondValue(c){
  const v = c.value;
  const u = c.metric.unit;
  if(u === '%') return v + '%';
  if(u === 'x') return v + '×';
  if(u === 'years') return v.toFixed(1) + ' лет';
  return v;
}

function plural(n, one, many, two){
  const m10 = n % 10, m100 = n % 100;
  if(m100 >= 11 && m100 <= 14) return many;
  if(m10 === 1) return one;
  if(m10 >= 2 && m10 <= 4) return two;
  return many;
}

function Group({ title, children }){
  return (
    <div className="border-b border-border last:border-0">
      <div className="px-3 pt-2 pb-1 text-text3 text-[10px] font-mono uppercase tracking-widest">{title}</div>
      <div>{children}</div>
    </div>
  );
}

function Row({ onClick, children }){
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-s2 text-left"
    >
      {children}
    </button>
  );
}

function ActionBtn({ onClick, title, children }){
  return (
    <span
      onClick={onClick}
      title={title}
      className="px-1.5 py-0.5 text-xs text-text3 hover:text-acc hover:bg-acc-dim rounded cursor-pointer"
    >{children}</span>
  );
}
