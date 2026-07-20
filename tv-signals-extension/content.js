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
    ['fade', 'Фейд у уровня', '#5EE6A8'],
    ['zonefade', 'Зона-фейд', '#52F2C9'],
  ];
  const NAME = {}, DEF_COLOR = {}, IDX = {}; META.forEach(([id, n, c], i) => { NAME[id] = n; DEF_COLOR[id] = c; IDX[id] = i; });
  // группировка списка по синергии (строгий рейтинг agree_scan: no-overlap + OOS).
  // Методы одной группы хорошо сочетаются в согласиях; заголовок — агрегат exp/win.
  const GROUPS = [
    { title: 'Разворотные — ядро связок', ids: ['fade', 'talib_anti', 'zonefade', 'accel', 'nw', 'vsa_abs'],
      desc: 'Mean-reversion/фейд-методы с сильнейшими согласиями (строго: связки удваивают одиночный edge и держатся OOS). «Фейд свечей» — клей, входит в большинство топ-пар. Лучшая частая связка: Фейд у уровня + Фейд свечей (+0.60 ATR).' },
    { title: 'Разворотные — поддержка', ids: ['zscore', 'alligator_inv', 'waning'],
      desc: 'Плюсовые сами по себе и усиливают ядро в согласиях, но слабее. Z-score и Аллигатор класс.(инв.) — частые, стабильные OOS.' },
    { title: 'Моментум / структура — слабы на R:R 2:1', ids: ['order_block', 'fvg', 'liq_sweep', 'false_breakout', 'hawkes', 'cascade'],
      desc: 'На брекете R:R 2:1 (заточен под разворот) в среднем в минус: Hawkes/Order Block/FVG/пробои — это моментум/структурные сигналы, им нужен другой выход, не фейд-сетка. Cascade нестабилен OOS. Держать выключенными или для контекста.' },
  ];
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
    zonefade: { what: 'Зона-фейд — валидированная стратегия (invest-bot аудит взамен NW). Зона z(T)<−0.4 & z(P)>0.6 (низкая интенсивность + высокая направленность) → ФЕЙД хода 3 баров, только когда рынок НЕ сонаправлен (breadth) и БОКОВИК (ER-60<0.3).', read: 'В зоне после роста → сигнал ВНИЗ, после падения → ВВЕРХ. Ставка на разворот в mean-reversion режиме.', note: 'Прошла весь чек-лист: TEST short +0.25 ATR, block-bootstrap CI [+0.11,+0.20], permutation p≈0, holdout по тикерам обобщается, синхронность рынка не ломает, P&L размазан. Наивный mean-reversion бьёт NW — вся аналог-память избыточна, это ядро edge. Брекет R:R 2:1 (тейк 2.0/стоп 1.0 ATR). До 20 одновременных позиций — сайзить с учётом коррелированного риска (см. калькулятор).' },
    fade: { what: 'Фейд у уровня + breadth: резкий ход (≥0.5 ATR за 3 бара), упёршийся в прошлый хай/лоу за 100 баров (реджект), И идиосинкразический либо против рынка (не сонаправлен с рынком).', read: 'Ход вверх в прошлый хай → сигнал ВНИЗ (фейд), ход вниз в прошлый лоу → ВВЕРХ. Фейдим только шум: если ход идёт ВМЕСТЕ с рынком — сигнала нет (это моментум).', note: 'ПОЛНАЯ версия both из бэктеста (invest-bot): level (реджект у уровня, −0.26 ATR) + breadth (медиана 3-барных доходностей корзины ~30 ликвидных бумаг MOEX). Пока breadth грузится (статус «фейд полный») — работает level-режим. TEST +0.31 ATR/сделку при R:R 2:1 (тейк ~1.5 / стоп ~0.75 ATR), но эдж режимный — сайзить умеренно.' },
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

  // ── сканер тикеров: полный OHLCV с MOEX для расчёта сигналов ───────────────────
  async function scanFetch(code, iv, t0, t1) {
    const d0 = cmpDate(t0 - 86400), d1 = cmpDate(t1 + 86400);
    const mkts = [['stock', 'shares'], ['stock', 'index'], ['futures', 'forts'], ['currency', 'selt']];
    for (const [eng, mkt] of mkts) {
      const url = 'https://iss.moex.com/iss/engines/' + eng + '/markets/' + mkt + '/securities/' + encodeURIComponent(code) +
        '/candles.json?iss.meta=off&interval=' + iv + '&from=' + d0 + '&till=' + d1;
      const r = await oiFetch(url); if (!r.ok) continue;
      let j; try { j = JSON.parse(r.json); } catch (e) { continue; }
      const cc = j.candles; if (!cc || !cc.data || !cc.data.length) continue;
      const C = cc.columns, io = C.indexOf('open'), ih = C.indexOf('high'), il = C.indexOf('low'),
        ic = C.indexOf('close'), iv2 = C.indexOf('volume'), ib = C.indexOf('begin');
      const bars = cc.data.map(row => ({
        time: Math.floor(Date.parse(String(row[ib]).replace(' ', 'T') + '+03:00') / 1000),
        open: +row[io], high: +row[ih], low: +row[il], close: +row[ic], volume: +row[iv2]
      })).filter(b => b.time && b.close > 0).sort((a, b) => a.time - b.time);
      if (bars.length) return { ok: true, bars };
    }
    return { ok: false };
  }
  async function scanRun() {
    const body = document.getElementById('tvsig-scan-body'); if (!body) return;
    const raw = (document.getElementById('tvsig-scan-list') || {}).value || '';
    const codes = raw.split(/[\s,;]+/).map(s => s.trim().toUpperCase().split(':').pop()).filter(Boolean);
    if (!codes.length) { body.innerHTML = '<div class="tvsig-fc-hint">Впиши тикеры MOEX через запятую/пробел/строку.</div>'; return; }
    try { localStorage.setItem('tvsig:scanlist', raw); } catch (e) {}
    const A = (document.getElementById('tvsig-scan-a') || {}).value, B = (document.getElementById('tvsig-scan-b') || {}).value;
    const auto = A === '__auto';                              // авто: лучший метод на каждый тикер
    const look = Math.max(1, parseInt((document.getElementById('tvsig-scan-look') || {}).value, 10) || 3);
    const dt = S.barDt || 300;
    const iv = dt <= 90 ? 1 : dt <= 1200 ? 10 : dt <= 10800 ? 60 : dt <= 259200 ? 24 : 7;
    const ivSec = iv === 1 ? 60 : iv === 10 ? 600 : iv === 60 ? 3600 : iv === 24 ? 86400 : 604800;
    const now = Math.floor(Date.now() / 1000), t0 = now - 1000 * ivSec;
    body.innerHTML = '<div class="tvsig-fc-hint">Сканирую ' + codes.length + ' тикеров' + (auto ? ' (авто-подбор метода)' : '') + '…</div>';
    const SC = window.SignalsCore; if (SC.setBreadth) SC.setBreadth(null, 0); // без кросс-тикер breadth в скане
    const hits = []; const diag = { ok: 0, err: 0, aFire: 0 }; // диагностика: сколько загрузилось, у скольких что-то мелькало
    const findFire = (ser, li, lo) => { for (let k = li; k >= lo; k--) if (ser[k]) return k; return -1; }; // самое свежее срабатывание в окне
    const pushHit = (code, bars, dir, hitBar, li, st, mid, ser) => {
      let oc = null; try { oc = SC.tradeOutcome(bars, hitBar, dir, 1.5, 0.75, 0.12, 12); } catch (e) {}
      let plan = null; try { plan = ser ? _planFor(bars, ser, hitBar, dir, ivSec, li) : null; } catch (e) {}
      hits.push({ code, dir, price: bars[hitBar].close, ago: li - hitBar, ts: bars[hitBar].time, mid,
        exp: st ? st.exp : null, win: st ? st.win : null, n: st ? st.n : 0,
        ocExit: oc ? oc.exit : null, ocPnl: oc ? oc.pnl : null, plan });
    };
    for (const code of codes) {
      let f; try { f = await scanFetch(code, iv, t0, now); } catch (e) { f = null; }
      if (!f || !f.ok || f.bars.length < 80) { diag.err++; continue; }
      diag.ok++;
      const bars = f.bars;
      const li = bars.length - 2, lo = Math.max(0, li - look + 1); // последний закрытый бар + окно свежести
      if (auto) {
        // для тикера считаем ВСЕ методы, берём тот, что (а) сработал в окне,
        // (б) с лучшим exp на истории тикера и exp>0, n>=10 — «самый точный ЗДЕСЬ».
        let comp; try { comp = SC.computeAll(bars, 12); } catch (e) { continue; }
        let best = null, anyFire = false;
        for (const id of SC.IDS) { const c = comp[id]; if (!c || !c.series) continue;
          const hb = findFire(c.series, li, lo); if (hb < 0) continue; anyFire = true;
          const st = c.stats; if (!st || st.exp == null || st.n < 10 || st.exp <= 0) continue;
          if (!best || st.exp > best.st.exp) best = { id, hb, dir: Math.sign(c.series[hb]), st };
        }
        if (anyFire) diag.aFire++;
        if (best) pushHit(code, bars, best.dir, best.hb, li, best.st, best.id, comp[best.id].series);
        continue;
      }
      let sa, sb;
      try { sa = SC.methods[A](bars); sb = B && B !== '-' ? SC.methods[B](bars) : null; } catch (e) { continue; }
      let aFired = false, hitBar = -1, dir = 0;
      // ищем САМОЕ СВЕЖЕЕ срабатывание в окне (от li вниз)
      for (let k = li; k >= lo; k--) {
        const va = sa[k] || 0; if (va) aFired = true;
        let ok = false, d = 0;
        if (sb) { const vb = sb[k] || 0; if (va && vb && Math.sign(va) === Math.sign(vb)) { ok = true; d = Math.sign(va); } }
        else if (va) { ok = true; d = Math.sign(va); }
        if (ok) { hitBar = k; dir = d; break; }
      }
      if (aFired) diag.aFire++;
      if (hitBar >= 0) {
        // точность связки НА ЭТОМ тикере: exp/win/n по истории (для сортировки).
        // Для согласия — серия только там, где оба метода в одну сторону.
        const ser2 = sb ? sa.map((v, k) => { const w = sb[k]; return (v && w && Math.sign(v) === Math.sign(w)) ? Math.sign(v) : 0; }) : sa;
        let st = null; try { st = SC.btStats(ser2, bars, 12); } catch (e) {}
        pushHit(code, bars, dir, hitBar, li, st, null, ser2);
      }
    }
    scanRender(hits, A, B, look, diag, ivSec, auto);
  }
  // «N баров назад» → реальное время с учётом ТФ
  function _scanAgo(ago, ivSec) {
    if (ago <= 0) return 'сейчас (последний бар)';
    const s = ago * ivSec;
    let t; if (s < 3600) t = Math.round(s / 60) + ' мин';
    else if (s < 86400) t = (s / 3600).toFixed(s < 36000 ? 1 : 0) + ' ч';
    else t = Math.round(s / 86400) + ' дн';
    return ago + ' баров / ' + t + ' назад';
  }
  function scanRender(hits, A, B, look, diag, ivSec, auto) {
    const body = document.getElementById('tvsig-scan-body'); if (!body) return;
    const found = hits.filter(h => h.dir);
    const combo = auto ? '🔝 лучший метод на тикере' : ((B && B !== '-') ? (NAME[A] + ' + ' + NAME[B]) : NAME[A]);
    const win = look > 1 ? ' за ' + look + ' баров' : ' на последнем баре';
    if (!found.length) {
      let msg = 'Нет срабатываний «' + combo + '»' + win + '. Загружено ' + diag.ok + ' тикеров';
      if (diag.err) msg += ' (' + diag.err + ' не отдали свечи)';
      if (auto) msg += '. Сигналы мелькали у ' + diag.aFire + ', но ни один прибыльный на истории (exp>0, n≥10) — увеличь окно или смени ТФ.';
      else { msg += '. ' + NAME[A] + ' мелькал у ' + diag.aFire + '.';
        if (B && B !== '-' && diag.aFire > 0) msg += ' Связка не сошлась — попробуй один метод (второй «—») или увеличь окно.';
        else if (diag.aFire === 0) msg += ' Метод редкий на этом ТФ — увеличь окно (за 5–10 баров) или смени ТФ графика.'; }
      body.innerHTML = '<div class="tvsig-fc-hint">' + msg + '</div>'; return;
    }
    // сортируем по историческому exp метода/связки на тикере (сильные/точные — вверх);
    // тикеры с малой выборкой (n<10) уводим вниз, оценке доверять нельзя.
    const rk = h => (h.n >= 10 && h.exp != null) ? h.exp : -Infinity;
    found.sort((a, b) => rk(b) - rk(a));
    body.innerHTML = '<div class="tvsig-scan-hd">' + combo + win + ' — ' + found.length + (auto ? ' тикеров с прибыльным сигналом' : ' сработало') + ' (по точности на тикере):</div>' +
      found.map(h => {
        const stat = (h.n >= 10 && h.exp != null)
          ? '<span class="' + (h.exp > 0.03 ? 'pos' : h.exp < -0.03 ? 'neg' : 'dim') + '" title="exp — средний P&L сделки метода/связки в ATR на истории тикера (R:R 2:1). win — винрейт, n — число сделок.">exp ' + (h.exp >= 0 ? '+' : '') + h.exp.toFixed(2) + ' · win ' + Math.round(h.win * 100) + '% · n' + h.n + '</span>'
          : '<span class="dim" title="Мало сделок на истории тикера — точность оценить нельзя.">мало истории</span>';
        const mname = (auto && h.mid) ? ' <span class="dim" title="Самый прибыльный на истории этого тикера метод, сработавший в окне">· ' + (NAME[h.mid] || h.mid) + '</span>' : '';
        const ago = '<span class="dim" title="Сколько назад сработало (баров и реального времени с учётом ТФ)">' + _scanAgo(h.ago, ivSec) + '</span>';
        // «имело ли смысл»: исход именно этой сделки, если уже отыграла
        let oc = '';
        if (h.ocExit === 'открыта') oc = ' <span class="dim" title="Сделка ещё не закрылась (свежий сигнал)">ещё открыта</span>';
        else if (h.ocExit && h.ocPnl != null) { const good = h.ocPnl > 0;
          oc = ' <span class="' + (good ? 'pos' : 'neg') + '" title="Чем закончилась ИМЕННО эта сделка от сигнала (тейк 1.5 / стоп 0.75 ATR, тайм-выход 12 баров)">→ ' + h.ocExit + ' ' + (h.ocPnl >= 0 ? '+' : '') + h.ocPnl.toFixed(2) + ' ATR</span>'; }
        const badges = _planBadges(h.plan);
        return '<div class="tvsig-scan-hit" data-code="' + h.code + '">' +
          '<b>' + h.code + '</b> <span class="' + (h.dir < 0 ? 'neg' : 'pos') + '">' + (h.dir < 0 ? '↓ шорт' : '↑ лонг') + '</span>' + mname +
          ' <span class="dim">@ ' + h.price + '</span> ' + ago + oc + (badges ? '<br>' + badges : '') + '<br>' + stat + '</div>';
      }).join('');
  }

  // ── рыночный breadth для полной версии фейда ──────────────────────────────────
  // Корзина ликвидных бумаг MOEX: медиана их 3-барных доходностей = «рынок».
  // ~30 имён достаточно (median робастна). Тянем через тот же cmpFetch, выравниваем
  // на бары графика. Полный аналог breadth-фильтра из бэктеста (both).
  const BREADTH_BASKET = ['SBER', 'GAZP', 'LKOH', 'GMKN', 'ROSN', 'NVTK', 'TATN', 'PLZL',
    'MGNT', 'MTSS', 'MOEX', 'VTBR', 'ALRS', 'CHMF', 'NLMK', 'SNGS', 'RUAL', 'AFLT', 'PIKK',
    'MAGN', 'IRAO', 'PHOR', 'SIBN', 'TRNFP', 'AFKS', 'HYDR', 'RTKM', 'SELG', 'FLOT', 'POSI'];

  // ── сканер: стандартные наборы тикеров MOEX (пресеты по секторам) ──────────────
  const SCAN_PRESETS = {
    'Голубые фишки': 'SBER GAZP LKOH GMKN ROSN NVTK TATN PLZL MGNT MTSS MOEX VTBR',
    'Нефтегаз': 'LKOH GAZP ROSN NVTK TATN SNGS SNGSP SIBN TRNFP BANE',
    'Металлурги / горнодоб': 'GMKN NLMK MAGN CHMF PLZL RUAL ALRS SELG MTLR RASP',
    'Финансы': 'SBER SBERP VTBR MOEX BSPB SVCB CBOM TCSG',
    'Потреб / ритейл': 'MGNT MVID FIXP LENT BELU AGRO GCHE ABRD',
    'Энергетика': 'IRAO HYDR FEES UPRO OGKB MSNG MRKC TGKA',
    'Технологии / телеком': 'MTSS RTKM POSI VKCO HHRU ASTR',
    'Широкий ликвид': 'SBER GAZP LKOH GMKN ROSN NVTK TATN PLZL MGNT MTSS MOEX VTBR ALRS CHMF NLMK MAGN SNGS RUAL AFLT PIKK IRAO PHOR SIBN AFKS HYDR RTKM SELG FLOT POSI MTLR',
  };
  // база для «списка дня»: широкий ликвидный универс, из которого ранжируем
  const SCAN_UNIVERSE = ('SBER SBERP GAZP LKOH GMKN ROSN NVTK TATN TATNP PLZL MGNT MTSS MOEX VTBR ' +
    'ALRS CHMF NLMK MAGN SNGS SNGSP RUAL AFLT PIKK IRAO PHOR SIBN AFKS HYDR RTKM SELG FLOT POSI ' +
    'MTLR MVID FIXP BSPB SVCB CBOM UPRO FEES OGKB MSNG BANE TRNFP RASP AGRO BELU HHRU VKCO ASTR').split(' ');

  async function breadthEnsure(bars, dt) {
    if (!window.SignalsCore || !bars || bars.length < 20 || !dt) return;
    const key = (S.symbol || '') + '|' + dt;
    if (S._breadthKey === key && S._breadthMap) { // уже построен на этот тикер+ТФ
      window.SignalsCore.setBreadth(S._breadthMap, S._breadthMedAbs); return; }
    if (S._breadthBuilding === key) return;       // уже строится — не дублируем
    S._breadthBuilding = key;
    const iv = dt <= 90 ? 1 : dt <= 1200 ? 10 : dt <= 10800 ? 60 : dt <= 259200 ? 24 : 7;
    const ivSec = iv === 1 ? 60 : iv === 10 ? 600 : iv === 60 ? 3600 : iv === 24 ? 86400 : 604800;
    const tol = ivSec * 1.5, t0 = bars[0].time, t1 = bars[bars.length - 1].time, m = 3;
    try {
      const results = await Promise.all(BREADTH_BASKET.map(code =>
        cmpFetch(code, iv, t0, t1).then(r => (r && r.ok) ? r.rows : null).catch(() => null)));
      const aligned = []; // на каждый удавшийся тикер — close[], выровненный на бары
      for (const rows of results) {
        if (!rows || rows.length < 10) continue;
        const cl = new Array(bars.length).fill(null); let j = 0;
        for (let bi = 0; bi < bars.length; bi++) { const bt = bars[bi].time;
          while (j + 1 < rows.length && Math.abs(rows[j + 1].t - bt) <= Math.abs(rows[j].t - bt)) j++;
          if (rows[j] && Math.abs(rows[j].t - bt) <= tol) cl[bi] = rows[j].close; }
        aligned.push(cl);
      }
      if (aligned.length < 8) { // мало корзины → остаёмся в level-режиме
        S._breadthBuilding = null;
        status('breadth: мало данных корзины (' + aligned.length + ') · фейд level-режим'); return; }
      const map = new Map(); const absv = [];
      for (let bi = m; bi < bars.length; bi++) { const rs = [];
        for (const cl of aligned) { const a = cl[bi], b = cl[bi - m]; if (a != null && b != null && b > 0) rs.push(a / b - 1); }
        if (rs.length < 5) continue;
        rs.sort((x, y) => x - y); const md = rs[rs.length >> 1];
        map.set(bars[bi].time, md); absv.push(Math.abs(md)); }
      absv.sort((x, y) => x - y); const medAbs = absv.length ? absv[absv.length >> 1] : 0;
      S._breadthMap = map; S._breadthMedAbs = medAbs; S._breadthKey = key; S._breadthBuilding = null;
      window.SignalsCore.setBreadth(map, medAbs);
      if (S.computed && S.bars) { // пересчитать только фейд + перерисовать
        S.computed.fade = window.SignalsCore.computeOne('fade', S.bars, 12);
        renderRows(); renderConsensus(); if (S.on && S.on.fade) drawMethod('fade'); }
      status('breadth готов (' + aligned.length + ' тикеров) · фейд полный');
    } catch (e) { S._breadthBuilding = null; }
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
    if (which === 'forecast') forecastRender();
    if (which === 'scan') scanInit();
  }
  function scanInit() {
    const sa = document.getElementById('tvsig-scan-a'), sb = document.getElementById('tvsig-scan-b');
    if (sa && !sa.dataset.init) {
      const opts = window.SignalsCore.IDS.map(id => '<option value="' + id + '">' + (NAME[id] || id) + '</option>').join('');
      // 🔝 авто: для каждого тикера сам берёт самый точный на его истории метод
      sa.innerHTML = '<option value="__auto">🔝 авто: лучший метод тикера</option>' + opts;
      sb.innerHTML = '<option value="-">— (один метод)</option>' + opts;
      sa.value = '__auto'; sb.value = '-';                   // авто-подбор по умолчанию — не надо жёстко задавать метод
      sa.dataset.init = '1';
      // в авто второй селект не нужен — гасим его
      const syncB = () => { sb.disabled = (sa.value === '__auto'); sb.style.opacity = sb.disabled ? '0.4' : ''; };
      sa.addEventListener('change', syncB); syncB();
      const lst = document.getElementById('tvsig-scan-list');
      try { const s = localStorage.getItem('tvsig:scanlist'); if (s && lst) lst.value = s; } catch (e) {}
      scanFillPresets();
    }
  }
  // свои списки: {имя: "SBER GAZP ..."} в localStorage
  function scanLoadLists() { try { return JSON.parse(localStorage.getItem('tvsig:scanlists') || '{}') || {}; } catch (e) { return {}; } }
  function scanSaveLists(o) { try { localStorage.setItem('tvsig:scanlists', JSON.stringify(o)); } catch (e) {} }
  // наполняем выпадашку: пресеты (стандартные) + свои списки (★). Пустой первый пункт.
  function scanFillPresets() {
    const sel = document.getElementById('tvsig-scan-preset'); if (!sel) return;
    const cur = sel.value, mine = scanLoadLists();
    let html = '<option value="">— набор тикеров —</option>';
    html += '<optgroup label="Стандартные">' + Object.keys(SCAN_PRESETS).map(k =>
      '<option value="p:' + k + '">' + k + '</option>').join('') + '</optgroup>';
    const mk = Object.keys(mine);
    if (mk.length) html += '<optgroup label="Мои списки">' + mk.map(k =>
      '<option value="m:' + k + '">★ ' + k + '</option>').join('') + '</optgroup>';
    sel.innerHTML = html; if (cur) sel.value = cur;
  }
  function scanApplyPreset(v) {
    const lst = document.getElementById('tvsig-scan-list'); if (!lst || !v) return;
    let txt = null;
    if (v.indexOf('p:') === 0) txt = SCAN_PRESETS[v.slice(2)];
    else if (v.indexOf('m:') === 0) txt = scanLoadLists()[v.slice(2)];
    if (txt != null) { lst.value = txt; try { localStorage.setItem('tvsig:scanlist', txt); } catch (e) {} }
  }
  function scanSaveList() {
    const lst = document.getElementById('tvsig-scan-list'); if (!lst) return;
    const txt = (lst.value || '').trim(); if (!txt) { status('список пуст — нечего сохранять'); return; }
    const name = (prompt('Имя списка (напр. «Мои ВДО» или «Список дня 19.07»):', '') || '').trim();
    if (!name) return;
    const o = scanLoadLists(); o[name] = txt; scanSaveLists(o); scanFillPresets();
    const sel = document.getElementById('tvsig-scan-preset'); if (sel) sel.value = 'm:' + name;
    status('список «' + name + '» сохранён');
  }
  function scanDeleteList() {
    const sel = document.getElementById('tvsig-scan-preset'); if (!sel) return;
    const v = sel.value;
    if (v.indexOf('m:') !== 0) { status('удалять можно только свои списки (★)'); return; }
    const name = v.slice(2); const o = scanLoadLists();
    if (!(name in o)) return;
    if (!confirm('Удалить список «' + name + '»?')) return;
    delete o[name]; scanSaveLists(o); scanFillPresets(); sel.value = ''; status('список «' + name + '» удалён');
  }
  // «список дня»: ранжируем широкий универс по волатильности (ATR%) и ликвидности
  // (медианный оборот) на ДНЕВНЫХ свечах, берём топ-15 по сумме перцентилей.
  async function scanListDay() {
    const body = document.getElementById('tvsig-scan-body'), lst = document.getElementById('tvsig-scan-list');
    if (!body || !lst) return;
    const btn = document.getElementById('tvsig-scan-day'); if (btn) btn.disabled = true;
    body.innerHTML = '<div class="tvsig-fc-hint">Считаю список дня по ' + SCAN_UNIVERSE.length + ' тикерам (дневные свечи)…</div>';
    const SC = window.SignalsCore, now = Math.floor(Date.now() / 1000), t0 = now - 120 * 86400;
    const rows = [];
    for (const code of SCAN_UNIVERSE) {
      let f; try { f = await scanFetch(code, 24, t0, now); } catch (e) { f = null; }
      if (!f || !f.ok || f.bars.length < 20) continue;
      const bars = f.bars, at = SC.atr(bars, 14);
      let a = null; for (let i = at.length - 1; i >= 0; i--) if (at[i] != null) { a = at[i]; break; }
      const price = bars[bars.length - 1].close; if (!a || !price) continue;
      const tos = bars.map(b => b.volume * b.close).filter(x => isFinite(x) && x > 0).sort((x, y) => x - y);
      if (!tos.length) continue;
      rows.push({ code, atrPct: 100 * a / price, turn: tos[tos.length >> 1] });
    }
    if (btn) btn.disabled = false;
    if (rows.length < 5) { body.innerHTML = '<div class="tvsig-fc-hint">Мало данных с MOEX — попробуй ещё раз позже.</div>'; return; }
    // перцентиль-ранг по каждой оси (0..1), скор = волатильность + ликвидность
    const rank = (key) => { const s = rows.slice().sort((x, y) => x[key] - y[key]); const m = new Map();
      s.forEach((r, i) => m.set(r.code, s.length > 1 ? i / (s.length - 1) : 0.5)); return m; };
    const rv = rank('atrPct'), rl = rank('turn');
    rows.forEach(r => r.score = rv.get(r.code) + rl.get(r.code));
    rows.sort((x, y) => y.score - x.score);
    const top = rows.slice(0, 15);
    const txt = top.map(r => r.code).join(' ');
    lst.value = txt; try { localStorage.setItem('tvsig:scanlist', txt); } catch (e) {}
    const bn = x => x >= 1e9 ? (x / 1e9).toFixed(1) + ' млрд' : (x / 1e6).toFixed(0) + ' млн';
    body.innerHTML = '<div class="tvsig-scan-hd">Список дня — топ-15 по волатильности × ликвидности:</div>' +
      top.map(r => '<div class="tvsig-scan-hit" data-code="' + r.code + '"><b>' + r.code + '</b> ' +
        '<span class="dim">ATR ' + r.atrPct.toFixed(1) + '% · оборот/день ' + bn(r.turn) + ' ₽</span></div>').join('') +
      '<div class="tvsig-fc-hint">Список подставлен выше. Жми «Скан» для проверки связки или «Сохранить…».</div>';
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

  // ── вкладка «Прогноз»: режим + условная точность + прогноз от точки + гипотеза ─
  // Сигнал-агностична: анализируем ВЫБРАННЫЙ сигнал (S.fcId), не только фейд —
  // мета-слой «когда он надёжен» одинаково полезен NW, фейду и любому из 14.
  function _fcNum(x, d) { return x == null ? '—' : (x >= 0 ? '+' : '') + x.toFixed(d == null ? 3 : d); }
  function _hhmm(ts) { const t = new Date(ts * 1000); return ('0' + t.getUTCHours()).slice(-2) + ':' + ('0' + t.getUTCMinutes()).slice(-2); }
  function _regLbl(rg) { return rg ? (rg.isTrend ? 'тренд ' + (rg.trendDir > 0 ? '↑' : '↓') : 'боковик') + (rg.vol ? '/' + rg.vol : '') : ''; }
  function _fcSeries(id) { const SC = window.SignalsCore;
    if (S.computed && S.computed[id] && S.computed[id].series) return S.computed[id].series;
    return SC.computeOne(id, S.bars, 12).series; }
  function _mtfDirAt(i) { return (S._mtfByTime && S.bars[i]) ? (S._mtfByTime.get(S.bars[i].time) || 0) : null; }
  function _mtfChip() {
    if (!S.mtfOn) return '';
    if (!S._mtfByTime) return '<span class="tvsig-fc-chip c-mtf">старший ТФ: гружу…</span>';
    const d = _mtfDirAt(S.bars.length - 1);
    return '<span class="tvsig-fc-chip c-mtf">' + (S._mtfTf || 'ТФ') + ': ' + (d > 0 ? 'тренд ↑' : d < 0 ? 'тренд ↓' : 'плоско') + '</span>';
  }
  function _regimeBadge(rg) {
    if (!rg) return '';
    const tr = rg.isTrend ? ('тренд ' + (rg.trendDir > 0 ? '↑' : '↓')) : 'боковик';
    const erS = rg.er != null ? ' · ER ' + rg.er.toFixed(2) : '';
    return '<span class="tvsig-fc-chip c-reg">' + tr + erS + '</span>' +
      '<span class="tvsig-fc-chip c-vol">vol: ' + (rg.vol || '—') + '</span>' +
      '<span class="tvsig-fc-chip c-mkt">' + (rg.mkt || 'breadth —') + '</span>' + _mtfChip();
  }
  // группированная таблица условной точности по осям режим/vol/рынок/сессия
  function _condTable(cs, cur) {
    const grp = (g) => { const keys = Object.keys(cs[g]);
      const rows = keys.map(k => { const s = cs[g][k], isCur = cur && cur[g] === k;
        const exp = s.n ? _fcNum(s.exp) : '—', win = s.n ? Math.round(s.win * 100) + '%' : '—';
        const cls = !s.n ? 'dim' : (s.exp > 0 ? 'pos' : 'neg');
        const nMark = s.n && s.n < 20 ? ' <span class="tvsig-fc-lown" title="мало сделок — цифра шумная">!</span>' : '';
        return '<tr class="' + (isCur ? 'cur' : '') + '"><td>' + k + (isCur ? ' ◂' : '') + '</td><td class="' + cls + '">' + exp + '</td><td>' + win + '</td><td class="dim">' + (s.n || 0) + nMark + '</td></tr>'; }).join('');
      return '<tr class="tvsig-fc-grp"><td colspan="4">' + g + '</td></tr>' + rows; };
    return '<table class="tvsig-fc-tbl"><tr><th>ось</th><th>exp</th><th>win</th><th>n</th></tr>' +
      ['режим', 'vol', 'рынок', 'сессия'].map(grp).join('') + '</table>';
  }
  // ── план активного сигнала: цель/срок, промежуточные чекпоинты, тренд метода,
  //    опровергнут ли рынком с начала забега (общий код для панели и сканера) ────
  function _fmtDuration(sec) {
    if (sec == null || !isFinite(sec)) return '—';
    const s = Math.max(0, Math.round(sec));
    if (s < 60) return s + ' с'; if (s < 3600) return Math.round(s / 60) + ' мин';
    if (s < 86400) return (s / 3600).toFixed(s < 36000 ? 1 : 0) + ' ч'; return Math.round(s / 86400) + ' дн';
  }
  // bars/ser — свои для тикера (панель: S.bars/series; сканер: бары сканируемого тикера),
  // i — бар, на котором ищем начало забега сигнала (в сканере — бар срабатывания,
  // а не обязательно последний), dir — направление, dt — шаг бара (сек), nowIdx —
  // «сейчас» для отсчёта возраста/чекпоинтов (по умолчанию = i, в сканере — li).
  function _planFor(bars, ser, i, dir, dt, nowIdx) {
    const SC = window.SignalsCore;
    const run = SC.signalRun(ser, i); if (!run) return null;
    nowIdx = nowIdx != null ? nowIdx : i;
    const live = SC.liveOutcome(bars, run.startIdx, dir, 1.5, 0.75, 0.12, 12);
    const trend = SC.methodTrend(ser, bars, 12);
    const ageBars = nowIdx - run.startIdx;
    const plan = { dir, startIdx: run.startIdx, startTime: bars[run.startIdx].time,
      ageBars, ageTime: ageBars * dt, trend, live, nowPrice: bars[nowIdx].close };
    if (live) { plan.entry = live.entry; plan.tp = live.tp; plan.sl = live.sl; }
    if (live && live.state === 'active') {
      plan.etaBars = live.barsRemaining; plan.etaTime = live.barsRemaining * dt;
      plan.checkpoints = [0.25, 0.5, 0.75, 1].map(f => {
        const barsFromNow = Math.max(1, Math.round(live.barsRemaining * f));
        return { f, barsFromNow, time: bars[nowIdx].time + barsFromNow * dt, price: plan.nowPrice + (live.tp - plan.nowPrice) * f };
      });
    }
    return plan;
  }
  function _signalPlan(id) {
    const c = S.computed && S.computed[id], bars = S.bars;
    if (!c || !c.last || !c.series || !bars || !bars.length) return null;
    return _planFor(bars, c.series, bars.length - 1, Math.sign(c.last), S.barDt || 300);
  }
  // компактный кластер бейджей: тренд метода (усил/слаб) + статус живой сделки
  // с начала сигнала (в пути / опровергнут стопом / цель достигнута / устарел)
  function _planBadges(p) {
    if (!p) return '';
    let html = '';
    if (p.trend && p.trend.state) {
      const t = p.trend.state, cls = t === 'up' ? 'up' : t === 'down' ? 'down' : 'flat';
      const arrow = t === 'up' ? '↗' : t === 'down' ? '↘' : '→';
      const word = t === 'up' ? 'усиливается' : t === 'down' ? 'слабеет' : 'стабильно';
      html += '<span class="tvsig-trend ' + cls + '" title="Метод ' + word + ': последние ' + p.trend.recentN + ' сделок exp ' +
        _fcNum(p.trend.recentExp) + ' ATR против предыдущих ' + p.trend.priorN + ' сделок exp ' + _fcNum(p.trend.priorExp) + ' ATR">' + arrow + '</span>';
    }
    if (p.live) {
      const st = p.live.state, since = 'с ' + _hhmm(p.startTime) + ' UTC (' + p.ageBars + ' бар. / ' + _fmtDuration(p.ageTime) + ' назад)';
      if (st === 'stopped') html += '<span class="tvsig-inval" title="Опровергнут: цена уже выбила расчётный стоп ' + p.sl.toFixed(4) + ' ' + since + '">⚠ стоп</span>';
      else if (st === 'reached') html += '<span class="tvsig-reached" title="Цель ' + p.tp.toFixed(4) + ' уже достигнута ' + since + '">✓ цель</span>';
      else if (st === 'expired') html += '<span class="tvsig-expired" title="Прошло больше горизонта (12 баров) без тейка/стопа — сигнал устарел, ' + since + '">⏱ истёк</span>';
      else if (st === 'active') html += '<span class="tvsig-eta" title="Сигнал ' + since + '. Цель ' + p.tp.toFixed(4) + ' · стоп ' + p.sl.toFixed(4) + ' · ~' + _fmtDuration(p.etaTime) + ' (' + p.etaBars + ' бар.) до конца горизонта (12 бар.), если темп сохранится">→' + p.tp.toFixed(2) + ' ~' + _fmtDuration(p.etaTime) + '</span>';
    }
    return html;
  }
  function _recentSignals(ser, bars) {
    const idx = []; for (let i = bars.length - 1; i >= 0 && idx.length < 8; i--) if (ser[i]) idx.push(i);
    if (!idx.length) return '<span class="tvsig-fc-hint">Нет сигналов на этой истории.</span>';
    return idx.map(i => '<div class="tvsig-fc-sig" data-idx="' + i + '">' + _hhmm(bars[i].time) + ' UTC · ' +
      (ser[i] < 0 ? '↓ шорт' : '↑ лонг') + ' · <span class="dim">' + _regLbl(window.SignalsCore.regimeInfo(bars, i)) + '</span></div>').join('');
  }
  // карточка ТЕКУЩЕГО активного сигнала выбранного метода: цель/срок, чекпоинты
  // по пути, тренд метода, статус (в пути / опровергнут / цель / устарел)
  function _activeSignalCard(id) {
    const p = _signalPlan(id);
    if (!p) return '<span class="tvsig-fc-hint">Сейчас нет активного сигнала «' + (NAME[id] || id) + '» на этом тикере.</span>';
    const dirTxt = p.dir < 0 ? '↓ шорт' : '↑ лонг';
    const since = _hhmm(p.startTime) + ' UTC · ' + p.ageBars + ' бар. / ' + _fmtDuration(p.ageTime) + ' назад';
    const st = p.live ? p.live.state : null;
    let stLine;
    if (st === 'stopped') stLine = '<span class="tvsig-inval">⚠ ОПРОВЕРГНУТ</span> — цена уже выбила стоп ' + p.sl.toFixed(4) + ' с начала сигнала';
    else if (st === 'reached') stLine = '<span class="tvsig-reached">✓ цель достигнута</span> — ' + p.tp.toFixed(4) + ' уже пройдена с начала сигнала';
    else if (st === 'expired') stLine = '<span class="tvsig-expired">⏱ устарел</span> — прошло больше горизонта (12 бар.) без тейка/стопа, актуальность под вопросом';
    else if (st === 'active') stLine = 'в пути · ещё ~' + _fmtDuration(p.etaTime) + ' (' + p.etaBars + ' бар.) до конца горизонта, если темп сохранится';
    else stLine = '—';
    const trend = p.trend && p.trend.state
      ? ((p.trend.state === 'up' ? '<span class="tvsig-trend up">↗ усиливается</span>' : p.trend.state === 'down' ? '<span class="tvsig-trend down">↘ слабеет</span>' : '<span class="tvsig-trend flat">→ стабильно</span>') +
        ' (посл. ' + p.trend.recentN + ' сделки exp ' + _fcNum(p.trend.recentExp) + ' ATR против пред. ' + p.trend.priorN + ' сделок exp ' + _fcNum(p.trend.priorExp) + ' ATR)')
      : '<span class="tvsig-fc-hint">мало сделок в истории для оценки тренда</span>';
    const cps = p.checkpoints ? '<table class="tvsig-fc-tbl"><tr><th>чекпоинт</th><th>к какому времени</th><th>ожид. цена</th></tr>' +
      p.checkpoints.map(c => '<tr><td>' + Math.round(c.f * 100) + '%</td><td>' + _hhmm(c.time) + ' UTC (+' + c.barsFromNow + ' бар.)</td><td>' + c.price.toFixed(4) + '</td></tr>').join('') + '</table>' : '';
    return '<div class="tvsig-fc-card"><b>' + (NAME[id] || id) + ': ' + dirTxt + '</b> · начало ' + since + '<br>' +
      'статус: ' + stLine + '<br>' +
      'вход <b>' + p.entry.toFixed(4) + '</b> · цель <b>' + p.tp.toFixed(4) + '</b> · стоп ' + p.sl.toFixed(4) + '<br>' +
      'тренд метода: ' + trend + cps + '</div>';
  }
  function _fcPickInit() {
    const sel = document.getElementById('tvsig-fc-pick'); if (!sel || sel.dataset.init) return;
    sel.innerHTML = (window.SignalsCore.IDS).map(id => '<option value="' + id + '">' + (NAME[id] || id) + '</option>').join('');
    if (!S.fcId) S.fcId = 'fade';
    sel.value = S.fcId; sel.dataset.init = '1';
  }
  function forecastRender() {
    const pane = document.getElementById('tvsig-pane-forecast'); if (!pane || pane.hidden) return;
    const bars = S.bars, SC = window.SignalsCore;
    _fcPickInit();
    const rgEl = document.getElementById('tvsig-fc-regime'), condEl = document.getElementById('tvsig-fc-cond'), sigEl = document.getElementById('tvsig-fc-signals');
    const actEl = document.getElementById('tvsig-fc-active');
    if (!bars || bars.length < 60) { if (rgEl) rgEl.innerHTML = '<span class="tvsig-fc-hint">Мало свечей — открой «Модели» и ⟳.</span>'; if (condEl) condEl.innerHTML = ''; if (sigEl) sigEl.innerHTML = ''; if (actEl) actEl.innerHTML = ''; return; }
    const rg = SC.regimeInfo(bars, bars.length - 1);
    if (rgEl) rgEl.innerHTML = _regimeBadge(rg);
    if (actEl) actEl.innerHTML = _activeSignalCard(S.fcId);
    const ser = _fcSeries(S.fcId);
    if (condEl) condEl.innerHTML = _condTable(SC.condStats(ser, bars, 12), SC.regimeBuckets(bars, bars.length - 1));
    if (sigEl) sigEl.innerHTML = _recentSignals(ser, bars);
    if (S.mtfOn) mtfEnsure(bars, S.barDt || 300);
    rcCompute(); // калькулятор позиции (цена/ATR обновляются на баре)
  }
  function fcDetail(i) {
    const el = document.getElementById('tvsig-fc-detail'), bars = S.bars, SC = window.SignalsCore;
    if (!el || !bars || i < 0 || i >= bars.length) return;
    const ser = _fcSeries(S.fcId), dir = Math.sign(ser[i] || 0); if (!dir) { el.innerHTML = ''; return; }
    const rg = SC.regimeInfo(bars, i), out = SC.tradeOutcome(bars, i, dir, 1.5, 0.75, 0.12, 12);
    if (!out) { el.innerHTML = ''; return; }
    const cs = SC.condStats(ser, bars, 12), bk = rg && rg.isTrend ? 'тренд' : 'боковик';
    const expC = cs['режим'][bk] && cs['режим'][bk].n ? _fcNum(cs['режим'][bk].exp) : '—';
    let real; if (out.exit === 'открыта') { const left = (i + 12) - (bars.length - 1); real = 'в позиции · осталось ' + Math.max(0, left) + ' баров'; }
    else real = out.exit + ' · P&L ' + _fcNum(out.pnl) + ' ATR';
    let mtf = ''; if (S.mtfOn) { const md = _mtfDirAt(i);
      if (md != null && md !== 0) mtf = '<br>старший ТФ (' + (S._mtfTf || '') + '): тренд ' + (md > 0 ? '↑' : '↓') + ' · сигнал <b>' + (md === dir ? 'согласован' : 'против') + '</b>'; }
    // NW: спроецировать ожидаемый путь по аналогам (что было ПОСЛЕ похожих баров)
    let nwLine = '';
    if (S.fcId === 'nw') { const fc = SC.nwForecast(bars, i, 12, { uncond: !!S.nwUncond });
      if (fc) { const lastM = fc.med[fc.med.length - 1], band = fc.hi[fc.hi.length - 1] - lastM;
        const zone = fc.inQuad ? '' : ' <span class="tvsig-fc-lown" title="вне валидированного квадранта — надёжность ниже">вне зоны</span>';
        const novol = S.hasVolume ? '' : '<br><span class="tvsig-fc-lown">без объёма — T по размаху (слабее)</span>';
        nwLine = '<br>NW-путь: аналогов <b>' + fc.n + '</b>' + zone + ' · ожидаемый ход за 12 баров <b>' + (lastM >= 0 ? '+' : '') + (lastM * 100).toFixed(2) + '%</b> (±' + (band * 100).toFixed(2) + '%)' + novol;
        if (S.chart) drawNwPath(i, fc); }
      else { nwLine = '<br>NW-путь: мало аналогов' + (S.nwUncond ? '' : ' (бар вне квадранта — включи «NW везде»)'); _clearNwPath(); }
    } else if (S.chart && out) drawForecastBand(i, out); // (C) полоса тейк/стоп для остальных
    el.innerHTML = '<div class="tvsig-fc-card"><b>' + (NAME[S.fcId] || S.fcId) + ': ' + (dir < 0 ? '↓ шорт' : '↑ лонг') + '</b> · ' + _regLbl(rg) + ' · ' + _hhmm(bars[i].time) + ' UTC<br>' +
      'вход <b>' + out.entry.toFixed(4) + '</b> · тейк ' + out.tp.toFixed(4) + ' · стоп ' + out.sl.toFixed(4) + '<br>' +
      'ожидание в этом режиме: exp <b>' + expC + '</b> ATR<br>факт: <b>' + real + '</b>' + mtf + nwLine + '</div>';
  }
  function fcHypo() {
    const el = document.getElementById('tvsig-fc-hypo'), inp = document.getElementById('tvsig-fc-price'), bars = S.bars, SC = window.SignalsCore;
    if (!el || !bars || bars.length < 5) return;
    const price = parseFloat(inp && inp.value); if (!(price > 0)) { el.innerHTML = '<span class="tvsig-fc-hint">Впиши цену.</span>'; return; }
    const dt = S.barDt || 300, last = bars[bars.length - 1];
    const synth = { time: last.time + (dt || 300), open: price, high: Math.max(price, last.close), low: Math.min(price, last.close), close: price, volume: 0 };
    const bars2 = bars.concat([synth]), li = bars2.length - 1;
    const sig = SC.computeOne(S.fcId, bars2, 12).series[li], rg = SC.regimeInfo(bars2, li);
    const txt = sig < 0 ? '↓ шорт' : sig > 0 ? '↑ лонг' : 'нет сигнала';
    el.innerHTML = '<div class="tvsig-fc-card">если цена дойдёт до <b>' + price + '</b>:<br>' + (NAME[S.fcId] || S.fcId) + ': <b>' + txt + '</b><br>режим: ' + (_regLbl(rg) || '—') + (rg && rg.mkt ? ' / ' + rg.mkt : '') + '</div>';
  }
  // Калькулятор позиции: счёт + риск% → размер и макс. число позиций.
  // Стоп/тейк — в % от цены (адаптивны к волатильности: SC.volProfile, ширина от
  // ATR × VR-шум, R:R 2:1). Размер по формуле риск/стоп: чем УЖЕ стоп, тем БОЛЬШЕ
  // позиция для того же риска в деньгах — так и должна работать риск-сайзинг
  // формула. Но на тикерах с типично узким ATR-стопом (особенно на коротких ТФ)
  // это почти ВСЕГДА выталкивает размер в покупательную способность целиком —
  // калькулятор предлагал класть весь депозит в одну бумагу. Поэтому есть
  // отдельный жёсткий потолок «% депозита на сделку» (tvsig-rc-cap), не зависящий
  // от риск/стоп-расчёта — он и раньше отсутствовал, теперь режет размер первым.
  function _rcVal(id) { const el = document.getElementById(id); const v = el ? parseFloat(el.value) : NaN; return isFinite(v) ? v : NaN; }
  function rcInit() {
    try { const s = JSON.parse(localStorage.getItem('tvsig:rc') || '{}');
      if (s.a != null && document.getElementById('tvsig-rc-acct')) document.getElementById('tvsig-rc-acct').value = s.a;
      if (s.r != null && document.getElementById('tvsig-rc-risk')) document.getElementById('tvsig-rc-risk').value = s.r;
      if (s.l != null && document.getElementById('tvsig-rc-lev')) document.getElementById('tvsig-rc-lev').value = s.l;
      if (s.p != null && document.getElementById('tvsig-rc-port')) document.getElementById('tvsig-rc-port').value = s.p;
      if (s.c != null && document.getElementById('tvsig-rc-cap')) document.getElementById('tvsig-rc-cap').value = s.c;
    } catch (e) {}
  }
  function rcCompute() {
    const out = document.getElementById('tvsig-rc-out'); if (!out) return;
    try { localStorage.setItem('tvsig:rc', JSON.stringify({ a: _rcVal('tvsig-rc-acct'), r: _rcVal('tvsig-rc-risk'), l: _rcVal('tvsig-rc-lev'), p: _rcVal('tvsig-rc-port'), c: _rcVal('tvsig-rc-cap') })); } catch (e) {}
    const bars = S.bars, SC = window.SignalsCore;
    if (!bars || bars.length < 20) { out.innerHTML = '<span class="tvsig-fc-hint">Нет свечей — открой «Модели» и ⟳.</span>'; return; }
    const vp = SC.volProfile ? SC.volProfile(bars) : null;
    const atrv = vp ? vp.atr : null, price = bars[bars.length - 1].close;
    if (!vp || !atrv || !price) { out.innerHTML = '<span class="tvsig-fc-hint">Нет ATR/цены.</span>'; return; }
    // всё в % от цены; ATR-кратность — только в подсказке
    const stopPct = 100 * vp.stopDist / price, takePct = 100 * vp.takeDist / price;
    const pct = x => x.toFixed(2) + '%', rub = x => Math.round(x).toLocaleString('ru-RU');
    const volTxt = vp.vol ? ' · ' + vp.vol : '', kindTxt = vp.vr != null ? ' · ' + vp.kind : '';
    let html = '<div class="tvsig-fc-card">волатильность (ATR) ' + pct(vp.atrPct) + volTxt + kindTxt +
      '<br>стоп <b>' + pct(stopPct) + '</b> · тейк <b>' + pct(takePct) + '</b> · R:R 2:1' +
      '<span class="tvsig-fc-lown" title="ширина в ATR: стоп ' + vp.stopK.toFixed(2) + ' / тейк ' + vp.takeK.toFixed(2) + ' ATR (крутится VR-шумом ' + (vp.vr != null ? vp.vr.toFixed(2) : '—') + ')"> ⓘ</span>';
    const acct = _rcVal('tvsig-rc-acct'), risk = _rcVal('tvsig-rc-risk'), port = _rcVal('tvsig-rc-port');
    const lev = Math.max(1, _rcVal('tvsig-rc-lev') || 1);
    const capPct = _rcVal('tvsig-rc-cap');
    if (acct > 0 && risk > 0 && stopPct > 0) {
      const stopFrac = stopPct / 100, takeFrac = takePct / 100;
      const buyPower = acct * lev;                          // покупательная способность с плечом
      const capValue = capPct > 0 ? acct * capPct / 100 : Infinity; // жёсткий потолок на одну сделку
      const hardCap = Math.min(buyPower, capValue);
      const posByRisk = (acct * risk / 100) / stopFrac;     // сколько НАДО, чтобы рискнуть risk%
      const capped = posByRisk > hardCap;                   // упёрлись в потолок (капитал или лимит/сделку)
      const posValue = Math.min(posByRisk, hardCap), units = posValue / price;
      const riskMoney = posValue * stopFrac, riskPctReal = 100 * riskMoney / acct, profit = posValue * takeFrac;
      const wpct = 100 * posValue / acct;
      const levTxt = lev > 1 ? ' · плечо ×' + lev : '';
      html += '<br>размер позиции: <b>' + rub(posValue) + ' ₽</b> (' + wpct.toFixed(0) + '% счёта' + levTxt + ') ≈ ' + (units >= 10 ? rub(units) : units.toFixed(2)) + ' ед.';
      html += '<br>риск по стопу: <b>' + rub(riskMoney) + ' ₽</b> (' + riskPctReal.toFixed(2) + '% счёта) · профит по тейку: <b>+' + rub(profit) + ' ₽</b>';
      if (capped) {
        if (hardCap === capValue && capValue < buyPower)
          html += '<br><span class="tvsig-fc-lown">стоп ' + pct(stopPct) + ' узкий: риск-формула просит ' + rub(posByRisk) + ' ₽ на сделку — больше лимита «' + capPct + '% депозита на сделку» (' + rub(capValue) + ' ₽). Взят лимит, фактический риск ' + riskPctReal.toFixed(2) + '% (ниже заданных ' + risk + '%).</span>';
        else
          html += '<br><span class="tvsig-fc-lown">стоп ' + pct(stopPct) + ': чтобы рискнуть ' + risk + '%, нужна позиция ' + rub(posByRisk) + ' ₽ — больше покупательной способности (' + rub(buyPower) + ' ₽ при плече ×' + lev + '). Взят максимум, фактический риск ' + riskPctReal.toFixed(2) + '%.</span>';
      }
      const maxByCap = Math.max(1, Math.floor(buyPower / posValue));
      const maxByRisk = (port > 0 && riskPctReal > 0) ? Math.floor(port / riskPctReal) : Infinity;
      let mp = Math.min(maxByCap, maxByRisk), lim = maxByRisk < maxByCap ? 'лимиту риска портфеля' : (lev > 1 ? 'покупательной способности' : 'капиталу');
      html += '<br>макс. одновременных позиций: <b>' + mp + '</b> (по ' + lim + ')';
      if (mp > 20) html += ' <span class="tvsig-fc-lown">в бэктесте до 20 — коррелир. риск, держи ≤20</span>';
    } else html += '<br><span class="tvsig-fc-hint">Введи счёт ₽ и риск% — посчитаю размер и лимит позиций (плечо ×1 = без плеча).</span>';
    out.innerHTML = html + '</div>';
  }

  // (A/#8) старший ТФ: тренд по нему, выровненный на бары графика (кэш по тикер+ТФ)
  async function mtfEnsure(bars, dt) {
    if (!bars || bars.length < 20 || !dt) return;
    const code = (S.symbol || '').split(':').pop().toUpperCase(); if (!code) return;
    const key = code + '|' + dt;
    if (S._mtfKey === key && S._mtfByTime) return;
    if (S._mtfBuilding === key) return; S._mtfBuilding = key;
    const iv = dt < 3600 ? 60 : dt < 86400 ? 24 : 7;
    try {
      const r = await cmpFetch(code, iv, bars[0].time, bars[bars.length - 1].time);
      if (r && r.ok && r.rows.length >= 5) {
        const rows = r.rows, L = rows.length, w = 10;
        const dirRow = rows.map((x, k) => k >= w ? Math.sign(x.close - rows[k - w].close) : 0);
        const map = new Map(); let j = 0;
        for (const b of bars) { while (j + 1 < L && rows[j + 1].t <= b.time) j++; map.set(b.time, dirRow[j] || 0); }
        S._mtfByTime = map; S._mtfTf = iv === 60 ? 'час' : iv === 24 ? 'день' : 'неделя'; S._mtfKey = key;
        forecastRender();
      }
    } catch (e) {}
    S._mtfBuilding = null;
  }
  // NW-путь на графике: медиана траектории аналогов (сегментами) + конус ±σ.
  // Проецируется от бара i вперёд kFwd баров (будущие времена = i.time + s·dt).
  function _clearNwPath() { (S._nwBand || []).forEach(id => { try { S.chart.removeEntity(id); } catch (e) {} }); S._nwBand = []; }
  function drawNwPath(i, fc) {
    try {
      _clearNwPath();
      const bars = S.bars, dt = S.barDt || 300, base = bars[i].close, t0 = bars[i].time;
      const P = r => base * (1 + r);
      const seg = (ta, pa, tb, pb, color, style, wdt) => { try {
        const id = S.chart.createMultipointShape([{ time: ta, price: pa }, { time: tb, price: pb }],
          { shape: 'trend_line', lock: true, disableSelection: true, overrides: { linecolor: color, linewidth: wdt || 1, linestyle: style } });
        if (id) S._nwBand.push(id); } catch (e) {} };
      // медиана: сегмент на каждый шаг (форма ожидаемого пути), фиолетовым
      let pt = t0, pp = P(0);
      for (let s = 1; s <= fc.med.length; s++) { const nt = t0 + s * dt, np = P(fc.med[s - 1]); seg(pt, pp, nt, np, '#B487F8', 0, 2); pt = nt; pp = np; }
      // конус неопределённости ±σ: от входа к финальным lo/hi, пунктиром
      const endT = t0 + fc.med.length * dt;
      seg(t0, P(0), endT, P(fc.lo[fc.lo.length - 1]), '#7CC7FF', 2, 1);
      seg(t0, P(0), endT, P(fc.hi[fc.hi.length - 1]), '#7CC7FF', 2, 1);
    } catch (e) {}
  }
  // (C) полоса ожидания на графике: тейк/стоп горизонтальными лучами от точки на 12 баров
  function drawForecastBand(i, out) {
    try {
      (S._fcBand || []).forEach(id => { try { S.chart.removeEntity(id); } catch (e) {} }); S._fcBand = [];
      const bars = S.bars, dt = S.barDt || 300;
      const t0 = bars[i].time, t1 = t0 + 12 * dt;
      const mk = (price, color) => { try {
        const id = S.chart.createMultipointShape([{ time: t0, price: price }, { time: t1, price: price }],
          { shape: 'trend_line', lock: true, disableSelection: true, overrides: { linecolor: color, linewidth: 1, linestyle: 2 } });
        if (id) S._fcBand.push(id); } catch (e) {} };
      mk(out.tp, '#52F2C9'); mk(out.sl, '#FF6A8B'); mk(out.entry, '#B487F8');
    } catch (e) {}
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
      forecastRender(); // режим + условная точность пересчитываются на баре
      status('тикер ' + (S.symbol || '?') + ' · ' + bars.length + ' баров · обновлено ' + fmtAgo(S.statsTs));
      breadthEnsure(bars, dt); // полная версия фейда: рыночный breadth (async, не блокирует)
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
      '<button class="tvsig-tab" data-tab="forecast">Прогноз</button>' +
      '<button class="tvsig-tab" data-tab="scan">Сканер</button>' +
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
      '<div id="tvsig-foot">Цифры считаются на свечах <b>текущего тикера</b>, хранятся по каждому и обновляются при закрытии нового бара. <b>exp</b> — экспектанси, средний P&amp;L сделки в ATR (тейк +1.5 / стоп −0.75 ATR, R:R 2:1 — валидировано; узкий брекет занижал вдвое, издержки 0.12); плюс = метод в прибыли. <b>%</b> — winrate, частота угадывания знака за 12 баров (не путать с win сделки — та выше при широком стопе). <b>n</b> — число сделок. Клик по строке рисует сигналы.</div>' +
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
      '</div>' + // /pane-theme
      '<div id="tvsig-pane-forecast" class="tvsig-pane" hidden>' +
      '<div id="tvsig-fc-pickrow">Сигнал <select id="tvsig-fc-pick"></select>' +
      '<label class="tvsig-fc-mtf"><input type="checkbox" id="tvsig-fc-mtf-on"> старший ТФ</label>' +
      '<label class="tvsig-fc-mtf" title="NW: проецировать от любого бара, не только из квадранта (надёжность ниже)"><input type="checkbox" id="tvsig-fc-uncond"> NW везде</label></div>' +
      '<div id="tvsig-fc-regime" class="tvsig-fc-badge"></div>' +
      '<div id="tvsig-fc-active"></div>' +
      // калькулятор риска и гипотеза — вверху, это самые нужные инструменты
      '<div class="tvsig-fc-sec">Калькулятор позиции (риск на сделку)</div>' +
      '<div id="tvsig-rc-ctrl">' +
      '<label>Счёт ₽<input id="tvsig-rc-acct" type="number" placeholder="сумма на счету"></label>' +
      '<label>Риск/сделку %<input id="tvsig-rc-risk" type="number" step="0.1" value="1"></label>' +
      '<label>Плечо ×<input id="tvsig-rc-lev" type="number" step="0.1" min="1" value="1" title="Встроенное плечо инструмента. 1 = без плеча (кэш). Для фьючерсов/маржи впиши доступное плечо — позиция сможет превышать счёт во столько раз."></label>' +
      '<label>Лимит риска портфеля %<input id="tvsig-rc-port" type="number" step="1" value="10"></label>' +
      '<label>Лимит на сделку, % депозита<input id="tvsig-rc-cap" type="number" step="1" value="25" title="Жёсткий потолок размера ОДНОЙ позиции, не зависит от риск/стоп-расчёта. При узком стопе риск-формула может требовать почти весь депозит на одну бумагу (риск% ÷ стоп% → доля счёта) — этот лимит её обрезает первым. 0 или пусто = без лимита (только покупательная способность)."></label>' +
      '</div>' +
      '<div id="tvsig-rc-out"></div>' +
      '<div class="tvsig-fc-sec">Гипотеза: если цена дойдёт до</div>' +
      '<div id="tvsig-fc-hypo-ctrl"><input id="tvsig-fc-price" type="number" step="any" placeholder="цена"><button id="tvsig-fc-hypo-go" title="Пересчитать сигнал на этой цене">→</button></div>' +
      '<div id="tvsig-fc-hypo"></div>' +
      '<div class="tvsig-fc-sec">Где точнее / слабее (exp ATR · win% · n по осям)</div>' +
      '<div id="tvsig-fc-cond"></div>' +
      '<div class="tvsig-fc-sec">Прогноз от точки — клик по сигналу</div>' +
      '<div id="tvsig-fc-signals"></div>' +
      '<div id="tvsig-fc-detail"></div>' +
      '<div id="tvsig-fc-foot">Калькулятор: тейк/стоп от волатильности (ATR×VR-шум), R:R 2:1. Режим: <b>ER</b> тренд/боковик (окно 60, порог 0.3), <b>vol</b> сжатие/расшир (ATR/медиана-200), <b>рынок</b> — breadth корзины. Условная точность — фейд по каждому режиму (тейк 1.5/стоп 0.75 ATR). Прогноз от точки: вход по close сигнала, тейк/стоп в ATR, тайм-выход 12 баров. Гипотеза: подставляет цену как закрытие следующего бара и пересчитывает.</div>' +
      '</div>' + // /pane-forecast
      '<div id="tvsig-pane-scan" class="tvsig-pane" hidden>' +
      '<div class="tvsig-fc-sec">Сканер связок по списку тикеров</div>' +
      '<div id="tvsig-scan-listrow"><select id="tvsig-scan-preset" title="Стандартный набор или свой список"></select>' +
      '<button id="tvsig-scan-day" title="Составить список дня: ранжирует широкий универс по волатильности и ликвидности (дневные свечи)">📊 Список дня</button>' +
      '<button id="tvsig-scan-save" title="Сохранить текущий список тикеров под своим именем">Сохранить…</button>' +
      '<button id="tvsig-scan-del" title="Удалить выбранный свой список">Удалить</button></div>' +
      '<textarea id="tvsig-scan-list" placeholder="SBER GAZP LKOH SNGS ROSN … (через пробел/запятую)"></textarea>' +
      '<div id="tvsig-scan-sel">Сигнал <select id="tvsig-scan-a"></select> + <select id="tvsig-scan-b"></select>' +
      ' за <select id="tvsig-scan-look" title="Сколько последних ЗАКРЫТЫХ баров считать «свежим» срабатыванием">' +
      '<option value="1">1</option><option value="3" selected>3</option><option value="5">5</option><option value="10">10</option></select> бар' +
      '<button id="tvsig-scan-go" title="Просканировать список">Скан</button></div>' +
      '<div id="tvsig-scan-body"></div>' +
      '<div id="tvsig-scan-foot"><b>🔝 авто</b> (по умолчанию): для каждого тикера сам считает все методы и берёт самый прибыльный НА ЕГО истории (exp&gt;0, n≥10), сработавший в окне — список тикеров с их лучшим методом и направлением, без ручного выбора. Или задай метод/связку вручную. Пресеты — стандартные секторные наборы MOEX; свои списки можно сохранять/удалять («список дня» тоже сохраняется). Скан тянет свечи каждого тикера на ТФ активного графика, ищет сигнал в последних N закрытых барах. «X баров / Y назад» — свежесть с пересчётом в реальное время по ТФ. «→ тейк/стоп/тайм ±ATR» — чем ЗАКОНЧИЛАСЬ именно эта сделка (успела ли отыграть): понятно, имел ли сигнал смысл. Хиты сортируются по ТОЧНОСТИ связки на истории тикера (exp/win/n, R:R 2:1); n&lt;10 = мало данных, вниз. Кросс-тикерный breadth в скане не применяется. Второй сигнал «—» = один метод.</div>' +
      '</div>'; // /pane-scan
    document.documentElement.appendChild(panel);
    try { const wv = parseInt(localStorage.getItem('tvsig:width') || '', 10); if (wv >= 300 && wv <= 640) panel.style.width = wv + 'px'; } catch (e) {}
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
    panel.querySelector('#tvsig-scan-go').onclick = () => scanRun();
    panel.querySelector('#tvsig-scan-preset').addEventListener('change', e => scanApplyPreset(e.target.value));
    panel.querySelector('#tvsig-scan-day').onclick = () => scanListDay();
    panel.querySelector('#tvsig-scan-save').onclick = () => scanSaveList();
    panel.querySelector('#tvsig-scan-del').onclick = () => scanDeleteList();
    panel.querySelector('#tvsig-scan-body').addEventListener('click', e => {
      const h = e.target.closest('.tvsig-scan-hit'); if (h && h.dataset.code) { try { S.chart.setSymbol(h.dataset.code); } catch (er) {} } });
    // «Прогноз»: клик по сигналу → карточка прогноза от точки; гипотеза по цене
    panel.querySelector('#tvsig-fc-signals').addEventListener('click', e => {
      const s = e.target.closest('.tvsig-fc-sig'); if (s) fcDetail(+s.dataset.idx); });
    panel.querySelector('#tvsig-fc-hypo-go').onclick = () => fcHypo();
    panel.querySelector('#tvsig-fc-price').addEventListener('keydown', e => { if (e.key === 'Enter') fcHypo(); });
    panel.querySelector('#tvsig-fc-pick').onchange = e => { S.fcId = e.target.value;
      const d = document.getElementById('tvsig-fc-detail'); if (d) d.innerHTML = '';
      try { _clearNwPath(); (S._fcBand || []).forEach(id => S.chart.removeEntity(id)); S._fcBand = []; } catch (er) {}
      forecastRender(); };
    panel.querySelector('#tvsig-fc-mtf-on').onchange = e => { S.mtfOn = e.target.checked; forecastRender(); };
    rcInit();
    ['tvsig-rc-acct', 'tvsig-rc-risk', 'tvsig-rc-port', 'tvsig-rc-cap', 'tvsig-rc-lev'].forEach(id => {
      const el = panel.querySelector('#' + id); if (el) el.addEventListener('input', rcCompute); });
    panel.querySelector('#tvsig-fc-uncond').onchange = e => { S.nwUncond = e.target.checked;
      const d = document.getElementById('tvsig-fc-detail'); if (d) d.innerHTML = ''; _clearNwPath(); forecastRender(); };
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

  // HTML одной строки метода (вынесено из renderRows, чтобы группировать)
  function rowHTML(id, noVol) {
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
          const badges = (c && c.last) ? _planBadges(_signalPlan(id)) : '';
          return pill(c ? c.last : 0) +
            '<span class="tvsig-exp" style="color:' + expCol + '" title="exp — экспектанси: средний P&L сделки в ATR (тейк +1.0 / стоп −0.5 ATR, издержки 0.12). Плюс = метод в прибыли, даже если winrate низкий.">' + exp + '</span>' +
            '<span class="tvsig-acc" title="winrate — частота совпадения знака с ходом за 12 баров. У фейдов бывает низкой при плюсовом exp — это норма.">' + win + '</span>' +
            '<span class="tvsig-n" title="Число сделок в exp-симуляции">n' + nn + '</span>' + badges;
        })();
    return '<div class="tvsig-row' + (on ? ' on' : '') + '" data-id="' + id + '">' +
      diam + '<span class="tvsig-name" title="' + NAME[id] + '">' + NAME[id] + '</span>' + mid + info + swatch + '</div>';
  }

  // агрегат exp/win по группе — среднее с весом по числу сделок n (только валидные stats)
  function groupAgg(ids) {
    let se = 0, sw = 0, sn = 0;
    ids.forEach(id => {
      const st = S.computed && S.computed[id] && S.computed[id].stats;
      if (!st || st.exp == null || !st.n) return;
      se += st.exp * st.n; if (st.acc != null) sw += st.acc * st.n; sn += st.n;
    });
    return sn ? { exp: se / sn, win: sw / sn, n: sn } : null;
  }

  function renderRows() {
    if (!rowsEl) return;
    const noVol = S.hasVolume === false;
    rowsEl.innerHTML = GROUPS.map(g => {
      const a = groupAgg(g.ids);
      const exp = a ? (a.exp >= 0 ? '+' : '') + a.exp.toFixed(2) : '—';
      const expCol = a ? (a.exp > 0.03 ? '#52F2C9' : a.exp < -0.03 ? '#FF6A8B' : '#A79BC9') : '#6F648F';
      const win = a && a.win ? (a.win * 100).toFixed(0) + '%' : '';
      const hd = '<div class="tvsig-grouphd" title="' + g.desc.replace(/"/g, '&quot;') + '">' +
        '<span class="tvsig-gh-title">' + g.title + '</span>' +
        '<span class="tvsig-gh-stat" style="color:' + expCol + '">' + exp +
        (win ? ' <span class="tvsig-gh-win">' + win + '</span>' : '') + '</span>' +
        '<div class="tvsig-gh-desc">' + g.desc + '</div></div>';
      return hd + g.ids.map(id => rowHTML(id, noVol)).join('');
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
    '#tvsig-cmp-foot, #tvsig-cmp-body, #tvsig-oi-body, .tvsig-oi-meta, .tvsig-oi-t, ' +
    '.tvsig-fc-sig, #tvsig-fc-cond, #tvsig-fc-detail, #tvsig-fc-hypo, #tvsig-fc-foot, #tvsig-fc-pickrow, ' +
    '#tvsig-rc-ctrl, #tvsig-rc-out, #tvsig-scan-list, #tvsig-scan-sel, #tvsig-scan-body, #tvsig-scan-foot, #tvsig-scan-listrow';
  function drag(el) {
    let sx, sy, ox, oy, on = false;
    el.addEventListener('mousedown', e => {
      if (e.button !== 0 || (e.target.closest && e.target.closest(NO_DRAG))) return;
      // правая кромка (~16px) — зона скроллбара/ресайза ширины; там не тащим панель
      const r = el.getBoundingClientRect();
      if (e.clientX > r.right - 16) return;
      on = true; sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top; e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!on) return; const w = el.offsetWidth;
      // держим панель в пределах экрана, чтобы не «застряла» за краем
      const left = Math.max(0, Math.min(window.innerWidth - Math.min(w, 60), ox + e.clientX - sx));
      const top = Math.max(0, Math.min(window.innerHeight - 30, oy + e.clientY - sy));
      el.style.left = left + 'px'; el.style.top = top + 'px'; el.style.right = 'auto'; el.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => on = false);
    // запоминаем ширину после ресайза (мышь могла тянуть угол — сравниваем с сохранённой)
    document.addEventListener('mouseup', () => { try { localStorage.setItem('tvsig:width', String(el.offsetWidth)); } catch (e) {} });
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
