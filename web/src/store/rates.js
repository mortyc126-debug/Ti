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

// Официальный ряд ключевой ставки ЦБ РФ: дата ВСТУПЛЕНИЯ В СИЛУ (следующий
// рабочий день после заседания) → ставка, %. Для догрузки «одной кнопкой».
export const CBR_CANON = [
  ['2021-10-25', 7.5], ['2021-12-20', 8.5], ['2022-02-14', 9.5], ['2022-02-28', 20],
  ['2022-04-11', 17], ['2022-05-04', 14], ['2022-05-27', 11], ['2022-06-14', 9.5],
  ['2022-07-25', 8], ['2022-09-19', 7.5], ['2023-07-24', 8.5], ['2023-08-15', 12],
  ['2023-09-18', 13], ['2023-10-30', 15], ['2023-12-18', 16], ['2024-07-29', 18],
  ['2024-09-16', 19], ['2024-10-28', 21], ['2025-06-09', 20], ['2025-07-28', 18],
  ['2025-09-15', 17], ['2025-10-27', 16.5], ['2025-12-22', 16], ['2026-02-16', 15.5],
  ['2026-03-23', 15], ['2026-04-27', 14.5], ['2026-06-22', 14.25], ['2026-07-27', 14],
  ['2026-09-14', 14],
];

// Текущая история как карта {date: rate}: канонический ключ «Долга», фолбэк —
// старый ключ отчётности.
function _asMap(){
  const m = {};
  for(const x of _collect()) m[x.d] = x.rate;
  return m;
}
// Записать карту обратно в канонический ключ (сортировка по дате) и отдать ряд.
function _writeMap(m, set){
  const lines = Object.keys(m).sort().map(d => d + ' ' + m[d]);
  try { localStorage.setItem(KEY_DEBT, lines.join('\n')); } catch(_){}
  const hist = _collect();
  const cur = hist[hist.length - 1] || null;
  set({ history: hist, current: cur ? cur.rate : null, asOf: cur ? cur.d : null, source: 'cbr' });
}

export const useRatesStore = create((set) => ({
  history: [], current: null, asOf: null, source: null,
  // Добавить/заменить запись «с даты d действует ставка rate» (держится до
  // следующей записи). Пишем в канонический ключ — подхватят все разделы.
  addEntry: (date, rate) => {
    const r = parseFloat(String(rate).replace(',', '.'));
    const d = String(date || '').slice(0, 10);
    if(!isFinite(r) || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
    const m = _asMap(); m[d] = r; _writeMap(m, set);
  },
  removeEntry: (date) => {
    const m = _asMap(); delete m[String(date || '').slice(0, 10)]; _writeMap(m, set);
  },
  // Догрузить официальный ряд ЦБ: добавляем только отсутствующие даты, свои
  // значения не перетираем.
  mergeCanon: () => {
    const m = _asMap();
    for(const [d, r] of CBR_CANON) if(!(d in m)) m[d] = r;
    _writeMap(m, set);
  },
  // Совместимость: «задать ставку на сегодня».
  setCurrent: (rate, date) => {
    const r = parseFloat(String(rate).replace(',', '.'));
    if(!isFinite(r)) return;
    const d = date || new Date().toISOString().slice(0, 10);
    const m = _asMap(); m[d] = r; _writeMap(m, set);
  },
  load: () => {
    let hist = _collect();
    if(hist.length){
      // Автодогрузка официального ряда ЦБ: если последняя сохранённая запись
      // старше последнего известного решения — добавляем недостающие даты
      // (свои значения не трогаем). Так КС не «залипает» на старой дате и не
      // требует ручного нажатия. Пишем только когда реально чего-то не хватает.
      const canonLast = CBR_CANON[CBR_CANON.length - 1][0];
      if(hist[hist.length - 1].d < canonLast){
        const m = _asMap(); let changed = false;
        for(const [d, r] of CBR_CANON) if(!(d in m)){ m[d] = r; changed = true; }
        if(changed){ _writeMap(m, set); return; }
      }
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
    addEntry: useRatesStore(s => s.addEntry),
    removeEntry: useRatesStore(s => s.removeEntry),
    mergeCanon: useRatesStore(s => s.mergeCanon),
  };
}
