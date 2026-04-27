import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Последние просмотренные эмитенты/выпуски. Кладём при каждом open
// плавающего окна или клике в таблице. Храним 20 последних, без дублей
// (повторное открытие переносит запись наверх).

const MAX = 20;

export const useRecent = create(
  persist(
    (set, get) => ({
      items: [],

      push(item){
        if(!item || !item.kind || !item.refId) return;
        const items = get().items.filter(x => !(x.kind === item.kind && x.refId === item.refId));
        items.unshift({ ...item, at: Date.now() });
        set({ items: items.slice(0, MAX) });
      },

      clear(){ set({ items: [] }); },
    }),
    { name: 'bondan_recent', version: 1 }
  )
);
