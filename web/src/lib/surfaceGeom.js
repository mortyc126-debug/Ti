// Геометрия для видов поверхности: проекции 2D ↔ псевдо-3D
// (axonometric) и marching squares для изолиний.

// Аксонометрический «скос»: плоскость как бы наклонена «от себя» —
// верхние строки уходят в глубину направо, всё сжимается по вертикали.
// alpha = коэф. сдвига (X получает +alpha·Y), beta = сжатие по Y.
//
// Обычные координаты на плоскости (sx, sy) → экранные (xx, yy):
//   xx = sx + alpha * (innerHeight - (sy - top)) ≈ sx + alpha*(sy_top_relative)
//   yy = top + (sy - top) * beta
// где top = верхний отступ, innerHeight = высота рабочей области.
//
// Подбираем так, чтобы (top + innerHeight) совпало с базовой нижней
// границей plane'а, а верхняя строка ушла в правый-верхний угол.
export function makeProjection(viewMode, layout){
  const { padTop, padLeft, innerW, innerH } = layout;
  if(viewMode === 'iso'){
    // alpha задаём через долю innerW, чтобы скос был «адекватным»
    // независимо от размера. beta < 1 — сжатие плоскости.
    const alpha = 0.42;            // X-скос, относительно высоты
    const beta  = 0.55;            // сжатие плоскости по Y
    return {
      project: (sx, sy) => {
        const yRel = sy - padTop;                          // 0..innerH
        const xx = sx + alpha * (innerH - yRel);
        const yy = padTop + yRel * beta;
        return [xx, yy];
      },
      // Подъём «головки» точки над плоскостью на pixels (positive
      // residual → вверх, отрицательный → вниз/сквозь).
      lift: (sx, sy, pixels) => {
        const [xx, yy] = makeProjection('iso', layout).project(sx, sy);
        return [xx, yy - pixels];
      },
      isIso: true,
    };
  }
  // 'flat' и 'sticks' — без скоса.
  return {
    project: (sx, sy) => [sx, sy],
    lift: (sx, sy, pixels) => [sx, sy - pixels],
    isIso: false,
  };
}

// Marching squares: для значения level находим контурные сегменты
// по сетке gridZ (массив массивов). xs, ys — координаты узлов.
// Возвращает массив [{x1,y1,x2,y2}].
export function marchingSquares(grid, level){
  const { xs, ys, z } = grid;
  const NX = xs.length, NY = ys.length;
  const segs = [];

  // Линейная интерполяция по ребру между двумя углами.
  const lerp = (a, b, va, vb) => {
    if(va === vb) return a;
    return a + (b - a) * ((level - va) / (vb - va));
  };

  for(let i = 0; i < NX - 1; i++){
    for(let j = 0; j < NY - 1; j++){
      const x0 = xs[i],   x1 = xs[i+1];
      const y0 = ys[j],   y1 = ys[j+1];
      // Углы: 0=bottom-left (i,j), 1=bottom-right (i+1,j),
      //       2=top-right (i+1,j+1), 3=top-left (i,j+1).
      const v0 = z[i][j], v1 = z[i+1][j], v2 = z[i+1][j+1], v3 = z[i][j+1];
      if(v0 == null || v1 == null || v2 == null || v3 == null) continue;
      const b0 = v0 > level ? 1 : 0;
      const b1 = v1 > level ? 1 : 0;
      const b2 = v2 > level ? 1 : 0;
      const b3 = v3 > level ? 1 : 0;
      const idx = (b3 << 3) | (b2 << 2) | (b1 << 1) | b0;
      // Edge points: bottom (0-1), right (1-2), top (2-3), left (3-0).
      const ePoints = {
        bottom: () => [lerp(x0, x1, v0, v1), y0],
        right:  () => [x1, lerp(y0, y1, v1, v2)],
        top:    () => [lerp(x0, x1, v3, v2), y1],
        left:   () => [x0, lerp(y0, y1, v0, v3)],
      };
      const add = (a, b) => {
        const [ax, ay] = ePoints[a]();
        const [bx, by] = ePoints[b]();
        segs.push({ x1: ax, y1: ay, x2: bx, y2: by });
      };
      switch(idx){
        case 1:  add('left',  'bottom'); break;
        case 2:  add('bottom','right');  break;
        case 3:  add('left',  'right');  break;
        case 4:  add('top',   'right');  break;
        case 5:  add('left',  'top');    add('bottom','right'); break;  // saddle
        case 6:  add('bottom','top');    break;
        case 7:  add('left',  'top');    break;
        case 8:  add('left',  'top');    break;
        case 9:  add('bottom','top');    break;
        case 10: add('left',  'bottom'); add('top','right'); break;     // saddle
        case 11: add('top',   'right'); break;
        case 12: add('left',  'right');  break;
        case 13: add('bottom','right');  break;
        case 14: add('left',  'bottom'); break;
        default: break;
      }
    }
  }
  return segs;
}

// Сгенерировать набор уровней для контуров. Шаг подбираем так, чтобы
// ~6-8 линий накрывало весь диапазон.
export function contourLevels(grid){
  const flat = [];
  for(const col of grid.z){
    for(const v of col){
      if(v != null && isFinite(v)) flat.push(v);
    }
  }
  if(!flat.length) return [];
  flat.sort((a, b) => a - b);
  const min = flat[0], max = flat[flat.length - 1];
  const range = max - min;
  if(range <= 0) return [];
  // Шаг: округляем до «приятного» 1 / 2 / 5 (% YTM).
  const targetSteps = 7;
  const raw = range / targetSteps;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  let step;
  if(norm < 1.5) step = 1 * mag;
  else if(norm < 3) step = 2 * mag;
  else if(norm < 7) step = 5 * mag;
  else step = 10 * mag;
  const out = [];
  const start = Math.ceil(min / step) * step;
  for(let v = start; v <= max; v += step){
    out.push(+v.toFixed(2));
  }
  return out;
}
