// Центральный источник процентных ставок для всего веба. Ставки раньше жили
// врозь: модуль «Долг» хранит историю КС в localStorage['debt_kc_hist_v1']
// (текст «YYYY-MM-DD ставка»), отчётность — в ['bondan_cbr_history'] (JSON
// [{d,r}]). Оба — тот же origin (iframe-модули), поэтому читаем отсюда оба,
// берём более свежий ряд, фолбэк — среднегодовая из macro-cache.json.
// Компоненты зовут useKeyRate(); он же переподхватывает изменения из модулей
// (событие storage летит в родителя при записи во фрейме + на focus).
import { useEffect } from 'react';
import { create } from 'zustand';

const KEY_DEBT = 'debt_kc_hist_v1';     // модуль «Долг»
const KEY_REP  = 'bondan_cbr_history';  // модуль «Отчётность»

function _ls(k){ try { return localStorage.getItem(k); } catch(_) { return null; } }

function _parseDebt(txt){
  return String(txt || '').split('\n')
    .map(l => l.trim().match(/^(\d{4}-\d{2}-\d{2})\s+([\d.,]+)/))
    .filter(Boolean)
    .map(m => ({ d: m[1], rate: parseFloat(m[2].replace(',', '.')) }))
    .filter(x => isFinite(x.rate));
}
function _parseRep(raw){
  try {
    const a = JSON.parse(raw || '[]');
    return Array.isArray(a)
      ? a.filter(x => x && x.d && x.r != null).map(x => ({ d: x.d, rate: +x.r })).filter(x => isFinite(x.rate))
      : [];
  } catch(_) { return []; }
}
function _collect(){
  const a = _parseDebt(_ls(KEY_DEBT));   // канонический источник — модуль «Долг»
  const b = _parseRep(_ls(KEY_REP));     // старый ключ отчётности — фолбэк
  const hist = a.length ? a : b;
  return hist.slice().sort((x, y) => x.d < y.d ? -1 : 1);
}

export const useRatesStore = create((set) => ({
  history: [], current: null, asOf: null, source: null,
  // Задать актуальную КС на дату (по умолчанию сегодня) — дописываем запись в
  // канонический ключ «Долга», её тут же подхватывают все разделы. Так ставку
  // можно поправить, не заходя в «Долг».
  setCurrent: (rate, date) => {
    const r = parseFloat(String(rate).replace(',', '.'));
    if(!isFinite(r)) return;
    const d = date || new Date().toISOString().slice(0, 10);
    const prev = _ls(KEY_DEBT) || '';
    const line = d + ' ' + r;
    const next = prev && !/\n$/.test(prev) ? prev + '\n' + line : prev + line;
    try { localStorage.setItem(KEY_DEBT, next); } catch(_){}
    const hist = _collect();
    const cur = hist[hist.length - 1] || { rate: r, d };
    set({ history: hist, current: cur.rate, asOf: cur.d, source: 'cbr' });
  },
  load: () => {
    const hist = _collect();
    if(hist.length){
      const cur = hist[hist.length - 1];
      set({ history: hist, current: cur.rate, asOf: cur.d, source: 'cbr' });
      return;
    }
    // фолбэк: среднегодовая ключевая ставка из macro-cache
    fetch('/macro-cache.json').then(r => r.ok ? r.json() : null).then(m => {
      const rate = m && m.rate;
      if(rate && typeof rate === 'object'){
        const ys = Object.keys(rate).sort();
        const y = ys[ys.length - 1];
        set({ current: rate[y], asOf: y, source: 'macro-avg', history: ys.map(k => ({ d: k, rate: rate[k] })) });
      }
    }).catch(() => {});
  },
}));

// Хук: грузит и подписывается на изменения (модули пишут в localStorage).
export function useKeyRate(){
  const load = useRatesStore(s => s.load);
  useEffect(() => {
    load();
    const onStorage = e => { if(!e || e.key === KEY_DEBT || e.key === KEY_REP) load(); };
    const onFocus = () => load();
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', onFocus);
    return () => { window.removeEventListener('storage', onStorage); window.removeEventListener('focus', onFocus); };
  }, [load]);
  return {
    current: useRatesStore(s => s.current),
    asOf:    useRatesStore(s => s.asOf),
    source:  useRatesStore(s => s.source),
    history: useRatesStore(s => s.history),
    setCurrent: useRatesStore(s => s.setCurrent),
  };
}
