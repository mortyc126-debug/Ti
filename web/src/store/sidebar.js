import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Состояние глобального sidebar'а: свёрнут (только иконки) или
// развёрнут (иконки + подписи). Хранится в localStorage, чтобы
// сохранялось между сессиями.

export const useSidebar = create(
  persist(
    (set, get) => ({
      expanded: true,
      toggle(){ set({ expanded: !get().expanded }); },
      setExpanded(v){ set({ expanded: !!v }); },
    }),
    { name: 'bondan_sidebar', version: 1 }
  )
);
