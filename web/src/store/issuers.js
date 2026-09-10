// Общий стор эмитентов (страница «Отрасли»). Грузит с backend ВСЕ годовые
// отчёты каждого эмитента ([{year, std, mults}]), кеширует в localStorage
// (TTL 6ч), фолбэк на мок. Плюс глобальный выбор ВИНТАЖА: год + тип
// отчётности → из сырья резолвится плоский список карточек (как getAllIssuers),
// чтобы было видно/выбираемо, за какой год сравниваем. Компоненты зовут
// useIssuers() (в рендере) / currentIssuers() (в обработчиках);
// контрол винтажа — useVintage().

import { useEffect } from 'react';
import { create } from 'zustand';
import { loadIssuersReal } from '../data/issuersReal.js';
import { getAllIssuers } from '../data/issuersMock.js';

const MOCK = getAllIssuers();
const CACHE_KEY = 'ba_issuers_raw_v14';  // v14: словарь issuer-names.json (из MOEX); v13: снимок облигаций
const TTL = 6 * 3600e3;

// выбрать отчёт эмитента под (год, тип); reps уже отсортированы по убыванию
function pickReport(reps, year, std){
  let cand = reps;
  if(std && std !== 'any') cand = cand.filter(r => r.std === std);
  if(!cand.length) return null;
  if(year === 'latest') return cand[0];
  return cand.find(r => r.year === year) || null;   // строго тот год (чистый срез)
}

// сырьё [{id,name,...,reports:[{year,std,mults}]}] + (год,тип) → плоские карточки
function resolve(raw, year, std){
  const out = [];
  for(const iss of raw){
    const rep = pickReport(iss.reports || [], year, std);
    if(!rep) continue;
    out.push({
      id: iss.id, inn: iss.inn, name: iss.name, ticker: iss.ticker,
      industry: iss.industry, kinds: iss.kinds,
      mults: rep.mults, reportYear: rep.year, reportStd: rep.std,
      reportDaysAgo: null, sampleSecid: null,
    });
  }
  return out;
}

function yearsOf(raw){
  const s = new Set();
  for(const iss of raw) for(const r of (iss.reports || [])) s.add(r.year);
  return [...s].sort((a, b) => b - a);
}

export const useIssuersStore = create((set, get) => ({
  raw: null,
  issuers: null,       // резолвнутый плоский список под текущий винтаж
  years: [],
  year: 'latest',      // 'latest' | number
  std: 'any',          // 'any' | 'РСБУ' | 'МСФО'
  loading: false,
  error: null,
  source: 'mock',

  _apply: () => {
    const { raw, year, std } = get();
    if(raw) set({ issuers: resolve(raw, year, std) });
  },
  setYear: (year) => { set({ year }); get()._apply(); },
  setStd: (std) => { set({ std }); get()._apply(); },

  load: async () => {
    if(get().loading || get().raw) return;
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if(cached){
        const c = JSON.parse(cached);
        if(c && Date.now() - c.ts < TTL && Array.isArray(c.data) && c.data.length){
          set({ raw: c.data, years: yearsOf(c.data), source: 'cache' });
          get()._apply();
          return;
        }
      }
    } catch(_){}
    set({ loading: true });
    try {
      const raw = await loadIssuersReal();
      if(raw && raw.length){
        set({ raw, years: yearsOf(raw), loading: false, source: 'backend', error: null });
        get()._apply();
        try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data: raw })); } catch(_){}
      } else {
        set({ loading: false, source: 'mock' });
      }
    } catch(e){
      set({ loading: false, error: String(e), source: 'mock' });
    }
  },
}));

export function useIssuers(){
  const issuers = useIssuersStore(s => s.issuers);
  const load = useIssuersStore(s => s.load);
  useEffect(() => { load(); }, [load]);
  return issuers ?? MOCK;
}

export function currentIssuers(){
  return useIssuersStore.getState().issuers ?? MOCK;
}

// хук для контрола винтажа (год + тип отчётности)
export function useVintage(){
  const year = useIssuersStore(s => s.year);
  const std = useIssuersStore(s => s.std);
  const years = useIssuersStore(s => s.years);
  const source = useIssuersStore(s => s.source);
  const loading = useIssuersStore(s => s.loading);
  const error = useIssuersStore(s => s.error);
  const count = useIssuersStore(s => s.issuers?.length ?? 0);
  const setYear = useIssuersStore(s => s.setYear);
  const setStd = useIssuersStore(s => s.setStd);
  return { year, std, years, source, loading, error, count, setYear, setStd };
}

// принудительная перезагрузка: сносим кэши эмитентов и тянем заново
export function reloadIssuers(){
  try {
    for(const k of Object.keys(localStorage)){
      if(k === CACHE_KEY || k.startsWith('ba_rep_') || k.startsWith('ba_issuers_')) {
        localStorage.removeItem(k);
      }
    }
  } catch(_){}
  useIssuersStore.setState({ raw: null, issuers: null, years: [], loading: false, error: null, source: 'mock' });
  useIssuersStore.getState().load();
}
