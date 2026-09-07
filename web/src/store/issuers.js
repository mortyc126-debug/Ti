// Общий стор эмитентов для страницы «Сравнение» (и медиан/панели компаний).
// Один источник на всё приложение: грузит реальные карточки с backend один
// раз, кеширует в localStorage (TTL 1ч), при ошибке — тихий фолбэк на мок.
// Компоненты вместо getAllIssuers() зовут useIssuers() (в рендере) или
// currentIssuers() (в обработчиках).

import { useEffect } from 'react';
import { create } from 'zustand';
import { loadIssuersReal } from '../data/issuersReal.js';
import { getAllIssuers } from '../data/issuersMock.js';

const MOCK = getAllIssuers();
const CACHE_KEY = 'ba_issuers_real_v2';   // v2: все эмитенты + полные метрики
const TTL = 6 * 3600e3;

export const useIssuersStore = create((set, get) => ({
  issuers: null,       // null → ещё не загружено (отдаём мок)
  loading: false,
  error: null,
  source: 'mock',      // 'backend' | 'cache' | 'mock'
  load: async () => {
    if(get().loading || get().issuers) return;
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if(raw){
        const c = JSON.parse(raw);
        if(c && Date.now() - c.ts < TTL && Array.isArray(c.data) && c.data.length){
          set({ issuers: c.data, source: 'cache' });
          return;
        }
      }
    } catch(_){}
    set({ loading: true });
    try {
      const data = await loadIssuersReal();
      if(data && data.length){
        set({ issuers: data, loading: false, source: 'backend', error: null });
        try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data })); } catch(_){}
      } else {
        set({ loading: false, source: 'mock' });
      }
    } catch(e){
      set({ loading: false, error: String(e), source: 'mock' });
    }
  },
}));

// Хук для рендера: триггерит загрузку, отдаёт реальные данные или мок.
export function useIssuers(){
  const issuers = useIssuersStore(s => s.issuers);
  const load = useIssuersStore(s => s.load);
  useEffect(() => { load(); }, [load]);
  return issuers ?? MOCK;
}

// Для обработчиков (вне рендера): текущее значение без подписки.
export function currentIssuers(){
  return useIssuersStore.getState().issuers ?? MOCK;
}
