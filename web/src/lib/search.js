import Fuse from 'fuse.js';
import { MOCK_CATALOG } from '../data/mockCatalog.js';
import { api } from '../api.js';

// Глобальный fuzzy-поиск по каталогу. При старте подгружает /catalog
// с бэка и кладёт в localStorage (TTL 1 час). Если бэк недоступен
// или каталог пустой — fallback на embedded mock, чтобы поиск
// продолжал работать.

const LS_KEY = 'bondan_catalog_v1';
const TTL_MS = 60 * 60 * 1000;

let _state = {
  catalog: null,           // {issuers, bonds, stocks}
  loading: null,           // Promise загрузки
  source: 'mock',          // 'mock' | 'api' | 'cache'
  generatedAt: null,
  index: null,             // {issuers, bonds, stocks} — три Fuse-индекса
  listeners: new Set(),
};

function buildIndex(catalog){
  return {
    issuers: new Fuse(catalog.issuers || [], {
      keys: ['name', 'short_name', 'ticker', 'inn', 'aliases'],
      threshold: 0.4, includeScore: true, ignoreLocation: true,
    }),
    bonds: new Fuse(catalog.bonds || [], {
      keys: ['name', 'isin'],
      threshold: 0.4, includeScore: true, ignoreLocation: true,
    }),
    stocks: new Fuse(catalog.stocks || [], {
      keys: ['name', 'ticker'],
      threshold: 0.4, includeScore: true, ignoreLocation: true,
    }),
  };
}

function setCatalog(catalog, source, generatedAt){
  _state.catalog = catalog;
  _state.index   = buildIndex(catalog);
  _state.source  = source;
  _state.generatedAt = generatedAt || new Date().toISOString();
  for(const cb of _state.listeners){ try { cb(); } catch(_){} }
}

// Стартовая инициализация: сначала встроенный mock (мгновенно), потом
// async-подгрузка свежего каталога с бэка с обновлением индекса.
function initOnce(){
  if(_state.catalog) return;

  // mock-каталог как мгновенный baseline
  setCatalog(MOCK_CATALOG, 'mock');

  // попробуем cache из localStorage — если свежее TTL, используем
  try {
    const raw = localStorage.getItem(LS_KEY);
    if(raw){
      const cached = JSON.parse(raw);
      const age = Date.now() - (cached.cachedAt || 0);
      if(age < TTL_MS && cached.catalog){
        setCatalog(cached.catalog, 'cache', cached.catalog.generatedAt);
      }
    }
  } catch(_){}

  // в любом случае идём за свежим
  if(!_state.loading){
    _state.loading = api.catalog()
      .then(c => {
        const isUseful = (c?.issuers?.length || 0) + (c?.bonds?.length || 0) + (c?.stocks?.length || 0) > 0;
        if(!isUseful) return; // пустой каталог — не затираем mock
        setCatalog(c, 'api', c.generatedAt);
        try { localStorage.setItem(LS_KEY, JSON.stringify({ cachedAt: Date.now(), catalog: c })); } catch(_){}
      })
      .catch(err => {
        // молча — оставляем то, что уже есть (mock или cache)
        console.warn('catalog fetch failed:', err.message);
      })
      .finally(() => { _state.loading = null; });
  }
}

initOnce();

export function searchCatalog(query, limit){
  if(!_state.catalog) initOnce();
  const q = (query || '').trim();
  const lim = limit || 5;
  const cat = _state.catalog;
  if(!q){
    return {
      issuers: (cat.issuers || []).slice(0, lim),
      bonds:   (cat.bonds   || []).slice(0, lim),
      stocks:  (cat.stocks  || []).slice(0, lim),
    };
  }
  const idx = _state.index;
  const take = arr => arr.slice(0, lim).map(r => r.item);
  return {
    issuers: take(idx.issuers.search(q)),
    bonds:   take(idx.bonds.search(q)),
    stocks:  take(idx.stocks.search(q)),
  };
}

export function findIssuerByInn(inn){
  if(!_state.catalog) initOnce();
  return (_state.catalog.issuers || []).find(x => x.inn === inn) || null;
}
export function findIssuerByTicker(ticker){
  if(!_state.catalog) initOnce();
  return (_state.catalog.issuers || []).find(x => x.ticker === ticker) || null;
}

// Метаинформация о каталоге — для индикатора в UI («📡 живой» / «📦 mock»).
export function getCatalogMeta(){
  return {
    source: _state.source,
    generatedAt: _state.generatedAt,
    counts: {
      issuers: _state.catalog?.issuers?.length || 0,
      bonds:   _state.catalog?.bonds?.length   || 0,
      stocks:  _state.catalog?.stocks?.length  || 0,
    },
  };
}

// Подписка на обновление каталога (когда async-fetch завершится).
export function subscribeCatalog(cb){
  _state.listeners.add(cb);
  return () => _state.listeners.delete(cb);
}
