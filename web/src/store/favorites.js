import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Избранное: сетка ячеек, в которые можно бросать карточки эмитентов.
// Каждая ячейка — { id, slot, kind, refId, title, ticker, ind } или
// пусто. Сейчас 12 ячеек 4×3 — достаточно для типичного watch-листа.

const TOTAL_SLOTS = 12;

export const useFavorites = create(
  persist(
    (set, get) => ({
      slots: Array.from({ length: TOTAL_SLOTS }, () => null),

      put(slot, item){
        const slots = [...get().slots];
        slots[slot] = item ? { ...item, addedAt: Date.now() } : null;
        set({ slots });
      },

      // Кладём в первую свободную ячейку. Возвращает индекс куда положили
      // или -1 если все заняты.
      add(item){
        const slots = [...get().slots];
        const idx = slots.findIndex(s => !s);
        if(idx < 0) return -1;
        // не дублируем по kind+refId
        const dup = slots.findIndex(s => s && s.kind === item.kind && s.refId === item.refId);
        if(dup >= 0) return dup;
        slots[idx] = { ...item, addedAt: Date.now() };
        set({ slots });
        return idx;
      },

      remove(slot){
        const slots = [...get().slots];
        slots[slot] = null;
        set({ slots });
      },

      move(from, to){
        const slots = [...get().slots];
        [slots[from], slots[to]] = [slots[to], slots[from]];
        set({ slots });
      },

      clear(){
        set({ slots: Array.from({ length: TOTAL_SLOTS }, () => null) });
      },
    }),
    { name: 'bondan_favorites', version: 1 }
  )
);
