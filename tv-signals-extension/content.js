/* content.js — «Сигнальные модели» поверх TradingView в Тинькофф-терминале.
 * Работает в MAIN-мире верхней страницы: тянется до графика через
 * iframe.contentWindow.tradingViewApi, берёт свечи из exportData(), считает
 * методы (SignalsCore) и рисует сигналы НАТИВНЫМИ фигурами (createShape),
 * привязанными к цене/времени. Панель показывает сигнал + точность по тикеру.
 * v1: без токена (данные из графика). Объёмные методы деградируют, если в
 * exportData нет объёма. */
(function () {
  'use strict';
  if (window.__tvSignals) return;

  const META = [
    ['zscore', 'Z-score', '#7CC7FF'], ['accel', 'Accel-fade', '#FF006E'],
    ['order_block', 'Order Block', '#FF9F40'], ['fvg', 'FVG', '#52F2C9'],
    ['liq_sweep', 'Liquidity Sweep', '#FF6A8B'], ['false_breakout', 'False Breakout', '#B45CFF'],
    ['vsa_abs', 'VSA Absorption', '#3DD9FF'], ['waning', 'Waning', '#FF8800'],
    ['talib_anti', 'Фейд свечей', '#A78BFA'], ['hawkes', 'Hawkes', '#7B61FF'],
    ['cascade', 'Cascade', '#B487F8'], ['nw', 'NW-память', '#9090BB'],
    ['alligator_inv', 'Аллигатор класс. (инв.)', '#E67E22'],
  ];
  const NAME = {}, DEF_COLOR = {}, IDX = {}; META.forEach(([id, n, c], i) => { NAME[id] = n; DEF_COLOR[id] = c; IDX[id] = i; });
  // описания для ℹ-окон: что делает · как читать знак · оговорка из прогонов бота
  const DESC = {
    zscore: { what: 'Rolling z-score: отклонение цены от среднего за 20 баров.', read: 'Контрарный возврат к среднему — цена высоко над средней → sell, глубоко под → buy.', note: 'Универсальный сигнал во всех режимах (OOS-подтверждён). Сильнее на менее ликвидных тикерах.' },
    accel: { what: 'Ускорение цены (2-я производная). Аномальный всплеск ПО тренду = климакс/истощение.', read: 'Фейд: сильное ускорение в сторону тренда → сигнал ПРОТИВ.', note: 'Гонтлет пройден (held-out +0.185 ATR). Эдж живёт при тейке 1.0/стопе 0.5; чувствителен к спреду — торгуй ликвид.' },
    order_block: { what: 'ICT Order Block: последняя противоположная свеча перед импульсом ≥1.2 ATR.', read: 'Возврат цены в зону блока → сигнал ПО направлению импульса (континуация).', note: 'Реальный сигнал, держится в OOS.' },
    fvg: { what: 'Fair Value Gap: 3-свечной гэп-имбаланс (свеча i−2 против i).', read: 'Возврат в гэп → сигнал ПО направлению гэпа (заполнение).', note: 'Универсальный сигнал, огромная выборка, работает во всех режимах.' },
    liq_sweep: { what: 'Снятие ликвидности: прокол 20-барного хая/лоя с закрытием обратно.', read: 'Контр: прокол вверх с возвратом → sell, вниз → buy.', note: 'В прогонах слабый/режимный; знак уже контрарный.' },
    false_breakout: { what: 'Ложный пробой: пробой 15-барного уровня с закрытием обратно за него.', read: 'Контр: провал пробоя вверх → sell, вниз → buy.', note: 'Режимный: + в up/ranging, − в down/stress. В OOS ослаб (anti→noise).' },
    vsa_abs: { what: 'VSA-поглощение: большой объём (≥1.8×) при крошечном размахе (≤0.7 ATR).', read: 'Усилие без результата → сигнал ПРОТИВ тела свечи (разворот).', note: 'Нужен объём. In-sample топ, но OOS не подтвердил — доверять осторожно.' },
    waning: { what: 'Затухание импульса: 3 свечи в одну сторону с убывающими телами.', read: 'Против гаснущего движения (разворот).', note: 'Держится сигналом в OOS — слабый, но стабильный.' },
    talib_anti: { what: 'Фейд свечных паттернов: крупное тело ≥1.2 ATR и ≥60% размаха.', read: 'Сигнал ПРОТИВ тела — именованные свечные шаблоны работают наоборот.', note: 'Топ-сигнал по вкладу в боте (win 54.5%, огромная выборка). Фейдить свечи = edge.' },
    hawkes: { what: 'Хоукс-интенсивность: EWMA абсолютных доходностей (кластеризация волатильности).', read: 'Рост интенсивности + ход за 5 баров → континуация в ту сторону.', note: 'Универсальный сигнал во всех режимах (OOS-подтверждён).' },
    cascade: { what: 'Ансамбль: Z-score + Order Block + FVG.', read: 'Сигнал только если ≥2 согласны в одну сторону (конфлюэнс).', note: 'Сильнейший effect-size в боте, но редкий — мало срабатываний.' },
    nw: { what: 'Nadaraya-Watson память: ядерный поиск похожих прошлых баров (объём×размах/ATR, направленность, ROC-сдвиг).', read: 'Предсказание направления по тому, что было ПОСЛЕ аналогов.', note: 'Режимный, но + в большинстве режимов. Без объёма — прокси по размаху (слабее).' },
    alligator_inv: { what: 'Классический Аллигатор Уильямса: SMMA 13/8/5 по медиане (H+L)/2 со сдвигами вперёд +8/+5/+3. Взят ИНВЕРТИРОВАННО.', read: 'Раскрытая пасть (Аллигатор говорит «тренд») → сигнал ПРОТИВ. Трендследящий Аллигатор на 5-мин РФ системно ошибается — фейдим его.', note: 'Как anti d≈−0.12 (инверт. → сигнал уровня ZSCORE), устойчив в OOS: train −0.15 → test −0.12, n≈166k. Сильнее alt-версии; в боте alt-Аллигатор выключен в его пользу.' },
  };
  const PREF = 'tvsig:on', CKEY = 'tvsig:colors', SKEY = 'tvsig:stats';

  const S = {
    api: null, chart: null, bars: [], symbol: '', res: null,
    on: loadPref(), colors: loadColors(), drawn: {}, // id -> [shapeId]
    computed: null, busy: false, hasVolume: null, oi: null,
    statsCache: loadStats(), lastBarTime: 0, statsTs: 0, // exp/winrate по тикеру
    barDt: 0, // медианный шаг баров — для распознавания смены ТФ
  };
  const OI_BASE_DEF = 'https://oi.marginacall.workers.dev';
  function oiBase() { try { return localStorage.getItem('tvsig:oibase') || OI_BASE_DEF; } catch (e) { return OI_BASE_DEF; } }
  // мост в isolated-world (oi-bridge.js) — обход CSP терминала на фетч воркера
  function oiFetch(url, headers) {
    return new Promise(resolve => {
      const id = 'oi' + Math.random().toString(36).slice(2);
      function onRes(e) { let r; try { r = JSON.parse(e.detail); } catch (_) { return; } if (r.id !== id) return; window.removeEventListener('tvsig:oi:res', onRes); resolve(r); }
      window.addEventListener('tvsig:oi:res', onRes);
      window.dispatchEvent(new CustomEvent('tvsig:oi:req', { detail: JSON.stringify({ id, url, headers: headers || null }) }));
      setTimeout(() => { window.removeEventListener('tvsig:oi:res', onRes); resolve({ ok: false, error: 'timeout' }); }, 12000);
    });
  }
  // токен AlgoPack (MOEX) — хранится локально, шлётся ТОЛЬКО в apim.moex.com
  function oiTokenGet() { try { return localStorage.getItem('tvsig:moextoken') || ''; } catch (e) { return ''; } }
  function oiTokenSet(v) { try { v ? localStorage.setItem('tvsig:moextoken', v) : localStorage.removeItem('tvsig:moextoken'); } catch (e) {} }
  // ISS columnar {columns,data} → массив объектов
  function issToObjects(block) {
    if (!block || !block.columns || !block.data) return [];
    return block.data.map(row => { const o = {}; block.columns.forEach((c, i) => o[c] = row[i]); return o; });
  }
  // Живой снэпшот физ/юр по контракту напрямую из AlgoPack (нужен токен).
  // Возвращает {ok, snap:{ts,fl,fs,yl,ys}, syms} или {ok:false, error, syms}.
  async function oiLiveSnap(candidates) {
    // futoi авторизуется КУКОЙ MOEX Passport (тот же вход, что даёт ручной доступ
    // на сайте), а не токеном. Хост — iss.moex.com (там живёт analyticalproducts),
    // куку туда шлёт background (credentials:'include'). Bearer-токен добавляем лишь
    // если задан — для тех, у кого отдельный AlgoPack APIKEY.
    const tok = oiTokenGet();
    const url = 'https://iss.moex.com/iss/analyticalproducts/futoi/securities.json?iss.meta=off&limit=5000';
    const r = await oiFetch(url, tok ? { Authorization: 'Bearer ' + tok } : null);
    if (!r.ok) return { ok: false, error: r.error || 'fetch' };
    let j; try { j = JSON.parse(r.json); } catch (_) { return { ok: false, error: 'parse' }; }
    const key = Object.keys(j).find(k => k !== 'metadata' && k !== 'history') || 'futoi';
    const rows = issToObjects(j[key]);
    const syms = [...new Set(rows.map(o => String(o.ticker || '').toUpperCase()))];
    // ищем sym среди кандидатов (полный код, 2-буквенный, и то что вернул сервер)
    let pick = null;
    for (const c of candidates) { const cu = c.toUpperCase(); if (syms.indexOf(cu) >= 0) { pick = cu; break; }
      const hit = syms.find(s => cu.indexOf(s) === 0 || s.indexOf(cu) === 0); if (hit) { pick = hit; break; } }
    if (!pick) return { ok: false, error: 'sym-not-found', syms };
    const grp = {};
    for (const o of rows) { if (String(o.ticker).toUpperCase() !== pick) continue; const g = String(o.clgroup || '').toUpperCase(); if (g === 'YUR' || g === 'FIZ') grp[g] = o; }
    const Y = grp.YUR || {}, F = grp.FIZ || {};
    const snap = { ts: Math.floor(Date.now() / 1000),
      yl: +(Y.pos_long || 0), ys: Math.abs(+(Y.pos_short || 0)), fl: +(F.pos_long || 0), fs: Math.abs(+(F.pos_short || 0)) };
    return { ok: true, snap: { ts: snap.ts, fl: snap.fl, fs: snap.fs, yl: snap.yl, ys: snap.ys }, sym: pick };
  }
  // накопленная live-серия по контракту (localStorage) — из неё Δ по региону
  function oiAccKey(sym) { return 'tvsig:oiacc:' + sym; }
  function oiAccLoad(sym) { try { return JSON.parse(localStorage.getItem(oiAccKey(sym)) || '[]'); } catch (e) { return []; } }
  function oiAccPush(sym, snap) {
    let arr = oiAccLoad(sym);
    if (arr.length && Math.abs(arr[arr.length - 1].ts - snap.ts) < 60) arr[arr.length - 1] = snap; // тот же снэпшот
    else arr.push(snap);
    if (arr.length > 600) arr = arr.slice(-600);
    try { localStorage.setItem(oiAccKey(sym), JSON.stringify(arr)); } catch (e) {}
    return arr;
  }
  function oiNormalize(r) {
    let ts, label;
    if (r.ts != null) { ts = Number(r.ts) / 1000; const d = new Date(ts * 1000); // oi_hourly: 5-мин, unix ms
      label = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
    else { ts = (Date.parse(String(r.tradedate || r.date || '').replace(' ', 'T')) / 1000) || 0; label = r.tradedate || r.date || ''; }
    return { date: label, ts, fl: +(r.fiz_long || 0), fs: +(r.fiz_short || 0), yl: +(r.yur_long || 0), ys: +(r.yur_short || 0) };
  }
  function oiCands() {
    let sym = ''; try { sym = S.chart.symbol(); } catch (e) {}
    const ov = ((document.getElementById('tvsig-oi-tk') || {}).value || '').trim().toUpperCase();
    const cands = []; if (ov) cands.push(ov);
    if (sym) { const u = sym.toUpperCase(); if (cands.indexOf(u) < 0) cands.push(u); const m = u.match(/^([A-Z]{2})/); if (m && cands.indexOf(m[1]) < 0) cands.push(m[1]); }
    return cands;
  }
  async function oiWorkerSeries(cands) { // архив из воркера (5-мин oihourly → дневной)
    for (const c of cands) for (const ep of [['oihourly', '&days=30', '5-мин'], ['oidaily', '', 'день']]) {
      const r = await oiFetch(oiBase() + '/db/' + ep[0] + '?ticker=' + encodeURIComponent(c) + ep[1]);
      if (!r.ok) continue;
      let arr; try { const j = JSON.parse(r.json); arr = Array.isArray(j) ? j : (j.rows || j.data || []); } catch (_) { arr = []; }
      const norm = arr.map(oiNormalize).filter(x => x.ts);
      if (norm.length) return { rows: norm.sort((a, b) => a.ts - b.ts), used: c, tf: ep[2] };
    }
    return null;
  }
  function oiMerge(a, b) { // объединяем по ts (сек), дедуп
    const map = {}; [...(a || []), ...(b || [])].forEach(r => { map[Math.round(r.ts)] = r; });
    return Object.values(map).sort((x, y) => x.ts - y.ts);
  }
  async function oiLoad() {
    if (!S.chart) return;
    const body = document.getElementById('tvsig-oi-body'); if (body && !S.oi) body.textContent = 'загрузка…';
    const cands = oiCands();
    if (!cands.length) { if (body) body.textContent = 'нет тикера'; return; }
    {
      // ЖИВОЙ путь: снэпшот futoi по сессии MOEX (ручной вход) или токену AlgoPack
      // + подсев архива из воркера + накопление. Не удался — падаем на архив.
      const live = await oiLiveSnap(cands);
      if (live.ok) {
        let series = oiAccPush(live.sym, live.snap);
        if (!S._oiSeeded || S._oiSeeded !== live.sym) { // разово подмешиваем историю из воркера
          const w = await oiWorkerSeries([live.sym, ...cands]);
          if (w) series = oiMerge(w.rows.map(r => ({ ts: r.ts, fl: r.fl, fs: r.fs, yl: r.yl, ys: r.ys })), series);
          S._oiSeeded = live.sym;
        }
        const rows = series.map(r => { const d = new Date(r.ts * 1000); return { ...r, date: ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) }; });
        S.oi = { rows, used: live.sym, tf: '5-мин live' }; oiRender(); return;
      }
      if (live.error === 'sym-not-found') { if (body) body.innerHTML = '<span style="color:#F4C36A">Контракт не найден в AlgoPack. Доступные коды: ' + (live.syms || []).slice(0, 40).join(', ') + '. Впиши нужный в поле кода.</span>'; return; }
      const er = live.error || 'ошибка', isAuth = /401|403/.test(er);
      // живой путь не удался (напр. 401) — не тупик: подхватываем архив воркера
      const w = await oiWorkerSeries(cands);
      if (w) { w.note = isAuth ? 'нет доступа к живым (войди на moex.com) → архив' : 'live не дошёл → архив'; S.oi = w; oiRender(); return; }
      if (body) body.innerHTML = '<span style="color:#FF6A8B">futoi: ' + er +
        (isAuth ? ' — нет доступа. Войди на moex.com в этом браузере (подписка на «Открытый интерес») — куку входа расширение подхватит само' : ' — запрос не дошёл (перезагрузи расширение)') + '. Архива по тикеру тоже нет.</span>';
      return;
    }
  }
  function oiRender() {
    const body = document.getElementById('tvsig-oi-body'); if (!body || !S.oi) return;
    const rows = S.oi.rows; let vr = null; try { vr = S.chart.getVisibleRange(); } catch (e) {}
    let reg = vr ? rows.filter(r => r.ts >= vr.from && r.ts <= vr.to) : rows;
    if (reg.length < 2) reg = rows; // в окне мало точек — берём весь диапазон
    const a = reg[0], b = reg[reg.length - 1];
    const num = v => Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + 'к' : v.toFixed(0);
    const dlt = v => (v > 0 ? '+' : v < 0 ? '−' : '') + num(Math.abs(v));
    const cell = (cur, d) => { const col = d > 0 ? '#52F2C9' : d < 0 ? '#FF6A8B' : '#A79BC9'; return '<b>' + num(cur) + '</b> <span style="color:' + col + '">' + dlt(d) + '</span>'; };
    body.innerHTML =
      '<div class="tvsig-oi-meta">' + S.oi.used + ' · ' + (S.oi.tf || '') + ' · ' + reg.length + ' точек (' + a.date + '…' + b.date + ')' + (S.oi.note ? ' · ' + S.oi.note : '') + '</div>' +
      '<table class="tvsig-oi-t"><tr><th></th><th>лонг</th><th>шорт</th></tr>' +
      '<tr><td>физ</td><td>' + cell(b.fl, b.fl - a.fl) + '</td><td>' + cell(b.fs, b.fs - a.fs) + '</td></tr>' +
      '<tr><td>юр</td><td>' + cell(b.yl, b.yl - a.yl) + '</td><td>' + cell(b.ys, b.ys - a.ys) + '</td></tr></table>';
    renderPeriod();
    segRender(); // OI подгрузился — пересчитать Δ по отрезкам
  }
  // ── сводка за период [t0,t1]: свечи, %Δ цены, Δ OI по всем сторонам ──────────
  function periodSummary(t0, t1) {
    const bars = S.bars || [], seg = bars.filter(b => b.time >= t0 && b.time <= t1), out = { n: seg.length };
    if (seg.length >= 2) { const p0 = seg[0].close, p1 = seg[seg.length - 1].close;
      out.pricePct = p0 ? (p1 - p0) / p0 * 100 : null; out.t0 = seg[0].time; out.t1 = seg[seg.length - 1].time; }
    // Δ OI берём по ГРАНИЦАМ отрезка: значение на/до t0 и на/до t1 (forward-fill).
    // Так дельта считается даже когда точек СТРОГО внутри отрезка нет — лишь бы
    // серия покрывала участок. rows отсортированы по ts возр.
    if (S.oi && S.oi.rows && S.oi.rows.length) {
      const rows = S.oi.rows; let a = null, b = null;
      for (const r of rows) { if (r.ts <= t0) a = r; if (r.ts <= t1) b = r; }
      if (!a) a = rows.find(r => r.ts >= t0 && r.ts <= t1) || null; // до t0 точек нет — первая внутри
      if (a && b && b.ts > a.ts) {
        out.oi = { fl: b.fl - a.fl, fs: b.fs - a.fs, yl: b.yl - a.yl, ys: b.ys - a.ys,
          pts: rows.filter(r => r.ts >= a.ts && r.ts <= b.ts).length }; }
    }
    return out;
  }
  // Ищем нарисованную линию (ровно 2 точки) и берём её отрезок по времени.
  // selectLineTool в терминале нет — линию юзер рисует нативным инструментом,
  // а мы читаем её концы через getAllShapes/getShapeById/getPoints.
  function lineSpan() {
    try {
      const c = S.chart; if (!c || typeof c.getAllShapes !== 'function' || typeof c.getShapeById !== 'function') return null;
      const sh = c.getAllShapes() || [];
      for (let i = sh.length - 1; i >= 0; i--) { // с конца — самая свежая линия
        let pts; try { pts = c.getShapeById(sh[i].id).getPoints(); } catch (e) { continue; }
        if (pts && pts.length === 2 && pts[0] && pts[1] && pts[0].time != null && pts[1].time != null) {
          const t0 = Math.min(pts[0].time, pts[1].time), t1 = Math.max(pts[0].time, pts[1].time);
          if (t1 > t0) return { from: t0, to: t1 };
        }
      }
    } catch (e) {}
    return null;
  }
  // Плашка «изложение за период»: отрезок нарисованной линии, иначе видимое окно.
  function renderPeriod(span) {
    const el = document.getElementById('tvsig-period'); if (!el) return;
    const bars = S.bars || []; if (!bars.length) { el.innerHTML = ''; return; }
    let t0, t1, label;
    const ls = span || lineSpan();
    if (ls) { t0 = ls.from; t1 = ls.to; label = 'по линии'; }
    else { let vr = null; try { vr = S.chart.getVisibleRange(); } catch (e) {}
      t0 = vr ? vr.from : bars[0].time; t1 = vr ? vr.to : bars[bars.length - 1].time; label = 'видимое окно'; }
    const s = periodSummary(t0, t1);
    if (!s.n) { el.innerHTML = ''; return; }
    const dnum = v => Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + 'к' : v.toFixed(0);
    const dsg = v => (v > 0 ? '+' : v < 0 ? '−' : '') + dnum(Math.abs(v));
    const dcol = v => v > 0 ? '#52F2C9' : v < 0 ? '#FF6A8B' : '#A79BC9';
    const pc = s.pricePct == null ? '' : ' · цена <b style="color:' + (s.pricePct >= 0 ? '#52F2C9' : '#FF6A8B') + '">' + (s.pricePct >= 0 ? '+' : '') + s.pricePct.toFixed(2) + '%</b>';
    let oi = '';
    if (s.oi) oi = '<div class="tvsig-period-oi">OI Δ: физ Л <b style="color:' + dcol(s.oi.fl) + '">' + dsg(s.oi.fl) + '</b> Ш <b style="color:' + dcol(s.oi.fs) + '">' + dsg(s.oi.fs) +
      '</b> · юр Л <b style="color:' + dcol(s.oi.yl) + '">' + dsg(s.oi.yl) + '</b> Ш <b style="color:' + dcol(s.oi.ys) + '">' + dsg(s.oi.ys) + '</b></div>';
    el.innerHTML = '<div>' + label + ': <b>' + s.n + '</b> св' + pc + '</div>' + oi;
  }
  // ── вкладка «Сравнение»: наложение второго инструмента (MOEX ISS) на активный ──
  // Активный тикер берём из графика (S.bars). Второй — свечи с iss.moex.com через
  // тот же SW-мост (oiFetch). Считаем корреляцию/бету по доходностям, наложение и
  // расхождение — в базе 100 по видимому окну.
  function cmpDate(ts) { const d = new Date(ts * 1000); return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2); }
  function cmpTfLabel(iv) { return iv === 1 ? '1-мин' : iv === 10 ? '10-мин' : iv === 60 ? 'час' : iv === 24 ? 'день' : 'неделя'; }
  function _pearson(x, y) {
    const n = x.length; if (n < 3) return null;
    let sx = 0, sy = 0; for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; }
    const mx = sx / n, my = sy / n; let cxy = 0, vx = 0, vy = 0;
    for (let i = 0; i < n; i++) { const a = x[i] - mx, b = y[i] - my; cxy += a * b; vx += a * a; vy += b * b; }
    if (vx <= 0 || vy <= 0) return null; return cxy / Math.sqrt(vx * vy);
  }
  function _cmpPath(vals, W, H, P, lo, hi) {
    const n = vals.length; if (n < 2) return ''; const span = (hi - lo) || 1;
    return vals.map((v, i) => { const x = P + (W - 2 * P) * (i / (n - 1)); const y = P + (H - 2 * P) * (1 - (v - lo) / span); return (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1); }).join(' ');
  }
  // перебираем рынки MOEX, пока не найдём свечи по коду
  async function cmpFetch(code, iv, t0, t1) {
    const d0 = cmpDate(t0 - 86400), d1 = cmpDate(t1 + 86400);
    const mkts = [['stock', 'shares'], ['stock', 'index'], ['futures', 'forts'], ['currency', 'selt'], ['stock', 'bonds']];
    let lastErr = 'не найдено на MOEX (проверь код)';
    for (const [eng, mkt] of mkts) {
      const url = 'https://iss.moex.com/iss/engines/' + eng + '/markets/' + mkt + '/securities/' + encodeURIComponent(code) +
        '/candles.json?iss.meta=off&interval=' + iv + '&from=' + d0 + '&till=' + d1;
      const r = await oiFetch(url); if (!r.ok) { lastErr = r.error || 'сеть'; continue; }
      let j; try { j = JSON.parse(r.json); } catch (e) { continue; }
      const cc = j.candles; if (!cc || !cc.data || !cc.data.length) { lastErr = 'нет свечей (код/рынок/период)'; continue; }
      const ci = cc.columns.indexOf('close'), bi = cc.columns.indexOf('begin');
      const rows = cc.data.map(row => ({ t: Math.floor(Date.parse(String(row[bi]).replace(' ', 'T') + '+03:00') / 1000), close: +row[ci] }))
        .filter(x => x.t && x.close > 0).sort((a, b) => a.t - b.t);
      if (rows.length) return { ok: true, rows, market: mkt };
    }
    return { ok: false, error: lastErr };
  }
  async function cmpLoad() {
    const body = document.getElementById('tvsig-cmp-body'); if (!body) return;
    const inp = document.getElementById('tvsig-cmp-tk');
    let code = ((inp && inp.value) || '').trim().toUpperCase().split(':').pop();
    if (!code) { body.innerHTML = '<div class="tvsig-cmp-hint">Впиши код бумаги/индекса/фьючерса MOEX (SBER, IMOEX, LKOH, MOEXOG…) и жми ⟳.</div>'; return; }
    if (!S.bars || S.bars.length < 10) { body.textContent = 'нет свечей активного тикера — открой вкладку «Сигналы» и нажми ⟳'; return; }
    try { localStorage.setItem('tvsig:cmpcode', code); } catch (e) {}
    body.textContent = 'загрузка ' + code + '…';
    // окно = видимый диапазон графика (то, на что смотрит юзер), иначе все бары
    let vr = null; try { vr = S.chart.getVisibleRange(); } catch (e) {}
    let abars = S.bars;
    if (vr) { const w = S.bars.filter(b => b.time >= vr.from && b.time <= vr.to); if (w.length >= 10) abars = w; }
    const dts = []; for (let i = 1; i < abars.length; i++) dts.push(abars[i].time - abars[i - 1].time);
    dts.sort((a, b) => a - b); const dt = dts[Math.floor(dts.length / 2)] || 86400;
    const iv = dt <= 90 ? 1 : dt <= 1200 ? 10 : dt <= 10800 ? 60 : dt <= 259200 ? 24 : 7;
    const ivSec = iv === 1 ? 60 : iv === 10 ? 600 : iv === 60 ? 3600 : iv === 24 ? 86400 : 604800;
    const fetched = await cmpFetch(code, iv, abars[0].time, abars[abars.length - 1].time);
    if (!fetched.ok) { body.innerHTML = '<div class="tvsig-cmp-hint" style="color:var(--negative)">' + code + ': ' + fetched.error + '</div>'; return; }
    // выравниваем второй инструмент на времена активных баров (ближайшая свеча в пределах допуска)
    const comp = fetched.rows, tol = ivSec * 1.5; let j = 0; const A = [], C = [];
    for (const b of abars) {
      while (j + 1 < comp.length && Math.abs(comp[j + 1].t - b.time) <= Math.abs(comp[j].t - b.time)) j++;
      if (comp[j] && Math.abs(comp[j].t - b.time) <= tol && b.close > 0) { A.push(b.close); C.push(comp[j].close); }
    }
    if (A.length < 8) { body.innerHTML = '<div class="tvsig-cmp-hint" style="color:var(--amber)">Мало совпавших точек (' + A.length + '). Похоже, у ' + code + ' другой таймфрейм/период — попробуй дневной ТФ на графике или другой код.</div>'; return; }
    const normA = A.map(v => v / A[0] * 100), normC = C.map(v => v / C[0] * 100);
    const spread = normA.map((v, i) => v - normC[i]);
    const rA = [], rC = []; for (let i = 1; i < A.length; i++) { rA.push(A[i] / A[i - 1] - 1); rC.push(C[i] / C[i - 1] - 1); }
    const corr = _pearson(rA, rC);
    let beta = null; { const n = rA.length; let mx = 0, my = 0; for (let i = 0; i < n; i++) { mx += rA[i]; my += rC[i]; } mx /= n; my /= n; let cxy = 0, vy = 0; for (let i = 0; i < n; i++) { cxy += (rA[i] - mx) * (rC[i] - my); vy += (rC[i] - my) ** 2; } if (vy > 0) beta = cxy / vy; }
    cmpRender({ aLabel: (S.symbol || 'актив').split(':').pop(), code, normA, normC, spread, corr, beta,
      moveA: A[A.length - 1] / A[0] - 1, moveC: C[C.length - 1] / C[0] - 1, n: A.length, tf: cmpTfLabel(iv) });
  }
  function cmpRender(o) {
    const body = document.getElementById('tvsig-cmp-body'); if (!body) return;
    const W = 248, H = 96, P = 6, SH = 46;
    const all = o.normA.concat(o.normC); let lo = Math.min.apply(null, all), hi = Math.max.apply(null, all); if (lo === hi) { lo -= 1; hi += 1; }
    const pA = _cmpPath(o.normA, W, H, P, lo, hi), pC = _cmpPath(o.normC, W, H, P, lo, hi);
    const y100 = (P + (H - 2 * P) * (1 - (100 - lo) / ((hi - lo) || 1))).toFixed(1);
    let slo = Math.min(0, Math.min.apply(null, o.spread)), shi = Math.max(0, Math.max.apply(null, o.spread)); if (slo === shi) { slo -= 1; shi += 1; }
    const pS = _cmpPath(o.spread, W, SH, P, slo, shi);
    const y0 = (P + (SH - 2 * P) * (1 - (0 - slo) / ((shi - slo) || 1))).toFixed(1);
    const col = v => v > 0 ? '#52F2C9' : v < 0 ? '#FF6A8B' : '#A79BC9';
    const pc = v => (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%';
    const corrTxt = o.corr == null ? '—' : o.corr.toFixed(2);
    const corrCol = o.corr == null ? '#A79BC9' : o.corr > 0.5 ? '#52F2C9' : o.corr < -0.5 ? '#FF6A8B' : (o.corr > 0.2 || o.corr < -0.2) ? '#F4C36A' : '#A79BC9';
    body.dataset.loaded = '1';
    body.innerHTML =
      '<div class="tvsig-cmp-legend"><span style="color:#7CC7FF">■ ' + o.aLabel + '</span> <span style="color:#F4C36A">■ ' + o.code + '</span> · ' + o.n + ' точек · ' + o.tf + '</div>' +
      '<svg class="tvsig-cmp-svg" viewBox="0 0 ' + W + ' ' + H + '" width="100%">' +
        '<line x1="' + P + '" y1="' + y100 + '" x2="' + (W - P) + '" y2="' + y100 + '" stroke="#3a2a50" stroke-dasharray="3 3"/>' +
        '<path d="' + pA + '" fill="none" stroke="#7CC7FF" stroke-width="1.4"/>' +
        '<path d="' + pC + '" fill="none" stroke="#F4C36A" stroke-width="1.4"/></svg>' +
      '<div class="tvsig-cmp-splabel">разница (' + o.aLabel + ' − ' + o.code + ', база 100)</div>' +
      '<svg class="tvsig-cmp-svg" viewBox="0 0 ' + W + ' ' + SH + '" width="100%">' +
        '<line x1="' + P + '" y1="' + y0 + '" x2="' + (W - P) + '" y2="' + y0 + '" stroke="#3a2a50"/>' +
        '<path d="' + pS + '" fill="none" stroke="#B487F8" stroke-width="1.4"/></svg>' +
      '<table class="tvsig-cmp-t">' +
        '<tr><td>корреляция</td><td style="color:' + corrCol + '"><b>' + corrTxt + '</b></td><td>бета</td><td>' + (o.beta == null ? '—' : o.beta.toFixed(2)) + '</td></tr>' +
        '<tr><td>' + o.aLabel + ' Δ</td><td style="color:' + col(o.moveA) + '">' + pc(o.moveA) + '</td><td>' + o.code + ' Δ</td><td style="color:' + col(o.moveC) + '">' + pc(o.moveC) + '</td></tr>' +
        '<tr><td>расхождение</td><td colspan="3" style="color:' + col(o.moveA - o.moveC) + '"><b>' + pc(o.moveA - o.moveC) + '</b> за окно</td></tr></table>';
  }
  function setTab(which) {
    if (!panel) return;
    panel.querySelectorAll('.tvsig-pane').forEach(p => { p.hidden = (p.id !== 'tvsig-pane-' + which); });
    panel.querySelectorAll('.tvsig-tab').forEach(b => b.classList.toggle('on', b.dataset.tab === which));
    if (which === 'compare') { const b = document.getElementById('tvsig-cmp-body'); const inp = document.getElementById('tvsig-cmp-tk');
      if (b && !b.dataset.loaded) { if (inp && inp.value.trim()) cmpLoad(); else b.innerHTML = '<div class="tvsig-cmp-hint">Впиши код бумаги/индекса/фьючерса MOEX и жми ⟳. Наложу на активный тикер, посчитаю корреляцию и расхождение по видимому окну.</div>'; } }
    if (which === 'periods') segRender();
  }
  // все нарисованные трендлинии/лучи (2 точки, разные времена) = отрезки
  function lineSpans() {
    const out = [];
    try {
      const c = S.chart; if (!c || typeof c.getAllShapes !== 'function' || typeof c.getShapeById !== 'function') return out;
      const sh = c.getAllShapes() || [];
      for (const s of sh) {
        let pts; try { pts = c.getShapeById(s.id).getPoints(); } catch (e) { continue; }
        if (pts && pts.length === 2 && pts[0] && pts[1] && pts[0].time != null && pts[1].time != null) {
          const t0 = Math.min(pts[0].time, pts[1].time), t1 = Math.max(pts[0].time, pts[1].time);
          if (t1 > t0) out.push({ from: t0, to: t1 });
        }
      }
    } catch (e) {}
    return out.sort((a, b) => a.from - b.from);
  }
  // таблица отрезков: видимое окно + каждая линия; по каждому цена %Δ и Δ OI
  function segRender() {
    const body = document.getElementById('tvsig-seg-body'); if (!body) return;
    if (!S.bars || !S.bars.length) { body.innerHTML = '<div class="tvsig-seg-hint">Нет свечей — открой вкладку «Модели» и нажми ⟳.</div>'; return; }
    const segs = [];
    let vr = null; try { vr = S.chart.getVisibleRange(); } catch (e) {}
    if (vr) segs.push({ label: 'видимое окно', from: vr.from, to: vr.to, live: true });
    lineSpans().forEach((s, i) => segs.push({ label: 'отрезок ' + (i + 1), from: s.from, to: s.to }));
    const p2 = n => ('0' + n).slice(-2);
    const fmt = t => { const d = new Date(t * 1000); return p2(d.getDate()) + '.' + p2(d.getMonth() + 1) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()); };
    const num = v => Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + 'к' : ('' + Math.round(v));
    const dlt = v => (v > 0 ? '+' : v < 0 ? '−' : '') + num(Math.abs(v));
    const dcol = v => v > 0 ? '#52F2C9' : v < 0 ? '#FF6A8B' : '#A79BC9';
    const hasOi = !!(S.oi && S.oi.rows && S.oi.rows.length);
    let html = '';
    for (const g of segs) {
      const s = periodSummary(g.from, g.to); if (!s.n) continue;
      const pc = s.pricePct == null ? '—' : '<b style="color:' + (s.pricePct >= 0 ? '#52F2C9' : '#FF6A8B') + '">' + (s.pricePct >= 0 ? '+' : '') + s.pricePct.toFixed(2) + '%</b>';
      let oi;
      if (!hasOi) oi = '<div class="tvsig-seg-oi na">OI не загружен (блок выше → ⟳)</div>';
      else if (!s.oi) oi = '<div class="tvsig-seg-oi na">нет точек OI в этом отрезке</div>';
      else oi = '<div class="tvsig-seg-oi">OI Δ · физ Л <b style="color:' + dcol(s.oi.fl) + '">' + dlt(s.oi.fl) + '</b> Ш <b style="color:' + dcol(s.oi.fs) + '">' + dlt(s.oi.fs) +
        '</b> · юр Л <b style="color:' + dcol(s.oi.yl) + '">' + dlt(s.oi.yl) + '</b> Ш <b style="color:' + dcol(s.oi.ys) + '">' + dlt(s.oi.ys) + '</b></div>';
      html += '<div class="tvsig-seg' + (g.live ? ' live' : '') + '"><div class="tvsig-seg-hd"><span class="tvsig-seg-nm">' + g.label +
        '</span><span class="tvsig-seg-pc">' + s.n + ' св · цена ' + pc + '</span></div>' +
        '<div class="tvsig-seg-rng">' + fmt(g.from) + ' – ' + fmt(g.to) + '</div>' + oi + '</div>';
    }
    if (!html) html = '<div class="tvsig-seg-hint">Нарисуй на графике трендлинию или луч (вкладка «Модели» → инструменты) — каждая линия станет отрезком. Всегда доступно «видимое окно».</div>';
    body.innerHTML = html;
  }
  function loadPref() { try { return JSON.parse(localStorage.getItem(PREF) || '{}'); } catch (e) { return {}; } }
  function savePref() { try { localStorage.setItem(PREF, JSON.stringify(S.on)); } catch (e) {} }
  function loadColors() { try { return Object.assign({}, DEF_COLOR, JSON.parse(localStorage.getItem(CKEY) || '{}')); } catch (e) { return Object.assign({}, DEF_COLOR); } }
  function saveColors() { try { localStorage.setItem(CKEY, JSON.stringify(S.colors)); } catch (e) {} }

  // ── статистика exp/winrate по тикеру: считается на его свечах, хранится
  //    per-symbol в localStorage, обновляется при закрытии нового бара ──────────
  function loadStats() { try { return JSON.parse(localStorage.getItem(SKEY) || '{}'); } catch (e) { return {}; } }
  function saveStats(sym, computed, bars) {
    if (!sym || !computed) return;
    const m = {}; // компактно: e=exp, a=acc(winrate), w=win-до-тейка, n=сделок
    META.forEach(([id]) => { const s = computed[id] && computed[id].stats; if (s) m[id] = { e: s.exp, a: s.acc, w: s.win, n: s.n }; });
    S.statsCache[sym] = { m, ts: Date.now(), bars: bars.length, t: bars.length ? bars[bars.length - 1].time : 0 };
    S.statsTs = S.statsCache[sym].ts;
    const keys = Object.keys(S.statsCache); // не разрастаться — держим последние ~300 тикеров
    if (keys.length > 300) keys.sort((a, b) => S.statsCache[a].ts - S.statsCache[b].ts).slice(0, keys.length - 300).forEach(k => delete S.statsCache[k]);
    try { localStorage.setItem(SKEY, JSON.stringify(S.statsCache)); } catch (e) {}
  }
  // мгновенно показать сохранённые цифры тикера, пока идёт свежий пересчёт
  function seedFromCache(sym) {
    const e = S.statsCache[sym];
    if (!e || !e.m) { S.computed = null; S.statsTs = 0; return; }
    const c = {};
    META.forEach(([id]) => { const x = e.m[id];
      c[id] = { last: 0, series: null, stats: x ? { exp: x.e, acc: x.a, win: x.w, n: x.n } : { exp: null, acc: null, win: null, n: 0 } }; });
    S.computed = c; S.statsTs = e.ts; renderRows();
  }
  function fmtAgo(ts) { if (!ts) return '—'; const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return s + 'с назад'; const m = Math.round(s / 60); if (m < 60) return m + 'м назад';
    return Math.round(m / 60) + 'ч назад'; }
  function setColor(id, val) { S.colors[id] = val; saveColors(); if (S.on[id]) drawMethod(id); renderRows(); }

  // ── доступ к TradingView ─────────────────────────────────────────────────────
  function _apiIn(w) { try { if (w && w.tradingViewApi && typeof w.tradingViewApi.activeChart === 'function') return w.tradingViewApi; } catch (e) {} return null; }
  function getApi() {
    let a = _apiIn(window); if (a) return a; // сам верхний фрейм
    const frames = document.getElementsByTagName('iframe');
    for (let i = 0; i < frames.length; i++) {
      let w; try { w = frames[i].contentWindow; } catch (e) { continue; }
      a = _apiIn(w); if (a) return a;
      // один уровень вложенности (терминал мог обернуть график ещё в iframe)
      let inner; try { inner = w && w.document && w.document.getElementsByTagName('iframe'); } catch (e) { inner = null; }
      if (inner) for (let j = 0; j < inner.length; j++) { let w2; try { w2 = inner[j].contentWindow; } catch (e) { continue; } a = _apiIn(w2); if (a) return a; }
    }
    return null;
  }
  function ready() {
    const api = getApi(); if (!api) return false;
    let c; try { c = api.activeChart(); } catch (e) { return false; }
    if (!c || typeof c.exportData !== 'function' || typeof c.createShape !== 'function') return false;
    S.api = api; S.chart = c; return true;
  }

  // ── данные + расчёт ──────────────────────────────────────────────────────────
  async function refresh(force) {
    if (S.busy || !S.chart) return;
    S.busy = true;
    try {
      let sym = ''; try { sym = S.chart.symbol(); } catch (e) {}
      const symChanged = sym !== S.symbol;
      if (symChanged) { clearAll(); S.symbol = sym; S.lastBarTime = 0; S.barDt = 0; seedFromCache(sym); status('тикер ' + (sym || '?') + ' · пересчёт…'); }
      const res = await Promise.resolve(S.chart.exportData());
      let bars = window.SignalsCore.parseExport(res);
      if (bars.length > 3000) bars = bars.slice(-3000); // держим NW (O(n^2)) в узде
      // таймфрейм ловим по медианному шагу баров (resolution() есть не во всех
      // сборках). Сменился ТФ на том же тикере → чистим старые точки и пересчёт,
      // иначе рисунки остаются от прежнего ТФ и не адаптируются.
      let dt = 0; if (bars.length > 5) { const d = []; for (let i = 1; i < bars.length; i++) d.push(bars[i].time - bars[i - 1].time); d.sort((a, b) => a - b); dt = d[d.length >> 1] || 0; }
      const tfChanged = !symChanged && dt > 0 && S.barDt > 0 && dt !== S.barDt;
      if (tfChanged) { clearAll(); S.lastBarTime = 0; status('ТФ сменился · пересчёт…'); }
      if (dt > 0) S.barDt = dt;
      const changed = symChanged || tfChanged;
      const lastT = bars.length ? bars[bars.length - 1].time : 0;
      const newBar = lastT !== S.lastBarTime;
      // тот же тикер и ТФ, новый бар не закрылся, есть живой расчёт → только «обновлено»
      if (!changed && !newBar && !force && S.computed && S.computed.__live) {
        status('тикер ' + (S.symbol || '?') + ' · ' + S.bars.length + ' баров · обновлено ' + fmtAgo(S.statsTs));
        renderPeriod(); // освежаем плашку периода при зуме/скролле (бары те же)
        S.busy = false; return;
      }
      if (!changed) status('считаю…');
      S.bars = bars;
      S.hasVolume = bars.some(b => b.volume && b.volume > 0);
      if (bars.length < 60) { status('мало свечей (' + bars.length + ')'); S.busy = false; return; }
      S.computed = window.SignalsCore.computeAll(bars, 12);
      S.computed.__live = true; S.lastBarTime = lastT;
      saveStats(S.symbol, S.computed, bars); // сохранить exp/winrate по этому тикеру
      renderRows();
      renderConsensus();
      // перерисовать активные слои
      Object.keys(S.on).forEach(id => { if (S.on[id]) drawMethod(id); });
      if (symChanged) { S.oi = null; S._oiSeeded = null; oiLoad(); } else if (S.oi) oiRender(); // OI: перезагрузка при смене тикера, иначе обновляем регион
      renderPeriod();
      status('тикер ' + (S.symbol || '?') + ' · ' + bars.length + ' баров · обновлено ' + fmtAgo(S.statsTs));
    } catch (e) { status('ошибка: ' + (e && e.message || e)); }
    S.busy = false;
  }

  // ── рисование сигналов ───────────────────────────────────────────────────────
  function clearMethod(id) {
    (S.drawn[id] || []).forEach(sid => { try { S.chart.removeEntity(sid); } catch (e) {} });
    S.drawn[id] = [];
  }
  function clearAll() { Object.keys(S.drawn).forEach(clearMethod); }
  const MAX_DOTS = 260; // потолок точек на метод в окне (перф + чистота)
  function drawMethod(id) {
    if (!S.chart || !S.computed || !S.computed[id]) return;
    clearMethod(id);
    let vr = null; try { vr = S.chart.getVisibleRange(); } catch (e) {}
    const series = S.computed[id].series, bars = S.bars;
    if (!series || !bars.length) return; // сид из кэша (series=null) — рисовать нечего до пересчёта
    // Точка на КАЖДОМ баре, где сигнал активен. ЦВЕТ = МЕТОД (совпадает с ромбом/
    // пикером в панели — так видно, чей это сигнал, когда активны несколько). ФОРМА =
    // направление: ▲ buy (под баром), ▼ sell (над баром). Слои чуть разнесены по
    // вертикали (off по индексу метода), чтобы точки разных методов не сливались.
    const col = S.colors[id] || DEF_COLOR[id];
    const off = 0.0006 * (IDX[id] || 0);
    const marks = [];
    for (let i = 0; i < bars.length; i++) {
      const sc = series[i]; if (sc == null || sc === 0) continue;
      const b = bars[i]; if (vr && (b.time < vr.from || b.time > vr.to)) continue;
      const buy = sc > 0;
      marks.push({ time: b.time, price: buy ? b.low * (0.9985 - off) : b.high * (1.0015 + off), buy });
    }
    const out = [];
    marks.slice(-MAX_DOTS).forEach(m => {
      try {
        const sid = S.chart.createShape(
          { time: m.time, price: m.price },
          { shape: 'text', text: m.buy ? '▲' : '▼', lock: true, disableSelection: true, disableSave: true,
            zOrder: 'top', overrides: { color: col, fontsize: 9, bold: true } });
        if (sid) out.push(sid);
      } catch (e) {}
    });
    S.drawn[id] = out;
  }
  function toggle(id) {
    S.on[id] = !S.on[id]; savePref();
    if (S.on[id]) drawMethod(id); else clearMethod(id);
    renderRows();
  }

  // Рисование НАТИВНЫМИ инструментами TradingView — фигуры привязаны к цене/времени
  // и масштабируются/двигаются вместе с графиком. selectLineTool переводит график
  // в режим рисования, дальше пользователь рисует мышью, TV сам считает координаты.
  function drawTool(t) {
    if (!S.chart) { status('график не готов'); return; }
    if (t === '__clear') {
      if (confirm('Стереть ВСЮ разметку на графике (включая стрелки-сигналы расширения)?')) {
        try { S.chart.removeAllShapes(); } catch (e) {}
        S.drawn = {};
      }
      return;
    }
    // selectLineTool в разных сборках Charting Library лежит либо на чарте
    // (activeChart), либо на самом виджете (tradingViewApi) — пробуем оба.
    const target = (S.chart && typeof S.chart.selectLineTool === 'function') ? S.chart
      : (S.api && typeof S.api.selectLineTool === 'function') ? S.api : null;
    if (!target) { status('терминал не даёт включить рисование из панели — рисуй инструментом слева, плашка покажет Δ по линии'); return; }
    try { target.selectLineTool(t); status(t === 'cursor' ? 'курсор' : 'рисуй: ' + t); }
    catch (e) { status('рисование: ' + (e && e.message || e)); }
  }

  // ── панель ───────────────────────────────────────────────────────────────────
  let panel, rowsEl, statusEl;
  function build() {
    panel = document.createElement('div'); panel.id = 'tvsig-panel';
    panel.innerHTML =
      '<div id="tvsig-head"><span id="tvsig-title">◆</span>' +
      '<button id="tvsig-refresh" title="Пересчитать">⟳</button>' +
      '<button id="tvsig-min" title="Свернуть">–</button></div>' +
      '<div id="tvsig-tabs">' +
      '<button class="tvsig-tab on" data-tab="signals">Модели</button>' +
      '<button class="tvsig-tab" data-tab="compare">Сравнение</button>' +
      '<button class="tvsig-tab" data-tab="periods">Периоды</button>' +
      '<button class="tvsig-tab" data-tab="theme">Тема</button></div>' +
      '<div id="tvsig-pane-signals" class="tvsig-pane">' +
      '<div id="tvsig-draw">' +
      '<button class="tvsig-dt" data-t="cursor" title="Курсор — выйти из режима рисования">➤</button>' +
      '<button class="tvsig-dt" data-t="horizontal_line" title="Горизонтальный уровень">━</button>' +
      '<button class="tvsig-dt" data-t="horizontal_ray" title="Луч-уровень (от точки вправо)">┅</button>' +
      '<button class="tvsig-dt" data-t="trend_line" title="Трендлиния">╱</button>' +
      '<button class="tvsig-dt" data-t="ray" title="Луч">→</button>' +
      '<button class="tvsig-dt" data-t="parallel_channel" title="Канал (параллели)">▱</button>' +
      '<button class="tvsig-dt" data-t="rectangle" title="Прямоугольник (зона)">▭</button>' +
      '<button class="tvsig-dt" data-t="brush" title="Свободное рисование">✎</button>' +
      '<button class="tvsig-dt danger" data-t="__clear" title="Стереть ВСЮ разметку на графике">✕</button>' +
      '</div>' +
      '<div id="tvsig-status">инициализация…</div>' +
      '<div id="tvsig-consensus" title="Общий текущий сигнал: сумма голосов методов, взвешенных по их exp на этом тикере"></div>' +
      '<div id="tvsig-rows"></div>' +
      '<div id="tvsig-foot">Цифры считаются на свечах <b>текущего тикера</b>, хранятся по каждому и обновляются при закрытии нового бара. <b>exp</b> — экспектанси, средний P&amp;L сделки в ATR (тейк +1.0 / стоп −0.5 ATR, издержки 0.12); плюс = метод в прибыли. <b>%</b> — winrate, частота угадывания знака за 12 баров (у фейдов низкая при плюсовом exp — норма). <b>n</b> — число сделок. Клик по строке рисует сигналы.</div>' +
      '</div>' + // /pane-signals
      '<div id="tvsig-pane-compare" class="tvsig-pane" hidden>' +
      '<div id="tvsig-cmp-ctrl">' +
      '<input id="tvsig-cmp-tk" placeholder="код MOEX: SBER, IMOEX, LKOH…" title="Код бумаги/индекса/фьючерса на MOEX">' +
      '<button id="tvsig-cmp-go" title="Наложить и посчитать">⟳</button></div>' +
      '<div id="tvsig-cmp-body"></div>' +
      '<div id="tvsig-cmp-foot">Второй инструмент грузится с MOEX ISS и накладывается на <b>видимое окно</b> активного графика (масштабом окна и задаётся период). Корреляция и бета — по доходностям баров; наложение и «разница» — в базе 100. Индекс — IMOEX, нефтегаз — MOEXOG, нефть — код фьючерса Brent (напр. BRN6).</div>' +
      '</div>' + // /pane-compare
      '<div id="tvsig-pane-periods" class="tvsig-pane" hidden>' +
      '<div id="tvsig-period" title="Сводка за видимое окно графика"></div>' +
      '<div id="tvsig-oi"><div id="tvsig-oi-head">Открытый интерес' +
      '<input id="tvsig-oi-tk" placeholder="код (авто)" title="Код OI-контракта; пусто = авто по тикеру">' +
      '<button id="tvsig-oi-key" title="Токен AlgoPack для живых 5-мин данных">AP</button>' +
      '<button id="tvsig-oi-load" title="Загрузить/обновить OI">⟳</button></div>' +
      '<div id="tvsig-oi-body"><span class="tvsig-oi-meta">физ/юр лонг-шорт и Δ по видимому окну · ⟳ загрузить</span></div></div>' +
      '<div class="tvsig-seg-ctrl">Отрезки<button id="tvsig-seg-go" title="Обновить отрезки по нарисованным линиям">⟳</button></div>' +
      '<div id="tvsig-seg-body"></div>' +
      '<div id="tvsig-seg-foot">Отрезок = трендлиния/луч, нарисованный на графике (вкладка «Модели» → инструменты рисования). Для каждого — цена %Δ и Δ открытого интереса за период. Несколько линий = несколько отрезков. Загрузи OI в блоке выше, чтобы видеть позиции.</div>' +
      '</div>' + // /pane-periods
      '<div id="tvsig-pane-theme" class="tvsig-pane" hidden>' +
      '<div class="tvsig-th-row"><label class="tvsig-th-sw"><input type="checkbox" id="tvsig-th-on"> Перекрасить терминал</label>' +
      '<button id="tvsig-th-reset" title="Сбросить">сброс</button></div>' +
      '<div class="tvsig-th-presets">' +
      '<button class="tvsig-th-pr" data-pr="warm">Тёплый</button>' +
      '<button class="tvsig-th-pr" data-pr="dim">Приглушить</button>' +
      '<button class="tvsig-th-pr" data-pr="contrast">Контраст</button>' +
      '<button class="tvsig-th-pr" data-pr="night">Ночь</button>' +
      '<button class="tvsig-th-pr" data-pr="invert">Инверсия</button></div>' +
      '<div class="tvsig-th-sl"><span>Яркость</span><input type="range" id="tvsig-th-b" min="50" max="130" step="1"><b id="tvsig-th-bv"></b></div>' +
      '<div class="tvsig-th-sl"><span>Контраст</span><input type="range" id="tvsig-th-c" min="70" max="150" step="1"><b id="tvsig-th-cv"></b></div>' +
      '<div class="tvsig-th-sl"><span>Насыщ.</span><input type="range" id="tvsig-th-s" min="0" max="180" step="1"><b id="tvsig-th-sv"></b></div>' +
      '<div class="tvsig-th-sl"><span>Тепло</span><input type="range" id="tvsig-th-w" min="0" max="100" step="1"><b id="tvsig-th-wv"></b></div>' +
      '<div class="tvsig-th-sl"><span>Оттенок</span><input type="range" id="tvsig-th-h" min="0" max="360" step="1"><b id="tvsig-th-hv"></b></div>' +
      '<label class="tvsig-th-sw"><input type="checkbox" id="tvsig-th-inv"> Инверсия цветов (тёмная↔светлая)</label>' +
      '<label class="tvsig-th-sw"><input type="checkbox" id="tvsig-th-logo"> Не менять цвет логотипов бумаг</label>' +
      '<div id="tvsig-th-foot">Фильтр накладывается на весь терминал (включая график); панель расширения не затрагивается. «Не менять логотипы» возвращает картинкам-логотипам родной цвет обратным фильтром (тёплый оттенок может слегка остаться; фоновые/SVG-значки не всегда ловятся). Пресеты задают ползунки. Настройки сохраняются.</div>' +
      '</div>'; // /pane-theme
    document.documentElement.appendChild(panel);
    rowsEl = panel.querySelector('#tvsig-rows'); statusEl = panel.querySelector('#tvsig-status');
    panel.querySelector('#tvsig-refresh').onclick = () => refresh(true);
    panel.querySelectorAll('.tvsig-dt').forEach(btn => btn.onclick = () => drawTool(btn.dataset.t));
    panel.querySelector('#tvsig-oi-load').onclick = () => oiLoad();
    panel.querySelector('#tvsig-oi-tk').addEventListener('keydown', e => { if (e.key === 'Enter') { S._oiSeeded = null; oiLoad(); } });
    const keyBtn = panel.querySelector('#tvsig-oi-key');
    function updateKeyBtn() { keyBtn.style.opacity = oiTokenGet() ? '1' : '0.5'; keyBtn.title = oiTokenGet() ? 'Токен AlgoPack задан (клик — сменить/очистить)' : 'Живые данные идут по твоему входу на moex.com. Токен нужен только при отдельном AlgoPack APIKEY'; }
    keyBtn.onclick = () => {
      const has = !!oiTokenGet();
      const v = prompt('Живой OI (5-мин физ/юр) обычно НЕ требует токена — расширение берёт данные по твоему входу на moex.com.\nТокен нужен, только если у тебя отдельный AlgoPack APIKEY.\nХранится ЛОКАЛЬНО, шлётся только в iss.moex.com.\n' + (has ? 'Есть заданный. Введи новый, или "-" чтобы очистить.' : 'Вставь токен (или Отмена):'), '');
      if (v === null) return;
      if (v.trim() === '-') oiTokenSet(''); else if (v.trim()) oiTokenSet(v.trim());
      updateKeyBtn(); S._oiSeeded = null; oiLoad();
    };
    updateKeyBtn();
    // вкладки + сравнение + отрезки
    panel.querySelectorAll('.tvsig-tab').forEach(b => b.onclick = () => setTab(b.dataset.tab));
    const cmpTk = panel.querySelector('#tvsig-cmp-tk');
    try { cmpTk.value = localStorage.getItem('tvsig:cmpcode') || ''; } catch (e) {}
    panel.querySelector('#tvsig-cmp-go').onclick = () => cmpLoad();
    cmpTk.addEventListener('keydown', e => { if (e.key === 'Enter') cmpLoad(); });
    panel.querySelector('#tvsig-seg-go').onclick = () => segRender();
    themeBind();
    let minimized = false;
    panel.querySelector('#tvsig-min').onclick = () => { minimized = !minimized; rowsEl.style.display = minimized ? 'none' : ''; panel.querySelector('#tvsig-foot').style.display = minimized ? 'none' : ''; };
    drag(panel);
    try { renderRows(); } catch (e) {} // список методов виден сразу, даже пока график не найден (stats будут «—»)
  }
  function status(t) { if (statusEl) statusEl.textContent = t; }
  function pill(sc) {
    if (sc > 0) return '<span class="tvsig-b buy" title="текущий сигнал: buy">▲</span>';
    if (sc < 0) return '<span class="tvsig-b sell" title="текущий сигнал: sell">▼</span>';
    return '<span class="tvsig-b neu" title="нет сигнала">—</span>';
  }
  // ── ℹ-окно метода: описание + аналог блока анализа indlab (бэктест по горизонтам) ─
  function closeInfo() { const o = document.getElementById('tvsig-info'); if (o) o.remove(); }
  function openInfo(id) {
    closeInfo();
    const d = DESC[id] || { what: '—', read: '—', note: '' };
    const col = S.colors[id] || DEF_COLOR[id];
    const bars = S.bars;
    let series = S.computed && S.computed[id] && S.computed[id].series;
    if (!series && bars && bars.length) { try { series = window.SignalsCore.methods[id](bars); } catch (e) { series = null; } }
    // чипы точности на горизонтах 5/10/20 баров — как «Анализ» в indlab
    const chips = (series && bars && bars.length) ? [5, 10, 20].map(h => {
      const s = window.SignalsCore.btStats(series, bars, h);
      if (!s || !s.n) return '<span class="tvsig-chip na">' + h + 'б: —</span>';
      const e = (s.exp >= 0 ? '+' : '') + s.exp.toFixed(2);
      const ec = s.exp > 0.03 ? '#52F2C9' : s.exp < -0.03 ? '#FF6A8B' : '#A79BC9';
      const w = s.acc != null ? Math.round(s.acc * 100) + '%' : '—';
      return '<span class="tvsig-chip"><b>' + h + 'б</b> exp <b style="color:' + ec + '">' + e + '</b> · ' + w + ' · n' + s.n + '</span>';
    }).join('') : '<span class="tvsig-chip na">нет данных (мало свечей)</span>';
    const last = S.computed && S.computed[id] ? S.computed[id].last : 0;
    const sig = last > 0 ? '<span style="color:#52F2C9">▲ buy</span>' : last < 0 ? '<span style="color:#FF6A8B">▼ sell</span>' : '<span style="color:#A79BC9">— нет</span>';
    const o = document.createElement('div'); o.id = 'tvsig-info';
    o.innerHTML =
      '<div class="tvsig-info-card">' +
        '<div class="tvsig-info-head"><span class="tvsig-info-dot" style="background:' + col + '"></span>' +
          '<span class="tvsig-info-title">' + NAME[id] + '</span>' +
          '<span class="tvsig-info-sig">' + sig + '</span>' +
          '<button class="tvsig-info-x" title="Закрыть">×</button></div>' +
        '<div class="tvsig-info-sec"><div class="tvsig-info-lbl">Что делает</div>' + d.what + '</div>' +
        '<div class="tvsig-info-sec"><div class="tvsig-info-lbl">Как читать</div>' + d.read + '</div>' +
        '<div class="tvsig-info-sec"><div class="tvsig-info-lbl">Бэктест по тикеру ' + (S.symbol || '?') + '</div>' +
          '<div class="tvsig-chips">' + chips + '</div>' +
          '<div class="tvsig-info-fine">exp — средний P&amp;L сделки в ATR (тейк 1.0 / стоп 0.5, издержки 0.12) при выходе через N баров · % — winrate · n — сделок</div></div>' +
        (d.note ? '<div class="tvsig-info-note">' + d.note + '</div>' : '') +
      '</div>';
    o.addEventListener('click', e => { if (e.target === o || e.target.classList.contains('tvsig-info-x')) closeInfo(); });
    document.documentElement.appendChild(o);
  }

  // ── консенсус: один живой вердикт из всех методов, взвешенный по их exp ────────
  function renderConsensus() {
    const el = document.getElementById('tvsig-consensus'); if (!el) return;
    const c = S.computed;
    if (!c || !c.__live) { el.innerHTML = ''; return; } // только по свежему расчёту, не по кэшу
    let net = 0, wsum = 0, buy = 0, sell = 0, working = 0;
    META.forEach(([id]) => {
      const m = c[id]; if (!m || !m.stats) return;
      const exp = m.stats.exp;
      if (exp == null || exp <= 0.03) return; // только методы с реальным edge на этом тикере
      working++;
      const sig = m.last > 0 ? 1 : m.last < 0 ? -1 : 0;
      if (sig === 0) return;
      const w = Math.min(1, exp); net += sig * w; wsum += w; if (sig > 0) buy++; else sell++;
    });
    if (working === 0) { el.innerHTML = '<div class="tvsig-cons-empty">Консенсус: у методов пока нет подтверждённого edge на этом тикере (мало истории — дай пересчитаться).</div>'; return; }
    const strength = wsum > 0 ? net / wsum : 0; // [-1..1]
    const dir = strength > 0.08 ? 1 : strength < -0.08 ? -1 : 0;
    const col = dir > 0 ? '#52F2C9' : dir < 0 ? '#FF6A8B' : '#A79BC9';
    const label = dir > 0 ? '▲ ПОКУПКА' : dir < 0 ? '▼ ПРОДАЖА' : '— нейтрально';
    const wd = Math.round(Math.abs(strength) * 50);
    const fill = (dir >= 0 ? 'left:50%;width:' + wd + '%' : 'left:' + (50 - wd) + '%;width:' + wd + '%') + ';background:' + col;
    el.innerHTML =
      '<div class="tvsig-cons-top"><b style="color:' + col + '">' + label + '</b>' +
      '<span class="tvsig-cons-pct">сила ' + Math.round(Math.abs(strength) * 100) + '%</span></div>' +
      '<div class="tvsig-cons-scale"><span class="tvsig-cons-mid"></span><span class="tvsig-cons-fill" style="' + fill + '"></span></div>' +
      '<div class="tvsig-cons-votes">' + buy + ' за покупку · ' + sell + ' за продажу · из ' + working + ' рабочих методов (exp&gt;0)</div>';
  }

  function renderRows() {
    if (!rowsEl) return;
    const noVol = S.hasVolume === false;
    rowsEl.innerHTML = META.map(([id]) => {
      const c = S.computed && S.computed[id];
      const on = !!S.on[id];
      const col = S.colors[id];
      // ромб-переключатель в стиле indlab: горит цветом метода когда включён
      const diam = '<span class="tvsig-diam' + (on ? ' on' : '') + '" data-id="' + id + '" title="Показать/скрыть на графике" ' +
        'style="border-color:' + col + ';background:' + (on ? col : 'transparent') + ';box-shadow:' + (on ? '0 0 6px ' + col : 'none') + ';"></span>';
      const swatch = '<input type="color" class="tvsig-col" data-id="' + id + '" value="' + col + '" title="Цвет метода">';
      const info = '<span class="tvsig-info-btn" data-id="' + id + '" title="Описание метода + бэктест по горизонтам">ⓘ</span>';
      const noVolRow = (id === 'vsa_abs' && noVol);
      const mid = noVolRow
        ? '<span class="tvsig-b neu" style="color:#F4C36A" title="Включи индикатор Объём на графике">нужен объём</span>'
        : (function () {
            const st = c && c.stats;
            // exp — главная цифра (деньги), красим по знаку; winrate — справочная, приглушённая
            const exp = st && st.exp != null ? (st.exp >= 0 ? '+' : '') + st.exp.toFixed(2) : '—';
            const expCol = st && st.exp != null ? (st.exp > 0.03 ? '#52F2C9' : st.exp < -0.03 ? '#FF6A8B' : '#A79BC9') : '#6F648F';
            const win = st && st.acc != null ? (st.acc * 100).toFixed(0) + '%' : '—';
            const nn = st ? st.n : 0;
            return pill(c ? c.last : 0) +
              '<span class="tvsig-exp" style="color:' + expCol + '" title="exp — экспектанси: средний P&L сделки в ATR (тейк +1.0 / стоп −0.5 ATR, издержки 0.12). Плюс = метод в прибыли, даже если winrate низкий.">' + exp + '</span>' +
              '<span class="tvsig-acc" title="winrate — частота совпадения знака с ходом за 12 баров. У фейдов бывает низкой при плюсовом exp — это норма.">' + win + '</span>' +
              '<span class="tvsig-n" title="Число сделок в exp-симуляции">n' + nn + '</span>';
          })();
      return '<div class="tvsig-row' + (on ? ' on' : '') + '" data-id="' + id + '">' +
        diam + '<span class="tvsig-name" title="' + NAME[id] + '">' + NAME[id] + '</span>' + mid + info + swatch + '</div>';
    }).join('');
    // ромб/имя → вкл/выкл; пикер цвета → своё событие (не триггерит toggle)
    rowsEl.querySelectorAll('.tvsig-diam, .tvsig-name').forEach(el =>
      el.addEventListener('click', e => { toggle(el.dataset.id || el.parentElement.dataset.id); e.stopPropagation(); }));
    rowsEl.querySelectorAll('.tvsig-info-btn').forEach(el =>
      el.addEventListener('click', e => { openInfo(el.dataset.id); e.stopPropagation(); }));
    rowsEl.querySelectorAll('.tvsig-col').forEach(inp => {
      inp.addEventListener('input', e => { setColor(inp.dataset.id, e.target.value); e.stopPropagation(); });
      inp.addEventListener('click', e => e.stopPropagation());
    });
  }
  // Тащим за ЛЮБУЮ пустую область панели. Не начинаем drag на кнопках/полях/
  // переключателях и на текстовых зонах (чтобы можно было кликать и выделять текст).
  const NO_DRAG = 'button, input, select, textarea, a, svg, .tvsig-diam, .tvsig-name, ' +
    '.tvsig-col, .tvsig-info-btn, .tvsig-tab, #tvsig-status, #tvsig-period, #tvsig-foot, ' +
    '#tvsig-cmp-foot, #tvsig-cmp-body, #tvsig-oi-body, .tvsig-oi-meta, .tvsig-oi-t';
  function drag(el) {
    let sx, sy, ox, oy, on = false;
    el.addEventListener('mousedown', e => {
      if (e.button !== 0 || (e.target.closest && e.target.closest(NO_DRAG))) return;
      on = true; sx = e.clientX; sy = e.clientY; const r = el.getBoundingClientRect(); ox = r.left; oy = r.top; e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!on) return; const w = el.offsetWidth, h = el.offsetHeight;
      // держим панель в пределах экрана, чтобы не «застряла» за краем
      const left = Math.max(0, Math.min(window.innerWidth - Math.min(w, 60), ox + e.clientX - sx));
      const top = Math.max(0, Math.min(window.innerHeight - 30, oy + e.clientY - sy));
      el.style.left = left + 'px'; el.style.top = top + 'px'; el.style.right = 'auto'; el.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => on = false);
  }

  // ── Оформление: CSS-фильтр на терминал (наша панель — вне body, не затронута) ──
  const TH_DEF = { on: false, b: 100, c: 100, s: 100, w: 0, h: 0, inv: false, logo: true };
  let _theme = null;
  function themeLoad() { try { return Object.assign({}, TH_DEF, JSON.parse(localStorage.getItem('tvsig:theme') || '{}')); } catch (e) { return Object.assign({}, TH_DEF); } }
  function themeFilter(t) {
    if (!t.on) return 'none';
    let f = 'brightness(' + t.b + '%) contrast(' + t.c + '%) saturate(' + t.s + '%)';
    if (t.w) f += ' sepia(' + t.w + '%)';
    if (t.h) f += ' hue-rotate(' + t.h + 'deg)';
    if (t.inv) f = 'invert(1) hue-rotate(180deg) ' + f; // «умная» инверсия: яркость флипается, оттенок сохраняется
    return f;
  }
  // обратный фильтр — компенсирует фильтр body на логотипах (sepia не обратим → лёгкий остаток)
  function themeInverseFilter(t) {
    const p = [];
    if (t.h) p.push('hue-rotate(' + (-t.h) + 'deg)');
    if (t.s > 0 && t.s !== 100) p.push('saturate(' + Math.round(10000 / t.s) + '%)');
    if (t.c !== 100) p.push('contrast(' + Math.round(10000 / t.c) + '%)');
    if (t.b !== 100) p.push('brightness(' + Math.round(10000 / t.b) + '%)');
    if (t.inv) { p.push('hue-rotate(-180deg)'); p.push('invert(1)'); }
    return p.join(' ');
  }
  function themeApply(t) {
    let st = document.getElementById('tvsig-theme-style');
    if (!st) { st = document.createElement('style'); st.id = 'tvsig-theme-style'; document.documentElement.appendChild(st); }
    const f = themeFilter(t);
    let css = f === 'none' ? '' : 'body{filter:' + f + ' !important;}';
    if (t.on && t.logo) { const inv = themeInverseFilter(t); if (inv) css += ' body img{filter:' + inv + ' !important;}'; }
    st.textContent = css;
  }
  function themePreset(p) {
    const t = _theme; t.on = true; t.inv = false; t.h = 0;
    if (p === 'warm') { t.b = 98; t.c = 100; t.s = 105; t.w = 30; }
    else if (p === 'dim') { t.b = 80; t.c = 94; t.s = 88; t.w = 8; }
    else if (p === 'contrast') { t.b = 102; t.c = 125; t.s = 112; t.w = 0; }
    else if (p === 'night') { t.b = 80; t.c = 106; t.s = 90; t.w = 18; }
    else if (p === 'invert') { t.b = 100; t.c = 100; t.s = 100; t.w = 0; t.inv = true; }
  }
  const _TH_UNIT = { b: '%', c: '%', s: '%', w: '%', h: '°' };
  function themeReflect() { // состояние → контролы
    if (!panel) return; const t = _theme;
    const on = panel.querySelector('#tvsig-th-on'), inv = panel.querySelector('#tvsig-th-inv'), lg = panel.querySelector('#tvsig-th-logo');
    if (on) on.checked = t.on; if (inv) inv.checked = t.inv; if (lg) lg.checked = t.logo;
    for (const k of ['b', 'c', 's', 'w', 'h']) { const el = panel.querySelector('#tvsig-th-' + k), lb = panel.querySelector('#tvsig-th-' + k + 'v');
      if (el) el.value = t[k]; if (lb) lb.textContent = t[k] + _TH_UNIT[k]; }
  }
  function themeBind() {
    _theme = themeLoad();
    const push = () => { try { localStorage.setItem('tvsig:theme', JSON.stringify(_theme)); } catch (e) {} themeApply(_theme); };
    const on = panel.querySelector('#tvsig-th-on'), inv = panel.querySelector('#tvsig-th-inv'), lg = panel.querySelector('#tvsig-th-logo');
    on.addEventListener('change', () => { _theme.on = on.checked; push(); });
    inv.addEventListener('change', () => { _theme.inv = inv.checked; _theme.on = true; on.checked = true; push(); });
    lg.addEventListener('change', () => { _theme.logo = lg.checked; push(); });
    for (const k of ['b', 'c', 's', 'w', 'h']) {
      panel.querySelector('#tvsig-th-' + k).addEventListener('input', e => { _theme[k] = +e.target.value; const lb = panel.querySelector('#tvsig-th-' + k + 'v'); if (lb) lb.textContent = _theme[k] + _TH_UNIT[k]; _theme.on = true; on.checked = true; push(); });
    }
    panel.querySelectorAll('.tvsig-th-pr').forEach(b => b.onclick = () => { themePreset(b.dataset.pr); themeReflect(); push(); });
    panel.querySelector('#tvsig-th-reset').onclick = () => { Object.assign(_theme, TH_DEF); themeReflect(); push(); };
    themeReflect(); themeApply(_theme); // применить сохранённое сразу
  }

  // ── старт: ждём готовность графика ───────────────────────────────────────────
  function boot() {
    build();
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      if (ready()) { clearInterval(iv); status('график найден'); refresh(true);
        setInterval(() => { if (!S.busy) refresh(false); }, 2500); // отслеживаем смену тикера/данных
        setInterval(() => { if (oiTokenGet() && S.oi) oiLoad(); }, 300000); } // живой OI раз в 5 мин
      else if (tries > 120) { clearInterval(iv); status('график не найден (открой вкладку с графиком)'); }
    }, 500);
  }

  window.__tvSignals = { S, refresh, drawMethod, toggle, getApi, ready };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', boot); else boot();
})();
