// UI-состояние «Карты». Сейчас единственный режим — «Горизонт»:
// X = configurable (срок / рейтинг / один мультипликатор / композит),
// Y = residual (отклонение от поверхности E[YTM]).

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

const initial = {
  yMode: 'scoring',                   // влияет на фит поверхности (квартиль quality)
  types: { ofz: true, corporate: true, municipal: true, exchange: true },
  ratingMin: 30,
  ratingMax: 100,
  matMin: 0,
  matMax: 20,
  bwX: 1.2,
  bwY: 12,
  // Конфигурация X-оси горизонта:
  //   'maturity'   — срок до погашения, лет
  //   'rating'     — кредитный рейтинг (ord 0..100)
  //   'multiplier' — один выбранный мультипликатор
  //   'composite'  — композит из набора (sum-перцентиль или
  //                  последовательная воронка по нормам отрасли)
  horizonX: 'maturity',
  horizonMultiplier: 'icr',
  horizonMetrics: ['safety', 'bqi'],
  horizonMode: 'sum',                 // 'sum' | 'sequential'
};

export const useMarketSurface = create(
  persist(
    (set, get) => ({
      ...initial,
      hoverId: null,
      selectedId: null,

      setYMode(m){ set({ yMode: m }); },
      toggleType(t){ set({ types: { ...get().types, [t]: !get().types[t] } }); },
      setRange(field, value){ set({ [field]: value }); },
      setBandwidth(axis, value){
        if(axis === 'x') set({ bwX: value });
        else set({ bwY: value });
      },

      setHorizonX(x){ set({ horizonX: x }); },
      setHorizonMultiplier(id){ set({ horizonMultiplier: id }); },
      toggleHorizonMetric(id){
        const cur = get().horizonMetrics;
        const next = cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id];
        set({ horizonMetrics: next });
      },
      setHorizonMode(m){ set({ horizonMode: m }); },

      setHover(id){ set({ hoverId: id }); },
      setSelected(id){ set({ selectedId: id }); },
      reset(){ set({ ...initial, hoverId: null, selectedId: null }); },
    }),
    {
      name: 'bondan_market_surface',
      version: 2,
      partialize: (s) => ({
        yMode: s.yMode, types: s.types,
        ratingMin: s.ratingMin, ratingMax: s.ratingMax,
        matMin: s.matMin, matMax: s.matMax,
        bwX: s.bwX, bwY: s.bwY,
        horizonX: s.horizonX, horizonMultiplier: s.horizonMultiplier,
        horizonMetrics: s.horizonMetrics, horizonMode: s.horizonMode,
      }),
      // При апгрейде с v1 (где были viewMode / showHeatmap / showContours)
      // — отбрасываем старые поля. Дефолты подставятся из initial.
      migrate: (persisted) => {
        if(!persisted) return undefined;
        const out = { ...persisted };
        delete out.viewMode;
        delete out.showHeatmap;
        delete out.showContours;
        return out;
      },
    }
  )
);
