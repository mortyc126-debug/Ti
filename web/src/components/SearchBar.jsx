import { useEffect, useRef, useState } from 'react';
import { searchCatalog, findIssuerByTicker } from '../lib/search.js';
import { useWindows } from '../store/windows.js';

// Глобальный поиск в шапке. Дебаунс 120мс, дропдаун с тремя группами
// (Компании / Облигации / Акции). Клик на компанию → открывает окно
// эмитента; кнопка «сравнить» → добавляет в сравнение (TODO);
// кнопка «в портфель» рядом с выпуском → быстрое добавление (TODO).

const fmt = n => n == null ? '—' : (n >= 100 ? n.toFixed(2) : n.toFixed(2));

export default function SearchBar(){
  const [q, setQ] = useState('');
  const [results, setResults] = useState({ issuers: [], bonds: [], stocks: [] });
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);
  const openWin = useWindows(s => s.open);

  // дебаунс ввода
  useEffect(() => {
    const t = setTimeout(() => {
      setResults(searchCatalog(q, 5));
    }, 120);
    return () => clearTimeout(t);
  }, [q]);

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

  function openIssuer(iss){
    openWin({ kind: 'issuer', id: iss.inn, title: iss.name, ticker: iss.ticker, mode: 'medium' });
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

  const hasAny = results.issuers.length || results.bonds.length || results.stocks.length;

  return (
    <div ref={wrapRef} className="relative flex-1 max-w-xl">
      <div className="flex items-center gap-2 bg-bg2 border border-border rounded px-3 h-9 focus-within:border-acc">
        <span className="text-text3 text-sm">🔍</span>
        <input
          ref={inputRef}
          type="text"
          placeholder="Поиск: компания, тикер, ISIN…  ( / )"
          className="flex-1 bg-transparent outline-none text-sm text-text placeholder-text3"
          value={q}
          onChange={e => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
        />
        {q && (
          <button
            className="text-text3 hover:text-text text-sm"
            onClick={() => { setQ(''); inputRef.current?.focus(); }}
            title="Очистить"
          >✕</button>
        )}
      </div>

      {open && (
        <div className="absolute left-0 right-0 mt-1 bg-bg2 border border-border rounded shadow-2xl z-50 max-h-[70vh] overflow-y-auto">
          {!hasAny && (
            <div className="px-4 py-3 text-text3 text-sm">Ничего не найдено</div>
          )}

          {results.issuers.length > 0 && (
            <Group title="Компании">
              {results.issuers.map(iss => (
                <Row key={iss.inn} onClick={() => openIssuer(iss)}>
                  <span className="text-text3">🏢</span>
                  <span className="flex-1 text-text truncate">{iss.name}</span>
                  {iss.ticker && <span className="text-text2 font-mono text-xs">{iss.ticker}</span>}
                  <ActionBtn onClick={(e) => { e.stopPropagation(); /* TODO compare */ }} title="Добавить в сравнение">⚖</ActionBtn>
                </Row>
              ))}
            </Group>
          )}

          {results.bonds.length > 0 && (
            <Group title="Облигации">
              {results.bonds.map(b => (
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

          {results.stocks.length > 0 && (
            <Group title="Акции">
              {results.stocks.map(s => (
                <Row key={s.ticker} onClick={() => openStock(s)}>
                  <span className="text-text3">📈</span>
                  <span className="font-mono text-text2 text-xs w-12">{s.ticker}</span>
                  <span className="flex-1 text-text truncate">{s.name}</span>
                  <span className="font-mono text-text text-xs w-16 text-right">{fmt(s.price)}</span>
                  <span className={`font-mono text-xs w-16 text-right ${s.changePct >= 0 ? 'text-green' : 'text-danger'}`}>
                    {s.changePct >= 0 ? '▲' : '▼'} {Math.abs(s.changePct).toFixed(2)}%
                  </span>
                </Row>
              ))}
            </Group>
          )}
        </div>
      )}
    </div>
  );
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
