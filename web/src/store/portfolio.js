// Стор реального портфеля из T-Invest API. Последний успешный снимок
// кэшируется в localStorage и показывается СРАЗУ при открытии — до любой
// сетевой загрузки, вместо мока (позиции за пару часов не меняются).
// Мок остаётся только как запасной вариант, когда снимка ещё нет вообще.
// Фоновое обновление запускается при входе; на ошибке кэш не затирается.

import { create } from 'zustand';
import { loadTinvestPositions, tinvestToken } from '../data/tinvest.js';
import { positions as mockPositions } from '../data/mockPortfolio.js';

// ── Кэш последнего снимка ─────────────────────────────────────────────
const CACHE_KEY = 'ba_portfolio_real_v1';
function _cacheLoad(){
  try {
    const o = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if(o && Array.isArray(o.positions) && o.positions.length) return o;
  } catch(_){}
  return null;
}
function _cacheSave(positions, accounts){
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ positions, accounts: accounts || [], savedAt: Date.now() })); } catch(_){}
}

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

const _boot = _cacheLoad();

export const usePortfolioStore = create((set, get) => ({
  // Стартуем с кэша: real сразу не null → UI показывает последнее
  // состояние, а не мок. savedAt — когда снимок сделан; fresh — обновляли
  // ли мы его по сети в этой сессии.
  real: _boot ? _boot.positions : null,
  accounts: _boot ? (_boot.accounts || []) : [],
  cachedAt: _boot ? (_boot.savedAt || null) : null,
  fresh: false,
  loading: false,
  error: null,
  loaded: false,       // пытались ли уже грузить в этой сессии

  load: async (force, _retried) => {
    if(get().loading) return;
    // Успешную загрузку кэшируем (loaded=true), но на ОШИБКЕ loaded не
    // ставим — чтобы повторное открытие «Портфеля» пробовало снова, а не
    // залипало на разовом сетевом сбое с сообщением про сертификат.
    if(get().loaded && !force) return;
    if(!tinvestToken()){
      // Токена нет — но кэш (если есть) оставляем на экране, не роняем в мок.
      set({ loaded: true, loading: false, error: 'нет токена (введите его в разделе «Долг»)' });
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
      _cacheSave(r.positions, r.accounts || []);
      set({
        real: r.positions, accounts: r.accounts || [], loading: false, loaded: true,
        cachedAt: Date.now(), fresh: true,
        error: r.positions.length ? null : 'портфель пуст',
      });
      return;
    }
    // Сбой. Один авто-ретрай на сетевую ошибку (часто разовый дроп),
    // потом показываем ошибку, но loaded оставляем false — переоткрытие
    // раздела попробует снова. real/кэш НЕ трогаем — на экране остаётся
    // последнее сохранённое состояние.
    const netlike = /Failed to fetch|таймаут|NetworkError|load failed/i.test(String(r.reason || ''));
    if(netlike && !_retried){
      set({ loading: false });
      setTimeout(() => { try { get().load(true, true); } catch(_){} }, 1500);
      return;
    }
    set({ loading: false, loaded: false, error: _friendlyError(r.reason) });
  },
}));

// Позиции для источника «портфель»: реальные (свежие или из кэша) иначе мок.
// Форма мока: {isin,name,qty,issuer,ind}; реальные: {isin,ticker,name,qty,type}.
export function currentPortfolioPositions(){
  const real = usePortfolioStore.getState().real;
  return (real && real.length) ? real : mockPositions;
}

export function portfolioIsReal(){
  const s = usePortfolioStore.getState();
  return !!(s.real && s.real.length);
}
