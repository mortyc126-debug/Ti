// Сторе для страницы «Сравнение». Содержит:
// - selected: упорядоченный массив { id, kind, visible } выбранных
//   эмитентов (kind = 'stock'|'bond'|'future');
// - sources: чек-боксы источников { recent, portfolio, favorites,
//   industry, all };
// - industryFilter: id отрасли при source=industry;
// - filters: { [metricId]: { min, max, dir } } — как в Bonds;
// - topN: { mode: 'sum'|'sequential', metrics: string[], n: number };
// - showLayer: { stock, bond, future } — видимость слоёв радара.
//
// Undo/redo: каждая мутация толкает snapshot в `history`. cursor
// показывает текущую позицию. undo/redo двигают cursor.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

const HIST_LIMIT = 50;

const initialState = {
  selected: [],                    // [{ id, kind, visible }]
  sources: {
    recent: true,
    portfolio: true,
    favorites: false,
    industry: false,
    all: false,
  },
  industryFilter: null,
  filters: {},                     // { metricId: { min, max, dir } }
  topN: { mode: 'sum', metrics: ['safety'], n: 20 },
  showLayer: { stock: true, bond: true, future: false },
};

// Снимок только мутируемой части состояния (без истории).
function snapshot(s){
  return {
    selected: s.selected.map(x => ({ ...x })),
    sources: { ...s.sources },
    industryFilter: s.industryFilter,
    filters: JSON.parse(JSON.stringify(s.filters)),
    topN: { ...s.topN, metrics: [...s.topN.metrics] },
    showLayer: { ...s.showLayer },
  };
}

function applySnapshot(target, snap){
  return { ...target, ...snap };
}

export const useComparison = create(
  persist(
    (set, get) => ({
      ...initialState,
      history: [snapshot(initialState)],
      cursor: 0,

      // Внутренний хелпер: применить мутацию + запушить snapshot.
      _push(mutator){
        const before = snapshot(get());
        const next = mutator({ ...before });
        const hist = get().history.slice(0, get().cursor + 1);
        hist.push(snapshot(next));
        const overflow = Math.max(0, hist.length - HIST_LIMIT);
        const newHist = hist.slice(overflow);
        set({
          ...applySnapshot(get(), next),
          history: newHist,
          cursor: newHist.length - 1,
        });
      },

      // Добавить эмитента (если уже есть — toggle visible).
      addIssuer(id, kind){
        get()._push(s => {
          const existing = s.selected.find(x => x.id === id && x.kind === kind);
          if(existing){
            existing.visible = !existing.visible;
          } else {
            s.selected.push({ id, kind, visible: true });
          }
          return s;
        });
      },

      removeIssuer(id, kind){
        get()._push(s => {
          s.selected = s.selected.filter(x => !(x.id === id && x.kind === kind));
          return s;
        });
      },

      toggleVisible(id, kind){
        get()._push(s => {
          const it = s.selected.find(x => x.id === id && x.kind === kind);
          if(it) it.visible = !it.visible;
          return s;
        });
      },

      replaceSelected(items){
        get()._push(s => {
          s.selected = items.map(x => ({ id: x.id, kind: x.kind, visible: true }));
          return s;
        });
      },

      setSource(name, on){
        get()._push(s => { s.sources[name] = !!on; return s; });
      },

      setIndustryFilter(id){
        get()._push(s => { s.industryFilter = id || null; return s; });
      },

      setFilter(metricId, value){
        get()._push(s => {
          if(value == null || (value.min === '' && value.max === '' && value.dir === 'both')){
            delete s.filters[metricId];
          } else {
            s.filters[metricId] = { ...value };
          }
          return s;
        });
      },

      setTopN(patch){
        get()._push(s => {
          s.topN = { ...s.topN, ...patch };
          return s;
        });
      },

      toggleLayer(kind){
        get()._push(s => { s.showLayer[kind] = !s.showLayer[kind]; return s; });
      },

      reset(){
        const snap = snapshot(initialState);
        const hist = get().history.slice(0, get().cursor + 1);
        hist.push(snap);
        set({
          ...initialState,
          history: hist.slice(Math.max(0, hist.length - HIST_LIMIT)),
          cursor: Math.min(hist.length - 1, HIST_LIMIT - 1),
        });
      },

      // Undo/redo не пушат новый snapshot — только сдвигают cursor.
      undo(){
        const c = get().cursor;
        if(c <= 0) return;
        const snap = get().history[c - 1];
        set({ ...applySnapshot(get(), snap), cursor: c - 1 });
      },
      redo(){
        const c = get().cursor;
        const h = get().history;
        if(c >= h.length - 1) return;
        const snap = h[c + 1];
        set({ ...applySnapshot(get(), snap), cursor: c + 1 });
      },

      canUndo(){ return get().cursor > 0; },
      canRedo(){ return get().cursor < get().history.length - 1; },
    }),
    {
      name: 'bondan_comparison',
      version: 1,
      // History тоже сохраняется — undo переживает перезагрузку страницы.
      partialize: (s) => ({
        selected: s.selected, sources: s.sources, industryFilter: s.industryFilter,
        filters: s.filters, topN: s.topN, showLayer: s.showLayer,
        history: s.history, cursor: s.cursor,
      }),
    }
  )
);
