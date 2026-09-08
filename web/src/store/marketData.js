// Стор реальной вселенной облигаций для «Карты». Грузит один раз (цены
// /bond/latest + фундамент из стора issuers), кеширует в localStorage (TTL 6ч),
// фолбэк — демо-каталог bondsMock. Компоненты зовут useBondUniverse() (в
// рендере) и currentBonds() (вне рендера). Статус для плашки — useBondSource().

import { useEffect } from 'react';
import { create } from 'zustand';
import { loadRealBonds, loadRealStocks, loadRealFutures } from '../data/marketReal.js';
import { bondsMock } from '../data/bondsCatalog.js';
import { stocksMock, futuresMock } from '../data/stocksMock.js';
import { useIssuersStore } from './issuers.js';

const CACHE_KEY = 'ba_bonds_universe_v3';   // v3: mults не бейкаем (винтаж на рендере)
const TTL = 6 * 3600e3;

export const useBondStore = create((set, get) => ({
  bonds: null,          // реальные выпуски (null → используем демо)
  loading: false,
  error: null,
  source: 'mock',       // 'mock' | 'cache' | 'live'

  load: async () => {
    if(get().loading || get().bonds) return;
    // фундамент (mults) пришивается к точкам по инн из стора эмитентов —
    // грузим его в любом случае, даже если бонды берём из кеша
    try { useIssuersStore.getState().load(); } catch(_){}
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if(cached){
        const c = JSON.parse(cached);
        if(c && Date.now() - c.ts < TTL && Array.isArray(c.data) && c.data.length){
          set({ bonds: c.data, source: 'cache' });
          return;
        }
      }
    } catch(_){}
    set({ loading: true });
    try {
      // фундамент нужен для join'а по инн — дождёмся стора эмитентов
      await useIssuersStore.getState().load();
      const bonds = await loadRealBonds();
      if(bonds && bonds.length){
        set({ bonds, loading: false, source: 'live', error: null });
        try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data: bonds })); } catch(_){}
      } else {
        set({ loading: false, source: 'mock' });
      }
    } catch(e){
      set({ loading: false, error: String(e), source: 'mock' });
    }
  },
}));

// массив выпусков для фита: реальные либо демо
export function currentBonds(){
  return useBondStore.getState().bonds ?? bondsMock;
}

// хук: триггерит загрузку и ре-рендер, когда данные подъедут
export function useBondUniverse(){
  const bonds = useBondStore(s => s.bonds);
  const load = useBondStore(s => s.load);
  useEffect(() => { load(); }, [load]);
  return bonds ?? bondsMock;
}

export function useBondSource(){
  const source = useBondStore(s => s.source);
  const loading = useBondStore(s => s.loading);
  const error = useBondStore(s => s.error);
  const count = useBondStore(s => s.bonds?.length ?? 0);
  return { source, loading, error, count };
}

export function reloadBonds(){
  try { localStorage.removeItem(CACHE_KEY); } catch(_){}
  useBondStore.setState({ bonds: null, loading: false, error: null, source: 'mock' });
  useBondStore.getState().load();
}

// ── АКЦИИ ─────────────────────────────────────────────────────────────
const STOCK_CACHE_KEY = 'ba_stocks_universe_v1';

export const useStockStore = create((set, get) => ({
  stocks: null, loading: false, error: null, source: 'mock',
  load: async () => {
    if(get().loading || get().stocks) return;
    try { useIssuersStore.getState().load(); } catch(_){}
    try {
      const cached = localStorage.getItem(STOCK_CACHE_KEY);
      if(cached){
        const c = JSON.parse(cached);
        if(c && Date.now() - c.ts < TTL && Array.isArray(c.data) && c.data.length){
          set({ stocks: c.data, source: 'cache' }); return;
        }
      }
    } catch(_){}
    set({ loading: true });
    try {
      const stocks = await loadRealStocks();
      if(stocks && stocks.length){
        set({ stocks, loading: false, source: 'live', error: null });
        try { localStorage.setItem(STOCK_CACHE_KEY, JSON.stringify({ ts: Date.now(), data: stocks })); } catch(_){}
      } else { set({ loading: false, source: 'mock' }); }
    } catch(e){ set({ loading: false, error: String(e), source: 'mock' }); }
  },
}));

export function currentStocks(){ return useStockStore.getState().stocks ?? stocksMock; }
export function useStockUniverse(){
  const stocks = useStockStore(s => s.stocks);
  const load = useStockStore(s => s.load);
  useEffect(() => { load(); }, [load]);
  return stocks ?? stocksMock;
}
export function useStockSource(){
  const source = useStockStore(s => s.source);
  const loading = useStockStore(s => s.loading);
  const count = useStockStore(s => s.stocks?.length ?? 0);
  return { source, loading, count };
}
export function reloadStocks(){
  try { localStorage.removeItem(STOCK_CACHE_KEY); } catch(_){}
  useStockStore.setState({ stocks: null, loading: false, error: null, source: 'mock' });
  useStockStore.getState().load();
}

// ── ФЬЮЧЕРСЫ ───────────────────────────────────────────────────────────
const FUT_CACHE_KEY = 'ba_futures_universe_v1';

export const useFutureStore = create((set, get) => ({
  futures: null, loading: false, error: null, source: 'mock',
  load: async () => {
    if(get().loading || get().futures) return;
    try { useStockStore.getState().load(); } catch(_){}   // фьючу нужен спот акции
    try {
      const cached = localStorage.getItem(FUT_CACHE_KEY);
      if(cached){
        const c = JSON.parse(cached);
        if(c && Date.now() - c.ts < TTL && Array.isArray(c.data) && c.data.length){
          set({ futures: c.data, source: 'cache' }); return;
        }
      }
    } catch(_){}
    set({ loading: true });
    try {
      const futures = await loadRealFutures();
      if(futures && futures.length){
        set({ futures, loading: false, source: 'live', error: null });
        try { localStorage.setItem(FUT_CACHE_KEY, JSON.stringify({ ts: Date.now(), data: futures })); } catch(_){}
      } else { set({ loading: false, source: 'mock' }); }
    } catch(e){ set({ loading: false, error: String(e), source: 'mock' }); }
  },
}));

export function currentFutures(){ return useFutureStore.getState().futures ?? futuresMock; }
export function useFutureUniverse(){
  const futures = useFutureStore(s => s.futures);
  const load = useFutureStore(s => s.load);
  useEffect(() => { load(); }, [load]);
  return futures ?? futuresMock;
}
export function useFutureSource(){
  const source = useFutureStore(s => s.source);
  const loading = useFutureStore(s => s.loading);
  const count = useFutureStore(s => s.futures?.length ?? 0);
  return { source, loading, count };
}
export function reloadFutures(){
  try { localStorage.removeItem(FUT_CACHE_KEY); } catch(_){}
  useFutureStore.setState({ futures: null, loading: false, error: null, source: 'mock' });
  useFutureStore.getState().load();
}
