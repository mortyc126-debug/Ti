// Клиент к нашему Cloudflare Worker'у.
//
// В dev-режиме (npm run dev) Vite-прокси перенаправляет /api/* на
// production-Worker (см. vite.config.js). В продакшене (на Pages)
// читаем явный URL из переменной окружения VITE_BACKEND_URL.

const BACKEND = import.meta.env.VITE_BACKEND_URL || '/api';

async function req(path, init){
  const url = BACKEND + path;
  const r = await fetch(url, init);
  if(!r.ok){
    let msg = `${r.status} ${r.statusText}`;
    try { const j = await r.json(); if(j?.error) msg += ' — ' + j.error; } catch(_){}
    throw new Error(msg);
  }
  return r.json();
}

export const api = {
  status: ()                 => req('/status'),
  stockLatest: (limit = 50)  => req(`/stock/latest?limit=${limit}`),
  futuresLatest: (asset)     => req(`/futures/latest${asset ? `?asset=${asset}` : ''}`),
  basis: (asset)             => req(`/basis?asset=${asset}`),
  basisHistory: (asset)      => req(`/basis/history?asset=${asset}`),
  bondLatest: (params = {})  => {
    const q = new URLSearchParams(params).toString();
    return req(`/bond/latest${q ? '?' + q : ''}`);
  },
  bondHistory: (secid)       => req(`/bond/history?secid=${secid}`),
  bondIssuer: (inn)          => req(`/bond/issuer?inn=${inn}`),
  catalog: ()                => req('/catalog'),
  issuerCard: (inn)          => req(`/issuer/${encodeURIComponent(inn)}`),
};
