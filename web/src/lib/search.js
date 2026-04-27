import Fuse from 'fuse.js';
import { MOCK_CATALOG } from '../data/mockCatalog.js';

// Глобальный fuzzy-поиск по каталогу. Пока работает на embedded mock,
// потом подменим источник на /catalog от Worker (структура та же).
// Три отдельных индекса — компании / облигации / акции, чтобы можно
// было показывать результаты сгруппированно и ранжировать каждую
// группу независимо.

const _idx = {
  issuers: new Fuse(MOCK_CATALOG.issuers, {
    keys: ['name', 'ticker', 'inn', 'aliases'],
    threshold: 0.4,
    includeScore: true,
    ignoreLocation: true,
  }),
  bonds: new Fuse(MOCK_CATALOG.bonds, {
    keys: ['name', 'isin'],
    threshold: 0.4,
    includeScore: true,
    ignoreLocation: true,
  }),
  stocks: new Fuse(MOCK_CATALOG.stocks, {
    keys: ['name', 'ticker'],
    threshold: 0.4,
    includeScore: true,
    ignoreLocation: true,
  }),
};

export function searchCatalog(query, limit){
  const q = (query || '').trim();
  const lim = limit || 5;
  if(!q){
    // пустой запрос — показываем «топ» каждой группы (просто первые)
    return {
      issuers: MOCK_CATALOG.issuers.slice(0, lim),
      bonds:   MOCK_CATALOG.bonds.slice(0, lim),
      stocks:  MOCK_CATALOG.stocks.slice(0, lim),
    };
  }
  const take = arr => arr.slice(0, lim).map(r => r.item);
  return {
    issuers: take(_idx.issuers.search(q)),
    bonds:   take(_idx.bonds.search(q)),
    stocks:  take(_idx.stocks.search(q)),
  };
}

export function findIssuerByInn(inn){
  return MOCK_CATALOG.issuers.find(x => x.inn === inn) || null;
}
export function findIssuerByTicker(ticker){
  return MOCK_CATALOG.issuers.find(x => x.ticker === ticker) || null;
}
