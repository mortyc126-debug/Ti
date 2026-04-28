// UI-состояние «Карты»: режим Y, фильтры по типу/рейтингу/сроку,
// hover/selected точка. Persist — только настройки фильтров (не
// hover/selected, они эфемерны).

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

const initial = {
  yMode: 'scoring',                   // rating | scoring | mix
  types: { ofz: true, corporate: true, municipal: true, exchange: true },
  // Диапазоны рейтинга (по нашему ординалу 0..100).
  ratingMin: 30,
  ratingMax: 100,
  // Диапазон срока (годы).
  matMin: 0,
  matMax: 20,
  // Полоса ядра: настраиваемо в UI «Поверхность · параметры».
  bwX: 1.2,    // годы
  bwY: 12,     // пунктов качества
  // Показывать ли фоновую тепловую карту.
  showHeatmap: true,
  // Изолинии E[YTM] поверх heatmap.
  showContours: true,
  // Режим визуализации высоты (residual'а):
  //   'flat'    — точки на плоскости, цвет = z-score (исходный вид)
  //   'sticks'  — стержни от плоскости с приподнятой головкой
  //   'horizon' — взгляд «от нулевой линии»: X = срок (или качество),
  //               Y = residual в bps. 0 = поверхность; точки выше
  //               торчат как горы, ниже — «утонули» под уровень.
  viewMode: 'sticks',
  // Что развёрнуто по горизонтали в режиме 'horizon'.
  horizonX: 'maturity',  // 'maturity' | 'quality'
};

export const useMarketSurface = create(
  persist(
    (set, get) => ({
      ...initial,
      hoverId: null,        // secid под мышью
      selectedId: null,     // выбранный кликом

      setYMode(m){ set({ yMode: m }); },
      toggleType(t){ set({ types: { ...get().types, [t]: !get().types[t] } }); },
      setRange(field, value){ set({ [field]: value }); },
      setBandwidth(axis, value){
        if(axis === 'x') set({ bwX: value });
        else set({ bwY: value });
      },
      toggleHeatmap(){ set({ showHeatmap: !get().showHeatmap }); },
      toggleContours(){ set({ showContours: !get().showContours }); },
      setViewMode(m){ set({ viewMode: m }); },
      setHorizonX(x){ set({ horizonX: x }); },
      setHover(id){ set({ hoverId: id }); },
      setSelected(id){ set({ selectedId: id }); },
      reset(){ set({ ...initial, hoverId: null, selectedId: null }); },
    }),
    {
      name: 'bondan_market_surface',
      version: 1,
      partialize: (s) => ({
        yMode: s.yMode, types: s.types,
        ratingMin: s.ratingMin, ratingMax: s.ratingMax,
        matMin: s.matMin, matMax: s.matMax,
        bwX: s.bwX, bwY: s.bwY,
        showHeatmap: s.showHeatmap, showContours: s.showContours,
        viewMode: s.viewMode, horizonX: s.horizonX,
      }),
    }
  )
);
