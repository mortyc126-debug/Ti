// Конструктор-холст: компоненты-узлы на 2D-поле, соединяются линиями
// (выход → вход). Слева палитра по категориям, справа инспектор
// (Настроить / Разобраться / Объяснить), снизу собранный код + запуск.
// Код собирается по связям: порядок = топологический обход рёбер.

// ── блоки-компоненты (каждый — самодостаточный кусок) ────────────────────────
const BLOCKS = {
  let:    { cat:'Переменные и данные', label:'переменная', type:'leaf', hint:'Коробка со значением. name — имя, value — что положить.', fields:[{k:'name',def:'цена'},{k:'value',def:'100'}], code:f=>`let ${f.name} = ${f.value};` },
  array:  { cat:'Переменные и данные', label:'массив', type:'leaf', hint:'Список значений через запятую.', fields:[{k:'name',def:'числа'},{k:'items',def:'40, 70, 30, 90, 55'}], code:f=>`const ${f.name} = [${f.items}];` },
  object: { cat:'Переменные и данные', label:'объект', type:'leaf', hint:'Карточка «ключ: значение».', fields:[{k:'name',def:'бумага'},{k:'body',def:'имя: "ОФЗ", купон: 7.1'}], code:f=>`const ${f.name} = { ${f.body} };` },
  map:    { cat:'Обработка', label:'map (преобразовать)', type:'leaf', hint:'Новый список: к каждому x применить выражение.', fields:[{k:'name',def:'удвоенные'},{k:'list',def:'числа'},{k:'expr',def:'x * 2'}], code:f=>`const ${f.name} = ${f.list}.map(x => ${f.expr});` },
  filter: { cat:'Обработка', label:'filter (отобрать)', type:'leaf', hint:'Оставить элементы, где условие истинно.', fields:[{k:'name',def:'большие'},{k:'list',def:'числа'},{k:'cond',def:'x > 50'}], code:f=>`const ${f.name} = ${f.list}.filter(x => ${f.cond});` },
  reduce: { cat:'Обработка', label:'reduce (свернуть)', type:'leaf', hint:'Свернуть список в одно значение. acc копит, x — текущий.', fields:[{k:'name',def:'сумма'},{k:'list',def:'числа'},{k:'expr',def:'acc + x'}], code:f=>`const ${f.name} = ${f.list}.reduce((acc, x) => ${f.expr}, 0);` },
  calc:   { cat:'Обработка', label:'расчёт (формула)', type:'leaf', hint:'Посчитать выражение и положить в имя.', fields:[{k:'name',def:'результат'},{k:'expr',def:'сумма / числа.length'}], code:f=>`const ${f.name} = ${f.expr};` },
  log:    { cat:'Вывод', label:'вывод в консоль', type:'leaf', hint:'Показать значение в превью при запуске.', fields:[{k:'value',def:'результат'}], code:f=>`console.log(${f.value});` },
  bars:   { cat:'Вывод', label:'столбики (canvas)', type:'draw', hint:'Нарисовать столбики по числам на холсте #c. Поле values принимает массив или список чисел.', fields:[{k:'values',def:'40, 70, 30, 90, 55'}], code:f=>`const ctx = document.querySelector("#c").getContext("2d");\nconst barValues = Array.isArray(${f.values}) ? ${f.values} : [${f.values}];\nbarValues.forEach((v, i) => { ctx.fillStyle = "#3DD9FF"; ctx.fillRect(i * 32, 140 - v, 22, v); });` },
  svg:    { cat:'Вывод', label:'SVG-линия', type:'draw', hint:'Линия по точкам «x,y x,y…» в области #out. Координаты проверяются как числа, SVG-узлы создаются через DOM.', fields:[{k:'points',def:'0,90 20,70 40,80 60,40 80,55 100,20'}], code:f=>{ const raw=JSON.stringify(String(f.points||'')); return `const svgHost = document.querySelector("#out");\nif (!svgHost) throw new Error('Не найден элемент #out для SVG');\nconst svgPointsRaw = ${raw};\nconst svgPairs = svgPointsRaw.trim().split(/\\s+/).filter(Boolean).map((pair) => pair.split(',').map(Number));\nif (!svgPairs.length || svgPairs.some((p) => p.length !== 2 || p.some((v) => !Number.isFinite(v)))) throw new Error('SVG: точки должны быть парами чисел x,y через пробел');\nconst svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');\nsvg.setAttribute('width', '200'); svg.setAttribute('height', '100');\nconst polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');\npolyline.setAttribute('points', svgPairs.map((p) => p.join(',')).join(' '));\npolyline.setAttribute('fill', 'none'); polyline.setAttribute('stroke', '#52F2C9'); polyline.setAttribute('stroke-width', '2');\nsvg.appendChild(polyline); svgHost.replaceChildren(svg);`; } },
  fetchj: { cat:'Сеть', label:'запрос (fetch)', type:'leaf', hint:'Сходить в сеть за JSON. Нужен await — ставь внутри async.', fields:[{k:'name',def:'данные'},{k:'url',def:'https://api.example.com/data'}], code:f=>`const ${f.name} = await fetch("${f.url}").then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });` },
  iff:    { cat:'Логика', label:'если (if)', type:'leaf', hint:'Выполнить строку только если условие истинно.', fields:[{k:'cond',def:'цена > 50'},{k:'then',def:'console.log("дорого")'}], code:f=>`if (${f.cond}) { ${f.then}; }` },
  forN:   { cat:'Логика', label:'повторить N раз', type:'leaf', hint:'Повторить строку count раз (счётчик i).', fields:[{k:'count',def:'3'},{k:'body',def:'console.log(i)'}], code:f=>`for (let i = 0; i < ${f.count}; i++) { ${f.body}; }` },
  func:   { cat:'Логика', label:'функция', type:'leaf', hint:'Рецепт: вход args → тело. Многострочное тело пиши в body.', fields:[{k:'name',def:'посчитать'},{k:'args',def:'a, b'},{k:'body',def:'return a + b;'}], code:f=>`function ${f.name}(${f.args}) {\n  ${f.body}\n}` },
  raw:    { cat:'Своё', label:'свой код', type:'leaf', labelFn:f=>classify(f.code||''), hint:'Любой свой JS-код как есть — вставь или втяни из каталога.', fields:[{k:'code',multi:true,def:'// свой код\nconsole.log("привет");'}], code:f=>f.code },
};
function classify(text){
  const l = (text || '').trim().split('\n')[0] || '';
  if(/^(export\s+)?(async\s+)?function\b/.test(l)) return 'функция';
  if(/^(export\s+)?class\b/.test(l)) return 'класс';
  if(/^if\b/.test(l)) return 'условие';
  if(/^for\b/.test(l)) return 'цикл';
  if(/fetch\(/.test(l)) return 'запрос';
  if(/console\./.test(l)) return 'вывод';
  if(/^(export\s+)?(const|let|var)\b/.test(l)) return 'переменная';
  if(/\.(map|filter|reduce|forEach)\(/.test(l)) return 'обработка списка';
  return 'код';
}

// Контракт блока: показываем требования и результат до того, как пользователь запускает код.
// Это подсказки по типовым блокам, а не доказательство автоматической совместимости.
const BLOCK_GUIDES = {
  let:    { input:'Значение, которое можно записать в переменную', output:'Переменная с указанным именем', needs:['Имя переменной без пробелов','Корректное JavaScript-выражение в поле «value»'], risks:['Если имя уже объявлено через const/let в той же области, возникнет ошибка повторного объявления.'] },
  array:  { input:'Элементы, перечисленные через запятую', output:'Массив с указанным именем', needs:['Имя массива','Элементы должны быть корректными выражениями: строки — в кавычках, объекты — в фигурных скобках'], risks:['Не заключай весь список в дополнительные квадратные скобки: блок добавляет их сам.'] },
  object: { input:'Пары ключ: значение', output:'Объект с указанным именем', needs:['Ключи и значения в синтаксисе JavaScript','Строковые значения нужно заключать в кавычки'], risks:['Неверная запятая или двоеточие сломают синтаксис.'] },
  map:    { input:'Массив из поля «list»', output:'Новый массив в переменной из поля «name»', needs:['Сначала создай массив или добавь блок, который объявляет переменную из поля «list»','В выражении используй x как текущий элемент'], risks:['Если переменной из «list» нет, будет ReferenceError.','map не меняет исходный массив, а возвращает новый.'] },
  filter: { input:'Массив из поля «list»', output:'Новый массив только с элементами, прошедшими условие', needs:['Переменная массива должна быть объявлена выше по порядку выполнения','Условие должно возвращать true/false; x — текущий элемент'], risks:['Если условие всегда истинно/ложно, результат будет содержать все/ни одного элемента.'] },
  reduce: { input:'Массив из поля «list»', output:'Одно итоговое значение', needs:['Объявленная переменная массива','Выражение использует acc (накопитель) и x (текущий элемент)'], risks:['Начальное значение здесь фиксировано как 0; для объектов/строк нужно изменить код вручную.'] },
  calc:   { input:'Переменные и выражения, указанные в формуле', output:'Переменная с результатом вычисления', needs:['Все имена в формуле должны быть объявлены раньше','Проверь деление на ноль и типы значений'], risks:['Необъявленная переменная приведёт к ReferenceError.'] },
  log:    { input:'Переменная или выражение из поля «value»', output:'Значение в журнале предпросмотра', needs:['Указанное имя должно существовать к моменту вывода'], risks:['Если имя не объявлено, запуск остановится с ошибкой.'] },
  bars:   { input:'Список чисел из поля «values»', output:'Столбчатая диаграмма на canvas #c', needs:['Среда предпросмотра содержит canvas с id="c"','Значения должны быть числами; высота столбца зависит от значения'], risks:['Если canvas отсутствует, getContext вызовет ошибку.'] },
  svg:    { input:'Координаты точек из поля «points»', output:'SVG-линия внутри элемента #out', needs:['Среда должна содержать элемент с id="out"','Точки задаются парами x,y через пробел и должны быть конечными числами'], risks:['Неверная точка остановит этот блок с понятной ошибкой; SVG больше не собирается через innerHTML.'] },
  fetchj: { input:'URL API из поля «url»', output:'Данные JSON в переменной из поля «name»', needs:['Доступ к сети и разрешение CORS со стороны сервера','Запрос должен выполняться в async-контексте — конструктор оборачивает код с await','API должен возвращать корректный JSON'], risks:['Домен-заглушка api.example.com не является готовым источником данных.','HTTP-ошибки и недоступная сеть могут сорвать запрос; нужна обработка ошибок.'] },
  iff:    { input:'Условие из поля «cond»', output:'Выполняет тело только если условие истинно', needs:['Все переменные в условии должны существовать','В поле then указывается JavaScript-код'], risks:['Условие сравнения обычно использует ===, >, < и другие операторы.'] },
  forN:   { input:'Количество повторений', output:'Выполняет тело цикла N раз', needs:['Количество — неотрицательное число','В теле доступна переменная-счётчик i'], risks:['Бесконечный цикл возможен, если вручную изменить условие/шаг.'] },
  func:   { input:'Аргументы, перечисленные в поле «args»', output:'Объявляет функцию; сама по себе не запускает её', needs:['Имя функции и параметры должны быть корректными идентификаторами','Чтобы получить результат, отдельно вызови функцию'], risks:['Функция с return ничего не посчитает до вызова.'] },
  raw:    { input:'Зависит от вставленного кода', output:'Зависит от вставленного кода', needs:['Проверь, что все переменные, функции и DOM-элементы доступны','Код выполняется в изолированном предпросмотре; серверные API и пакеты не подключены автоматически'], risks:['Свободный код может иметь побочные эффекты; проверь его перед запуском.'] }
};


// Runtime-проверка: отделяем «по описанию должно быть» от того, что реально есть
// в текущем preview. Состояние используется инспектором и запуском.
const runtimeState = { status:'idle', errors:[], warnings:[], checkedAt:0 };
const COMMON_GLOBALS = new Set([
  'Array','Boolean','Date','Error','JSON','Map','Math','Number','Object','Promise','RegExp','Set','String','Symbol','URL','console','document','window','fetch','localStorage','sessionStorage','indexedDB','requestAnimationFrame','cancelAnimationFrame','setTimeout','clearTimeout','setInterval','clearInterval','parseInt','parseFloat','isNaN','isFinite','Intl','TextEncoder','TextDecoder','FormData','Blob','File','FileReader','URLSearchParams'
]);
const LIBRARY_GLOBALS = {
  XLSX:'XLSX', Chart:'Chart', React:'React', Vue:'Vue', VueRouter:'VueRouter', axios:'axios', dayjs:'dayjs', moment:'moment', _:'_', echarts:'echarts', THREE:'THREE'
};
const DEPENDENCY_REGISTRY = {
  XLSX:{id:'sheetjs',name:'SheetJS (xlsx)',global:'XLSX',mode:'script',url:'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',provide:'подключение SheetJS browser bundle',provider:'libs-sheetjs'},
  Chart:{id:'chartjs',name:'Chart.js',global:'Chart',mode:'script',url:'https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js',provide:'подключение Chart.js browser bundle'},
  React:{id:'react',name:'React',global:'React',mode:'script',url:'https://unpkg.com/react@18/umd/react.development.js',provide:'подключение React UMD или сборщик'},
  Vue:{id:'vue',name:'Vue',global:'Vue',mode:'script',url:'https://unpkg.com/vue@3/dist/vue.global.js',provide:'подключение Vue Global или сборщик'},
  axios:{id:'axios',name:'Axios',global:'axios',mode:'script',url:'https://cdn.jsdelivr.net/npm/axios@1.7.9/dist/axios.min.js',provide:'подключение Axios browser bundle'},
  dayjs:{id:'dayjs',name:'Day.js',global:'dayjs',mode:'script',url:'https://cdn.jsdelivr.net/npm/dayjs@1/dayjs.min.js',provide:'подключение Day.js browser bundle'},
  moment:{id:'moment',name:'Moment.js',global:'moment',mode:'script',url:'https://cdn.jsdelivr.net/npm/moment@2.30.1/min/moment.min.js',provide:'подключение Moment.js browser bundle'},
  _:{id:'lodash',name:'Lodash',global:'_',mode:'script',url:'https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js',provide:'подключение Lodash browser bundle'},
  echarts:{id:'echarts',name:'Apache ECharts',global:'echarts',mode:'script',url:'https://cdn.jsdelivr.net/npm/echarts@5.6.0/dist/echarts.min.js',provide:'подключение ECharts browser bundle'},
  THREE:{id:'three',name:'Three.js',global:'THREE',mode:'script',url:'https://cdn.jsdelivr.net/npm/three@0.172.0/build/three.min.js',provide:'подключение Three.js browser bundle'},
  zustand:{id:'zustand',name:'Zustand',mode:'module',provide:'npm/ESM-среда; обычный script-preview не поддерживает автоматическое подключение',provider:'libs-zustand'}
};
const DEPENDENCY_ALIASES={xlsx:'XLSX','chart.js':'Chart',react:'React',vue:'Vue',axios:'axios',dayjs:'dayjs',moment:'moment',lodash:'_',echarts:'echarts',three:'THREE',zustand:'zustand'};
function runtimeSelectors(code){
  const out=[]; const seen=new Set(); const text=String(code||'');
  const push=(v)=>{ if(v && !seen.has(v)){seen.add(v);out.push(v);} };
  for(const re of [/querySelector\(\s*["']([^"']+)["']\s*\)/g,/querySelectorAll\(\s*["']([^"']+)["']\s*\)/g,/getElementById\(\s*["']([^"']+)["']\s*\)/g]){
    let m; while((m=re.exec(text))) push(m[1]);
  }
  return out;
}
function runtimeLibraryNeeds(code){
  const text=String(code||''); const out=[]; const seen=new Set();
  const add=(key,evidence)=>{const dep=DEPENDENCY_REGISTRY[key]; if(!dep||seen.has(dep.id)) return; seen.add(dep.id); out.push({...dep,evidence:evidence||'global'});};
  Object.keys(LIBRARY_GLOBALS).forEach(name=>{const re=new RegExp('\\b'+name.replace(/[$]/g,'\\$&')+'\\b'); if(re.test(text)&&!COMMON_GLOBALS.has(name)) add(name,'global '+name);});
  for(const m of text.matchAll(/(?:import|export)\s+(?:[^'\"]+?\s+from\s+)?['\"]([^'\"]+)['\"]/g)){const raw=m[1],key=DEPENDENCY_ALIASES[raw]||raw;if(DEPENDENCY_REGISTRY[key]) add(key,'import '+raw);}
  return out;
}
function dependencyStatus(doc,code){
  const deps=runtimeLibraryNeeds(code),result={ready:[],missing:[],manual:[]};
  deps.forEach(dep=>{if(dep.mode==='module'){result.manual.push(dep);return;} try{if(doc.defaultView&&dep.global in doc.defaultView) result.ready.push(dep);else result.missing.push(dep);}catch(_){result.missing.push(dep);}});
  return result;
}
function dependencyAdvice(dep){const source=dep.provider?` Источник/блок: ${dep.provider}.`:''; return dep.mode==='module'?`Зависимость «${dep.name}» требует ESM/npm-среду: ${dep.provide}.${source}`:`Зависимость «${dep.name}» не найдена: ${dep.provide}.${source}`; }

function runtimeFreeIdentifierNeeds(code){
  const declared=new Set(['console','document','window','globalThis']);
  const scrubbed=String(code||'').replace(/\/\*[\s\S]*?\*\//g,' ').replace(/(^|[^:])\/\/.*$/gm,' ').replace(/(['\"`])(?:\\.|(?!\1)[^\\])*\1/g,' ');
  for(const m of scrubbed.matchAll(/(?:const|let|var|function|class)\s+([\p{ID_Start}_$][\p{ID_Continue}_$]*)/gu)) declared.add(m[1]);
  const used=[]; const seen=new Set();
  for(const m of scrubbed.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g)){
    const w=m[1]; if(seen.has(w)||declared.has(w)||COMMON_GLOBALS.has(w)||LIBRARY_GLOBALS[w]) continue;
    // Ключевые слова и свойства после точки не считаем внешними зависимостями.
    const i=m.index||0; if(i>0 && String(code)[i-1]==='.') continue;
    if(/^(if|else|for|while|return|const|let|var|function|class|new|throw|try|catch|finally|async|await|true|false|null|undefined|typeof|instanceof|in|of|this|switch|case|break|continue|do|delete|void|yield)$/.test(w)) continue;
    seen.add(w); used.push(w);
  }
  return used;
}
function runtimeAnalyze(code){
  const selectors=runtimeSelectors(code), libraries=runtimeLibraryNeeds(code), external=runtimeFreeIdentifierNeeds(code);
  return { selectors, libraries, external };
}
function runtimeCheckDocument(doc, code){
  const a=runtimeAnalyze(code), errors=[], warnings=[];
  a.selectors.forEach(sel=>{try{if(!doc.querySelector(sel))errors.push(`Не найден DOM-элемент «${sel}».`);}catch(e){errors.push(`Некорректный CSS-селектор «${sel}».`);}});
  const dependencies=dependencyStatus(doc,code);
  dependencies.missing.forEach(d=>errors.push(`Не подключена библиотека «${d.name}» (${d.global||d.id}). ${dependencyAdvice(d)}`));
  dependencies.manual.forEach(d=>warnings.push(`Библиотека «${d.name}» требует ESM/npm-настройку. ${dependencyAdvice(d)}`));
  if(a.external.length)warnings.push(`Возможные внешние переменные/библиотеки: ${a.external.join(', ')}.`);
  return {errors,warnings,analysis:a,dependencies};
}
function setRuntimeState(status, errors=[], warnings=[]){ runtimeState.status=status; runtimeState.errors=[...new Set(errors)]; runtimeState.warnings=[...new Set(warnings)]; runtimeState.checkedAt=Date.now(); const el=document.getElementById('runtimeStatus'); if(el){ el.className='runtime-status '+status; el.textContent=status==='ready'?'✓ окружение готово':status==='error'?'⛔ есть ошибки':status==='checking'?'… проверка':'Preview не запускался'; } }

// Формальный контракт соединений. Это уже не только текстовая подсказка:
// addEdge() использует эти данные и не создаёт заведомо несовместимую связь.
const BLOCK_CONTRACTS = {
  let:    { output:'any', outputField:'name', outputKind:'value' },
  array:  { output:'array', outputField:'name', outputKind:'value' },
  object: { output:'object', outputField:'name', outputKind:'value' },
  map:    { input:'array', inputField:'list', output:'array', outputField:'name' },
  filter: { input:'array', inputField:'list', output:'array', outputField:'name' },
  reduce: { input:'array', inputField:'list', output:'any', outputField:'name' },
  calc:   { input:'any', inputField:'expr', output:'any', outputField:'name', inputMode:'expression' },
  log:    { input:'any', inputField:'value', output:'void', inputMode:'expression' },
  bars:   { input:'array', inputField:'values', output:'void', inputMode:'expression', dom:['c'] },
  svg:    { input:'points', inputField:'points', output:'void', inputMode:'expression', dom:['out'] },
  fetchj: { output:'any', outputField:'name', async:true },
  iff:    { input:'any', inputField:'cond', output:'void', inputMode:'expression' },
  forN:   { output:'void' },
  func:   { output:'function', outputField:'name' },
  raw:    { input:'any', output:'any', inputMode:'free', unknown:true }
};
const TYPE_RU = { any:'значение', array:'массив', object:'объект', points:'точки', string:'строка', number:'число', boolean:'логическое значение', function:'функция', void:'ничего' };
const IDENTIFIER_RE = /^[\p{ID_Start}_$][\p{ID_Continue}_$]*$/u;
const DECLARATION_RE = /(?:const|let|var)\s+([\p{ID_Start}_$][\p{ID_Continue}_$]*)\s*=\s*([^;\n]+)/gu;

function blockContract(nd){ return BLOCK_CONTRACTS[nd && nd.blockId] || BLOCK_CONTRACTS.raw; }
function outputName(nd){ const c=blockContract(nd), f=nd.fields||{}; return c.outputField ? String(f[c.outputField]||'').trim() : ''; }
function inferExprType(expr, defined){
  const x=String(expr||'').trim();
  if(!x) return 'any';
  if(/^\[/.test(x) || /\.(?:map|filter)\s*\(/.test(x)) return 'array';
  if(/^\{/.test(x)) return 'object';
  if(/^(?:true|false)$/.test(x)) return 'boolean';
  if(/^["'`]/.test(x)) return 'string';
  if(/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(x)) return 'number';
  if(/^function\b|^\(?[^=]*\)?\s*=>/.test(x)) return 'function';
  if(/^document\./.test(x) || /^document\.querySelector/.test(x)) return 'object';
  if(defined && defined.has(x)) return defined.get(x) || 'any';
  return 'any';
}
function buildSymbols(code){
  const symbols=new Map();
  for(const m of String(code||'').matchAll(DECLARATION_RE)) symbols.set(m[1], inferExprType(m[2], symbols));
  return symbols;
}
function typeCompatible(actual, expected){ return expected==='any' ? true : actual===expected; }
function connectedIncoming(nd){ return graph.edges.filter(e=>e.to===nd.id).map(e=>byId(e.from)).filter(Boolean); }
function connectedOutgoing(nd){ return graph.edges.filter(e=>e.from===nd.id).map(e=>byId(e.to)).filter(Boolean); }
function edgeCheck(from,to){
  const a=blockContract(from), b=blockContract(to);
  if(a.unknown || b.unknown) return {ok:true,level:'info',reason:'Связь со «своим кодом» требует ручной проверки.'};
  if(b.input==null) return {ok:false,reason:`«${nodeLabel(to)}» не принимает вход от другого блока.`};
  if(a.output==='void') return {ok:false,reason:`«${nodeLabel(from)}» ничего не выдаёт для передачи дальше.`};
  const sourceType=outputType(from);
  if(!typeCompatible(sourceType,b.input)) return {ok:false,reason:`Несовместимые типы: «${nodeLabel(from)}» выдаёт ${TYPE_RU[sourceType]||sourceType}, а «${nodeLabel(to)}» ожидает ${TYPE_RU[b.input]||b.input}.`};
  const sourceName=outputName(from);
  if(b.inputMode!=='free' && b.inputField && !sourceName) return {ok:false,reason:`«${nodeLabel(from)}» не имеет имени результата, которое можно передать в поле «${b.inputField}».`};
  if(b.dom && b.dom.length) return {ok:true,level:'info',reason:`Данные совместимы. Кроме них нужен DOM-элемент: ${b.dom.map(x=>'#'+x).join(', ')}.`};
  return {ok:true};
}
// нужен ли узлу вход, которого пока нет (для пометки «нужен вход»)
function nodeNeedsInput(nd){
  const c = blockContract(nd);
  if(c.unknown || c.input == null || !c.inputField || c.inputMode === 'free') return false;
  if(graph.edges.some(e => e.to === nd.id)) return false;      // есть входящая связь
  const val = String((nd.fields || {})[c.inputField] || '').trim();
  if(!val) return true;                                        // поле пустое — вход точно нужен
  if(inferExprType(val, new Map()) !== 'any') return false;    // литерал (число/массив/строка) — вход уже есть
  // ссылка на имя: считаем входом, если это имя выдаёт какой-то другой узел
  // (границы слова — через ID_Continue, т.к. \b не работает с кириллицей)
  const names = graph.nodes.filter(n => n !== nd).map(outputName).filter(Boolean);
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return !names.some(nm => new RegExp('(^|[^\\p{ID_Continue}$])' + esc(nm) + '($|[^\\p{ID_Continue}$])', 'u').test(val));
}
// текст подсказки «что нужно подать на вход» (из гайда блока или контракта)
function needHint(nd){
  const g = (typeof BLOCK_GUIDES !== 'undefined') ? BLOCK_GUIDES[nd.blockId] : null;
  const c = blockContract(nd);
  let s = 'Нужен вход';
  if(g && g.input) s += ': ' + g.input;
  else if(c.inputField) s += ' в поле «' + c.inputField + '»' + (c.input && TYPE_RU[c.input] ? ' (' + TYPE_RU[c.input] + ')' : '');
  s += '.';
  if(g && g.needs && g.needs.length) s += ' ' + g.needs.join('; ') + '.';
  s += ' Соедини с узлом-источником или впиши имя существующей переменной.';
  return s;
}
// проставить/снять пометку «нужен вход» на всех узлах
function markNeeds(){
  canvas.querySelectorAll('.gnode').forEach(elm => {
    const nd = byId(elm.dataset.id); if(!nd) return;
    const need = nodeNeedsInput(nd);
    elm.classList.toggle('needs-input', need);
    let badge = elm.querySelector('.need-badge');
    if(need){ if(!badge){ badge = el('div', 'need-badge', 'нужен вход'); elm.appendChild(badge); } badge.title = needHint(nd); }
    else if(badge){ badge.remove(); }
  });
}
function outputType(nd){
  const c=blockContract(nd), f=nd.fields||{};
  if(c.outputField && f[c.outputField]){
    if(nd.blockId==='let') return inferExprType(f.value, new Map());
    if(nd.blockId==='calc') return inferExprType(f.expr, buildSymbols(''));
    return c.output || 'any';
  }
  return c.output || 'any';
}
function bindEdge(from,to){
  const c=blockContract(to); if(!c.inputField || c.inputMode==='free') return;
  const name=outputName(from); if(!name) return;
  to.fields=to.fields||{}; to.fields[c.inputField]=name;
}
function edgeExplanation(from,to){ const check=edgeCheck(from,to); if(!check.ok) return {...check,text:'Связь запрещена: '+check.reason}; bindEdge(from,to); return {...check,text:check.reason||`Совместимо: ${nodeLabel(from)} → ${nodeLabel(to)}.`}; }
function compatibleTargets(nd){
  return graph.nodes.filter(n=>n.id!==nd.id).filter(n=>edgeCheck(nd,n).ok).map(n=>nodeLabel(n));
}


const CATS = [...new Set(Object.values(BLOCKS).map(b => b.cat))];

// ── состояние: граф {nodes:[{id,blockId,fields,x,y,title?}], edges:[{from,to}]} ─
let graph = { nodes: [], edges: [] };
let selectedId = null, inspTab = 'set';
const LS = 'codelab_graph';
const uid = () => Math.random().toString(36).slice(2, 8);
const $ = s => document.querySelector(s);
const canvas = $('#canvas'), edgesSvg = $('#edges'), codeEl = $('#code'), preview = $('#preview');

function persistRaw(){ try { localStorage.setItem(LS, JSON.stringify(graph)); } catch(_){} }
// История для отмены/повтора. Быстрые правки (печать) схлопываются в один шаг.
let histPast = [], histFuture = [], histLast = null, histTimer = null;
function histInit(){ histLast = JSON.stringify(graph); updateUndoButtons(); }
function histCommit(){
  const cur = JSON.stringify(graph);
  if(cur === histLast) return;
  histPast.push(histLast); if(histPast.length > 120) histPast.shift();
  histFuture = []; histLast = cur; updateUndoButtons();
}
function persist(){ persistRaw(); clearTimeout(histTimer); histTimer = setTimeout(histCommit, 350); }
function histFlush(){ clearTimeout(histTimer); histCommit(); }
function applySnap(s){ try { const g = JSON.parse(s); graph = { nodes: g.nodes || [], edges: Array.isArray(g.edges) ? g.edges : [] }; selectedId = null; renderCanvas(); renderInspector(); renderCode(); persistRaw(); } catch(_){} }
function undo(){ histFlush(); if(!histPast.length) return; histFuture.push(histLast); const s = histPast.pop(); histLast = s; applySnap(s); updateUndoButtons(); }
function redo(){ histFlush(); if(!histFuture.length) return; histPast.push(histLast); const s = histFuture.pop(); histLast = s; applySnap(s); updateUndoButtons(); }
function updateUndoButtons(){ const u = $('#undo'), r = $('#redo'); if(u) u.disabled = !histPast.length; if(r) r.disabled = !histFuture.length; }
function restore(){
  try { const s = JSON.parse(localStorage.getItem(LS) || 'null');
    if(s && Array.isArray(s.nodes)) graph = { nodes: s.nodes, edges: Array.isArray(s.edges) ? s.edges : [] };
  } catch(_){}
}
// масштаб холста (только уменьшение — чтобы увидеть больше узлов; скролл полотна остаётся рабочим)
let zoom = 1;
function setZoom(z){
  zoom = Math.max(0.4, Math.min(1, Math.round(z * 20) / 20));
  canvas.style.transformOrigin = '0 0';
  canvas.style.transform = 'scale(' + zoom + ')';
  const lbl = document.getElementById('zoomLbl'); if(lbl) lbl.textContent = Math.round(zoom * 100) + '%';
}
const byId = id => graph.nodes.find(n => n.id === id);
function nodeLabel(nd){ const b = BLOCKS[nd.blockId]; return nd.title || (b.labelFn ? b.labelFn(nd.fields) : b.label); }
function nodeCode(nd){ const b = BLOCKS[nd.blockId]; const c = b.code(nd.fields); return b.type === 'container' ? (c.open + '\n' + c.close) : String(c); }
function nodePreview(nd){ const l = nodeCode(nd).split('\n')[0] || ''; return l.length > 36 ? l.slice(0, 36) + '…' : l; }
function kindClass(nd){ const b = BLOCKS[nd.blockId]; return b.type === 'draw' ? 'draw' : b.type === 'container' ? 'container' : 'leaf'; }

// ── таксономия как в каталоге: назначение → подкатегория ─────────────────────
const PURPOSE = [
  ['Интерфейс', ['dom','форм','ввод','кнопк','таблиц','карточк','модал','меню','уведомл','поиск','canvas','цвет','анимац','стил','css','верстк','grid','flex','клик','наведен','ползун','slider','рисов','отрисов','svg','экран','курсор','градиент','частиц']],
  ['Работа с данными', ['массив','объект','словар','строк','crud','база','sql','хранилищ','localstorage','кэш','миграц','импорт','экспорт','модел','схем','сохран','reduce','.map','filter','сортиров','фильтр','очеред','стек','дек','множеств']],
  ['Интеграции', ['fetch','api','http','rest','запрос','вебхук','webhook','почт','платеж','сторонн','таймаут','прокси','cors','moex','гир бо']],
  ['Файлы и документы', ['csv','xlsx','excel','pdf','docx','sheetjs','mammoth','разбор файл','чтение файл']],
  ['Автоматизация', ['расписан','планировщ','фонов','периодическ','cron','setinterval','пакет','батч','batch']],
  ['Диагностика и тестирование', ['тест','логир','ошибк','трассиров','монитор','debug','отладк','исключ','assert']],
  ['Запуск и инфраструктура', ['сервер','запуск','конфиг','зависимост','сборк','контейнер','env','порт','node','flask','маршрут','роут','модул','импорт','export']],
];
const PORDER = ['Интеграции','Файлы и документы','Автоматизация','Диагностика и тестирование','Запуск и инфраструктура','Интерфейс','Работа с данными'];
const SUBCATS = {
  'Интерфейс':[['Формы и ввод',['форм','input','ввод','checkbox','select','ползун','range','поле','type=']],['Таблицы и списки',['таблиц','tbody','список строк']],['Рисование (Canvas/SVG)',['canvas','svg','рисов','градиент','fillrect','filltext','arc','lineto','moveto','drawimage','кадр','частиц','clearrect','столбик']],['Цвета',['цвет','hsl','rgba','gradient','палитр']],['Анимация и время',['анимац','requestanimationframe','время']],['События',['событ','клик','keydown','keyup','клавиш','мыш','наведен','курсор']],['DOM-элементы',['dom','queryselector','createelement','classlist','setattribute','textcontent','innerhtml','style','append','надпис']]],
  'Работа с данными':[['Массивы и объекты',['массив','объект','map','reduce','filter','foreach']],['Строки',['строк','split','replace','join']],['Хранилище',['localstorage','хранилищ','кэш','setitem','сохран']],['База и CRUD',['crud','база','добав','найд','удал']],['Сортировка и фильтры',['сортиров','фильтр','sort']],['Структуры',['стек','очеред','дек','множеств','set']],['Основы',['переменн','услови','цикл','функц','тип','ветвлен','switch','break','continue','return']]],
  'Интеграции':[['HTTP-запросы',['fetch','http','запрос','анатом']],['Разбор ответа',['парсер','columns','разбор','ответ api']],['Прокси и CORS',['прокси','cors']],['Цепочки и параллельно',['цепочк','promise','await','параллель']]],
  'Файлы и документы':[['CSV',['csv']],['Excel',['xlsx','excel','sheetjs']],['Разбор',['парсер','разбор','parse']]],
  'Автоматизация':[['Таймеры',['таймер','интервал','setinterval']],['Планировщик',['расписан','планировщ','cron']],['Пакетная обработка',['пакет','батч','batch']]],
  'Диагностика и тестирование':[['Ошибки',['ошибк','try','catch','исключ']],['Логи',['лог','console']],['Тесты',['тест']],['Отладка',['отладк','debug','трассиров']]],
  'Запуск и инфраструктура':[['Серверы',['сервер','node','flask','порт']],['Маршруты',['маршрут','роут']],['Модули и импорты',['модул','импорт','export','файл']],['Конфигурация',['конфиг','env','сборк','зависимост']]],
};
function thay(t){ return ((t.group||'')+' '+(t.title||'')+' '+(t.desc||'')).toLowerCase(); }
function purposeOf(t){ if(t.comp && t.comp.tags && t.comp.tags.purpose && t.comp.tags.purpose.length) return t.comp.tags.purpose[0]; const h = thay(t); for(const key of PORDER){ const P = PURPOSE.find(x=>x[0]===key); if(P[1].some(w=>h.includes(w))) return key; } return 'Работа с данными'; }
function subOf(t, pk){ if(t.comp && t.comp.subcat) return t.comp.subcat; const defs = SUBCATS[pk]||[]; const h = thay(t); for(const [name,kws] of defs){ if(kws.some(w=>h.includes(w))) return name; } return 'Разное'; }

// ── палитра: Базовые блоки + компоненты каталога по иерархии назначений ───────
let CATALOG = [];
async function loadCatalog(){ try { CATALOG = await fetch('/api/list').then(r => r.json()); } catch(_){ CATALOG = []; } renderPalette(); }
function palDetails(title, count, open){
  const d = document.createElement('details'); d.className = 'pal-d'; if(open) d.open = true;
  const s = document.createElement('summary'); s.innerHTML = '<span>' + esc(title) + '</span><span class="pal-n">' + count + '</span>'; d.appendChild(s); return d;
}
function palItem(title, hint){ const it = el('div', 'pal-item2'); it.appendChild(el('span', 'pi-t', title)); if(hint) it.title = hint; return it; }
function renderPalette(){
  const host = $('#palList'); host.innerHTML = '';
  const q = ($('#palSearch').value || '').toLowerCase();
  // базовые блоки (со структурными полями)
  const base = Object.entries(BLOCKS).filter(([id, b]) => !q || (b.label + ' ' + (b.hint || '')).toLowerCase().includes(q));
  if(base.length){
    const d = palDetails('Базовые блоки', base.length, !!q || !CATALOG.length);
    base.forEach(([id, b]) => { const it = palItem(b.label, b.hint); it.onclick = () => addNode(id); d.appendChild(it); });
    host.appendChild(d);
  }
  // каталог по назначению → подкатегория
  const js = CATALOG.filter(t => (t.lang || 'js') === 'js').filter(t => !q || (t.title + ' ' + (t.desc || '')).toLowerCase().includes(q));
  const byP = {}; js.forEach(t => { const p = purposeOf(t); (byP[p] = byP[p] || []).push(t); });
  PURPOSE.map(x => x[0]).forEach(pk => {
    const items = byP[pk]; if(!items || !items.length) return;
    const d = palDetails(pk, items.length, !!q);
    const bySub = {}; items.forEach(t => { const s = subOf(t, pk); (bySub[s] = bySub[s] || []).push(t); });
    const order = (SUBCATS[pk] || []).map(x => x[0]).concat(['Разное']);
    Object.keys(bySub).sort((a, b) => { const ia = order.indexOf(a), ib = order.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); }).forEach(sub => {
      d.appendChild(el('div', 'pal-sub', sub + ' · ' + bySub[sub].length));
      bySub[sub].forEach(t => {
        const it = palItem(t.title, t.desc); it.onclick = () => addFromCatalog(t);
        // удалить шаблон прямо из палитры (на случай дублей/переименований)
        const del = el('span', 'pi-del', '🗑'); del.title = 'удалить шаблон насовсем';
        del.onclick = e => { e.stopPropagation(); delTemplate(t); };
        it.appendChild(del);
        d.appendChild(it);
      });
    });
    host.appendChild(d);
  });
}
async function delTemplate(t){
  if(!confirm('Удалить шаблон «' + (t.title || t.id) + '» насовсем? Файл будет удалён.')) return;
  const r = await fetch('/api/delete', { method:'POST', body: JSON.stringify({ id: t.id }) }).then(r => r.json()).catch(() => ({}));
  if(r && r.ok) loadCatalog(); else alert('не вышло удалить');
}
async function addFromCatalog(t){
  try {
    const tpl = await fetch('/api/template?id=' + encodeURIComponent(t.id)).then(r => r.json());
    const code = (tpl.lines || []).map(line => (line || []).map(k => k.v != null ? k.v : '').join('')).join('\n');
    // запоминаем, из какого шаблона узел + когда взято описание (для авто-сведения по дате)
    addNode('raw', { fields: { code }, title: t.title, desc: tpl.desc || '', descAt: tpl.descAt || 0, src: { id: t.id, title: t.title, desc: tpl.desc || '', code } });
  } catch(_){}
}
$('#palSearch').oninput = renderPalette;
// «свести описания» — авто-сведение по дате, массово по всем узлам из каталога
(function(){ const btn = $('#reconcile'); if(!btn) return; btn.onclick = async () => {
  btn.disabled = true; const o = btn.textContent; btn.textContent = 'свожу…';
  const r = await reconcileByDate();
  btn.textContent = r.groupsN ? ('✓ узлов ' + r.nodeChanges + ' · шаблонов ' + r.tplChanges) : 'нечего сводить';
  setTimeout(() => { btn.textContent = o; btn.disabled = false; }, 2000);
}; })();

function makeNode(blockId, extra){
  const b = BLOCKS[blockId]; const fields = {}; (b.fields || []).forEach(f => fields[f.k] = f.def);
  return Object.assign({ id: uid(), blockId, fields, x: 80, y: 60 }, extra);
}
function spawnPos(){
  // каскад, чтобы новые не ложились друг на друга; с учётом прокрутки
  const sc = $('.canvas-scroll');
  const n = graph.nodes.length;
  return { x: (sc ? sc.scrollLeft : 0) + 40 + (n % 6) * 30, y: (sc ? sc.scrollTop : 0) + 40 + (n % 6) * 30 };
}
function addNode(blockId, extra){
  const p = spawnPos();
  const nd = makeNode(blockId, Object.assign({ x: p.x, y: p.y }, extra || {}));
  graph.nodes.push(nd); renderCanvas(); select(nd); persist(); renderCode();
  return nd;
}

// ── холст ─────────────────────────────────────────────────────────────────────
function renderCanvas(){
  canvas.querySelectorAll('.gnode').forEach(el => el.remove());
  graph.nodes.forEach(nd => canvas.appendChild(nodeEl(nd)));
  $('#emptyHint').style.display = graph.nodes.length ? 'none' : 'block';
  drawEdges(); markNeeds();
}
function nodeEl(nd){
  const el = document.createElement('div');
  el.className = 'gnode ' + kindClass(nd) + (nd.id === selectedId ? ' sel' : '');
  el.dataset.id = nd.id; el.style.left = nd.x + 'px'; el.style.top = nd.y + 'px';
  const pin = document.createElement('div'); pin.className = 'port in'; pin.dataset.id = nd.id;
  const pout = document.createElement('div'); pout.className = 'port out'; pout.dataset.id = nd.id;
  const head = document.createElement('div'); head.className = 'gnode-head';
  const title = document.createElement('span'); title.className = 'gnode-title'; title.textContent = nodeLabel(nd);
  const del = document.createElement('button'); del.className = 'gnode-del'; del.textContent = '×'; del.title = 'удалить';
  del.onclick = e => { e.stopPropagation(); removeNode(nd.id); };
  head.append(title, del);
  const prev = document.createElement('div'); prev.className = 'gnode-prev'; prev.textContent = nodePreview(nd);
  el.append(pin, head, prev, pout);
  headDrag(head, el, nd);
  portConnect(pout, nd);
  return el;
}

// перетаскивание узла за шапку; без сдвига — это выбор
function headDrag(head, el, nd){
  head.addEventListener('pointerdown', e => {
    if(e.target.classList.contains('gnode-del')) return;
    e.preventDefault(); head.setPointerCapture(e.pointerId);
    // если тащим узел из группы — двигаем всю группу
    const groupIds = (multi.has(nd.id) && multi.size > 1) ? [...multi] : [nd.id];
    const starts = groupIds.map(id => { const n = byId(id); return n ? { n, x: n.x, y: n.y } : null; }).filter(Boolean);
    const sx = e.clientX, sy = e.clientY; let moved = false;
    const mv = ev => {
      const dx = (ev.clientX - sx) / zoom, dy = (ev.clientY - sy) / zoom;
      if(!moved && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 3) moved = true;
      if(moved){ starts.forEach(s => { s.n.x = Math.max(0, s.x + dx); s.n.y = Math.max(0, s.y + dy); const elm = canvas.querySelector('.gnode[data-id="' + cssEsc(s.n.id) + '"]'); if(elm){ elm.style.left = s.n.x + 'px'; elm.style.top = s.n.y + 'px'; } }); drawEdges(); }
    };
    const up = ev => {
      head.releasePointerCapture(e.pointerId);
      head.removeEventListener('pointermove', mv); head.removeEventListener('pointerup', up);
      if(moved){ persist(); }
      else if(ev.shiftKey){ if(multi.has(nd.id)) multi.delete(nd.id); else multi.add(nd.id); selectedId = nd.id; markSel(); renderInspector(nd); persist(); }
      else { multi.clear(); select(nd); }
    };
    head.addEventListener('pointermove', mv); head.addEventListener('pointerup', up);
  });
}

// протянуть связь от выхода к входу другого узла
let connecting = null;
function portConnect(pout, nd){
  pout.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    connecting = { from: nd.id };
    const tmp = document.createElementNS('http://www.w3.org/2000/svg', 'path'); tmp.setAttribute('class', 'tmp'); edgesSvg.appendChild(tmp);
    const cr = () => canvas.getBoundingClientRect();
    const start = portXY(nd.id, 'out');
    const mv = ev => {
      const r = cr(); const x2 = (ev.clientX - r.left) / zoom, y2 = (ev.clientY - r.top) / zoom;
      tmp.setAttribute('d', bez(start.x, start.y, x2, y2));
      const hot = document.elementFromPoint(ev.clientX, ev.clientY);
      document.querySelectorAll('.port.in.hot').forEach(p => p.classList.remove('hot'));
      if(hot && hot.classList.contains('in')) hot.classList.add('hot');
    };
    const up = ev => {
      document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up);
      tmp.remove(); document.querySelectorAll('.port.in.hot').forEach(p => p.classList.remove('hot'));
      const t = document.elementFromPoint(ev.clientX, ev.clientY);
      if(t && t.classList.contains('in') && t.dataset.id && t.dataset.id !== nd.id) addEdge(nd.id, t.dataset.id);
      connecting = null;
    };
    document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up);
  });
}
let edgeMessageTimer = null;
function showEdgeMessage(text, level){
  let box = $('#edgeMessage');
  if(!box){
    box = el('div','edge-message'); box.id='edgeMessage';
    document.body.appendChild(box);
  }
  box.className = 'edge-message ' + (level || 'ok');
  box.textContent = text;
  box.style.display = 'block';
  clearTimeout(edgeMessageTimer);
  edgeMessageTimer = setTimeout(() => { box.style.display = 'none'; }, 4200);
}
function addEdge(from, to){
  if(graph.edges.some(e => e.from === from && e.to === to)) return;
  const a = byId(from), b = byId(to);
  if(!a || !b) return;
  const result = edgeExplanation(a, b);
  // Связь не запрещаем — собирать схему можно в любом порядке. Если типы не
  // сходятся, связь всё равно создаётся, но с предупреждением; узел-получатель
  // остаётся помеченным «нужен вход», пока вход реально не подойдёт.
  graph.edges = graph.edges.filter(e => e.to !== to);
  graph.edges.push({ from, to });
  if(!result.ok){ try { bindEdge(a, b); } catch(_){} }   // всё равно пробуем подставить имя
  drawEdges(); persist(); renderCode(); renderInspector(b); markNeeds();
  showEdgeMessage(result.ok ? result.text : ('⚠ ' + result.reason + ' Связь создана — проверь вход.'), result.ok ? (result.level === 'info' ? 'warn' : 'ok') : 'warn');
}
function removeNode(id){
  graph.nodes = graph.nodes.filter(n => n.id !== id);
  graph.edges = graph.edges.filter(e => e.from !== id && e.to !== id);
  if(selectedId === id){ selectedId = null; renderInspector(); }
  renderCanvas(); persist(); renderCode();
}

// координаты порта узла (в системе холста) по его DOM-элементу
function portXY(id, which){
  const el = canvas.querySelector('.gnode[data-id="' + cssEsc(id) + '"]'); if(!el) return { x: 0, y: 0 };
  const x = el.offsetLeft + el.offsetWidth / 2;
  const y = which === 'out' ? el.offsetTop + el.offsetHeight : el.offsetTop;
  return { x, y };
}
function bez(x1, y1, x2, y2){ const dy = Math.max(30, Math.abs(y2 - y1) / 2); return 'M ' + x1 + ' ' + y1 + ' C ' + x1 + ' ' + (y1 + dy) + ' ' + x2 + ' ' + (y2 - dy) + ' ' + x2 + ' ' + y2; }
let selectedEdge = null;   // {from,to} выбранной связи для удаления
function sameEdge(a, b){ return a && b && a.from === b.from && a.to === b.to; }
function removeEdge(ed){
  graph.edges = graph.edges.filter(e => !(e.from === ed.from && e.to === ed.to));
  if(sameEdge(selectedEdge, ed)) selectedEdge = null;
  drawEdges(); persist(); renderCode(); markNeeds();
  showEdgeMessage('Связь удалена.', 'ok');
}
function drawEdges(){
  edgesSvg.querySelectorAll('path:not(.tmp), .edge-hit').forEach(p => p.remove());
  graph.edges.forEach(e => {
    if(!byId(e.from) || !byId(e.to)) return;
    const a = portXY(e.from, 'out'), b = portXY(e.to, 'in'); const d = bez(a.x, a.y, b.x, b.y);
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', d);
    if(sameEdge(selectedEdge, e)) p.setAttribute('class', 'sel');
    // широкая прозрачная дорожка сверху — чтобы по тонкой стрелке было легко попасть
    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path'); hit.setAttribute('d', d); hit.setAttribute('class', 'edge-hit');
    hit.addEventListener('pointerdown', ev => { ev.stopPropagation(); selectedEdge = { from: e.from, to: e.to }; selectedId = null; markSel(); renderInspector(); drawEdges(); showEdgeMessage('Связь выбрана. Delete или двойной клик — удалить.', 'warn'); });
    hit.addEventListener('dblclick', ev => { ev.stopPropagation(); removeEdge({ from: e.from, to: e.to }); });
    edgesSvg.appendChild(p); edgesSvg.appendChild(hit);
  });
}
// по пустому месту левой кнопкой — рамка выделения; с пробелом — это панорама
canvas.addEventListener('pointerdown', e => {
  if(e.button !== 0 || spaceHeld) return;
  if(!(e.target === canvas || e.target === edgesSvg)) return;
  selectedId = null; selectedEdge = null; multi.clear(); markSel(); renderInspector(); drawEdges();
  const rect = canvas.getBoundingClientRect();
  const sx = (e.clientX - rect.left) / zoom, sy = (e.clientY - rect.top) / zoom;
  const box = el('div', 'sel-box'); canvas.appendChild(box);
  const mv = ev => {
    const x = (ev.clientX - rect.left) / zoom, y = (ev.clientY - rect.top) / zoom;
    const l = Math.min(sx, x), t = Math.min(sy, y), w = Math.abs(x - sx), h = Math.abs(y - sy);
    box.style.left = l + 'px'; box.style.top = t + 'px'; box.style.width = w + 'px'; box.style.height = h + 'px';
    multi.clear();
    graph.nodes.forEach(n => {
      const elm = canvas.querySelector('.gnode[data-id="' + cssEsc(n.id) + '"]');
      const nw = elm ? elm.offsetWidth : 190, nh = elm ? elm.offsetHeight : 70;
      if(n.x < l + w && n.x + nw > l && n.y < t + h && n.y + nh > t) multi.add(n.id);
    });
    markSel();
  };
  const up = () => {
    document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); box.remove();
    if(multi.size === 1){ selectedId = [...multi][0]; multi.clear(); renderInspector(byId(selectedId)); }
    markSel();
  };
  document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up);
});
// Delete/Backspace — удалить выбранную связь, иначе выбранный узел (если не печатаем в поле)
document.addEventListener('keydown', e => {
  if(e.key !== 'Delete' && e.key !== 'Backspace') return;
  const ae = document.activeElement; if(ae && /INPUT|TEXTAREA|SELECT/.test(ae.tagName)) return;
  if(multi.size){ e.preventDefault(); const ids = [...multi]; graph.nodes = graph.nodes.filter(n => !multi.has(n.id)); graph.edges = graph.edges.filter(ed => !multi.has(ed.from) && !multi.has(ed.to)); multi.clear(); selectedId = null; renderCanvas(); renderInspector(); renderCode(); persist(); return; }
  if(selectedEdge){ e.preventDefault(); removeEdge(selectedEdge); return; }
  if(!selectedId) return;
  e.preventDefault(); removeNode(selectedId);
});

// ── инспектор ─────────────────────────────────────────────────────────────────
let spaceHeld = false;
const multi = new Set();   // множественное выделение узлов
function select(nd){ selectedId = nd.id; markSel(); renderInspector(nd); persist(); }
function markSel(){ canvas.querySelectorAll('.gnode').forEach(el => el.classList.toggle('sel', el.dataset.id === selectedId || multi.has(el.dataset.id))); }
function updateCard(nd){
  const el = canvas.querySelector('.gnode[data-id="' + cssEsc(nd.id) + '"]'); if(!el) return;
  el.querySelector('.gnode-title').textContent = nodeLabel(nd);
  el.querySelector('.gnode-prev').textContent = nodePreview(nd);
  drawEdges(); markNeeds();
}
function renderInspector(nd){
  const host = $('#inspector'); if(!host) return;
  nd = nd || (selectedId ? byId(selectedId) : null);
  if(!nd){ host.innerHTML = '<div class="insp-body"><div class="insp-empty">Выбери узел на холсте — здесь его поля (Настроить), подсказка (Разобраться) и объяснение с кодом (Объяснить).<br><br>Пусто? Слева выбери компонент.</div></div>'; return; }
  const b = BLOCKS[nd.blockId];
  host.innerHTML = '';
  const head = document.createElement('div'); head.className = 'insp-head';
  [['set','Настроить'],['learn','Разобраться'],['why','Объяснить']].forEach(([k, lbl]) => {
    const btn = document.createElement('button'); btn.textContent = lbl; if(k === inspTab) btn.classList.add('on');
    btn.onclick = () => { inspTab = k; renderInspector(nd); };
    head.appendChild(btn);
  });
  host.appendChild(head);
  const body = document.createElement('div'); body.className = 'insp-body';
  const titleEl = el('div', 'insp-title', nodeLabel(nd)); body.appendChild(titleEl);
  body.appendChild(el('div', 'insp-kind', b.type === 'draw' ? 'рисование' : 'компонент'));
  body.appendChild(renderBlockContract(nd, b));
  const save = el('button', 'insp-save', '💾 сохранить в каталог'); save.title = 'добавить этот кусок в каталог как компонент'; save.onclick = () => saveToCatalog(nd); body.appendChild(save);
  if(inspTab === 'set'){ body.appendChild(nodeMetaEditor(nd, titleEl)); body.appendChild(inspFields(nd, b)); }
  else if(inspTab === 'learn') body.appendChild(descEditor(nd, b));
  else body.appendChild(inspWhy(nd, b));
  host.appendChild(body);
}

function renderBlockContract(nd, b){
  const guide = BLOCK_GUIDES[nd.blockId] || {
    input:'Определяется кодом блока',
    output:'Определяется кодом блока',
    needs:['Открой «Объяснить» и проверь код, переменные и окружение перед запуском.'],
    risks:['Для этого блока пока нет подробной автоматической проверки требований.']
  };
  const box = el('section', 'block-contract');
  const top = el('div', 'bc-io');
  const input = el('div', 'bc-side');
  input.append(el('span','bc-label','ПОЛУЧАЕТ'), el('span','bc-value',guide.input));
  const arrow = el('div','bc-arrow','→');
  const output = el('div','bc-side');
  output.append(el('span','bc-label','ДАЁТ'), el('span','bc-value',guide.output));
  top.append(input,arrow,output); box.appendChild(top);
  const checks = validateBlockSetup(nd, guide);
  const status = el('div', 'bc-status ' + (checks.length ? 'needs-work' : 'ready'));
  status.textContent = checks.length ? `Перед запуском проверь: ${checks.length} пункт(а)` : 'Базовые требования по шаблону отмечены';
  box.appendChild(status);
  const needs = el('div','bc-section');
  needs.appendChild(el('div','bc-heading','Что нужно'));
  const ul = document.createElement('ul');
  guide.needs.forEach(x => ul.appendChild(el('li','',x)));
  checks.forEach(x => { const li=el('li','bc-alert',x); ul.appendChild(li); });
  needs.appendChild(ul); box.appendChild(needs);
  const depStatus=dependencyStatus(document,currentCode());
  if(depStatus.ready.length||depStatus.missing.length||depStatus.manual.length){
    const depBox=el('div','bc-section'); depBox.appendChild(el('div','bc-heading','Зависимости'));
    const ul=document.createElement('ul');
    depStatus.ready.forEach(d=>ul.appendChild(el('li','',`✓ ${d.name} — доступна.`)));
    depStatus.missing.forEach(d=>ul.appendChild(el('li','bc-alert',`⛔ ${d.name} — не подключена. ${dependencyAdvice(d)}`)));
    depStatus.manual.forEach(d=>ul.appendChild(el('li','bc-alert',`⚠ ${d.name} — требуется ESM/npm. ${dependencyAdvice(d)}`)));
    depBox.appendChild(ul); box.appendChild(depBox);
  }
  if(guide.risks && guide.risks.length){
    const det = document.createElement('details'); det.className='bc-details';
    const sum = document.createElement('summary'); sum.textContent='Возможные ошибки и ограничения'; det.appendChild(sum);
    const riskList = document.createElement('ul');
    guide.risks.forEach(x => riskList.appendChild(el('li','',x)));
    det.appendChild(riskList); box.appendChild(det);
  }
  return box;
}
function compatibleBlockTypes(nd){
  const labels=[];
  Object.keys(BLOCK_CONTRACTS).forEach(id=>{
    if(id===nd.blockId) return;
    const candidate={blockId:id,fields:{}};
    const c=BLOCK_CONTRACTS[id];
    if(!c || c.input==null) return;
    if(edgeCheck(nd,candidate).ok) labels.push(BLOCKS[id] ? BLOCKS[id].label : id);
  });
  return labels;
}
function validateBlockSetup(nd, guide){
  const out=[]; const f=nd.fields||{}; const ordered=orderedNodes();
  const idx=ordered.findIndex(n=>n.id===nd.id); const prior=ordered.slice(0,idx<0?ordered.length:idx);
  const priorCode=prior.map(nodeCode).join('\n'); const defined=buildSymbols(priorCode); const c=blockContract(nd);

  connectedIncoming(nd).forEach(src=>{ const result=edgeCheck(src,nd); if(!result.ok || result.level==='info') out.push(result.reason); });

  const checkIdentifierField=(field,label=field)=>{
    const value=String(f[field]||'').trim();
    if(value && IDENTIFIER_RE.test(value) && !defined.has(value)) out.push(`Не найдено объявление переменной «${value}» — добавь совместимый блок выше или исправь поле «${label}».`);
  };
  if(c.inputField && c.inputMode!=='expression' && c.inputMode!=='free') checkIdentifierField(c.inputField);
  if(['map','filter','reduce'].includes(nd.blockId) && f.list) checkIdentifierField('list');
  if(nd.blockId==='log'){
    const value=String(f.value||'').trim();
    if(IDENTIFIER_RE.test(value) && !defined.has(value)) out.push(`Переменная «${value}» не найдена среди объявлений в текущей сборке.`);
  }
  if(nd.blockId==='calc'){
    const expr=String(f.expr||'');
    for(const m of expr.matchAll(/[\p{ID_Start}_$][\p{ID_Continue}_$]*/gu)){
      const word=m[0];
      if(['Math','true','false','null','undefined','NaN','Infinity'].includes(word) || defined.has(word)) continue;
      if(word==='length') continue;
      if(!out.some(x=>x.includes(`«${word}»`))) out.push(`Переменная «${word}» в формуле может быть не объявлена.`);
    }
  }
  if(c.dom) c.dom.forEach(id=>{ const selector='#'+id; if(!runtimeState.checkedAt) out.push(`Среда запуска должна содержать DOM-элемент ${selector}.`); else if(runtimeState.errors.some(x=>x.includes(`«${selector}»`))) out.push(`Среда запуска не содержит ${selector}.`); });
  if(c.async && !prior.concat([nd]).some(n=>/\bawait\b/.test(nodeCode(n)))) out.push('Блок использует async/await: при запуске он должен находиться в async-контексте.');
  const targets=compatibleBlockTypes(nd);
  if(c.output && c.output!=='void' && !c.unknown) out.push(targets.length ? `Подходящие типы блоков для соединения: ${targets.join(', ')}.` : 'Для этого результата пока нет блока с подтверждённо совместимым входом.');
  return [...new Set(out)];
}


function inspFields(nd, b){
  if(nd.blockId === 'raw') return rawInspFields(nd);   // у «своего кода» — поля по переменным + весь код
  if(!(b.fields || []).length) return el('div', 'insp-text', 'нет настроек.');
  const box = document.createElement('div');
  (b.fields || []).forEach(f => {
    const row = el('div', 'insp-field'); row.appendChild(el('label', '', f.k));
    if(f.multi){
      const ta = document.createElement('textarea'); ta.className = 'blk-code'; ta.spellcheck = false; ta.value = nd.fields[f.k];
      ta.rows = Math.min(16, String(nd.fields[f.k]).split('\n').length + 1);
      ta.addEventListener('input', () => { nd.fields[f.k] = ta.value; updateCard(nd); renderCode(); persist(); });
      row.appendChild(attachHighlight(ta));
    } else {
      const inp = document.createElement('input'); inp.value = nd.fields[f.k]; inp.spellcheck = false;
      inp.addEventListener('input', () => { nd.fields[f.k] = inp.value; updateCard(nd); renderCode(); persist(); });
      row.appendChild(inp);
    }
    box.appendChild(row);
  });
  return box;
}
// «Настроить» для своего кода: понятные поля по строкам `имя = значение;`
// (значения правятся прямо отсюда) + весь код в раскрывашке.
const VAR_RE = /^(\s*(?:const|let|var)\s+([A-Za-zА-Яа-яЁё_$][\wА-Яа-яЁё$]*)\s*=\s*)(.+);\s*$/;
function rawVars(code){ const out = []; String(code).split('\n').forEach((ln, i) => { const m = ln.match(VAR_RE); if(m) out.push({ i, name: m[2], value: m[3] }); }); return out; }
function setVar(nd, name, val){
  const lines = String(nd.fields.code || '').split('\n');
  for(let i = 0; i < lines.length; i++){ const m = lines[i].match(VAR_RE); if(m && m[2] === name){ lines[i] = m[1] + val + ';'; break; } }
  nd.fields.code = lines.join('\n');
}
function rawInspFields(nd){
  const box = document.createElement('div');
  const vars = rawVars(nd.fields.code);
  if(vars.length){
    const note = el('div', 'insp-kind', 'что можно поменять'); note.style.marginBottom = '6px'; box.appendChild(note);
    vars.forEach(v => {
      const row = el('div', 'insp-field'); row.appendChild(el('label', '', v.name));
      const inp = document.createElement('input'); inp.value = v.value; inp.spellcheck = false;
      inp.addEventListener('input', () => { setVar(nd, v.name, inp.value); updateCard(nd); renderCode(); persist(); });
      row.appendChild(inp); box.appendChild(row);
    });
  } else {
    box.appendChild(el('div', 'insp-text', 'Готовых полей тут нет — весь код ниже можно править целиком.'));
  }
  // весь код — в раскрывашке (или сразу, если полей нет)
  const det = document.createElement('details'); det.style.marginTop = '8px'; if(!vars.length) det.open = true;
  const sum = document.createElement('summary'); sum.textContent = 'весь код'; sum.style.cssText = 'cursor:pointer;color:var(--text3);font-size:12px;margin-bottom:6px'; det.appendChild(sum);
  const ta = document.createElement('textarea'); ta.className = 'blk-code'; ta.spellcheck = false; ta.value = nd.fields.code;
  ta.rows = Math.min(18, String(nd.fields.code).split('\n').length + 1);
  ta.addEventListener('input', () => { nd.fields.code = ta.value; updateCard(nd); renderCode(); persist(); });
  det.appendChild(attachHighlight(ta));
  box.appendChild(det);
  return box;
}

// узел отличается от своего шаблона?
function nodeDirty(nd){
  if(!nd.src) return false;
  return nodeLabel(nd) !== nd.src.title || (nd.desc || '') !== (nd.src.desc || '') || String(nd.fields && nd.fields.code || '') !== String(nd.src.code || '');
}
// описание узла: пишется и сразу видно здесь же, во вкладке «Разобраться»
function descEditor(nd, b){
  const box = document.createElement('div');
  box.appendChild(el('div', 'insp-kind', 'описание — своими словами, сохраняется сразу'));
  const ta = document.createElement('textarea'); ta.className = 'insp-desc'; ta.spellcheck = false; ta.value = nd.desc || '';
  ta.placeholder = 'что это и зачем — чтобы не забыть. `код` в кавычках — цветная плашка';
  const prev = el('div', 'desc-prev');
  const draw = () => { const v = ta.value.trim() ? descFmt(ta.value) : (b && b.hint ? descFmt(b.hint) + '<div class="desc-hint" style="margin-top:6px">↑ пока показана встроенная подсказка. Впиши своё описание — заменит её.</div>' : '<span class="muted">пока пусто</span>'); prev.innerHTML = v; };

  // блок сведения описаний: узел в схеме ⇄ шаблон в каталоге
  const sync = el('div', 'desc-sync');
  // актуальное описание шаблона берём из свежего списка каталога (а не из снимка при добавлении)
  const tplDesc = () => { if(!nd.src) return ''; const t = (CATALOG || []).find(x => x.id === nd.src.id); return t ? (t.desc || '') : (nd.src.desc || ''); };
  const drawSync = () => {
    sync.innerHTML = ''; if(!nd.src){ sync.style.display = 'none'; return; }
    sync.style.display = '';
    const here = nd.desc || '', there = tplDesc();
    sync.appendChild(el('div', 'desc-sync-h', 'Сведение с каталогом · шаблон «' + nd.src.title + '»'));
    if(here === there){ sync.appendChild(el('div', 'desc-hint', '✓ Описание узла и шаблона в каталоге совпадают.')); return; }
    sync.appendChild(el('div', 'desc-hint', 'Сейчас расходятся. В каталоге:'));
    const box2 = el('div', 'desc-prev'); box2.style.margin = '2px 0 4px'; box2.innerHTML = there.trim() ? descFmt(there) : '<span class="muted">пусто</span>'; sync.appendChild(box2);
    const row = el('div', 'desc-sync-btns');
    const up = el('button', 'btn', '↑ записать моё в шаблон'); up.type = 'button';
    up.onclick = async () => {
      up.textContent = 'сохраняю…'; up.disabled = true;
      const r = await fetch('/api/edit', { method:'POST', body: JSON.stringify({ id: nd.src.id, desc: here, descAt: nd.descAt || Date.now() }) }).then(r => r.json()).catch(() => ({}));
      if(r && r.ok){ nd.src.desc = here; persist(); await loadCatalog(); drawSync(); } else { up.textContent = 'не вышло, ещё раз'; up.disabled = false; }
    };
    const down = el('button', 'btn', '↓ взять из каталога'); down.type = 'button';
    down.onclick = () => { const t = (CATALOG || []).find(x => x.id === nd.src.id); ta.value = there; nd.desc = there; nd.descAt = (t && t.descAt) || 0; nd.src.desc = there; persist(); draw(); drawSync(); };
    row.append(up, down); sync.appendChild(row);
  };
  ta.addEventListener('input', () => { nd.desc = ta.value; nd.descAt = Date.now(); persist(); draw(); drawSync(); });
  box.appendChild(ta);
  const tools = el('div', 'desc-tools');
  const chip = el('button', 'btn', '⟨⟩ код в плашку'); chip.type = 'button'; chip.onclick = () => { wrapBackticks(ta); nd.desc = ta.value; nd.descAt = Date.now(); persist(); draw(); drawSync(); };
  tools.appendChild(chip); tools.appendChild(el('span', 'desc-hint', '`код` — плашка, блок — в тройных ```'));
  box.appendChild(tools);
  box.appendChild(el('div', 'desc-prev-h', 'как выглядит'));
  box.appendChild(prev);
  box.appendChild(sync);
  draw(); drawSync();
  return box;
}
// авто-сведение описаний по дате: для каждого шаблона берём самое свежее описание
// (среди самого шаблона и всех его узлов на холсте) и раскатываем на всех
async function reconcileByDate(){
  const groups = {};
  graph.nodes.forEach(nd => { if(nd.src && nd.src.id) (groups[nd.src.id] = groups[nd.src.id] || []).push(nd); });
  let nodeChanges = 0, tplChanges = 0, groupsN = 0;
  for(const id of Object.keys(groups)){
    const t = (CATALOG || []).find(x => x.id === id); if(!t) continue;
    groupsN++;
    const nodes = groups[id];
    // кандидаты: шаблон + каждый узел; у каждого — описание и его дата
    const cand = [{ desc: t.desc || '', at: t.descAt || 0, tpl: true }];
    nodes.forEach(nd => cand.push({ desc: nd.desc || '', at: nd.descAt || 0 }));
    let win = cand[0];
    cand.forEach(c => { if(c.at > win.at) win = c; });   // самое новое; при равенстве остаётся шаблон
    if(cand.every(c => c.desc === win.desc)) continue;   // уже всё одинаковое
    nodes.forEach(nd => { if((nd.desc || '') !== win.desc){ nd.desc = win.desc; nodeChanges++; } nd.descAt = win.at; nd.src.desc = win.desc; });
    if((t.desc || '') !== win.desc){
      await fetch('/api/edit', { method:'POST', body: JSON.stringify({ id, desc: win.desc, descAt: win.at }) }).then(r => r.json()).catch(() => ({}));
      tplChanges++;
    }
  }
  persist(); await loadCatalog(); renderInspector();
  return { groupsN, nodeChanges, tplChanges };
}
// редактор заголовка узла (в «Настроить»); описание — во вкладке «Разобраться»
function nodeMetaEditor(nd, titleEl){
  const box = document.createElement('div');
  const r1 = el('div', 'insp-field'); r1.appendChild(el('label', '', 'заголовок'));
  const ti = document.createElement('input'); ti.value = nodeLabel(nd); ti.spellcheck = false;
  ti.addEventListener('input', () => { nd.title = ti.value; updateCard(nd); if(titleEl) titleEl.textContent = ti.value; persist(); renderScope(); });
  r1.appendChild(ti); box.appendChild(r1);
  const hr = el('div', 'desc-hint', 'описание узла — во вкладке «Разобраться»'); hr.style.margin = '2px 0 10px'; box.appendChild(hr);

  // где живут правки + сохранение в сам шаблон
  const scope = el('div', 'insp-scope'); box.appendChild(scope);
  function renderScope(){
    scope.innerHTML = '';
    if(!nd.src){
      scope.appendChild(el('div', 'scope-note', 'Этот узел не связан с шаблоном. Правки живут только в этой схеме. Чтобы сохранить насовсем — «💾 сохранить в каталог» выше.'));
      return;
    }
    const dirty = nodeDirty(nd);
    const h = el('div', 'scope-h');
    h.appendChild(el('span', 'scope-src', 'из шаблона: «' + nd.src.title + '»'));
    h.appendChild(el('span', 'scope-st ' + (dirty ? 'dirty' : 'clean'), dirty ? '● изменено только в схеме' : '✓ как в шаблоне'));
    scope.appendChild(h);
    scope.appendChild(el('div', 'scope-note', dirty
      ? 'Правки заголовка, описания и кода пока только в этой схеме. Можно оставить так — или записать их в сам шаблон (изменится везде, где он используется).'
      : 'Совпадает с шаблоном. Поменяй что-нибудь выше — появится выбор: оставить в схеме или записать в шаблон.'));
    if(dirty){
      const btns = el('div', 'scope-btns');
      const sv = el('button', 'scope-save', '✎ записать в шаблон'); sv.onclick = () => saveNodeToTemplate(nd, sv, renderScope);
      const rv = el('button', 'scope-revert', '↩ вернуть как в шаблоне'); rv.onclick = () => {
        nd.title = nd.src.title; nd.desc = nd.src.desc; if(nd.fields) nd.fields.code = nd.src.code;
        updateCard(nd); if(titleEl) titleEl.textContent = nodeLabel(nd); persist(); renderInspector(nd);
      };
      btns.append(sv, rv); scope.appendChild(btns);
    }
  }
  renderScope();
  return box;
}
// записать правки узла обратно в его шаблон (меняет сам .json через /api/edit)
async function saveNodeToTemplate(nd, btn, done){
  if(!nd.src || !nd.src.id) return;
  const payload = { id: nd.src.id, title: nodeLabel(nd), desc: nd.desc || '', code: (nd.fields && nd.fields.code) || nodeCode(nd) };
  if(btn){ btn.textContent = 'сохраняю…'; btn.disabled = true; }
  const r = await fetch('/api/edit', { method:'POST', body: JSON.stringify(payload) }).then(r => r.json()).catch(() => ({}));
  if(r && r.ok){
    nd.src = { id: nd.src.id, title: payload.title, desc: payload.desc, code: payload.code };  // теперь шаблон = текущее
    persist(); loadCatalog();   // палитра/каталог подтянут новое название
    if(btn){ btn.textContent = '✓ записано в шаблон'; setTimeout(() => done && done(), 900); }
  } else if(btn){ btn.textContent = 'не вышло, ещё раз'; btn.disabled = false; }
}
// сохранить узел как компонент в каталог (появится в каталоге и палитре)
function componentPreflight(nd, code){
  const errors = [], warnings = [];
  const text = String(code || '');
  if(!text.trim()) errors.push('Код пустой — компонент нечего запускать.');

  // Проверяем синтаксис в том же режиме, в котором preview сможет выполнить код.
  if(text.trim()){
    try {
      const hasAwait = /\bawait\b/.test(text);
      if(hasAwait) new Function(`return (async()=>{\n${text}\n})()`);
      else new Function(text);
    } catch(e) {
      errors.push(`Синтаксическая ошибка: ${e && e.message ? e.message : 'код не разбирается JavaScript'}.`);
    }
  }

  // Контракт выбранного блока: обязательные поля, входы и тип результата.
  const guide = BLOCK_GUIDES[nd.blockId] || null;
  const c = blockContract(nd);
  const f = nd.fields || {};
  if(guide && Array.isArray(guide.needs)){
    const requiredFields = (BLOCKS[nd.blockId] && BLOCKS[nd.blockId].fields || []).filter(x => x && x.required).map(x => x.k);
    requiredFields.forEach(k => { if(!String(f[k] == null ? '' : f[k]).trim()) errors.push(`Не заполнено обязательное поле «${k}».`); });
  }

  // Если блок требует именованный вход, он должен быть либо связан, либо реально объявлен в коде.
  if(c.inputField && c.inputMode !== 'expression' && c.inputMode !== 'free'){
    const value = String(f[c.inputField] || '').trim();
    if(!value) errors.push(`Не указан вход «${c.inputField}».`);
    else if(IDENTIFIER_RE.test(value)){
      const symbols = buildSymbols(text);
      if(!symbols.has(value)) errors.push(`Переменная «${value}» не объявлена в компоненте. Добавь источник данных или измени вход.`);
    }
  }

  // Все связи выбранного блока должны быть подтверждены контрактом.
  connectedIncoming(nd).forEach(src => {
    const r = edgeCheck(src, nd);
    if(!r.ok) errors.push(`Входящая связь «${nodeLabel(src)} → ${nodeLabel(nd)}»: ${r.reason}`);
    else if(r.level === 'info') warnings.push(`Входящая связь «${nodeLabel(src)} → ${nodeLabel(nd)}» требует ручной проверки.`);
  });
  connectedOutgoing(nd).forEach(dst => {
    const r = edgeCheck(nd, dst);
    if(!r.ok) errors.push(`Исходящая связь «${nodeLabel(nd)} → ${nodeLabel(dst)}»: ${r.reason}`);
    else if(r.level === 'info') warnings.push(`Исходящая связь «${nodeLabel(nd)} → ${nodeLabel(dst)}» требует ручной проверки.`);
  });

  // Runtime-зависимости: missing блокирует сохранение, ESM/manual остаётся предупреждением.
  const deps = dependencyStatus(document, text);
  // Script-зависимости зарегистрированы и preview умеет их автоматически подключать.
  // Поэтому отсутствие глобала в самом конструкторе — предупреждение, а не ложная ошибка сохранения.
  deps.missing.forEach(d => warnings.push(`Библиотека «${d.name}» пока не загружена в конструкторе; Preview попытается подключить её автоматически. ${dependencyAdvice(d)}`));
  deps.manual.forEach(d => errors.push(`Зависимость «${d.name}» требует ESM/npm-среду, которой нет в обычном script-preview. ${dependencyAdvice(d)}`));

  // Эти элементы гарантированно создаются wrapHtml() перед запуском preview.
  const PREVIEW_DOM_IDS = new Set(['c','out','log']);
  if(c.dom && c.dom.length){
    c.dom.forEach(id => {
      const selector = '#' + id;
      if(!PREVIEW_DOM_IDS.has(id)) warnings.push(`Обязательный DOM-элемент ${selector} не входит в стандартный preview: добавь его в окружение компонента.`);
    });
  }

  // Для встроенных выражений проверяем именно имена, а не только свободные идентификаторы runtime-анализатора.
  const symbols = buildSymbols(text);
  if(nd.blockId === 'calc'){
    for(const m of String(f.expr || '').matchAll(/[\p{ID_Start}_$][\p{ID_Continue}_$]*/gu)){
      const word=m[0];
      if(['Math','true','false','null','undefined','NaN','Infinity'].includes(word) || symbols.has(word) || word==='length') continue;
      errors.push(`Переменная «${word}» в формуле не объявлена в компоненте.`);
    }
  }

  // Внешние идентификаторы не всегда ошибка: это может быть вход, который компонент получает от среды.
  // Поэтому они явно показываются как неподтверждённые предупреждения, а не маскируются.
  const runtime = runtimeAnalyze(text);
  if(runtime.external.length) warnings.push(`Неподтверждённые внешние идентификаторы: ${runtime.external.join(', ')}.`);
  if(c.async && !/\bawait\b/.test(text)) warnings.push('Контракт помечен как async, но await в коде не найден — проверь намерение блока.');

  return { errors:[...new Set(errors)], warnings:[...new Set(warnings)] };
}
function renderPreflight(host, result){
  host.innerHTML = '';
  const title = el('div','preflight-title', result.errors.length ? '⛔ Сохранение заблокировано' : result.warnings.length ? '⚠ Можно сохранить, но есть предупреждения' : '✓ Компонент прошёл самопроверку');
  host.appendChild(title);
  if(result.errors.length){ const ul=document.createElement('ul'); result.errors.forEach(x=>ul.appendChild(el('li','preflight-error',x))); host.appendChild(ul); }
  if(result.warnings.length){ const ul=document.createElement('ul'); result.warnings.forEach(x=>ul.appendChild(el('li','preflight-warning',x))); host.appendChild(ul); }
}
function saveToCatalog(nd){
  const bg = el('div', 'modal-bg');
  const purposeOpts = PURPOSE.map(p => '<option>' + esc(p[0]) + '</option>').join('');
  bg.innerHTML = '<div class="modal"><h3>Сохранить в каталог</h3>'
    + '<p class="mh">Этот кусок станет компонентом в выбранном разделе — появится в каталоге и в палитре слева.</p>'
    + '<div class="mrow"><div class="mfield"><label>Назначение</label><select id="s-purpose">' + purposeOpts + '</select></div>'
    + '<div class="mfield"><label>Подкатегория</label><select id="s-sub"></select></div></div>'
    + '<div class="mfield"><label>Название</label><input id="s-title"></div>'
    + '<div class="mfield"><label>Описание</label><textarea id="s-desc" style="min-height:70px"></textarea></div>'
    + '<div class="mfield"><label>Код</label><textarea id="s-code" spellcheck="false"></textarea></div>'
    + '<div class="preflight" id="s-preflight"></div>'
    + '<div class="m-dup" id="s-dup" style="display:none"></div>'
    + '<div class="mbtns"><button class="btn ok" id="s-save">Сохранить</button><button class="btn" id="s-cancel">Отмена</button></div><div class="merr" id="s-err"></div></div>';
  document.body.appendChild(bg);
  const q = s => bg.querySelector(s);
  q('#s-title').value = nodeLabel(nd); q('#s-desc').value = nd.desc || ''; q('#s-code').value = nodeCode(nd);
  const preflightBox = q('#s-preflight');
  const refreshPreflight = () => {
    const result = componentPreflight(nd, q('#s-code').value);
    renderPreflight(preflightBox, result);
    q('#s-save').disabled = result.errors.length > 0;
    q('#s-save').title = result.errors.length ? 'Исправь ошибки самопроверки перед сохранением' : '';
    return result;
  };
  q('#s-code').addEventListener('input', refreshPreflight);
  const fillSubs = () => { const pk = q('#s-purpose').value; const subs = (SUBCATS[pk] || []).map(x => x[0]).concat(['Разное']); q('#s-sub').innerHTML = subs.map(s => '<option>' + esc(s) + '</option>').join(''); };
  fillSubs(); q('#s-purpose').onchange = fillSubs;
  bg.onclick = e => { if(e.target === bg) bg.remove(); };
  q('#s-cancel').onclick = () => bg.remove();
  // совпадение по названию → предложить обновить вместо дубля (приоритет — родной шаблон узла)
  const findDup = () => { const t = q('#s-title').value.trim().toLowerCase(); if(!t) return null;
    if(nd.src && (nd.src.title||'').trim().toLowerCase() === t) return { id: nd.src.id, title: nd.src.title };
    return CATALOG.find(x => (x.title||'').trim().toLowerCase() === t && (x.lang||'js') === 'js'); };
  const refreshDup = () => { const d = findDup(), box = q('#s-dup');
    if(d){ box.style.display = 'block'; box.innerHTML = 'Компонент «' + esc(d.title) + '» уже есть. <label class="m-dup-lbl"><input type="checkbox" id="s-asnew"> создать новый, а не обновлять</label>'; q('#s-save').textContent = 'Обновить существующий'; }
    else { box.style.display = 'none'; box.innerHTML = ''; q('#s-save').textContent = 'Сохранить'; } };
  q('#s-title').addEventListener('input', refreshDup); refreshDup(); refreshPreflight();
  q('#s-save').onclick = async () => {
    const title = q('#s-title').value.trim(), code = q('#s-code').value;
    if(!title || !code.trim()){ q('#s-err').textContent = 'нужны название и код'; return; }
    const preflight = refreshPreflight();
    if(preflight.errors.length){ q('#s-err').textContent = 'Сохранение заблокировано: сначала исправь ошибки самопроверки.'; return; }
    const purpose = q('#s-purpose').value, subcat = q('#s-sub').value;
    const detectedDeps=runtimeLibraryNeeds(code).map(d=>d.provider?`${d.name} — источник/блок: ${d.provider}`:d.name); const component = { type:'component', tags:{ purpose:[purpose], technology:['JavaScript'], runtime:[] }, subcat, summary:{ input:'', output:'', dependencies:detectedDeps, requirements:[] } };
    const payload = { title, lang:'js', group: subcat, desc: q('#s-desc').value.trim(), code, component };
    const dup = findDup(), asNew = q('#s-asnew') && q('#s-asnew').checked;
    q('#s-save').textContent = 'сохраняю…';
    let r;
    if(dup && !asNew) r = await fetch('/api/edit', { method:'POST', body: JSON.stringify(Object.assign({ id: dup.id }, payload)) }).then(x => x.json()).catch(() => ({}));
    else r = await fetch('/api/add', { method:'POST', body: JSON.stringify(payload) }).then(x => x.json()).catch(() => ({}));
    if(r.id || r.ok){ if(dup && !asNew){ nd.src = { id: dup.id, title, desc: payload.desc, code }; persist(); } bg.remove(); loadCatalog(); }
    else { q('#s-err').textContent = 'не сохранилось'; refreshDup(); }
  };
}

function inspWhy(nd, b){
  const box = document.createElement('div');
  const first = (b.hint || '').split('.')[0];
  box.appendChild(el('div', 'insp-text', 'Это «' + nodeLabel(nd) + '». ' + (first ? first + '.' : '')));
  const cw = el('div', 'insp-code');
  const pre = document.createElement('pre'); pre.className = 'code mono'; pre.style.maxHeight = '240px';
  buildHighlight(nodeCode(nd)).forEach(l => pre.appendChild(l)); cw.appendChild(pre); box.appendChild(cw);
  return box;
}

// ── сборка кода по связям ─────────────────────────────────────────────────────
const byPos = (a, b) => (a.y - b.y) || (a.x - b.x);
function orderedNodes(){
  const incoming = {}; graph.nodes.forEach(n => incoming[n.id] = 0);
  graph.edges.forEach(e => { if(incoming[e.to] != null) incoming[e.to]++; });
  const adj = {}; graph.edges.forEach(e => { (adj[e.from] = adj[e.from] || []).push(e.to); });
  const seen = new Set(), order = [];
  const visit = id => { if(seen.has(id)) return; seen.add(id); const n = byId(id); if(n) order.push(n);
    (adj[id] || []).map(byId).filter(Boolean).sort(byPos).forEach(x => visit(x.id)); };
  graph.nodes.filter(n => !incoming[n.id]).sort(byPos).forEach(n => visit(n.id));
  graph.nodes.slice().sort(byPos).forEach(n => { if(!seen.has(n.id)){ seen.add(n.id); order.push(n); } });
  return order;
}
function currentCode(){
  const nodes = orderedNodes();
  const needAsync = nodes.some(n => /\bawait\b/.test(nodeCode(n)));
  const body = nodes.map(nodeCode).join('\n');
  return needAsync ? '(async () => {\n' + body.split('\n').map(l => '  ' + l).join('\n') + '\n})();' : body;
}

// ── подсветка ─────────────────────────────────────────────────────────────────
const KW = new Set(['const','let','var','function','return','if','else','for','of','while','new','=>','await','async']);
const BI = new Set(['console','log','document','querySelector','getContext','addEventListener','map','reduce','filter','forEach','fillRect','innerHTML','fetch','then']);
function buildHighlight(code){
  const lines = [];
  String(code).split('\n').forEach(line => {
    const div = document.createElement('div'); div.className = 'line';
    let i = 0; const n = line.length;
    const push = (cls, v) => { const s = document.createElement('span'); if(cls) s.style.color = cls; s.textContent = v; div.appendChild(s); };
    while(i < n){
      const rest = line.slice(i), c = line[i];
      if(rest.startsWith('//')){ push('#9090BB', line.slice(i)); break; }
      if(c === '"' || c === "'" || c === '`'){ let j = i+1; while(j<n && line[j]!==c) j++; j++; push('#52F2C9', line.slice(i, j)); i = j; continue; }
      if(/[0-9]/.test(c)){ const mm=/^\d[\d.]*/.exec(rest); push('#FF8800', mm[0]); i+=mm[0].length; continue; }
      const im = /^[A-Za-zА-Яа-яЁё_$][\wА-Яа-яЁё$]*/.exec(rest);
      if(im){ const w=im[0]; let k=i+w.length; while(k<n&&line[k]===' ')k++;
        push(KW.has(w)?'#B45CFF':(line[k]==='('||BI.has(w))?'#3DD9FF':'#CBC2EA', w); i+=w.length; continue; }
      const ws2=/^\s+/.exec(rest); if(ws2){ push(null, ws2[0]); i+=ws2[0].length; continue; }
      push('#9C90C4', c); i++;
    }
    if(!line) div.appendChild(document.createTextNode('​'));
    lines.push(div);
  });
  return lines;
}
function renderCode(){ codeEl.innerHTML = ''; buildHighlight(currentCode()).forEach(l => codeEl.appendChild(l)); }
function attachHighlight(ta){
  const wrap = el('div', 'blk-code-wrap'); const pre = document.createElement('pre'); pre.className = 'blk-hl'; pre.setAttribute('aria-hidden', 'true');
  const sync = () => { pre.innerHTML = ''; buildHighlight(ta.value).forEach(l => pre.appendChild(l)); };
  ta.addEventListener('input', sync); ta.addEventListener('scroll', () => { pre.scrollTop = ta.scrollTop; pre.scrollLeft = ta.scrollLeft; });
  wrap.append(pre, ta); sync(); return wrap;
}

// ── запуск / файлы ────────────────────────────────────────────────────────────
function buildPreviewHtml(code, analysis, runId){
  const deps = analysis.libraries.filter(x => x.mode === 'script').map(x => ({name:x.name,global:x.global,url:x.url}));
  const safeRunId = String(runId).replace(/[^a-zA-Z0-9_-]/g, '');
  return `<!doctype html><meta charset="utf-8"><body style="margin:8px;font:12px ui-monospace,monospace;color:#F6F4FF;background:#0E0720">
<canvas id="c" width="280" height="140" style="background:#140A24;border:1px solid #241638;border-radius:6px"></canvas>
<div id="out" style="margin-top:8px"></div>
<pre id="log" style="color:#52F2C9;white-space:pre-wrap;margin-top:8px"></pre>
<script>
var log=document.getElementById('log');
var _p=function(){ log.textContent += Array.prototype.join.call(arguments,' ')+'\\n'; };
var console={log:_p,error:_p,warn:_p,info:_p};
var _report=function(prefix,e){ var msg=e && e.stack ? e.stack : (e && e.message ? e.message : String(e)); _p(prefix + msg); try{ parent.postMessage({type:'codeforge-preview-error',runId:'${safeRunId}',message:String(msg)}, '*'); }catch(_){} };
window.addEventListener('error',function(e){ _report('⛔ ', e.error || e.message); });
window.addEventListener('unhandledrejection',function(e){ _report('⛔ Promise: ', e.reason); e.preventDefault(); });
(async function(){
  try{
    const deps=${JSON.stringify(deps)};
    for(const dep of deps){
      if(dep.global && window[dep.global]) continue;
      await new Promise((resolve,reject)=>{const sc=document.createElement('script');sc.src=dep.url;sc.onload=resolve;sc.onerror=()=>reject(new Error('Не удалось загрузить '+dep.name+' из '+dep.url));document.head.appendChild(sc);});
    }
${String(code).split('\\n').map(l => '    '+l).join('\\n')}
  }catch(e){ _report('⛔ ', e); }
})().then(function(){ try{ parent.postMessage({type:'codeforge-preview-ready',runId:'${safeRunId}'}, '*'); }catch(_){} }).catch(function(e){ _report('⛔ async: ', e); });
<\\/script></body>`;
}

function run(){
  const code = currentCode();
  const analysis = runtimeAnalyze(code);
  const preWarnings=[]; if(analysis.external.length) preWarnings.push(`Возможные внешние переменные/библиотеки: ${analysis.external.join(', ')}.`); analysis.libraries.filter(x=>x.mode==='module').forEach(x=>preWarnings.push(`Библиотека ${x.name} требует ESM/npm-среду.`));
  setRuntimeState('checking', [], preWarnings);
  renderInspector();
  const runId = Date.now().toString(36);
  preview.srcdoc = buildPreviewHtml(code, analysis, runId);
  // Явно ждём сообщение об ошибке из iframe: ошибки Promise/fetch больше
  // не теряются после завершения синхронного try/catch.
  preview.dataset.runId = runId;
}
window.addEventListener('message', e => {
  const d=e.data||{}; if(!d || !d.type || d.runId !== preview.dataset.runId) return;
  if(d.type==='codeforge-preview-error'){
    setRuntimeState('error', [...runtimeState.errors, 'Preview: '+d.message], runtimeState.warnings);
    showEdgeMessage('⛔ Preview: '+d.message, 'error'); renderInspector();
  } else if(d.type==='codeforge-preview-ready'){
    const doc=preview.contentDocument; const check=doc ? runtimeCheckDocument(doc, currentCode()) : {errors:['Не удалось получить документ preview.'],warnings:[]};
    setRuntimeState(check.errors.length ? 'error' : 'ready', check.errors, [...runtimeState.warnings, ...check.warnings]);
    renderInspector();
    if(check.errors.length) showEdgeMessage('⛔ Окружение preview не готово: '+check.errors[0], 'error');
    else showEdgeMessage('✓ Preview: окружение проверено', 'ok');
  }
});
$('#copy').onclick = () => { navigator.clipboard.writeText(currentCode()); flash($('#copy'), '✓'); };
$('#run').onclick = run;
function download(name, text, mime){ const b = new Blob([text], { type: mime + ';charset=utf-8' }); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(u), 2000); }
function wrapHtml(code){ return '<!doctype html>\n<html lang="ru"><head><meta charset="utf-8"><title>моя страница</title>\n<style>body{margin:12px;font:13px ui-monospace,monospace;color:#F6F4FF;background:#0E0720}#log{color:#52F2C9;white-space:pre-wrap}</style></head>\n<body>\n<canvas id="c" width="300" height="160" style="background:#140A24;border:1px solid #241638;border-radius:6px"></canvas>\n<div id="out"></div><pre id="log"></pre>\n<script>\nvar log=document.getElementById("log");var _p=function(){log.textContent+=Array.prototype.join.call(arguments," ")+"\\n";};var console={log:_p,error:_p,warn:_p,info:_p};\ntry{\n' + code + '\n}catch(e){log.textContent+="\\u26d4 "+e.message;}\n<\/script>\n</body></html>\n'; }
$('#dl').onclick = () => { const code = currentCode(); const fmt = $('#fmt').value; if(fmt === 'html') download('схема.html', wrapHtml(code), 'text/html'); else if(fmt === 'txt') download('код.txt', code, 'text/plain'); else download('код.js', code, 'text/javascript'); flash($('#dl'), '✓'); };
function flash(b, t){ const o = b.textContent; b.textContent = t; setTimeout(() => b.textContent = o, 1000); }

$('#save').onclick = async () => {
  const code = currentCode(); if(!code.trim()){ flash($('#save'), 'пусто'); return; }
  const title = prompt('Название шаблона:', 'Моя сборка'); if(title === null) return;
  const r = await fetch('/api/add', { method: 'POST', body: JSON.stringify({ title: title || 'Моя сборка', lang: 'js', group: 'Из конструктора', code, desc: 'собрано в конструкторе' }) }).then(r => r.json()).catch(() => ({}));
  flash($('#save'), r.id ? '✓ в шаблонах' : 'ошибка');
};

// «+ компонент из каталога» — добавить узел «свой код» с кодом шаблона
$('#fromtpl').onclick = async e => {
  e.stopPropagation(); closeMenu();
  let list; try { list = await fetch('/api/list').then(r => r.json()); } catch(_){ return; }
  const jsOnly = list.filter(t => (t.lang || 'js') === 'js');
  const m = el('div', 'menu'); m.id = '_menu';
  const byGroup = {}; jsOnly.forEach(t => { (byGroup[t.group] = byGroup[t.group] || []).push(t); });
  if(!jsOnly.length) m.innerHTML = '<div class="mcat">нет JS-компонентов</div>';
  for(const g of Object.keys(byGroup)){
    m.appendChild(el('div', 'mcat', g));
    byGroup[g].forEach(t => {
      const it = el('div', 'mitem'); it.textContent = t.title;
      it.onclick = async () => { closeMenu();
        try { const tpl = await fetch('/api/template?id=' + encodeURIComponent(t.id)).then(r => r.json());
          const code = (tpl.lines || []).map(line => (line || []).map(k => k.v != null ? k.v : '').join('')).join('\n');
          addNode('raw', { fields: { code }, title: t.title });
        } catch(_){}
      };
      m.appendChild(it);
    });
  }
  document.body.appendChild(m);
  const r = $('#fromtpl').getBoundingClientRect();
  m.style.left = Math.min(r.left, window.innerWidth - 320) + 'px'; m.style.top = (r.bottom + window.scrollY + 4) + 'px';
  setTimeout(() => document.addEventListener('mousedown', outside), 0);
};
function outside(e){ const m = $('#_menu'); if(m && !m.contains(e.target)) closeMenu(); }
function closeMenu(){ const m = $('#_menu'); if(m) m.remove(); document.removeEventListener('mousedown', outside); }

// разобрать HTML на части: разметка / стили / скрипт(ы)
function breakdownHTML(text){
  const parts = [];
  const scripts = [...text.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1].trim()).filter(Boolean);
  const styles  = [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1].trim()).filter(Boolean);
  const markup  = text.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/\n{3,}/g, '\n\n').trim();
  if(markup) parts.push({ title: 'разметка (HTML)', code: markup });
  styles.forEach((s, i) => parts.push({ title: 'стили (CSS)' + (styles.length > 1 ? ' ' + (i + 1) : ''), code: s }));
  scripts.forEach((s, i) => parts.push({ title: 'скрипт (JS)' + (scripts.length > 1 ? ' ' + (i + 1) : ''), code: s }));
  return parts.length ? parts : [{ title: 'HTML', code: text }];
}
// разбить JS на верхнеуровневые шаги (функции/объявления/вызовы)
function splitTopLevel(code){
  const out = []; let brace = 0, paren = 0, seg = '', i = 0; const n = code.length;
  const push = () => { const t = seg.trim(); if(t) out.push(t); seg = ''; };
  const skipStr = (j, q) => { j++; while(j < n){ if(code[j] === '\\'){ j += 2; continue; } if(code[j] === q){ j++; break; } j++; } return j; };
  while(i < n){
    const c = code[i];
    if(c === '"' || c === "'" || c === '`'){ const j = skipStr(i, c); seg += code.slice(i, j); i = j; continue; }
    if(c === '/' && code[i + 1] === '/'){ let j = code.indexOf('\n', i); if(j < 0) j = n; seg += code.slice(i, j); i = j; continue; }
    if(c === '/' && code[i + 1] === '*'){ let j = code.indexOf('*/', i + 2); j = j < 0 ? n : j + 2; seg += code.slice(i, j); i = j; continue; }
    if(c === '(' || c === '['){ paren++; seg += c; i++; continue; }
    if(c === ')' || c === ']'){ paren = Math.max(0, paren - 1); seg += c; i++; continue; }
    if(c === '{'){ brace++; seg += c; i++; continue; }
    if(c === '}'){ brace = Math.max(0, brace - 1); seg += c; i++;
      if(brace === 0 && paren === 0){ let j = i; while(j < n && /\s/.test(code[j])) j++; if(code[j] === ';'){ seg += code.slice(i, j + 1); i = j + 1; } push(); }
      continue; }
    if(c === ';' && brace === 0 && paren === 0){ seg += c; push(); i++; continue; }
    seg += c; i++;
  }
  push();
  return out.filter(Boolean);
}
// положить части колонкой и соединить стрелками (выход → вход)
function addPieces(parts){
  const startX = graph.nodes.length ? Math.max(...graph.nodes.map(n => n.x)) + 240 : 60;
  let prev = null;
  parts.forEach((pc, i) => {
    const nd = makeNode('raw', { fields: { code: pc.code }, title: pc.title, x: startX, y: 50 + i * 150 });
    graph.nodes.push(nd);
    if(prev) graph.edges.push({ from: prev.id, to: nd.id });
    prev = nd;
  });
  renderCanvas(); renderCode(); persist();
  if(parts.length) select(graph.nodes[graph.nodes.length - 1]);
}
// разобрать произвольный текст: auto определяет HTML/JS по виду
function breakdownText(text, kind){
  const looksHTML = /<\s*(!doctype|html|head|body|div|section|span|p|a|script|style|canvas|svg|ul|li|table|h[1-6])\b/i.test(text);
  const mode = kind === 'auto' ? (looksHTML ? 'html' : 'js') : kind;
  if(mode === 'html') return { parts: breakdownHTML(text), mode };
  return { parts: splitTopLevel(text).map(c => ({ title: classify(c), code: c })), mode };
}
$('#imp').onclick = () => $('#impfile').click();
// «вставить код» — панель с textarea, разбор на блоки прямо из вставленного
$('#paste').onclick = () => {
  const pp = $('#pastePanel'); const show = pp.style.display === 'none';
  pp.style.display = show ? 'block' : 'none';
  if(show){ $('#pasteNote').textContent = ''; $('#pasteCode').focus(); }
};
$('#pasteCancel').onclick = () => { $('#pastePanel').style.display = 'none'; $('#pasteCode').value = ''; $('#pasteNote').textContent = ''; };
$('#pasteGo').onclick = () => {
  const text = $('#pasteCode').value; const note = $('#pasteNote');
  if(!text.trim()){ note.textContent = 'поле пустое'; return; }
  if(text.length > 120000){ note.textContent = 'многовато — вставь кусок поменьше'; return; }
  const { parts, mode } = breakdownText(text, $('#pasteKind').value);
  if(!parts.length){ note.textContent = 'не нашлось, что разбить'; return; }
  addPieces(parts);
  note.textContent = 'готово: ' + parts.length + ' блок(ов), ' + (mode === 'html' ? 'как HTML' : 'как JS');
  $('#pasteCode').value = '';
  setTimeout(() => { $('#pastePanel').style.display = 'none'; note.textContent = ''; }, 1200);
};
$('#impfile').onchange = async e => {
  const f = e.target.files && e.target.files[0]; if(!f) return;
  const text = await f.text(); if(text.length > 120000){ alert('Файл большой — возьми кусок поменьше.'); return; }
  const ext = (f.name.split('.').pop() || '').toLowerCase();
  let parts;
  if(ext === 'html' || ext === 'htm') parts = breakdownHTML(text);
  else if(['js','mjs','jsx','ts'].includes(ext)) parts = splitTopLevel(text).map(c => ({ title: classify(c), code: c }));
  else parts = [{ title: f.name.replace(/\.[^.]+$/, ''), code: text }];
  addPieces(parts);
  e.target.value = '';
};

$('#clear').onclick = () => { graph = { nodes: [], edges: [] }; selectedId = null; renderCanvas(); renderInspector(); renderCode(); persist(); };
$('#example').onclick = () => {
  const a = uid(), b = uid(), c = uid(), d = uid();
  graph = { nodes: [
    { id:a, blockId:'array',  fields:{ name:'числа', items:'40, 70, 30, 90, 55' }, x:70,  y:60 },
    { id:b, blockId:'reduce', fields:{ name:'сумма', list:'числа', expr:'acc + x' }, x:70,  y:230 },
    { id:c, blockId:'calc',   fields:{ name:'среднее', expr:'сумма / числа.length' }, x:70, y:400 },
    { id:d, blockId:'bars',   fields:{ values:'40, 70, 30, 90, 55' }, x:360, y:230 },
  ], edges: [ { from:a, to:b }, { from:b, to:c }, { from:a, to:d } ] };
  selectedId = null; renderCanvas(); renderInspector(); renderCode(); persist();
};

function el(tag, cls, text){ const e = document.createElement(tag); if(cls) e.className = cls; if(text != null) e.textContent = text; return e; }
function esc(s){ return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
// описание с кодом: `код` → цветная плашка, ```блок``` → цветной блок
function descFmt(s){
  s = String(s == null ? '' : s);
  const blocks = [];
  s = s.replace(/```([\s\S]*?)```/g, (m, c) => { blocks.push(c.replace(/^\n+|\n+$/g, '')); return '\u0001' + (blocks.length - 1) + '\u0001'; });
  let html = esc(s).replace(/`([^`\n]+)`/g, (m, c) => '<code class="desc-chip">' + c + '</code>').replace(/\n/g, '<br>');
  return html.replace(/\u0001(\d+)\u0001/g, (m, i) => '<pre class="desc-code">' + esc(blocks[+i]) + '</pre>');
}
// обернуть выделение в textarea обратными кавычками
function wrapBackticks(ta){
  const a = ta.selectionStart, b = ta.selectionEnd, v = ta.value, sel = v.slice(a, b) || 'код';
  ta.value = v.slice(0, a) + '`' + sel + '`' + v.slice(b);
  ta.focus(); ta.selectionStart = a + 1; ta.selectionEnd = a + 1 + sel.length;
  ta.dispatchEvent(new Event('input'));
}
function cssEsc(s){ return String(s).replace(/["\\]/g, '\\$&'); }

restore();
loadCatalog();
renderCanvas();
renderInspector();
renderCode();
histInit();

// Зум: кнопки − / % / + и Ctrl+колесо; панорама — средней кнопкой мыши или с зажатым пробелом
setZoom(1);
if($('#zoomOut')) $('#zoomOut').onclick = () => setZoom(zoom - 0.1);
if($('#zoomIn')) $('#zoomIn').onclick = () => setZoom(zoom + 0.1);
if($('#zoomReset')) $('#zoomReset').onclick = () => setZoom(1);
const scroll = $('.canvas-scroll');
if(scroll){
  scroll.addEventListener('wheel', e => { if(!(e.ctrlKey || e.metaKey)) return; e.preventDefault(); setZoom(zoom - Math.sign(e.deltaY) * 0.1); }, { passive: false });
  // панорама: средняя кнопка, либо пробел+тащить по пустому месту
  let panning = null;
  document.addEventListener("keydown", e => { if(e.code === "Space" && !/INPUT|TEXTAREA|SELECT/.test((document.activeElement||{}).tagName||"")) spaceHeld = true; });
  document.addEventListener("keyup", e => { if(e.code === "Space") spaceHeld = false; });
  scroll.addEventListener("pointerdown", e => {
    const onNode = e.target.closest && e.target.closest(".gnode");
    if(e.button === 1 || (spaceHeld && !onNode)){
      e.preventDefault(); panning = { x: e.clientX, y: e.clientY, l: scroll.scrollLeft, t: scroll.scrollTop };
      scroll.setPointerCapture(e.pointerId); scroll.style.cursor = 'grabbing';
    }
  });
  scroll.addEventListener('pointermove', e => { if(!panning) return; scroll.scrollLeft = panning.l - (e.clientX - panning.x); scroll.scrollTop = panning.t - (e.clientY - panning.y); });
  const endPan = () => { panning = null; scroll.style.cursor = ''; };
  scroll.addEventListener('pointerup', endPan); scroll.addEventListener('pointercancel', endPan);
}

// Undo/Redo: кнопки на тулбаре + Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z
if($('#undo')) $('#undo').onclick = undo;
if($('#redo')) $('#redo').onclick = redo;
document.addEventListener('keydown', e => {
  if(!(e.ctrlKey || e.metaKey)) return;
  const ae = document.activeElement; if(ae && /INPUT|TEXTAREA|SELECT/.test(ae.tagName)) return;  // в полях — родная отмена
  const k = e.key.toLowerCase();
  if(k === 'z' && !e.shiftKey){ e.preventDefault(); undo(); }
  else if((k === 'z' && e.shiftKey) || k === 'y'){ e.preventDefault(); redo(); }
});

// перетягиваемые границы колонок (палитра | холст | инспектор); размеры запоминаются
(function(){
  const gw = document.querySelector('.gwrap'); if(!gw) return;
  let PW = 230, IW = 300;
  try { PW = +localStorage.getItem('codelab_pw') || 230; IW = +localStorage.getItem('codelab_iw') || 300; } catch(_){}
  const apply = () => { gw.style.setProperty('--pw', PW + 'px'); gw.style.setProperty('--iw', IW + 'px'); };
  apply();
  const mkGutter = which => {
    const g = document.createElement('div'); g.className = 'gutter'; g.title = 'потяни, чтобы изменить ширину';
    g.addEventListener('pointerdown', e => {
      e.preventDefault(); g.classList.add('drag');
      const sx = e.clientX, sPW = PW, sIW = IW;
      const mv = ev => {
        const dx = ev.clientX - sx;
        if(which === 'left') PW = Math.max(150, Math.min(520, sPW + dx));
        else IW = Math.max(200, Math.min(680, sIW - dx));
        apply();
      };
      const up = () => {
        g.classList.remove('drag');
        document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up);
        try { localStorage.setItem('codelab_pw', PW); localStorage.setItem('codelab_iw', IW); } catch(_){}
        if(typeof drawEdges === 'function') drawEdges();
      };
      document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up);
    });
    return g;
  };
  const pal = gw.querySelector('.palette'), insp = gw.querySelector('.g-insp');
  if(pal) gw.insertBefore(mkGutter('left'), pal.nextSibling);
  if(insp) gw.insertBefore(mkGutter('right'), insp);
})();
