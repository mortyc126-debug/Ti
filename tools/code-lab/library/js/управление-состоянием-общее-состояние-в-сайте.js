import { create } from "zustand";

export const useСчёт = create((set) => ({
  значение: 0,
  плюс: () => set((s) => ({ значение: s.значение + 1 })),
}));

// в компоненте:  const n = useСчёт(s => s.значение);