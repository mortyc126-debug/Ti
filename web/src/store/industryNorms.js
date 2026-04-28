// Сторе для пользовательских правок норм. Ключ — `${industry}/${metric}`,
// значение — { green, red } или { quartile } для percentileBased метрик.
// Тоггл автокалибровки тоже здесь.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const useIndustryNorms = create(
  persist(
    (set, get) => ({
      autocalibrate: true,
      overrides: {},   // { [`${industry}/${metric}`]: { green, red } }
      // Для percentileBased: квартиль, который считается «зелёной зоной».
      // 'top25' (default) | 'top50' | 'medianPlus'
      quartileMode: 'top25',

      setAutocalibrate(on){ set({ autocalibrate: !!on }); },
      setQuartileMode(m){ set({ quartileMode: m }); },

      setOverride(industryId, metricId, value){
        const key = `${industryId}/${metricId}`;
        const next = { ...get().overrides };
        if(value == null) delete next[key];
        else next[key] = { ...value };
        set({ overrides: next });
      },

      clearAll(){ set({ overrides: {} }); },
    }),
    { name: 'bondan_industry_norms', version: 1 }
  )
);
