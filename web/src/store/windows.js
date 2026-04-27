import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Менеджер «плавающих окон» эмитентов. Окно живёт поверх обычного
// роутинга; их может быть много одновременно — это и есть главная
// идея «рабочего стола». Состояние окна (позиция, размер, режим,
// активная вкладка) сериализуется в localStorage, чтобы при
// перезагрузке страницы окна возвращались туда, где их оставили.

const DEFAULT_SIZE = { medium: { w: 520, h: 640 }, micro: { w: 320, h: 220 } };
const STAGGER = 28; // смещение каждого нового окна, чтобы не клались точно друг на друга

let _seq = 1;
const nextId = () => `w${Date.now().toString(36)}-${_seq++}`;

export const useWindows = create(
  persist(
    (set, get) => ({
      windows: [],
      zTop: 1,

      open(payload){
        // payload: {kind: 'issuer'|'bond'|'stock', id, title, ticker?, mode?, tab?}
        const wins = get().windows;
        const same = wins.find(w => w.kind === payload.kind && w.id === payload.id);
        if(same){
          // если такое окно уже есть — поднимаем поверх и не плодим дубль
          // (для дубликата пользователь жмёт ⧉ внутри окна)
          get().focus(same.wid);
          return same.wid;
        }
        const mode = payload.mode || 'medium';
        const size = DEFAULT_SIZE[mode] || DEFAULT_SIZE.medium;
        const baseX = 80, baseY = 80;
        const offset = wins.length * STAGGER;
        const z = get().zTop + 1;
        const win = {
          wid: nextId(),
          kind: payload.kind,
          id: payload.id,
          title: payload.title || payload.id,
          ticker: payload.ticker || null,
          mode,
          tab: payload.tab || 'finances',
          tabState: {},
          x: baseX + offset, y: baseY + offset,
          w: size.w, h: size.h,
          z,
        };
        set({ windows: [...wins, win], zTop: z });
        return win.wid;
      },

      close(wid){ set({ windows: get().windows.filter(w => w.wid !== wid) }); },

      duplicate(wid){
        const src = get().windows.find(w => w.wid === wid);
        if(!src) return;
        const z = get().zTop + 1;
        const copy = { ...src, wid: nextId(), x: src.x + STAGGER, y: src.y + STAGGER, z };
        set({ windows: [...get().windows, copy], zTop: z });
      },

      focus(wid){
        const z = get().zTop + 1;
        set({
          windows: get().windows.map(w => w.wid === wid ? { ...w, z } : w),
          zTop: z,
        });
      },

      setMode(wid, mode){
        const size = DEFAULT_SIZE[mode];
        set({
          windows: get().windows.map(w => {
            if(w.wid !== wid) return w;
            // при смене режима подгоняем размер только если он близок к
            // предыдущему дефолту — иначе уважаем пользовательский resize
            const prev = DEFAULT_SIZE[w.mode];
            const userResized = prev && (Math.abs(w.w - prev.w) > 16 || Math.abs(w.h - prev.h) > 16);
            return userResized
              ? { ...w, mode }
              : { ...w, mode, w: size?.w || w.w, h: size?.h || w.h };
          }),
        });
      },

      patch(wid, updates){
        set({ windows: get().windows.map(w => w.wid === wid ? { ...w, ...updates } : w) });
      },

      setTab(wid, tab){ get().patch(wid, { tab }); },

      patchTabState(wid, partial){
        const w = get().windows.find(x => x.wid === wid);
        if(!w) return;
        get().patch(wid, { tabState: { ...w.tabState, ...partial } });
      },
    }),
    {
      name: 'bondan_windows',
      version: 1,
      // не пересохраняем seq и tabState слишком агрессивно — этого достаточно
      partialize: s => ({ windows: s.windows, zTop: s.zTop }),
    }
  )
);
