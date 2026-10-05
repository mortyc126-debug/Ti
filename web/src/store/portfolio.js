// Стор реального портфеля из T-Invest API. Загружается по запросу (когда
// включён источник «Портфель» в «Сравнении»), кэшируется в памяти на сессию.
// Если токена нет или API недоступен — источник «Портфель» падает обратно
// на мок-портфель (mockPortfolio), чтобы ничего не ломалось.

import { create } from 'zustand';
import { loadTinvestPositions, tinvestToken } from '../data/tinvest.js';
import { positions as mockPositions } from '../data/mockPortfolio.js';

export const usePortfolioStore = create((set, get) => ({
  real: null,          // [{isin,ticker,name,type,qty,accounts}] | null (null → мок)
  loading: false,
  error: null,
  accounts: [],        // имена счетов, с которых собраны позиции
  loaded: false,       // пытались ли уже грузить в этой сессии

  load: async (force) => {
    if(get().loading) return;
    if(get().loaded && !force) return;
    if(!tinvestToken()){
      set({ real: null, loaded: true, loading: false, error: 'нет токена (введите его в разделе «Долг»)' });
      return;
    }
    set({ loading: true, error: null });
    const r = await loadTinvestPositions();
    if(r.ok){
      set({
        real: r.positions, accounts: r.accounts || [], loading: false, loaded: true,
        error: r.positions.length ? null : 'портфель пуст',
      });
    } else {
      set({ real: null, accounts: [], loading: false, loaded: true, error: r.reason });
    }
  },
}));

// Позиции для источника «портфель»: реальные (если загрузились) иначе мок.
// Форма мока: {isin,name,qty,issuer,ind}; реальные: {isin,ticker,name,qty,type}.
export function currentPortfolioPositions(){
  const real = usePortfolioStore.getState().real;
  return (real && real.length) ? real : mockPositions;
}

export function portfolioIsReal(){
  const s = usePortfolioStore.getState();
  return !!(s.real && s.real.length);
}
