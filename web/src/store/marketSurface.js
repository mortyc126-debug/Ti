// UI-состояние карт по kind'ам. Раньше был один store на bonds —
// теперь отдельный для каждого таба (bonds / stocks / futures).
// Конфигурации почти совпадают, разные только дефолты горизонта и
// набор фильтров (срок есть у бондов, нет у акций; маркет-кап у
// акций есть, у бондов нет).

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

const COMMON = {
  yMode: 'scoring',                   // влияет на фит поверхности
  ratingMin: 30, ratingMax: 100,
  bwX: 1.2, bwY: 12,
  // Конфигурация X-оси горизонта.
  horizonX: 'maturity',               // переопределяется ниже
  horizonMultiplier: 'icr',
  horizonMetrics: ['safety', 'bqi'],
  horizonMode: 'sum',                 // 'sum' | 'sequential'
};

const BOND_DEFAULTS = {
  ...COMMON,
  types: { ofz: true, corporate: true, municipal: true, exchange: true },
  matMin: 0, matMax: 20,
  horizonX: 'maturity',
};

const STOCK_DEFAULTS = {
  ...COMMON,
  // У акций нет сроков и типов выпуска — есть капитализация.
  mktCapMin: 0, mktCapMax: 30000,    // млрд ₽
  horizonX: 'composite',
  horizonMetrics: ['roa', 'safety', 'bqi'],
};

const FUTURE_DEFAULTS = {
  ...COMMON,
  mktCapMin: 0, mktCapMax: 30000,
  horizonX: 'composite',
  horizonMetrics: ['roa', 'safety'],
};

function makeStore(name, defaults){
  return create(
    persist(
      (set, get) => ({
        ...defaults,
        hoverId: null,
        selectedId: null,

        setYMode(m){ set({ yMode: m }); },
        toggleType(t){ set({ types: { ...(get().types || {}), [t]: !(get().types?.[t]) } }); },
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
        reset(){ set({ ...defaults, hoverId: null, selectedId: null }); },
      }),
      {
        name, version: 3,
        partialize: (s) => {
          const { hoverId, selectedId, ...rest } = s;
          return rest;
        },
        migrate: (persisted) => {
          if(!persisted) return undefined;
          const out = { ...persisted };
          // снести устаревшие поля от старого общего стора
          delete out.viewMode;
          delete out.showHeatmap;
          delete out.showContours;
          delete out.horizonXOld;
          return out;
        },
      }
    )
  );
}

export const useMarketBonds   = makeStore('bondan_market_bonds',   BOND_DEFAULTS);
export const useMarketStocks  = makeStore('bondan_market_stocks',  STOCK_DEFAULTS);
export const useMarketFutures = makeStore('bondan_market_futures', FUTURE_DEFAULTS);
export const useMarketOverlay = makeStore('bondan_market_overlay', STOCK_DEFAULTS);

// Удобный хелпер: возвращает store hook по kind'у.
export function useMarketStore(kind){
  if(kind === 'stock')   return useMarketStocks;
  if(kind === 'future')  return useMarketFutures;
  if(kind === 'overlay') return useMarketOverlay;
  return useMarketBonds;
}

// Бэкап-совместимость: старый импорт useMarketSurface продолжает
// работать как bonds — внешние компоненты, которые ещё на нём, не
// упадут.
export const useMarketSurface = useMarketBonds;
