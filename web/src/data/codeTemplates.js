// Библиотека «шаблонов кода» — разборы реальных методов этого проекта
// кусочками. Каждый chunk: code (подсветится), note (что делает эта часть,
// по-человечески) и out (что ожидать на выходе/в переменной). Цель — понять
// «франкенштейна» и уметь править/встраивать.
//
// Структура: { id, group, lang, title, desc, chunks:[{code, note, out}] }.
// lang ∈ {js, python, sql} — определяет подсветку. Добавлять новые — просто
// дописывать объект в массив.

export const TEMPLATE_GROUPS = [
  { id: 'bonds',   label: 'Доходность облигаций' },
  { id: 'risk',    label: 'Риск портфеля' },
  { id: 'weights', label: 'Оптимизация весов' },
  { id: 'data',    label: 'Данные и сеть' },
  { id: 'store',   label: 'Хранилище и состояние' },
  { id: 'lang',    label: 'Языки: базовые приёмы' },
];

export const TEMPLATES = [
  // ───────────────────────── Облигации ─────────────────────────
  {
    id: 'ytm', group: 'bonds', lang: 'js',
    title: 'YTM — эффективная доходность к погашению',
    desc: 'Ищем ставку r, при которой сумма дисконтированных купонов и номинала равна «грязной» цене. Метод — бисекция (деление отрезка пополам): надёжно и без производных.',
    chunks: [
      {
        code: `// Цена облигации при ставке r: купоны по датам + номинал в конце.\n// t — годы от сегодня до выплаты; cf — размер выплаты (₽).\nfunction priceAt(r, flows){\n  let pv = 0;\n  for(const { t, cf } of flows) pv += cf / Math.pow(1 + r, t);\n  return pv;\n}`,
        note: 'Приведённая стоимость: каждую будущую выплату делим на (1+r)^t. Чем больше r, тем сильнее «сжимается» далёкий платёж — поэтому цена монотонно падает с ростом r.',
        out: 'priceAt(0.15, flows) → число ₽ (текущая справедливая цена при ставке 15%).',
      },
      {
        code: `// Бисекция: цена монотонно убывает по r, значит корень ровно один.\nfunction ytm(dirtyPrice, flows){\n  let lo = 0.0001, hi = 3;           // 0.01%..300% годовых\n  for(let k = 0; k < 100; k++){\n    const mid = (lo + hi) / 2;\n    if(priceAt(mid, flows) > dirtyPrice) lo = mid;  // цена велика → ставка мала\n    else hi = mid;\n  }\n  return (lo + hi) / 2;\n}`,
        note: 'На каждом шаге отрезок [lo,hi] делится пополам и половина отбрасывается. 100 итераций → точность ~2^-100, фактически машинная. Направление: если расчётная цена выше рыночной — настоящая доходность ещё выше, двигаем нижнюю границу.',
        out: 'ytm(1012.5, flows) → 0.1473 (т.е. 14.73% годовых).',
      },
      {
        code: `// «Грязная» цена = чистая (из стакана) + накопленный купон (НКД).\nconst dirty = cleanPrice + accruedCoupon;\nconst r = ytm(dirty, flows);\nconsole.log((r * 100).toFixed(2) + '% годовых');`,
        note: 'Важная ловушка: дисконтируем от грязной цены, а в стакане котируется чистая. Забыл НКД — YTM «уедет» на процент-полтора.',
        out: '14.73% годовых',
      },
    ],
  },
  {
    id: 'gspread', group: 'bonds', lang: 'js',
    title: 'G-spread — премия к кривой ОФЗ',
    desc: 'Насколько доходность бумаги выше «безрисковой» ОФЗ той же дюрации. Строим кривую ОФЗ по точкам (дюрация→доходность) и линейно интерполируем под нужную дюрацию.',
    chunks: [
      {
        code: `// Точки кривой ОФЗ: [{dur, ytm}], отсортированы по дюрации.\n// Линейная интерполяция доходности под произвольную дюрацию d.\nfunction ofzYieldAt(curve, d){\n  if(d <= curve[0].dur) return curve[0].ytm;\n  const last = curve[curve.length - 1];\n  if(d >= last.dur) return last.ytm;\n  for(let i = 1; i < curve.length; i++){\n    const a = curve[i - 1], b = curve[i];\n    if(d <= b.dur){\n      const w = (d - a.dur) / (b.dur - a.dur);   // доля между точками\n      return a.ytm + w * (b.ytm - a.ytm);\n    }\n  }\n}`,
        note: 'Между двумя соседними точками кривой проводим прямую. За краями — «полка» (берём крайнее значение), чтобы не экстраполировать в абсурд.',
        out: 'ofzYieldAt(curve, 2.3) → 0.161 — доходность ОФЗ на дюрации 2.3 года.',
      },
      {
        code: `// Спред в базисных пунктах (1 б.п. = 0.01%).\nconst gspread = (bondYtm - ofzYieldAt(curve, bondDur)) * 10000;\nconst label = gspread.toFixed(0) + ' б.п.';`,
        note: 'Умножаем на 10000, потому что доходности в долях (0.1473), а спред принято показывать в б.п. Разница доходности 1% = 100 б.п.',
        out: 'bondYtm=0.1932, ОФЗ≈0.161 → gspread ≈ 322 б.п.',
      },
    ],
  },
  // ───────────────────────── Риск ─────────────────────────
  {
    id: 'sortino', group: 'risk', lang: 'js',
    title: 'Sortino — доходность на единицу «плохого» риска',
    desc: 'Как Шарп, но в знаменателе только нисходящая волатильность (колебания вниз). Рост портфеля риском не считаем — наказываем только за падения.',
    chunks: [
      {
        code: `// downside deviation: корень из среднего квадрата ТОЛЬКО отрицательных\n// отклонений от безрисковой ставки за период (rfDaily).\nfunction downsideDev(returns, rfDaily){\n  let s = 0, k = 0;\n  for(const r of returns){\n    const d = r - rfDaily;\n    if(d < 0){ s += d * d; k++; }   // плюсы игнорируем\n  }\n  return k ? Math.sqrt(s / k) : 0;\n}`,
        note: 'Ключевое отличие от обычной волатильности — суммируем квадраты только убыточных дней. Поэтому ровно растущий портфель даёт downside=0 и бесконечный Sortino (на это надо проверять выше).',
        out: 'downsideDev(returns, rf) → 0.0081 (дневная нисходящая волатильность).',
      },
      {
        code: `// Годовой Sortino: избыточная доходность / нисходящий риск, оба в год.\n// ppy — наблюдений в году (у ликвидной бумаги ~252, у ВДО меньше).\nfunction sortino(returns, rfDaily, ppy){\n  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;\n  const excessAnnual = (mean - rfDaily) * ppy;\n  const ddAnnual = downsideDev(returns, rfDaily) * Math.sqrt(ppy);\n  return ddAnnual ? excessAnnual / ddAnnual : Infinity;\n}`,
        note: 'Аннуализация: среднюю доходность множим на число периодов, а волатильность — на корень из него (так масштабируется случайное блуждание). Отсюда sqrt(ppy).',
        out: 'sortino(...) → 1.8 — норм; >2 отлично; <0 портфель в среднем падает.',
      },
    ],
  },
  {
    id: 'varcvar', group: 'risk', lang: 'js',
    title: 'VaR / CVaR — размер типичного и хвостового убытка',
    desc: 'VaR 95% — убыток, который не превышается в 95% дней. CVaR («ожидаемый дефицит») — средний убыток в оставшихся 5% худших дней. CVaR всегда ≥ VaR и честнее про хвост.',
    chunks: [
      {
        code: `function varCvar(returns, conf = 0.95){\n  const sorted = [...returns].sort((a, b) => a - b);  // от худшего к лучшему\n  const idx = Math.floor((1 - conf) * sorted.length);  // граница 5% хвоста\n  const vaR = -sorted[idx];                             // убыток → знак +\n  let tail = 0;\n  for(let i = 0; i <= idx; i++) tail += sorted[i];\n  const cVaR = -(tail / (idx + 1));                     // средний по хвосту\n  return { vaR, cVaR };\n}`,
        note: 'Сортируем доходности по возрастанию, берём квантиль на границе хвоста. VaR — значение на границе; CVaR — среднее всего, что хуже границы. Минус — чтобы убыток был положительным числом.',
        out: '{ vaR: 0.021, cVaR: 0.034 } → в худший день из 20 теряем ~2.1%, в среднем по чёрным дням ~3.4%.',
      },
    ],
  },
  {
    id: 'drawdown', group: 'risk', lang: 'js',
    title: 'Просадка и Ulcer — глубина и мучительность падений',
    desc: 'Просадка — падение от последнего пика. Макс. просадка — худшее из них. Ulcer-индекс — RMS всех просадок: наказывает и за глубину, и за длительность «подводного» состояния.',
    chunks: [
      {
        code: `// equity — кривая стоимости портфеля (от 1.0). Идём, запоминая пик.\nfunction drawdownUlcer(equity){\n  let peak = equity[0], maxDD = 0, sumSq = 0;\n  for(const v of equity){\n    if(v > peak) peak = v;              // новый максимум\n    const dd = v / peak - 1;            // ≤ 0: насколько ниже пика\n    if(dd < maxDD) maxDD = dd;\n    sumSq += dd * dd;                   // для Ulcer\n  }\n  return { maxDD, ulcer: Math.sqrt(sumSq / equity.length) };\n}`,
        note: 'peak «тянется» только вверх и никогда не опускается. dd=0 на новых максимумах и отрицателен в просадке. Ulcer = корень из среднего квадрата просадок — длинная неглубокая яма даёт больший Ulcer, чем короткий провал.',
        out: '{ maxDD: -0.18, ulcer: 0.064 } → худшее падение −18%, «индекс боли» 6.4%.',
      },
    ],
  },
  {
    id: 'montecarlo', group: 'risk', lang: 'js',
    title: 'Монте-Карло — веер возможных траекторий',
    desc: 'Тысячи случайных «переигровок» истории блоками (чтобы сохранить автокорреляцию), чтобы оценить разброс итогов за год: худший/медианный/лучший.',
    chunks: [
      {
        code: `// Блочный бутстрэп: берём случайные КУСКИ истории длиной block и склеиваем,\n// пока не наберём горизонт (ppy шагов = один год). Блоки сохраняют\n// «кластеры волатильности», которые ломает обычная выборка по одному.\nfunction samplePath(returns, horizon, block){\n  const path = [];\n  while(path.length < horizon){\n    const start = Math.floor(Math.random() * (returns.length - block));\n    for(let j = 0; j < block && path.length < horizon; j++)\n      path.push(returns[start + j]);\n  }\n  return path;\n}`,
        note: 'Почему блоками, а не по одному дню: доходности не независимы — спокойные и бурные периоды идут сериями. Блок ~20 дней сохраняет эту структуру.',
        out: 'samplePath(returns, 252, 20) → массив из 252 дневных доходностей — одна возможная «переигровка» года.',
      },
      {
        code: `function monteCarlo(returns, { paths = 5000, horizon, block = 20 }){\n  const finals = [];\n  for(let p = 0; p < paths; p++){\n    let eq = 1;\n    for(const r of samplePath(returns, horizon, block)) eq *= (1 + r);\n    finals.push(eq - 1);               // итоговая доходность пути\n  }\n  finals.sort((a, b) => a - b);\n  const q = p => finals[Math.floor(p * finals.length)];\n  return { worst: q(0.05), median: q(0.5), best: q(0.95) };\n}`,
        note: '5000 раз прокручиваем год, каждый итог — произведение (1+r). Квантили 5/50/95% дают «реалистично плохо / типично / реалистично хорошо». Крайние 5% отрезаем, чтобы единичный выброс не пугал.',
        out: '{ worst: -0.22, median: 0.11, best: 0.38 } → за год скорее всего +11%, но в плохом сценарии −22%.',
      },
    ],
  },
  // ───────────────────────── Веса ─────────────────────────
  {
    id: 'simplex', group: 'weights', lang: 'js',
    title: 'Проекция на симплекс — привести веса к сумме 1 без шортов',
    desc: 'После любой оптимизации веса могут уйти в минус или не суммироваться к 1. Проекция находит ближайший допустимый вектор (все ≥0, сумма =1). Классический алгоритм Held–Wolfe.',
    chunks: [
      {
        code: `function projectSimplex(w){\n  const u = [...w].sort((a, b) => b - a);  // по убыванию\n  let css = 0, rho = -1, theta = 0;\n  for(let i = 0; i < u.length; i++){\n    css += u[i];\n    const t = (css - 1) / (i + 1);          // кандидат на порог\n    if(u[i] - t > 0) { rho = i; theta = t; } // пока элемент «переживает» сдвиг\n  }\n  return w.map(x => Math.max(0, x - theta)); // сдвиг + обрезка снизу нулём\n}`,
        note: 'Идея: вычесть из всех одно и то же число theta так, чтобы после обнуления отрицательных сумма стала ровно 1. Сортировка нужна, чтобы найти, сколько элементов «выживет».',
        out: 'projectSimplex([0.7, 0.5, -0.2]) → [0.6, 0.4, 0] (сумма 1, без минусов).',
      },
    ],
  },
  {
    id: 'minvar', group: 'weights', lang: 'js',
    title: 'Min-variance — веса минимального риска',
    desc: 'Аналитический минимум дисперсии портфеля: w ∝ Σ⁻¹·1, нормируем. Ковариацию «подсаживаем» к диагонали (shrinkage), иначе на коротком ряду Σ почти вырождена и веса скачут.',
    chunks: [
      {
        code: `// Shrinkage: смесь выборочной ковариации и диагонали (только дисперсии).\n// lambda=0.3 — компромисс: стабильнее, но не теряем связи между бумагами.\nfunction shrink(cov, lambda = 0.3){\n  const n = cov.length;\n  return cov.map((row, i) => row.map((v, j) =>\n    i === j ? v : v * (1 - lambda)));\n}`,
        note: 'Внедиагональные элементы (ковариации) гасим на 30%. Это «регуляризация»: уменьшает переобучение на шуме короткой истории. Диагональ (собственные дисперсии) не трогаем.',
        out: 'shrink(cov) → матрица с ослабленными связями — обратима и устойчива.',
      },
      {
        code: `// w ∝ Σ⁻¹ · 1, затем нормировка и проекция на симплекс.\nfunction wMinVariance(cov){\n  const inv = invert(shrink(cov));       // обращение матрицы\n  const ones = inv.map(row => row.reduce((a, b) => a + b, 0)); // Σ⁻¹·1\n  const s = ones.reduce((a, b) => a + b, 0);\n  return projectSimplex(ones.map(x => x / s));\n}`,
        note: 'Σ⁻¹·1 даёт направление минимальной дисперсии; делим на сумму, чтобы веса давали 1; проекция убирает возможные минусы. Чем «тише» бумага и чем слабее её связи с другими — тем больше её вес.',
        out: 'wMinVariance(cov) → [0.41, 0.33, 0.26] — больше всего в самую спокойную бумагу.',
      },
    ],
  },
  // ───────────────────────── Данные/сеть ─────────────────────────
  {
    id: 'moex', group: 'data', lang: 'js',
    title: 'MOEX ISS — история доходностей облигации',
    desc: 'Открытый API Московской биржи (CORS разрешён, токен не нужен). Данные приходят в формате columns+data — массив строк по именам колонок; собираем в объекты сами.',
    chunks: [
      {
        code: `async function fetchYieldHistory(secid, from, till){\n  const url = \`https://iss.moex.com/iss/history/engines/stock/markets/\` +\n    \`bonds/securities/\${secid}.json?from=\${from}&till=\${till}\`;\n  const r = await fetch(url);\n  const j = await r.json();\n  return j.history;   // { columns:[...], data:[[...], ...] }\n}`,
        note: 'ISS отдаёт не массив объектов, а колонки отдельно и строки отдельно (экономия байт). secid — код бумаги (напр. SU26238RMFS4). Даты в формате YYYY-MM-DD.',
        out: 'history.columns → ["TRADEDATE","YIELDCLOSE","DURATION",...]; history.data → [["2025-01-09", 16.1, 2.3, ...], ...]',
      },
      {
        code: `// Собираем [{date, ytm, dur}] из columns/data по индексам колонок.\nfunction parse(history){\n  const col = n => history.columns.indexOf(n);\n  const iD = col('TRADEDATE'), iY = col('YIELDCLOSE'), iDur = col('DURATION');\n  return history.data\n    .map(row => ({ date: row[iD], ytm: row[iY], dur: row[iDur] }))\n    .filter(x => x.ytm != null);   // в выходные/без торгов — null, выкидываем\n}`,
        note: 'Имя колонки → индекс через indexOf один раз, потом по индексам читаем каждую строку. Фильтр убирает дни без сделок (иначе дырки в графике и в расчётах).',
        out: '[{date:"2025-01-09", ytm:16.1, dur:2.3}, ...] — готовый ряд для графика/спреда.',
      },
    ],
  },
  {
    id: 'ghcommit', group: 'data', lang: 'js',
    title: 'GitHub Contents — коммит файла из браузера',
    desc: 'Так работают «Схемы отраслей»: PUT в Contents API = коммит. Для замены существующего файла нужен его sha. Тело кодируется в base64 (UTF-8 — поблочно, иначе переполнение стека).',
    chunks: [
      {
        code: `// UTF-8 → base64 ПОБЛОЧНО: спред большого массива в fromCharCode(...bytes)\n// роняет стек ("Maximum call stack size exceeded") на файлах в десятки КБ.\nfunction utf8ToB64(s){\n  const bytes = new TextEncoder().encode(s);\n  let bin = ''; const CH = 0x8000;      // 32768 аргументов за раз\n  for(let i = 0; i < bytes.length; i += CH)\n    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));\n  return btoa(bin);\n}`,
        note: 'btoa понимает только latin1, поэтому сперва кодируем в байты, потом склеиваем строку кусками по 32 КБ. Это ровно тот баг, что ловили на загрузке больших HTML-схем.',
        out: 'utf8ToB64("<html>…кириллица…") → "PGh0bWw+4oCm..." (base64, безопасно для JSON).',
      },
      {
        code: `async function putFile(repo, path, text, token, sha){\n  const body = { message: 'add ' + path, content: utf8ToB64(text), branch: 'main' };\n  if(sha) body.sha = sha;              // есть sha → замена, нет → новый файл\n  await fetch(\`https://api.github.com/repos/\${repo}/contents/\${path}\`, {\n    method: 'PUT',\n    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' },\n    body: JSON.stringify(body),\n  });\n}`,
        note: 'PUT с content создаёт коммит. Для перезаписи GitHub требует sha текущей версии (оптимистичная блокировка — защита от затирания чужих правок). Токен живёт только в localStorage, в код/логи не попадает.',
        out: 'В репозитории появляется новый коммит с этим файлом; ответ содержит content.sha новой версии.',
      },
    ],
  },
  // ───────────────────────── Хранилище ─────────────────────────
  {
    id: 'zustand', group: 'store', lang: 'js',
    title: 'zustand + localStorage — глобальное состояние с автосохранением',
    desc: 'Мини-стор без провайдеров. Начальное значение читаем из localStorage, каждое изменение туда же пишем. Так устроены ключевая ставка, настройки, портфель.',
    chunks: [
      {
        code: `import { create } from 'zustand';\n\nconst load = () => { try { return JSON.parse(localStorage.getItem('ba_rate')) || 16; }\n  catch(_){ return 16; } };          // битый JSON / приватный режим → дефолт`,
        note: 'Любое чтение localStorage оборачиваем в try/catch: в приватном окне или при битых данных .getItem кидает/вернёт мусор. Дефолт 16 — чтобы приложение жило даже без сохранёнки.',
        out: 'load() → 14 (сохранённое значение) или 16 (если ничего/ошибка).',
      },
      {
        code: `export const useKeyRate = create((set) => ({\n  current: load(),\n  setCurrent: (v) => {\n    try { localStorage.setItem('ba_rate', JSON.stringify(v)); } catch(_){}\n    set({ current: v });             // обновили стор → перерисовались все подписчики\n  },\n}));`,
        note: 'create возвращает хук. set меняет состояние и дёргает ре-рендер компонентов, читающих этот кусок. Запись в localStorage — рядом, чтобы состояние пережило перезагрузку.',
        out: 'В компоненте: const r = useKeyRate(s => s.current) → 14; useKeyRate.getState().setCurrent(15) обновит везде.',
      },
    ],
  },
  // ───────────────────────── Языки ─────────────────────────
  {
    id: 'py-basics', group: 'lang', lang: 'python',
    title: 'Python — те же расчёты (бот/бэктест)',
    desc: 'В invest-bot расчёты на numpy. Те же идеи, что в JS выше, но векторно — без ручных циклов.',
    chunks: [
      {
        code: `import numpy as np\n\n# Дневные доходности из ряда цен: p[t]/p[t-1] - 1.\n# np.diff считает разности, деление векторное — цикл не нужен.\ndef daily_returns(prices):\n    p = np.asarray(prices, dtype=float)\n    return p[1:] / p[:-1] - 1.0`,
        note: 'p[1:] — со второго элемента, p[:-1] — без последнего: поэлементно это пары (сегодня, вчера). numpy делит массивы сразу, без for. Так же в JS, но там циклом.',
        out: 'daily_returns([100, 101, 99]) → array([ 0.01, -0.0198])',
      },
      {
        code: `# Аннуализированные волатильность и Sharpe. ddof=1 — несмещённая оценка.\ndef sharpe(returns, rf_daily=0.0, ppy=252):\n    r = np.asarray(returns)\n    excess = r.mean() - rf_daily\n    vol = r.std(ddof=1)\n    return (excess / vol) * np.sqrt(ppy) if vol else np.inf`,
        note: 'ppy — периодов в году (252 торговых дня). sqrt(ppy) — аннуализация волатильности (у неё корневой масштаб), сам Sharpe тоже домножаем. ddof=1 делит на n-1, как принято для выборки.',
        out: 'sharpe(returns) → 1.42',
      },
    ],
  },
  {
    id: 'sql-basics', group: 'lang', lang: 'sql',
    title: 'SQL — агрегации по сделкам',
    desc: 'Если данные сделок лягут в таблицу — вот типовые запросы: сводка P&L по бумагам и скользящая позиция.',
    chunks: [
      {
        code: `-- P&L и оборот по каждой бумаге. qty>0 покупка, qty<0 продажа.\nselect\n  secid,\n  sum(qty * price) * -1 as realized_pnl,   -- приход минус расход\n  sum(abs(qty) * price) as turnover,\n  count(*) as trades\nfrom trades\ngroup by secid\norder by realized_pnl desc;`,
        note: 'group by secid сворачивает строки сделок в одну на бумагу. sum(qty*price)*-1: покупка — отток денег, продажа — приток; знак переворачиваем, чтобы прибыль была положительной.',
        out: 'secid | realized_pnl | turnover | trades\nSU26238 | 12400 | 980000 | 17',
      },
      {
        code: `-- Накопленная позиция по датам (оконная функция).\nselect trade_date, secid,\n  sum(qty) over (\n    partition by secid order by trade_date\n  ) as position\nfrom trades\norder by secid, trade_date;`,
        note: 'sum(...) over (partition by secid order by ...) — скользящая сумма внутри каждой бумаги по времени: сколько штук на руках после каждой сделки. partition = «отдельно по каждой бумаге».',
        out: 'trade_date | secid | position\n2025-01-09 | SU26238 | 50\n2025-01-15 | SU26238 | 30',
      },
    ],
  },
];
