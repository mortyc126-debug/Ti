// Адаптер для страницы «Карта». Возвращает массив точек-выпусков
// для surface-фита. Когда подъедет реальный backend-эндпоинт — здесь
// меняется одна функция, всё остальное продолжит работать.
//
// Сейчас источник: bondsMock из bondsCatalog.js + локальные хелперы
// для maturity/quality.

import { bondsMock } from './bondsCatalog.js';
import { qualityY, maturityYears } from '../lib/qualityComposite.js';

// Получить точки для surface-плоскости.
// yMode: 'rating' | 'scoring' | 'mix'.
// typeFilter: Set<string> или null (все).
export function loadBondPoints({ yMode = 'scoring', typeFilter = null } = {}){
  const out = [];
  for(const b of bondsMock){
    if(typeFilter && !typeFilter.has(b.type)) continue;
    const x = maturityYears(b.mat_date);
    const y = qualityY(b, yMode);
    const z = b.ytm;
    if(x == null || y == null || z == null) continue;
    out.push({
      // Исходные поля для тултипа и кликов.
      secid:    b.secid,
      name:     b.name,
      issuer:   b.issuer,
      type:     b.type,
      rating:   b.rating,
      industry: b.industry,
      volumeBn: b.volume_bn,
      // Координаты для регрессии.
      x, y, z,
    });
  }
  return out;
}

// Будущая точка интеграции с backend. Сейчас — заглушка.
//   import { api } from '../api.js';
//   const r = await api.bondSnapshot();
//   return r.bonds.map(toPoint);
export async function loadBondPointsAsync(opts){
  return loadBondPoints(opts);
}
