// Стор реального портфеля из T-Invest API. Загружается по запросу (когда
// включён источник «Портфель» в «Сравнении»), кэшируется в памяти на сессию.
// Если токена нет или API недоступен — источник «Портфель» падает обратно
// на мок-портфель (mockPortfolio), чтобы ничего не ломалось.

import { create } from 'zustand';
import { loadTinvestPositions, tinvestToken } from '../data/tinvest.js';
import { positions as mockPositions } from '../data/mockPortfolio.js';

// Сетевой сбой из браузера к invest-public-api.tinkoff.ru почти всегда =
// браузер не доверяет сертификату Т-Банка (российский УЦ Минцифры не
// установлен). Подсказываем это прямо, а не «Failed to fetch».
function _friendlyError(reason){
  const r = String(reason || '');
  if(r === 'no-token') return 'нет токена (введите в разделе «Долг»)';
  if(/Failed to fetch|таймаут|NetworkError|load failed|cert|CERT/i.test(r)){
    return 'нет связи с T-API — сетевой сбой или сертификат Минцифры; нажмите «Обновить из T-API»';
  }
  return r;
}

export const usePortfolioStore = create((set, get) => ({
  real: null,          // [{isin,ticker,name,type,qty,accounts}] | null (null → мок)
  loading: false,
  error: null,
  accounts: [],        // имена счетов, с которых собраны позиции
  loaded: false,       // пытались ли уже грузить в этой сессии

  load: async (force, _retried) => {
    if(get().loading) return;
    // Успешную загрузку кэшируем (loaded=true), но на ОШИБКЕ loaded не
    // ставим — чтобы повторное открытие «Портфеля» пробовало снова, а не
    // залипало на разовом сетевом сбое с сообщением про сертификат.
    if(get().loaded && !force) return;
    if(!tinvestToken()){
      set({ real: null, loaded: true, loading: false, error: 'нет токена (введите его в разделе «Долг»)' });
      return;
    }
    set({ loading: true, error: null });
    let r;
    try {
      r = await loadTinvestPositions();
    } catch(e){
      r = { ok: false, reason: String(e && e.message || e) };
    }
    if(r.ok){
      set({
        real: r.positions, accounts: r.accounts || [], loading: false, loaded: true,
        error: r.positions.length ? null : 'портфель пуст',
      });
      return;
    }
    // Сбой. Один авто-ретрай на сетевую ошибку (часто разовый дроп),
    // потом показываем ошибку, но loaded оставляем false — переоткрытие
    // раздела попробует снова.
    const netlike = /Failed to fetch|таймаут|NetworkError|load failed/i.test(String(r.reason || ''));
    if(netlike && !_retried){
      set({ loading: false });
      setTimeout(() => { try { get().load(true, true); } catch(_){} }, 1500);
      return;
    }
    set({ real: null, accounts: [], loading: false, loaded: false, error: _friendlyError(r.reason) });
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
