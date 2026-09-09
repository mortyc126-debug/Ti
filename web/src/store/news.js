// Новости по эмитентам — снимок web/public/news-cache.json (из
// invest-bot/make_news_cache.py). Грузим один раз, отдаём по тикеру.

import { create } from 'zustand';

let _started = false;

export const useNewsStore = create((set, get) => ({
  items: null,          // null — ещё не грузили; [] — загружено пусто
  loading: false,
  load: async () => {
    if(_started) return;
    _started = true;
    set({ loading: true });
    try {
      const r = await fetch('/news-cache.json');
      const d = r.ok ? await r.json() : [];
      set({ items: Array.isArray(d) ? d : [], loading: false });
    } catch {
      set({ items: [], loading: false });
    }
  },
}));

// Новости для эмитента: по тикеру (точное совпадение первого слова).
export function newsForTicker(items, ticker){
  if(!items || !ticker) return [];
  const tk = String(ticker).trim().split(/\s+/)[0].toUpperCase();
  if(!tk) return [];
  return items.filter(n => String(n.ticker || '').toUpperCase() === tk);
}
