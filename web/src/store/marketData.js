// Стор реальной вселенной облигаций для «Карты». Грузит один раз (цены
// /bond/latest + фундамент из стора issuers), кеширует в localStorage (TTL 6ч),
// фолбэк — демо-каталог bondsMock. Компоненты зовут useBondUniverse() (в
// рендере) и currentBonds() (вне рендера). Статус для плашки — useBondSource().

import { useEffect } from 'react';
import { create } from 'zustand';
import { loadRealBonds } from '../data/marketReal.js';
import { bondsMock } from '../data/bondsCatalog.js';
import { useIssuersStore } from './issuers.js';

const CACHE_KEY = 'ba_bonds_universe_v2';   // v2: в записях появился inn
const TTL = 6 * 3600e3;

export const useBondStore = create((set, get) => ({
  bonds: null,          // реальные выпуски (null → используем демо)
  loading: false,
  error: null,
  source: 'mock',       // 'mock' | 'cache' | 'live'

  load: async () => {
    if(get().loading || get().bonds) return;
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
