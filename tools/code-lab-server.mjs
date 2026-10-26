// Локальный сервер «Лаборатории кода» — отдельная от сайта штука, чтобы могла
// расти без риска для основного приложения. Каждый шаблон — отдельный JSON-файл
// в templates/. Добавлять можно прямо со страницы: вставил/загрузил код — он
// раскрашивается и сохраняется новым файлом; клик по слову → вписываешь, что
// оно значит, и это пишется в тот же файл. Ничего не пересобирается.
//
// stdlib node (http/fs/path), без зависимостей. Ленивость: /api/list отдаёт
// только мету; полный шаблон — при выборе.
//
// Запуск:  node tools/code-lab-server.mjs            (порт 8788)
// Открыть: http://localhost:8788/

import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { annotateLines } from './code-lab/lib/annotate.mjs';
import { createLibraryStore } from './code-lab/lib/library-store.mjs';
import { createSearchService } from './code-lab/lib/search.mjs';
import { tokenize } from './code-lab/lib/tokenizer.mjs';
import { parseSnippets } from './code-lab/lib/ingest.mjs';
import { createDescriptionQueue } from './code-lab/lib/describe-queue.mjs';
import { createAiAssist } from './code-lab/lib/ai-assist.mjs';
import { createProviderRuntime } from './code-lab/lib/ai-providers.mjs';
import { handleWorkspace } from './code-lab/lib/workspace.mjs';
import { createAiGenerate, LANGS as AI_LANGS } from './code-lab/lib/ai-generate.mjs';   // токенайзер вынесен в модуль — его тестируют отдельно
import { createVendor } from './code-lab/lib/vendor.mjs';   // управляемые обновления CodeMirror (по кнопке)

// сетевые/TLS-ошибки провайдеров ИИ (GigaChat и пр.) не должны ронять весь сервер —
// логируем и продолжаем работать, чтобы Лаборатория оставалась доступной.
process.on('uncaughtException', e => { console.error('[code-lab] uncaughtException:', (e && e.stack) || e); });
process.on('unhandledRejection', e => { console.error('[code-lab] unhandledRejection:', (e && e.stack) || e); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, 'code-lab');
const PUBLIC = path.join(ROOT, 'public');
const TEMPLATES = path.join(ROOT, 'templates');   // старые карточки: теперь только источник для миграции
const LIBRARY = path.join(ROOT, 'library');       // куски кода: обычные файлы + .meta.json рядом
const FLOWS = path.join(ROOT, 'flows');   // сохранённые схемы-сборки (граф со связями)
const DATA = path.join(ROOT, 'data');     // сохранённые JSON-данные пользователя
const RECIPES = path.join(ROOT, 'recipes'); // рецепты: название + описание + список кусков
const PORT = Number(process.argv[2]) || 8788;
// файловое хранилище библиотеки (код — обычные файлы; подсветка и пояснения строятся из текста при загрузке)
const store = createLibraryStore({ root: LIBRARY, legacyDir: TEMPLATES, dictPath: path.join(PUBLIC, 'keyword-dict.json'), getDict: () => kwDict(), coverage: j => coverage(j), contract: (code, lang) => codeContract(code, lang) });
// поиск: по названию, описанию, тегам, коду и пояснениям; синонимы лежат в library/_synonyms.json (правятся руками)
const search = createSearchService({ store, synonymsPath: path.join(LIBRARY, '_synonyms.json'), defaultSynonymsPath: path.join(ROOT, 'lib', 'default-synonyms.json') });
const aiRuntime = createProviderRuntime({ configPath: path.join(ROOT, 'ai-config.json') });   // выбранный ИИ-сервис (ключей в файле нет)
// настройки ИИ меняют только запросы со своей страницы: проверяем Host и Origin
const aiLocalOnly = req => {
  const host = String(req.headers.host || '').toLowerCase();
  const origin = String(req.headers.origin || '').toLowerCase();
  const okHost = [`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`].includes(host);
  const okOrigin = !origin || [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`, `http://[::1]:${PORT}`].includes(origin);
  return okHost && okOrigin;
};
const describeQueue = createDescriptionQueue({ store, statePath: path.join(DATA, 'description-jobs.json'), fetchImpl: aiRuntime.fetch });
const aiAssist = createAiAssist({ store, fetchImpl: aiRuntime.fetch });   // ИИ-дополнение разделов куска (предложить → человек правит → применить)
const aiGenerate = createAiGenerate({ store, fetchImpl: aiRuntime.fetch });   // ИИ-создание новых кусков (предложить → человек отмечает → создать)
const vendor = createVendor({ root: path.join(ROOT, 'vendor') });   // CodeMirror лежит в code-lab/vendor/codemirror/<версия>/
// кто может обращаться к серверу: только своя страница (чужой сайт в браузере не должен уметь писать файлы, запускать код, качать версии)
const isLocalHost = h => { const m = /^(localhost|127\.0\.0\.1|\[::1\])(?::(\d+))?$/.exec(String(h || '')); return !!m && Number(m[2] || 80) === PORT; };
const isLocalOrigin = o => { try { const x = new URL(o); return (x.hostname === 'localhost' || x.hostname === '127.0.0.1' || x.hostname === '[::1]') && Number(x.port || (x.protocol === 'https:' ? 443 : 80)) === PORT; } catch { return false; } };

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
// no-store обязателен: иначе браузер кэширует GET /api/list и /api/template и показывает старые описания после правок
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };

function within(base, rel){
  const p = path.resolve(base, '.' + path.sep + (rel || '').replace(/^\/+/, ''));
  if(p !== base && !p.startsWith(base + path.sep)) return null;
  return p;
}
function readBody(req){
  return new Promise((resolve, reject) => {
    let d = ''; req.on('data', c => { d += c; if(d.length > 80e6) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch(e){ reject(e); } });
    req.on('error', reject);
  });
}

// ── git: чтобы шаблоны уходили на GitHub, а не висели локально ────────────────
function git(args, cwd){
  return new Promise(resolve => {
    execFile('git', args, { cwd: cwd || HERE, timeout: 30000, maxBuffer: 10e6 }, (e, so, se) => {
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, out: String(so || '').trim(), err: String(se || '').trim() });
    });
  });
}
async function gitRoot(){ const r = await git(['rev-parse', '--show-toplevel']); return r.code === 0 ? r.out : null; }
// гарантируем, что папки лаборатории существуют — иначе git add/status по ним даёт «pathspec did not match»
async function ensureLabDirs(){ for(const d of [LIBRARY, FLOWS, DATA, RECIPES]){ try { await fs.mkdir(d, { recursive: true }); } catch(_){} } }
// только НЕпустые папки лаборатории — пустую git commit не примет («did not match any file(s) known to git»)
async function labPaths(){ const out = []; for(const d of [LIBRARY, FLOWS, RECIPES]){ try { if((await fs.readdir(d)).length) out.push(d); } catch(_){} } return out; }
// то же + файл словаря пояснений (keyword-dict.json) — чтобы правки словаря тоже уезжали на GitHub, а не терялись при pull
async function labTargets(){ const out = await labPaths();
  const dp = path.join(PUBLIC, 'keyword-dict.json'); try { await fs.access(dp); out.push(dp); } catch(_){}
  const ld = path.join(PUBLIC, 'dict'); try { if((await fs.readdir(ld)).length) out.push(ld); } catch(_){}   // словари по языкам
  return out; }

// ── токенайзер: см. code-lab/lib/tokenizer.mjs (сырой код → строки токенов {k, v, r?}) ──

// словарь пояснений. База (общее/код + HTML + CSS) — keyword-dict.json; словари по языкам
// лежат ОТДЕЛЬНЫМИ файлами dict/langs/<язык>.json и подмешиваются в dict.langs при загрузке.
// Так каждый язык в своём файле — чисто и без конфликтов при заливке.
const DICT_BASE = path.join(PUBLIC, 'keyword-dict.json');
const DICT_DIR = path.join(PUBLIC, 'dict');
const LANGS_DIR = path.join(DICT_DIR, 'langs');
const EXAMPLES_FILE = path.join(DICT_DIR, 'examples.json');   // привязка «слово/конструкция → кусок-пример» {term:{id,title}}
const SYN_FILE = path.join(DICT_DIR, 'synonyms.json');        // синонимы для поиска по смыслу: {term:[фраза,…]} — найти, не помня имени
// алиасы языка → канон: чтобы «javascript»/«py»/«c++» не плодили файл-двойник рядом с js/python/cpp
const LANG_ALIAS = { javascript: 'js', typescript: 'ts', py: 'python', python3: 'python', shell: 'bash', sh: 'bash', zsh: 'bash', 'c++': 'cpp', cplusplus: 'cpp', cxx: 'cpp', 'c#': 'csharp', 'c-sharp': 'csharp', cs: 'csharp', golang: 'go', rb: 'ruby', kt: 'kotlin', rs: 'rust', jsx: 'js', tsx: 'ts', htm: 'html', yml: 'yaml' };
const canonLang = v => { v = String(v || '').trim().toLowerCase(); return LANG_ALIAS[v] || v.replace(/[^a-z0-9_+-]/g, '') || 'other'; };
let _kwDict = null;
// эвристики «на своём ли месте»: словарь описывает КОД, слева должен быть код-токен, а не русская фраза.
const _hasLat = s => /[A-Za-z]/.test(String(s));
const _isRuS = s => /[А-Яа-яЁё]/.test(String(s));
const _commas = s => (String(s).match(/,/g) || []).length;
// это ПОЯСНЕНИЕ (предложение), а не список: есть « — »/двоеточие или союзы/глаголы-связки.
// Нужно, чтобы не путать нормальное пояснение с запятыми («добавляет класс, если его нет») со списком синонимов.
const _isSentence = s => { const t = String(s); return /[—–:]/.test(t) || /\b(если|когда|иначе|чтобы|потому|котор|это|нужно|значит|добавля|убира|возвраща|созда[её]т|вызыва|позволя|прове|делает)\b/i.test(t); };
// это СПИСОК синонимов: ≥3 запятых (4+ пункта), не предложение, и каждый кусок короткий (≤3 слова)
const _isSynList = s => { const t = String(s).trim(); if(_commas(t) < 3 || _isSentence(t)) return false; return t.split(',').every(p => p.trim().split(/\s+/).filter(Boolean).length <= 3); };
// «код» — это чисто русский текст без латиницы и код-символов → скорее словарь/синонимы, а не код
const _looksProse = s => { const t = String(s); if(!_isRuS(t)) return false; if(_hasLat(t)) return false; return !/[{}()\[\];=<>\/\\|&*%#@$`]/.test(t); };
async function loadExamples(){ try { const o = JSON.parse(await fs.readFile(EXAMPLES_FILE, 'utf8')); return (o && typeof o === 'object') ? o : {}; } catch(_){ return {}; } }
async function loadSynonyms(){ try { const o = JSON.parse(await fs.readFile(SYN_FILE, 'utf8')); return (o && typeof o === 'object') ? o : {}; } catch(_){ return {}; } }
async function loadLangDicts(){
  const out = {};
  let files = []; try { files = (await fs.readdir(LANGS_DIR)).filter(n => n.endsWith('.json')); } catch(_){ return out; }
  for(const fn of files){ const lang = fn.replace(/\.json$/, '').toLowerCase();
    try { const o = JSON.parse(await fs.readFile(path.join(LANGS_DIR, fn), 'utf8')); if(o && typeof o === 'object'){ const m = {}; for(const [w, t] of Object.entries(o)) if(typeof t === 'string') m[w.toLowerCase()] = t; out[lang] = m; } } catch(_){}
  }
  return out;
}
async function kwDict(){
  if(_kwDict) return _kwDict;
  let base;
  try { base = JSON.parse(await fs.readFile(DICT_BASE, 'utf8')); } catch(_){ base = {}; }
  for(const s of ['words','htmlTags','htmlAttrs','cssProps','cssVals']) if(!base[s]) base[s] = {};
  base.langs = base.langs && typeof base.langs === 'object' ? base.langs : {};
  // файлы языков поверх (приоритет у файлов)
  const fromFiles = await loadLangDicts();
  for(const [lang, m] of Object.entries(fromFiles)){ base.langs[lang] = Object.assign({}, base.langs[lang] || {}, m); }
  base.examples = await loadExamples();   // привязки «термин → кусок-пример»
  base.synonyms = await loadSynonyms();   // синонимы/фразы для поиска по смыслу
  _kwDict = base;
  return _kwDict;
}
// записать словарь языка в свой файл dict/langs/<lang>.json (мёрдж с существующим)
async function saveLangDict(lang, pairs){
  lang = canonLang(lang);
  await fs.mkdir(LANGS_DIR, { recursive: true });
  const fp = path.join(LANGS_DIR, lang + '.json');
  let cur = {}; try { cur = JSON.parse(await fs.readFile(fp, 'utf8')); } catch(_){}
  if(!cur || typeof cur !== 'object') cur = {};
  let added = 0;
  for(let [w, t] of pairs){ w = String(w || '').trim().toLowerCase(); t = String(t || '').trim(); if(!w || !t) continue; cur[w] = t.slice(0, 600); added++; }
  // ключи по алфавиту — файл стабилен в git
  const sorted = {}; for(const k of Object.keys(cur).sort()) sorted[k] = cur[k];
  await fs.writeFile(fp, JSON.stringify(sorted, null, 2), 'utf8');
  _kwDict = null;   // сбросить кэш — пересоберётся с новым языком
  return { added, total: Object.keys(cur).length, file: 'dict/langs/' + lang + '.json' };
}
// разовая миграция: если в базовом keyword-dict.json есть langs — вынести их в отдельные файлы
async function migrateLangsOut(){
  let base; try { base = JSON.parse(await fs.readFile(DICT_BASE, 'utf8')); } catch(_){ return; }
  if(!base.langs || !Object.keys(base.langs).length) return;
  for(const [lang, m] of Object.entries(base.langs)){ if(m && typeof m === 'object' && Object.keys(m).length) await saveLangDict(lang, Object.entries(m)); }
  delete base.langs;
  await fs.writeFile(DICT_BASE, JSON.stringify(base, null, 2), 'utf8');
  _kwDict = null;
}
// разовая миграция: сделать HTML и CSS обычными языками. Вливаем seed-секции базового файла
// (htmlTags/htmlAttrs → html.json, cssProps/cssVals → css.json) и убираем спец-секции.
// Записи пользователя в языковом файле ПОБЕЖДАЮТ (seed добавляется только для отсутствующих ключей). Идемпотентно.
async function migrateHtmlCssToLangs(){
  let base; try { base = JSON.parse(await fs.readFile(DICT_BASE, 'utf8')); } catch(_){ return; }
  const plan = [['html', ['htmlTags', 'htmlAttrs']], ['css', ['cssProps', 'cssVals']]];
  let changedBase = false;
  for(const [lang, sects] of plan){
    const seed = {};
    for(const s of sects){ if(base[s] && typeof base[s] === 'object') for(const [k, v] of Object.entries(base[s])) if(typeof v === 'string' && v.trim()) seed[k.toLowerCase()] = v; }
    const fp = path.join(LANGS_DIR, lang + '.json');
    let cur = {}; try { cur = JSON.parse(await fs.readFile(fp, 'utf8')); } catch(_){}
    if(!cur || typeof cur !== 'object') cur = {};
    const curLow = new Set(Object.keys(cur).map(x => x.toLowerCase()));
    let add = 0;
    for(const [k, v] of Object.entries(seed)){ if(!curLow.has(k)){ cur[k] = v.slice(0, 600); curLow.add(k); add++; } }
    if(add){ await fs.mkdir(LANGS_DIR, { recursive: true }); const sorted = {}; for(const kk of Object.keys(cur).sort()) sorted[kk] = cur[kk]; await fs.writeFile(fp, JSON.stringify(sorted, null, 2), 'utf8'); }
    for(const s of sects) if(base[s] !== undefined){ delete base[s]; changedBase = true; }
  }
  if(changedBase){ await fs.writeFile(DICT_BASE, JSON.stringify(base, null, 2), 'utf8'); _kwDict = null; }
}
// автоподпись слов из словаря: см. code-lab/lib/annotate.mjs

// объединённый импорт. Принимает: сборник {dict, pieces}, массив кусков, или один кусок
// ({code,...} или полноценный {lines,...} с готовой разметкой и пояснениями). Дополняет словарь
// (разделом dict и словами из кусков), создаёт/обновляет куски. Куски с готовыми lines берутся
// как есть (их e сохраняются), иначе код токенизируется и подписывается из словаря.
async function importBundle(b){
  const dictPath = path.join(PUBLIC, 'keyword-dict.json');
  let dict; try { dict = JSON.parse(await fs.readFile(dictPath, 'utf8')); } catch(_){ dict = {}; }
  for(const s of ['words','htmlTags','htmlAttrs','cssProps','cssVals']) if(!dict[s]) dict[s] = {};
  let learned = 0;
  const mergeInto = (obj, section) => { if(!obj || typeof obj !== 'object') return; for(const [k, v] of Object.entries(obj)){ if(typeof v === 'string' && v.trim() && dict[section][k.toLowerCase()] == null){ dict[section][k.toLowerCase()] = v.slice(0, 600); learned++; } } };
  // нормализация входа → pieces[] (+ верхнеуровневый dict)
  let pieces = [];
  if(Array.isArray(b)) pieces = b;
  else if(b && Array.isArray(b.pieces)) pieces = b.pieces;
  else if(b && (b.code != null || Array.isArray(b.lines) || b.title || b.lang)) pieces = [b];   // один кусок
  const topDict = b && !Array.isArray(b) ? b.dict : null;
  if(topDict){ mergeInto(topDict.words, 'words'); mergeInto(topDict.htmlTags, 'htmlTags'); mergeInto(topDict.htmlAttrs, 'htmlAttrs'); mergeInto(topDict.cssProps, 'cssProps'); mergeInto(topDict.cssVals, 'cssVals'); }
  for(const pc of pieces) mergeInto(pc && pc.words, 'words');
  await fs.writeFile(dictPath, JSON.stringify(dict, null, 2), 'utf8'); _kwDict = dict;
  let created = 0, updated = 0, skipped = 0; const warnings = [];
  // кусок описывает КОД: если «код» — это чисто русский текст, то грузят словарь как кусок (_looksProse)
  const looksProse = _looksProse;
  for(const pc of pieces){
    if(!pc || typeof pc !== 'object'){ skipped++; continue; }
    const lang = String(pc.lang || 'js').toLowerCase();
    const title = String(pc.title || 'Без названия').slice(0, 80);
    const hasLines = Array.isArray(pc.lines) && pc.lines.length > 0;
    const code = hasLines ? '' : String(pc.code || '');
    if(!hasLines && !code.trim()){ skipped++; continue; }
    if(!hasLines && looksProse(code)){ skipped++; warnings.push({ title, reason: 'в коде русский текст без кода — похоже на словарь/синонимы, а не кусок' }); continue; }
    const codeForDup = hasLines ? pc.lines.map(ln => (ln || []).map(t => (t && t.v) || '').join('')).join('\n') : code;
    // дубль: сначала точное совпадение (название+код), иначе — тот же КОД под другим названием
    const dup = (await findSameTemplate(title, codeForDup)) || (await findByCode(codeForDup));
    let obj;
    if(dup){ obj = await store.get(dup); obj.lang = lang; obj.title = title; if(pc.group) obj.group = String(pc.group).slice(0, 60); if(pc.desc) obj.desc = String(pc.desc).slice(0, 400); obj.lines = hasLines ? pc.lines : tokenize(code, lang); if(pc.output != null) obj.output = String(pc.output); updated++; }
    else { obj = { id: slug(title || lang), lang, group: (pc.group != null ? String(pc.group) : 'Мои куски').slice(0, 60), title, desc: String(pc.desc || '').slice(0, 400), lines: hasLines ? pc.lines : tokenize(code, lang), output: pc.output != null ? String(pc.output) : '', descAt: Date.now() }; if(pc.component && typeof pc.component === 'object') obj.component = pc.component; created++; }
    if(_CONTRACT_LANGS.has(lang) && !hasLines){ const c = codeContract(code, lang); obj.component = obj.component || {}; obj.component.provides = c.provides; obj.component.requires = c.requires; }
    annotateLines(obj.lines, lang, dict);   // автоподпись из словаря (уже с новыми словами); готовые e не трогает
    if(pc.words && typeof pc.words === 'object'){   // ручные пояснения куска — поверх авто
      const low = {}; for(const [k, v] of Object.entries(pc.words)) low[k.toLowerCase()] = v;
      for(const line of obj.lines) for(const t of line){ if(!t || t.k === 'sp' || t.k === 'op') continue; const e = low[String(t.v).toLowerCase()]; if(e) t.e = String(e).slice(0, 600); }
    }
    await store.save(obj, { origin: 'imported' });
  }
  return { ok: true, learned, created, updated, skipped, warnings, total: pieces.length };
}

// ── контракт куска: что он ОБЪЯВЛЯЕТ наружу (provides) и что БЕРЁТ со стороны (requires) ──────
// Один механизм на ВСЕ языки, без привилегий: имена (js/ts/python), DOM-селекторы (html/svg/css/js),
// CSS-переменные и @keyframes, таблицы SQL. autoConnect стыкует куски по общему токену.
const _GLOBALS = new Set(['console','document','window','globalThis','Math','JSON','Array','Object','Number','String','Boolean','Date','Map','Set','Promise','RegExp','Error','Symbol','fetch','setTimeout','setInterval','clearTimeout','clearInterval','requestAnimationFrame','parseInt','parseFloat','isNaN','isFinite','localStorage','sessionStorage','URL','URLSearchParams','true','false','null','undefined','NaN','Infinity']);
const _KWSET = new Set(['const','let','var','function','return','if','else','for','while','of','in','new','await','async','class','extends','super','try','catch','finally','throw','typeof','instanceof','this','break','continue','switch','case','do','yield','delete','void','import','export','from','default','static','get','set']);
const _PY_KW = new Set(['False','True','None','and','as','assert','async','await','break','class','continue','def','del','elif','else','except','finally','for','from','global','if','import','in','is','lambda','nonlocal','not','or','pass','raise','return','try','while','with','yield','match','case','self','cls']);
const _PY_BUILTIN = new Set(['print','len','range','int','str','float','list','dict','set','tuple','bool','type','enumerate','zip','map','filter','sum','min','max','abs','open','input','isinstance','issubclass','super','Exception','ValueError','KeyError','TypeError','IndexError','RuntimeError','StopIteration','sorted','reversed','any','all','round','format','repr','id','hash','object','property','staticmethod','classmethod','next','iter','getattr','setattr','hasattr','vars','dir','bytes','bytearray','frozenset','complex','divmod','pow','chr','ord','hex','oct','bin','slice','callable','globals','locals','__name__']);
const _HEX = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;   // не путать id-селектор с hex-цветом
// html/svg: элемент с id/классом — его создаёт эта разметка (provides)
function markupAnchors(t, provides){
  for(const m of t.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)) provides.add('#' + m[1].trim());
  for(const m of t.matchAll(/\bclass\s*=\s*["']([^"']+)["']/g)) m[1].trim().split(/\s+/).forEach(c => c && provides.add('.' + c));
}
// css: стилизует селекторы (requires #id/.class), объявляет @keyframes и --переменные (provides), берёт var()/animation (requires)
function cssAnchors(t, provides, requires){
  for(const block of t.split('}')){ const sel = block.split('{')[0];   // селекторная часть — без значений (hex-цвета)
    for(const m of sel.matchAll(/#([A-Za-z_][\w-]*)/g)) requires.add('#' + m[1]);
    for(const m of sel.matchAll(/\.([A-Za-z_][\w-]*)/g)) requires.add('.' + m[1]); }
  for(const m of t.matchAll(/@keyframes\s+([A-Za-z_][\w-]*)/g)) provides.add('@' + m[1]);                 // анимация объявлена тут
  for(const m of t.matchAll(/(--[A-Za-z_][\w-]*)\s*:/g)) provides.add(m[1]);                              // --переменная задана тут
  for(const m of t.matchAll(/var\(\s*(--[A-Za-z_][\w-]*)/g)) requires.add(m[1]);                          // var(--x) — нужна переменная
  for(const m of t.matchAll(/animation(?:-name)?\s*:\s*([^;}]+)/g)) for(const w of (m[1].match(/[A-Za-z_][\w-]*/g) || [])) requires.add('@' + w);
}
// js/ts: куда пишет (requires #sel), что помечает id/классом (provides), какие @keyframes/--vars трогает
function scriptDomAnchors(t, provides, requires){
  for(const m of t.matchAll(/querySelector(?:All)?\(\s*["'`]([^"'`]+)["'`]/g)) for(const s of (m[1].match(/[#.][A-Za-z_][\w-]*/g) || [])) requires.add(s);
  for(const m of t.matchAll(/getElementById\(\s*["'`]([^"'`]+)["'`]/g)) requires.add('#' + m[1].trim());
  for(const m of t.matchAll(/getElementsByClassName\(\s*["'`]([^"'`]+)["'`]/g)) m[1].trim().split(/\s+/).forEach(c => c && requires.add('.' + c));
  for(const m of t.matchAll(/\.id\s*=\s*["'`]([^"'`]+)["'`]/g)) provides.add('#' + m[1].trim());
  for(const m of t.matchAll(/setAttribute\(\s*["'`]id["'`]\s*,\s*["'`]([^"'`]+)["'`]/g)) provides.add('#' + m[1].trim());
  for(const m of t.matchAll(/classList\.add\(\s*["'`]([^"'`]+)["'`]/g)) provides.add('.' + m[1].trim());
}
// js/ts: имена, объявленные наружу, и имена, взятые со стороны (строки/комменты вырезаны)
function jsIdents(code, provides, requires){
  const txt = String(code || '').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1 ').replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, ' ');
  const ID = '[A-Za-zА-Яа-яЁё_$][\\wА-Яа-яЁё$]*';
  for(const m of txt.matchAll(new RegExp('(?:const|let|var|function|class)\\s+(' + ID + ')', 'g'))) provides.add(m[1]);
  const local = new Set(provides);
  const addParams = s => String(s || '').split(',').forEach(p => { const m = p.trim().match(new RegExp('^(' + ID + ')')); if(m) local.add(m[1]); });
  for(const m of txt.matchAll(new RegExp('function\\s*' + ID + '?\\s*\\(([^)]*)\\)', 'g'))) addParams(m[1]);
  for(const m of txt.matchAll(/\(([^)]*)\)\s*=>/g)) addParams(m[1]);
  for(const m of txt.matchAll(new RegExp('(' + ID + ')\\s*=>', 'g'))) local.add(m[1]);
  for(const m of txt.matchAll(new RegExp('catch\\s*\\(\\s*(' + ID + ')', 'g'))) local.add(m[1]);
  for(const m of txt.matchAll(new RegExp('for\\s*\\(\\s*(?:const|let|var)?\\s*(' + ID + ')', 'g'))) local.add(m[1]);
  for(const m of txt.matchAll(new RegExp('(' + ID + ')', 'g'))){
    const w = m[1]; const i = m.index || 0;
    if(i > 0 && txt[i - 1] === '.') continue;             // свойство после точки — не внешняя зависимость
    if(_KWSET.has(w) || _GLOBALS.has(w) || local.has(w)) continue;
    requires.add(w);
  }
}
// python: def/class/присваивание на верхнем уровне → provides; импорты/параметры/локальные → не requires
function pyIdents(code, provides, requires){
  const t = String(code || '').replace(/'''[\s\S]*?'''/g, ' ').replace(/"""[\s\S]*?"""/g, ' ').replace(/#[^\n]*/g, ' ').replace(/'(?:\\.|[^'\\])*'/g, ' ').replace(/"(?:\\.|[^"\\])*"/g, ' ');
  const ID = '[A-Za-z_][A-Za-z0-9_]*';
  for(const m of t.matchAll(new RegExp('(?:^|\\n)\\s*(?:async\\s+)?def\\s+(' + ID + ')', 'g'))) provides.add(m[1]);
  for(const m of t.matchAll(new RegExp('(?:^|\\n)\\s*class\\s+(' + ID + ')', 'g'))) provides.add(m[1]);
  for(const m of t.matchAll(new RegExp('(?:^|\\n)(' + ID + ')\\s*=(?!=)', 'g'))) provides.add(m[1]);   // модульная переменная (с начала строки)
  const local = new Set(provides);
  for(const m of t.matchAll(new RegExp('import\\s+(' + ID + ')', 'g'))) local.add(m[1]);
  for(const m of t.matchAll(new RegExp('\\bas\\s+(' + ID + ')', 'g'))) local.add(m[1]);
  for(const m of t.matchAll(new RegExp('from\\s+' + ID + '(?:\\.' + ID + ')*\\s+import\\s+([^\\n]+)', 'g'))) m[1].split(',').forEach(x => { const mm = x.trim().match(new RegExp('^(' + ID + ')')); if(mm) local.add(mm[1]); });
  for(const m of t.matchAll(new RegExp('(' + ID + ')\\s*=(?!=)', 'g'))) local.add(m[1]);                // любое присваивание — локальное имя
  for(const m of t.matchAll(new RegExp('def\\s+' + ID + '\\s*\\(([^)]*)\\)', 'g'))) m[1].split(',').forEach(p => { const mm = p.trim().match(new RegExp('^\\*{0,2}(' + ID + ')')); if(mm) local.add(mm[1]); });
  for(const m of t.matchAll(new RegExp('lambda\\s+([^:]*):', 'g'))) m[1].split(',').forEach(p => { const mm = p.trim().match(new RegExp('^(' + ID + ')')); if(mm) local.add(mm[1]); });
  for(const m of t.matchAll(new RegExp('for\\s+(' + ID + ')', 'g'))) local.add(m[1]);
  for(const m of t.matchAll(new RegExp('(' + ID + ')', 'g'))){
    const w = m[1]; const i = m.index || 0;
    if(i > 0 && t[i - 1] === '.') continue;
    if(w.length < 2 || !/[A-Za-z]/.test(w) || _PY_KW.has(w) || _PY_BUILTIN.has(w) || local.has(w)) continue;   // без букв (напр. _000 из 1_000) — не имя
    requires.add(w);
  }
}
// sql: CREATE TABLE/VIEW/… → provides tbl:имя; FROM/JOIN/INTO/UPDATE → requires tbl:имя (имена в своём namespace)
function sqlAnchors(code, provides, requires){
  const t = String(code || '').replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/'(?:''|[^'])*'/g, ' ');
  const NAME = '[`"\\[]?([A-Za-z_][A-Za-z0-9_$.]*)[`"\\]]?';
  for(const m of t.matchAll(new RegExp('create\\s+(?:or\\s+replace\\s+)?(?:global\\s+|local\\s+)?(?:temp(?:orary)?\\s+)?(?:table|view|materialized\\s+view|index|sequence)\\s+(?:if\\s+not\\s+exists\\s+)?' + NAME, 'gi'))) provides.add('tbl:' + m[1].toLowerCase());
  for(const m of t.matchAll(new RegExp('(?:\\bfrom|\\bjoin|\\binto|\\bupdate|delete\\s+from)\\s+' + NAME, 'gi'))) requires.add('tbl:' + m[1].toLowerCase());
}
function codeContract(code, lang){
  lang = String(lang || 'js').toLowerCase();
  const raw = String(code || '');
  const provides = new Set(), requires = new Set();
  if(lang === 'js' || lang === 'ts'){ jsIdents(raw, provides, requires); scriptDomAnchors(raw, provides, requires); }
  else if(lang === 'python'){ pyIdents(raw, provides, requires); }
  else if(lang === 'html' || lang === 'svg'){ markupAnchors(raw, provides); }
  else if(lang === 'css'){ cssAnchors(raw, provides, requires); }
  else if(lang === 'sql'){ sqlAnchors(raw, provides, requires); }
  for(const s of [...requires]){ if(provides.has(s) || _HEX.test(s)) requires.delete(s); }   // своё не требуем; hex — не селектор
  for(const s of [...provides]) if(_HEX.test(s)) provides.delete(s);
  return { provides: [...provides].slice(0, 60), requires: [...requires].slice(0, 60) };
}
const _CONTRACT_LANGS = new Set(['js', 'ts', 'html', 'svg', 'css', 'python', 'sql']);

function slug(s){
  const base = String(s || 'tpl').toLowerCase().replace(/[^\wа-яё]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'tpl';
  return base + '-' + Date.now().toString(36);
}

// что из 8 граней описано/видно у куска — для колонки «описано» в Описи
function coverage(j){
  const c = j.component || {}, s = c.summary || {}, v = c.views || {};
  const code = j._code != null ? String(j._code) : (Array.isArray(j.lines) ? j.lines.map(l => (l || []).map(k => k.v != null ? k.v : '').join('')).join('\n') : '');
  const effects = { dom: /\bdocument\.|innerHTML|\.style\b|createElement|appendChild|querySelector/.test(code), storage: /localStorage|sessionStorage|indexedDB/.test(code), net: /\bfetch\(|XMLHttpRequest|\.ajax\(/.test(code), timers: /setInterval|setTimeout|requestAnimationFrame/.test(code) };
  const envBrowser = /\bdocument\b|\bwindow\b|localStorage|querySelector/.test(code);
  const envNode = /\brequire\(|\bprocess\.|module\.exports|__dirname/.test(code);
  return {
    inputs:  !!(s.input) || (Array.isArray(c.requires) && c.requires.length > 0),
    outputs: !!(s.output) || (Array.isArray(c.provides) && c.provides.length > 0),
    env:     !!(c.tags && Array.isArray(c.tags.runtime) && c.tags.runtime.length) || envBrowser || envNode,
    pre:     Array.isArray(s.requirements) && s.requirements.length > 0,
    effects: effects.dom || effects.storage || effects.net || effects.timers,
    errors:  !!(c.safety && c.safety.level) || !!(v.check && (v.check.pitfalls || v.check.errors)) || (Array.isArray(c.verification) && c.verification.length > 0),
    links:   Array.isArray(c.requires) && c.requires.length > 0,
    check:   !!(v.check && (v.check.expected_result || v.check.how)) || (Array.isArray(c.verification) && c.verification.length > 0)
  };
}
async function listTemplates(){ return store.rows(); }
// найти уже существующий кусок с таким же названием и кодом (для дедупа при добавлении) → id или null
// нормализуем переводы строк (\r\n → \n), иначе «тот же» код из Windows-файла считается другим → дубли
const _normCode = store.normCode;
async function findSameTemplate(title, code){
  const wantT = String(title || '').trim().toLowerCase(), wantC = _normCode(code);
  for(const e of await store.entries()){ if((e.title || '').trim().toLowerCase() === wantT && _normCode(e.code) === wantC) return e.id; }
  return null;
}
// дубль по коду, даже под другим названием: тот же код — тот же кусок (пустой код не считаем)
async function findByCode(code){
  const wantC = _normCode(code); if(!wantC) return null;
  for(const e of await store.entries()){ if(_normCode(e.code) === wantC) return e.id; }
  return null;
}

// ── запуск кода на установленных у пользователя языках ───────────────────────
// Карта: язык → чем запускать (bin + аргументы) и расширение файла. Каждая запись
// выполняет НАСТОЯЩИЙ код на машине пользователя — поэтому только локально.
const RUNNERS = {
  javascript:{ bin:'node',    ext:'js'  }, js:{ bin:'node', ext:'js' }, node:{ bin:'node', ext:'js' },
  python:    { bin:'python3', ext:'py', alt:'python' }, py:{ bin:'python3', ext:'py', alt:'python' },
  ruby:      { bin:'ruby',    ext:'rb'  }, rb:{ bin:'ruby', ext:'rb' },
  php:       { bin:'php',     ext:'php' },
  perl:      { bin:'perl',    ext:'pl'  }, pl:{ bin:'perl', ext:'pl' },
  lua:       { bin:'lua',     ext:'lua' },
  bash:      { bin:'bash',    ext:'sh'  }, sh:{ bin:'bash', ext:'sh' }, shell:{ bin:'bash', ext:'sh' },
  powershell:{ bin:'pwsh',    ext:'ps1' }, ps1:{ bin:'pwsh', ext:'ps1' },
  r:         { bin:'Rscript', ext:'R'   },
  go:        { bin:'go', args:['run'],  ext:'go' },
  tsx:       { bin:'npx', args:['-y','tsx'], ext:'ts' }, typescript:{ bin:'npx', args:['-y','tsx'], ext:'ts' }, ts:{ bin:'npx', args:['-y','tsx'], ext:'ts' }
};
function runnerFor(lang){ return RUNNERS[String(lang || '').trim().toLowerCase()] || null; }
const _runExec = (bin, args, opts) => new Promise(resolve => {
  const child = execFile(bin, args, opts, (err, stdout, stderr) => {
    resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || ''), code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0), signal: err && err.signal, enoent: err && err.code === 'ENOENT', timedOut: err && err.killed });
  });
});
// какие языки реально установлены — пробуем bin с безобидным аргументом версии
let _langCache = null;
async function detectLangs(){
  if(_langCache) return _langCache;
  const bins = {}; Object.values(RUNNERS).forEach(r => { bins[r.bin] = r; });
  const avail = {};
  for(const [bin, r] of Object.entries(bins)){
    const verArg = bin === 'go' ? 'version' : '--version';
    const res = await _runExec(bin, [verArg], { timeout: 4000, maxBuffer: 1 << 20 }).catch(() => ({ enoent: true }));
    avail[bin] = !res.enoent;   // любой ответ (даже с ошибкой флага) значит, что бинарь есть
  }
  // понятные названия установленных языков (по одному на интерпретатор)
  const LABEL = { node:'JavaScript', python3:'Python', ruby:'Ruby', php:'PHP', perl:'Perl', lua:'Lua', bash:'Bash', pwsh:'PowerShell', Rscript:'R', go:'Go', npx:'TypeScript' };
  const langs = Object.keys(avail).filter(b => avail[b]).map(b => LABEL[b] || b);
  _langCache = { langs, bins: avail };
  return _langCache;
}
async function runCode(lang, code){
  const r = runnerFor(lang);
  if(!r) return { ok:false, error:'Язык «' + lang + '» пока не поддержан для запуска. Поддержаны: ' + [...new Set(Object.values(RUNNERS).map(x=>x.bin))].join(', ') };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codelab-run-'));
  const file = path.join(dir, 'code.' + r.ext);
  try {
    await fs.writeFile(file, String(code == null ? '' : code), 'utf8');
    const tryBins = [r.bin].concat(r.alt ? [r.alt] : []);
    let res = null;
    for(const bin of tryBins){
      res = await _runExec(bin, (r.args || []).concat(file), { timeout: 10000, maxBuffer: 2 << 20, cwd: dir });
      if(!res.enoent) break;   // бинарь найден — не пробуем запасной
    }
    if(res.enoent) return { ok:false, error:'Не найден интерпретатор «' + r.bin + '»' + (r.alt ? ' (и «' + r.alt + '»)' : '') + '. Похоже, язык не установлен.' };
    return { ok:true, stdout: res.stdout.slice(0, 200000), stderr: res.stderr.slice(0, 200000), code: res.code, timedOut: !!res.timedOut };
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    // ── защита от чужих сайтов и подмены адреса (DNS rebinding): сервер умеет писать файлы и запускать код ──
    if(u.pathname.startsWith('/api/') || u.pathname.startsWith('/vendor/')){
      if(!isLocalHost(req.headers.host)) return json(res, 403, { error: 'запрещено: открывайте сервер по адресу http://localhost:' + PORT });
      if(req.headers.origin && !isLocalOrigin(req.headers.origin)) return json(res, 403, { error: 'запрещено: запрос с чужой страницы' });
    }

    // ── ИИ-сервисы: выбранный провайдер и проверка ключа (ключи в файлы не пишутся) ──
    if(u.pathname.startsWith('/api/ai/')){
      if(!aiLocalOnly(req)) return json(res, 403, { error: 'Запрос отклонён: чужой адрес или источник.' });
      if(u.pathname === '/api/ai/config' && req.method === 'GET') return json(res, 200, { config: aiRuntime.getConfig() });
      if(req.method === 'POST' && req.headers['x-code-lab'] !== '1') return json(res, 403, { error: 'Нужен заголовок X-Code-Lab.' });
      if(u.pathname === '/api/ai/config' && req.method === 'POST'){
        const b = await readBody(req);
        const allowed = {}; for(const k of ['type', 'model', 'baseUrl', 'scope', 'authUrl', 'caPath', 'insecureTls']) if(k in b) allowed[k] = b[k];
        return json(res, 200, { config: await aiRuntime.save(allowed) });
      }
      if(u.pathname === '/api/ai/models' && req.method === 'POST'){
        const b = await readBody(req);
        const key = String(req.headers['x-mistral-api-key'] || '').trim();
        try { return json(res, 200, { models: await aiRuntime.listModels({ ...aiRuntime.getConfig(), type: b.type, model: b.model, baseUrl: b.baseUrl, scope: b.scope }, key) }); }
        catch(e){ return json(res, 502, { error: String(e?.message || e) }); }
      }
    }
    if(u.pathname === '/api/describe' && req.method === 'POST'){
      const b = await readBody(req);
      const requestKey = String(req.headers['x-mistral-api-key'] || '').trim();
      if (requestKey) describeQueue.setApiKey(requestKey);
      if (!requestKey && !process.env.MISTRAL_API_KEY) return json(res, 503, { error: 'Добавьте API-ключ Mistral в Настройках лаборатории.' });
      const ids = Array.isArray(b.ids) ? [...new Set(b.ids.map(String))] : null;
      try { return json(res, 202, await describeQueue.start({ ids, apiKey: requestKey || null })); }
      catch (e) { return json(res, 503, { error: String(e?.message || e) }); }
    }
    // ── ИИ-создание новых кусков ────────────────────────────────────────
    // языки, которые можно дополнять, и сколько кусков в каждом уже есть
    if(u.pathname === '/api/ai-langs'){
      const counts = {}; for(const r of await store.rows()) counts[r.lang] = (counts[r.lang] || 0) + 1;
      return json(res, 200, { langs: AI_LANGS, counts });
    }
    // необязательно: «чего здесь не хватает?» → темы для подстановки в поле. Тело: { lang }. Ничего не сохраняет.
    if(u.pathname === '/api/ai-gaps' && req.method === 'POST'){
      const b = await readBody(req);
      const key = String(req.headers['x-mistral-api-key'] || '').trim();
      try { return json(res, 200, await aiGenerate.gaps({ lang: b.lang, key })); }
      catch(e){ const m = String(e?.message || e); return json(res, /ключ Mistral/.test(m) ? 503 : /Неизвестный язык/.test(m) ? 400 : 502, { error: m }); }
    }
    // шаг 1: предложить. Тело: { lang, topic, count, instruction }. Ничего не сохраняет и не запускает.
    if(u.pathname === '/api/ai-generate' && req.method === 'POST'){
      const b = await readBody(req);
      const key = String(req.headers['x-mistral-api-key'] || '').trim();
      try { return json(res, 200, await aiGenerate.propose({ lang: b.lang, topic: b.topic, count: b.count, instruction: b.instruction, key })); }
      catch(e){ const m = String(e?.message || e); return json(res, /ключ Mistral/.test(m) ? 503 : /Неизвестный язык/.test(m) ? 400 : 502, { error: m }); }
    }
    // шаг 2: создать то, что человек отметил (после правок). Тело: { pieces:[{title,lang,group,desc,output,tags,aliases,code}] }
    if(u.pathname === '/api/ai-create' && req.method === 'POST'){
      const b = await readBody(req);
      const list = Array.isArray(b.pieces) ? b.pieces.slice(0, 20) : [];
      const created = [], skipped = [];
      const dict = await kwDict();
      for(const p of list){
        const lang = String(p.lang || '').toLowerCase(), title = String(p.title || '').trim().slice(0, 80), code = String(p.code || '').replace(/\u0000/g, '');
        if(!AI_LANGS[lang]){ skipped.push({ title, reason: 'неизвестный язык' }); continue; }
        if(!title || !code.trim() || code.length > 20000){ skipped.push({ title, reason: 'нет названия или кода (или код слишком длинный)' }); continue; }
        const dup = await findByCode(code);
        if(dup){ skipped.push({ title, reason: 'такой код уже есть', id: dup }); continue; }
        let id = slug(title), n = 2; while(await store.has(id)) id = slug(title) + '-' + (n++);
        const group = String(p.group || 'Мои шаблоны').trim().slice(0, 60) || 'Мои шаблоны';
        const segs = group.split('/').map(x => x.trim()).filter(Boolean);
        const tidy = a => [...new Set((Array.isArray(a) ? a : []).map(x => String(x).trim().slice(0, 60)).filter(Boolean))].slice(0, 8);
        const obj = {
          id, lang, group, title, desc: String(p.desc || '').trim().slice(0, 400), output: String(p.output || '').trim().slice(0, 300),
          tags: tidy(p.tags), aliases: tidy(p.aliases), descAt: Date.now(),
          lines: tokenize(code, lang),
          component: {
            type: 'fragment',
            tags: { purpose: [segs[0] || 'Мои шаблоны'], technology: [AI_LANGS[lang]] },
            subcat: segs.slice(1).join(' / ') || 'Разное',
            summary: { output: String(p.output || '').trim().slice(0, 300) },
            generated: { by: 'ai', at: new Date().toISOString(), note: 'создано ИИ; код не запускался и не проверялся человеком' },
            verification: { code_review: 'not_verified', tests: 'not_run', compatibility: 'not_verified' },
          },
        };
        if(_CONTRACT_LANGS.has(lang)){ const c = codeContract(code, lang); obj.component.provides = c.provides; obj.component.requires = c.requires; }
        annotateLines(obj.lines, lang, dict);
        try { await store.save(obj, { origin: 'ai' }); created.push({ id, title }); }
        catch(e){ skipped.push({ title, reason: String(e?.message || e) }); }
      }
      return json(res, 200, { created, skipped });
    }

    // ИИ-дополнение раздела куска. Шаг 1: предложить (ничего не сохраняет). Тело: { id | piece:{title,lang,code,desc}, section, instruction }
    if(u.pathname === '/api/ai-complete' && req.method === 'POST'){
      const b = await readBody(req);
      const key = String(req.headers['x-mistral-api-key'] || '').trim();
      try { return json(res, 200, await aiAssist.suggest({ id: b.id, piece: b.piece, section: String(b.section || ''), instruction: b.instruction, key })); }
      catch(e){ const m = String(e?.message || e); return json(res, /ключ Mistral/.test(m) ? 503 : /не найден|нет кода|Неизвестный/.test(m) ? 400 : 502, { error: m }); }
    }
    // свободный вопрос к ИИ о коде: {code, action|question, lang}. Ответ — обычный текст (не JSON-схема).
    if(u.pathname === '/api/ai-ask' && req.method === 'POST'){
      const b = await readBody(req);
      const key = String(req.headers['x-mistral-api-key'] || '').trim();
      if(!key) return json(res, 503, { error: 'Не задан ключ ИИ. Открой Настройки и сохрани API-ключ.' });
      const code = String(b.code || '').slice(0, 12000), lang = String(b.lang || '').slice(0, 20);
      const q = String(b.question || '').slice(0, 1000);
      const ACTIONS = {
        explain: 'Объясни простыми словами, по-русски, что делает этот код и зачем. Коротко и по делу.',
        bugs: 'Найди возможные баги, ошибки и слабые места в этом коде. Перечисли конкретные проблемы и как их починить. Если явных багов нет — так и скажи.',
        improve: 'Предложи, как улучшить этот код: читаемость, надёжность, краткость. Короткий список конкретных правок.',
        tests: 'Предложи, что и как стоит проверить/протестировать в этом коде. Короткий список случаев (включая граничные).'
      };
      const task = ACTIONS[b.action] || (q ? q : ACTIONS.explain);
      if(!code.trim() && !q){ return json(res, 400, { error: 'Нечего спрашивать: выдели код или впиши вопрос.' }); }
      const sys = 'Ты внимательный помощник-программист. Отвечай по-русски, кратко и по делу, без воды и без Markdown-заголовков. Не выдумывай того, чего в коде нет.';
      const user = task + (code.trim() ? ('\n\nКод' + (lang ? ' (' + lang + ')' : '') + ':\n```\n' + code + '\n```') : '');
      try {
        const cfg = aiRuntime.getConfig();
        const resp = await aiRuntime.chat(cfg, key, { temperature: 0.3, max_tokens: 900, messages: [ { role: 'system', content: sys }, { role: 'user', content: user } ] });
        if(!resp.ok){
          const t = await resp.text();
          if(resp.status === 429){ const ra = (resp.headers.get && resp.headers.get('retry-after')) || ''; return json(res, 429, { error: 'ИИ отвечает «слишком часто» (429 — лимит запросов тарифа)' + (ra ? '. Повтори через ' + ra + ' сек.' : '. Подожди 10–60 сек и повтори, или выдели меньше кода.') }); }
          return json(res, 502, { error: 'ИИ вернул ошибку ' + resp.status + ': ' + t.slice(0, 300) });
        }
        const data = await resp.json();
        let content = data?.choices?.[0]?.message?.content;
        if(Array.isArray(content)) content = content.map(x => x.text || '').join('');
        return json(res, 200, { answer: String(content || '').trim() || '(пустой ответ)' });
      } catch(e){ return json(res, 502, { error: 'Не удалось связаться с ИИ: ' + String(e?.message || e) }); }
    }

    // Шаг 2: записать то, что человек принял (после правок). Тело: { id, section, value }
    if(u.pathname === '/api/ai-apply' && req.method === 'POST'){
      const b = await readBody(req);
      try { return json(res, 200, await aiAssist.apply({ id: b.id, section: String(b.section || ''), value: b.value })); }
      catch(e){ return json(res, 400, { error: String(e?.message || e) }); }
    }
    // ── CodeMirror: проверить → скачать → проверить на библиотеке → включить / откатить. Всё по кнопкам со страницы vendor.html ──
    if(u.pathname.startsWith('/vendor/cm/') || u.pathname.startsWith('/api/vendor/')){
      const origin = req.headers.origin;
      if(origin && !isLocalOrigin(origin)) return json(res, 403, { error: 'запрещено: запрос с чужой страницы' });
      if(u.pathname.startsWith('/vendor/cm/') && req.method === 'GET'){
        const mm = /^\/vendor\/cm\/(5\.\d+\.\d+)\/(.+)$/.exec(u.pathname);
        let rel = null; try { rel = mm && decodeURIComponent(mm[2]); } catch(_){}
        const abs = rel && vendor.resolveFile(mm[1], rel);
        const data = abs ? await fs.readFile(abs).catch(() => null) : null;
        if(!data) return json(res, 404, { error: 'not found' });
        // файлы версии не меняются никогда (проверяются по sha256), поэтому кэш вечный
        res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000, immutable' });
        return res.end(data);
      }
      if(u.pathname === '/api/vendor/active') return json(res, 200, vendor.activeInfo());
      if(u.pathname === '/api/vendor/status'){
        const counts = {};
        for(const en of await store.entries()){ const l = String(en.lang || (en.meta && en.meta.lang) || 'txt').toLowerCase(); counts[l] = (counts[l] || 0) + 1; }
        const langs = Object.entries(counts).map(([lang, count]) => ({ lang, count })).sort((a, b) => b.count - a.count);
        return json(res, 200, { ...(await vendor.status()), langs });
      }
      if(u.pathname === '/api/vendor/sample'){      // куски библиотеки для проверки новой версии подсветки (только чтение)
        const entries = (await store.entries()).map(en => ({ id: en.id, lang: String(en.lang || (en.meta && en.meta.lang) || 'txt').toLowerCase(), code: String(en.code || '').slice(0, 20000) }));
        return json(res, 200, { entries });
      }
      if(req.method === 'POST'){
        if(req.headers['x-code-lab'] !== '1') return json(res, 403, { error: 'запрещено' });
        const b = await readBody(req);
        const wrap = async fn => { try { return json(res, 200, await fn()); } catch(e){ return json(res, e && e.name === 'VendorError' ? 400 : 500, { error: String(e && e.message || e), code: e && e.code }); } };
        if(u.pathname === '/api/vendor/check') return wrap(() => vendor.check());
        if(u.pathname === '/api/vendor/install') return wrap(() => vendor.install(String(b.version || ''), { allowYoung: b.allowYoung === true }));
        if(u.pathname === '/api/vendor/activate') return wrap(() => vendor.activate(String(b.version || '')));
        if(u.pathname === '/api/vendor/rollback') return wrap(() => vendor.rollback());
        if(u.pathname === '/api/vendor/deactivate') return wrap(() => vendor.deactivate());
        if(u.pathname === '/api/vendor/remove') return wrap(() => vendor.remove(String(b.version || '')));
        if(u.pathname === '/api/vendor/verify') return wrap(() => vendor.verify(String(b.version || '')));
        if(u.pathname === '/api/vendor/test-result') return wrap(() => vendor.recordTest(String(b.version || ''), b.result));
      }
      return json(res, 404, { error: 'not found' });
    }

    if(u.pathname === '/api/jobs') {
      const requestKey = String(req.headers['x-mistral-api-key'] || '').trim();
      if (requestKey) describeQueue.setApiKey(requestKey);
      return json(res, 200, await describeQueue.get());
    }

    if(u.pathname === '/api/list'){ return json(res, 200, await listTemplates()); }

    // поиск по всей библиотеке: ?q=слова&limit=60 → { hits:[{id, score, why:[…]}], total, terms }
    if(u.pathname === '/api/search'){
      const q = u.searchParams.get('q') || '';
      const limit = Math.min(200, Number(u.searchParams.get('limit')) || 60);
      return json(res, 200, await search.search(q, { limit }));
    }

    // «на что похоже»: сравнить присланный код с кусками библиотеки по общим токенам (Жаккар).
    // {code, lang?, exclude?} → { hits:[{id,title,lang,score, shared:[токены]}] } — похожие фрагменты.
    if(u.pathname === '/api/similar' && req.method === 'POST'){
      const b = await readBody(req);
      const toks = s => { const set = new Set(); const m = String(s || '').toLowerCase().match(/[a-zа-яё_$][\wа-яё$-]{1,}/gi) || []; for(const t of m) if(t.length > 1) set.add(t); return set; };
      const A = toks(b.code); if(!A.size) return json(res, 200, { hits: [] });
      const lang = String(b.lang || '').toLowerCase();
      const hits = [];
      for(const e of await store.entries()){
        if(b.exclude && e.id === b.exclude) continue;
        const B = toks(e.code); if(!B.size) continue;
        let inter = 0; const shared = []; for(const t of A) if(B.has(t)){ inter++; if(shared.length < 8) shared.push(t); }
        if(!inter) continue;
        let score = inter / (A.size + B.size - inter);   // Жаккар
        if(lang && e.lang && e.lang.toLowerCase() === lang) score *= 1.15;   // тот же язык — чуть выше
        hits.push({ id: e.id, title: e.title || e.id, lang: e.lang || '', score: Math.round(score * 100), shared });
      }
      hits.sort((x, y) => y.score - x.score);
      return json(res, 200, { hits: hits.filter(h => h.score > 0).slice(0, 20) });
    }

    if(await handleWorkspace(req, res, u, { readBody, json, root: ROOT })) return;   // рабочая папка проекта (/api/ws/*)
    if(u.pathname === '/api/template'){
      const t = await store.get(u.searchParams.get('id'));
      if(!t) return json(res, 404, { error: 'нет такого шаблона' });
      return json(res, 200, t);
    }

    // создать шаблон из вставленного кода
    if(u.pathname === '/api/add' && req.method === 'POST'){
      const b = await readBody(req);
      const lang = String(b.lang || 'js').toLowerCase();
      const code = String(b.code || '');
      const title = String(b.title || 'Без названия').slice(0, 80);
      // дедуп: тот же код (точное совпадение по названию+коду или просто тот же код) — обновляем, не плодим
      const dupId = (await findSameTemplate(title, code)) || (await findByCode(code));
      if(dupId){
        const j = await store.get(dupId);
        j.lang = lang; j.title = title;
        if(b.group != null) j.group = String(b.group).slice(0, 60) || j.group;
        if(b.desc) j.desc = String(b.desc).slice(0, 400);
        if(b.component && typeof b.component === 'object') j.component = Object.assign({}, j.component, b.component);
        await store.save(j);
        return json(res, 200, { id: j.id || dupId, dedup: true });
      }
      const obj = {
        id: slug(title || lang),
        lang, group: String(b.group || 'Мои шаблоны').slice(0, 60),
        title,
        desc: String(b.desc || '').slice(0, 400),
        lines: tokenize(code, lang),
        output: b.output != null ? String(b.output) : '',
        descAt: Date.now(),   // когда описание задано/изменено — для авто-сведения по дате
      };
      if(b.component && typeof b.component === 'object') obj.component = b.component;   // метаданные компонента (теги осей, подкатегория, контракт)
      if(_CONTRACT_LANGS.has(lang)){ const c = codeContract(code, lang); obj.component = obj.component || {}; obj.component.provides = c.provides; obj.component.requires = c.requires; }
      annotateLines(obj.lines, lang, await kwDict());   // автоподпись ключевых слов из словаря
      await store.save(obj);
      return json(res, 200, { id: obj.id });
    }

    // вписать/изменить пояснение к конкретному слову (сохраняется в файл)
    if(u.pathname === '/api/annotate' && req.method === 'POST'){
      const b = await readBody(req);
      const j = await store.get(b.id);
      if(!j) return json(res, 404, { error: 'нет такого шаблона' });
      const tok = j.lines && j.lines[b.line] && j.lines[b.line][b.idx];
      if(!tok) return json(res, 400, { error: 'не нашлось слово' });
      tok.e = String(b.e || '').slice(0, 600);
      await store.save(j);
      return json(res, 200, { ok: true });
    }

    // автоподпись из словаря теперь происходит при каждой загрузке куска, поэтому писать ничего не нужно
    if(u.pathname === '/api/annotate-all' && req.method === 'POST'){
      return json(res, 200, { ok: true, files: 0, added: 0, total: await store.count(), note: 'пояснения из словаря подставляются автоматически при загрузке' });
    }

    // убрать дубли: куски с одинаковым кодом схлопнуть в один (оставить самый полный)
    if(u.pathname === '/api/dedup' && req.method === 'POST'){
      const ents = await store.entries();
      const byCode = new Map();
      for(const e of ents){
        const code = _normCode(e.code); if(!code) continue;   // пустой код не трогаем
        const key = (e.lang || '') + '\u0000' + code;          // одинаковый код В ТОМ ЖЕ языке
        if(!byCode.has(key)) byCode.set(key, []);
        byCode.get(key).push(e);
      }
      // оценка «полноты»: есть раздел, описание, пояснения к словам — такой оставляем
      const score = e => { let n = 0; if(String(e.meta.group || '').trim()) n += 3; if(String(e.meta.desc || '').trim()) n += 2; return n + Math.min((e.meta.wordNotes || []).filter(w => w.source === 'custom').length, 20); };
      let removed = 0, groups = 0;
      for(const [, arr] of byCode){
        if(arr.length < 2) continue;
        groups++;
        arr.sort((a, b) => score(b) - score(a));   // лучший — первым, его оставляем
        for(let i = 1; i < arr.length; i++){ if(await store.remove(arr[i].id)) removed++; }
      }
      return json(res, 200, { ok: true, groups, removed, total: ents.length });
    }

    // объединённый импорт: один код-файл, полноценный кусок JSON, массив кусков или сборник {dict,pieces}
    // пачка кусков одним текстом (txt) → файлы в library/. dry:true — только показать, что получится
    if(u.pathname === '/api/ingest' && req.method === 'POST'){
      const b = await readBody(req);
      const { pieces, warnings } = parseSnippets(b.text, { lang: b.lang, group: b.group });
      const dict = await kwDict();
      const items = []; let created = 0, duplicates = 0;
      for(const pc of pieces){
        const dupId = await findByCode(pc.code);
        const item = { title: pc.title, lang: pc.lang, group: pc.group || 'Мои куски', lines: pc.code.split('\n').length, status: dupId ? 'duplicate' : 'new', id: dupId || null };
        if(dupId) duplicates++;
        else {
          created++;
          if(!b.dry){
            const title = String(pc.title).slice(0, 80);
            const obj = { id: slug(title || pc.lang), lang: pc.lang, group: item.group.slice(0, 60), title, desc: String(pc.desc || '').slice(0, 400), output: pc.output || '', lines: tokenize(pc.code, pc.lang), descAt: Date.now() };
            if(pc.tags) obj.tags = pc.tags;
            if(pc.aliases) obj.aliases = pc.aliases;
            obj.source = { title: 'manual', desc: pc.desc ? 'manual' : null, tags: pc.tags ? 'manual' : null };
            if(_CONTRACT_LANGS.has(pc.lang)){ const c = codeContract(pc.code, pc.lang); obj.component = { provides: c.provides, requires: c.requires }; }
            annotateLines(obj.lines, pc.lang, dict);
            await store.save(obj, { origin: 'imported' });
            item.id = obj.id;
          }
        }
        items.push(item);
      }
      return json(res, 200, { ok: true, dry: !!b.dry, total: pieces.length, created, duplicates, needDescription: pieces.filter((p, i) => items[i].status === 'new' && !p.desc).length, warnings, items });
    }

    if((u.pathname === '/api/import' || u.pathname === '/api/import-collection') && req.method === 'POST'){
      return json(res, 200, await importBundle(await readBody(req)));
    }

    // восстановление бэкапа библиотеки КАК ЕСТЬ: {files:[{name,text,lang?}]} — пишем код и паспорта
    // .meta.json прямо в library/<язык>/ байт-в-байт, без токенизации/аннотации/дедупа. Паспорт
    // (настоящее название, разделы, пояснения) сохраняется ровно как в бэкапе.
    if(u.pathname === '/api/library/restore' && req.method === 'POST'){
      const b = await readBody(req);
      const files = Array.isArray(b.files) ? b.files : [];
      const EXT2LANG = { js:'js', mjs:'js', cjs:'js', ts:'ts', tsx:'ts', jsx:'js', py:'python', rb:'ruby', php:'php', go:'go', rs:'rust', java:'java', c:'c', h:'c', cpp:'cpp', cs:'csharp', css:'css', html:'html', htm:'html', svg:'svg', sql:'sql', sh:'bash', json:'json' };
      const safeLang = l => (String(l || 'txt').toLowerCase().replace(/[^a-z0-9_+-]/g, '') || 'txt');
      const langOfName = n => safeLang(EXT2LANG[String(n).split('.').pop().toLowerCase()] || 'txt');
      const isMeta = n => /\.meta\.json$/i.test(n);
      const metas = files.filter(f => f && isMeta(f.name));
      const codes = files.filter(f => f && !isMeta(f.name));
      const codeByBase = {}; codes.forEach(c => { codeByBase[path.basename(c.name)] = c; });
      let wroteCode = 0, wroteMeta = 0, pairs = 0, metaOnly = 0, codeOnly = 0; const consumed = new Set();
      for(const m of metas){
        let meta; try { meta = JSON.parse(m.text); } catch(_){ continue; }
        const base = path.basename(m.name).replace(/\.meta\.json$/i, '');   // «arc-….js»
        const lang = safeLang(meta.lang) || langOfName(base);
        const dir = path.join(LIBRARY, lang); await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, base + '.meta.json'), m.text.endsWith('\n') ? m.text : m.text + '\n', 'utf8'); wroteMeta++;
        const code = codeByBase[base];
        if(code){ await fs.writeFile(path.join(dir, base), String(code.text), 'utf8'); wroteCode++; pairs++; consumed.add(base); }
        else metaOnly++;
      }
      for(const c of codes){ const bn = path.basename(c.name); if(consumed.has(bn)) continue;
        const lang = safeLang(c.lang) || langOfName(bn);
        const dir = path.join(LIBRARY, lang); await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, bn), String(c.text), 'utf8'); wroteCode++; codeOnly++;
      }
      try { await store.refresh(); } catch(_){}
      return json(res, 200, { ok: true, pairs, metaOnly, codeOnly, wroteCode, wroteMeta });
    }

    // правка шаблона целиком: новый код → заново токенизируем, перезаписываем файл
    if(u.pathname === '/api/edit' && req.method === 'POST'){
      const b = await readBody(req);
      const j = await store.get(b.id);
      if(!j) return json(res, 404, { error: 'нет такого шаблона' });
      if(b.lang != null) j.lang = String(b.lang).toLowerCase();
      if(b.title != null) j.title = String(b.title).slice(0, 80) || j.title;
      if(b.group != null){
        const g = String(b.group).slice(0, 60); j.group = g || j.group;
        // «раздел» — единый источник: из него же задаём раздел/подраздел в Конструкторе (purpose/subcat)
        const segs = (g || '').split('/').map(s => s.trim()).filter(Boolean);
        if(segs.length){ j.component = j.component || {}; j.component.tags = Object.assign({}, j.component.tags, { purpose: [segs[0]] }); j.component.subcat = segs.slice(1).join(' / ') || 'Разное'; }
      }
      if(b.desc != null){ const nv = String(b.desc).slice(0, 400); if(nv !== (j.desc || '')) j.descAt = (b.descAt && Number(b.descAt)) || Date.now(); j.desc = nv; }
      if(b.output != null) j.output = String(b.output);
      const _names = a => (Array.isArray(a) ? a : String(a || '').split(',')).map(x => String(x).trim()).filter(Boolean).slice(0, 40);
      // ручная правка контракта «нужно/даёт» — фиксируется и больше не перетирается авторазбором кода
      if(b.provides !== undefined){ j.component = j.component || {}; j.component.provides = _names(b.provides); j.component.contractLocked = true; }
      if(b.requires !== undefined){ j.component = j.component || {}; j.component.requires = _names(b.requires); j.component.contractLocked = true; }
      if(b.code != null){ j.lines = tokenize(b.code, j.lang);   // код заново раскрашивается
        if(_CONTRACT_LANGS.has(j.lang || 'js') && !(j.component && j.component.contractLocked)){ const c = codeContract(b.code, j.lang || 'js'); j.component = j.component || {}; j.component.provides = c.provides; j.component.requires = c.requires; } }
      // свои разделы (классификация пользователя) и заметки к словам — хранятся на компоненте
      if(Array.isArray(b.collections)){ j.component = j.component || {}; j.component.collections = b.collections.map(x => String(x).slice(0, 60)).slice(0, 30); }
      if(b.notes && typeof b.notes === 'object'){ j.component = j.component || {}; j.component.notes = b.notes; }
      if(b.lineNotes && typeof b.lineNotes === 'object'){ j.component = j.component || {}; j.component.lineNotes = b.lineNotes; }
      if(b.component && typeof b.component === 'object'){ j.component = Object.assign({}, j.component || {}, b.component); }
      await store.save(j);
      return json(res, 200, { ok: true, id: j.id });
    }

    // ── сохранённые данные (JSON из архивов) ──────────────────────────────
    if(u.pathname === '/api/data/save' && req.method === 'POST'){
      const b = await readBody(req);
      const id = slug(b.name || 'data');
      const obj = { id, name: String(b.name || 'без имени').slice(0, 120), desc: String(b.desc || '').slice(0, 400), category: String(b.category || '').slice(0, 80), savedAt: new Date().toISOString(), data: b.data };
      await fs.mkdir(DATA, { recursive: true });
      await fs.writeFile(path.join(DATA, id + '.json'), JSON.stringify(obj), 'utf8');
      return json(res, 200, { id });
    }
    if(u.pathname === '/api/data/list'){
      let names = [];
      try { names = (await fs.readdir(DATA)).filter(n => n.endsWith('.json')); } catch(_){ return json(res, 200, []); }
      const out = [];
      for(const n of names.sort().reverse()){
        try { const st = await fs.stat(path.join(DATA, n)); const j = JSON.parse(await fs.readFile(path.join(DATA, n), 'utf8'));
          out.push({ id: j.id || n.replace(/\.json$/, ''), name: j.name || n, desc: j.desc || '', category: j.category || '', savedAt: j.savedAt || '', size: st.size }); } catch(_){}
      }
      return json(res, 200, out);
    }
    if(u.pathname === '/api/data/get'){
      const id = u.searchParams.get('id'); const abs = within(DATA, (id || '') + '.json');
      if(!abs) return json(res, 400, { error: 'bad id' });
      const txt = await fs.readFile(abs, 'utf8').catch(() => null);
      if(txt == null) return json(res, 404, { error: 'нет такого' });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(txt); return;
    }
    if(u.pathname === '/api/data/update' && req.method === 'POST'){
      const b = await readBody(req); const abs = within(DATA, (b.id || '') + '.json');
      if(!abs) return json(res, 400, { error: 'bad id' });
      const txt = await fs.readFile(abs, 'utf8').catch(() => null);
      if(txt == null) return json(res, 404, { error: 'нет такого' });
      const j = JSON.parse(txt);
      if(b.name != null) j.name = String(b.name).slice(0, 120);
      if(b.desc != null) j.desc = String(b.desc).slice(0, 400);
      if(b.category != null) j.category = String(b.category).slice(0, 80);
      if(b.data !== undefined) j.data = b.data;   // правки понятных полей сохраняются в сами данные
      await fs.writeFile(abs, JSON.stringify(j), 'utf8');
      return json(res, 200, { ok: true });
    }
    if(u.pathname === '/api/data/delete' && req.method === 'POST'){
      const b = await readBody(req); const abs = within(DATA, (b.id || '') + '.json');
      if(!abs) return json(res, 400, { error: 'bad id' });
      await fs.unlink(abs).catch(() => {});
      return json(res, 200, { ok: true });
    }
    // убрать из «Данных» паспорта библиотеки (.meta.json), случайно загруженные как объекты.
    // Паспорт живёт рядом с кодом в библиотеке и создаётся сам; в «Данных» ему не место. {apply:false} — только показать.
    if(u.pathname === '/api/data/clean' && req.method === 'POST'){
      const b = await readBody(req);
      let names = []; try { names = (await fs.readdir(DATA)).filter(n => n.endsWith('.json')); } catch(_){}
      const junk = [];
      for(const n of names){ if(n === 'description-jobs.json') continue;
        try { const j = JSON.parse(await fs.readFile(path.join(DATA, n), 'utf8')); const nm = String(j.name || ''); const d = j.data;
          const isMetaName = /\.meta\.json$/i.test(nm);
          const isMetaData = d && typeof d === 'object' && !Array.isArray(d) && d.id != null && d.lang != null && (d.component != null || d.schema != null) && (d.file != null || Array.isArray(d.wordNotes));
          if(isMetaName || isMetaData) junk.push({ file: n, name: nm });
        } catch(_){}
      }
      if(!b.apply) return json(res, 200, { ok: true, applied: false, count: junk.length, sample: junk.slice(0, 20).map(x => x.name) });
      let removed = 0; for(const x of junk){ try { await fs.unlink(path.join(DATA, x.file)); removed++; } catch(_){} }
      return json(res, 200, { ok: true, applied: true, removed });
    }

    // ── синхронизация шаблонов с GitHub ───────────────────────────────────
    if(u.pathname === '/api/git/info'){
      await ensureLabDirs();
      let templates = 0;
      try { templates = await store.count(); } catch(_){}
      const root = await gitRoot();
      let branch = '', dirty = 0;
      if(root){
        branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], root)).out;
        const paths = await labTargets();
        if(paths.length){ const st = await git(["status", "--porcelain", "--", ...paths], root); dirty = st.out ? st.out.split('\n').filter(Boolean).length : 0; }
      }
      return json(res, 200, { repo: !!root, branch, dirty, templates });
    }
    if(u.pathname === '/api/git/sync' && req.method === 'POST'){
      await ensureLabDirs();
      const root = await gitRoot();
      if(!root) return json(res, 200, { ok: false, stage: 'repo', message: 'Папка лаборатории не внутри git-репозитория — шаблоны сохранены только локально.' });
      const paths = await labTargets();   // непустые папки + файл словаря — иначе git спотыкается на пустых
      if(!paths.length) return json(res, 200, { ok: true, pushed: false, message: 'нечего сохранять' });
      const add = await git(["add", "--", ...paths], root);
      if(add.code !== 0) return json(res, 200, { ok: false, stage: 'add', message: add.err || 'git add не удался' });
      const staged = (await git(["diff", "--cached", "--name-only", "--", ...paths], root)).out.split('\n').filter(Boolean).length;
      if(staged > 0){
        const c = await git(["commit", "-m", "Лаборатория: мои шаблоны, схемы и словарь", "--", ...paths], root);
        if(c.code !== 0) return json(res, 200, { ok: false, stage: 'commit', message: c.err || c.out });
      }
      // подтянуть серверные изменения ПЕРЕД push, чтобы не упираться в отклонение.
      // --autostash бережёт другие несохранённые правки; при конфликте — откат, ничего не ломаем.
      const up = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], root);
      if(up.code === 0 && up.out){
        const pull = await git(['pull', '--rebase', '--autostash'], root);
        if(pull.code !== 0){
          await git(['rebase', '--abort'], root);
          return json(res, 200, { ok: false, stage: 'pull', committed: staged, message: 'С сервера пришли изменения, которые конфликтуют с твоими — автослияние не вышло. Я откатила, ничего не испорчено. Нужно слить вручную (git pull) и повторить. ' + (pull.err || pull.out || '').slice(0, 240) });
        }
      }
      let push = await git(['push'], root);
      if(push.code !== 0){
        const br = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], root)).out;
        push = await git(['push', '-u', 'origin', br], root);
        if(push.code !== 0) return json(res, 200, { ok: false, stage: 'push', committed: staged, message: push.err || push.out || 'push отклонён' });
      }
      return json(res, 200, { ok: true, committed: staged, message: staged ? ('Отправлено на GitHub: ' + staged + ' файл(ов).') : 'На GitHub уже всё актуально.' });
    }

    // удалить шаблон
    if(u.pathname === '/api/delete' && req.method === 'POST'){
      const b = await readBody(req);
      if(!(await store.has(b.id))) return json(res, 404, { error: 'нет такого шаблона' });
      await store.remove(b.id);
      return json(res, 200, { ok: true });
    }

    // ── схемы-сборки (граф со связями) ────────────────────────────────────────
    if(u.pathname === '/api/flows/list'){
      let names = [];
      try { names = (await fs.readdir(FLOWS)).filter(n => n.endsWith('.json')); } catch(_){ return json(res, 200, []); }
      const out = [];
      for(const n of names.sort()){
        try { const j = JSON.parse(await fs.readFile(path.join(FLOWS, n), 'utf8'));
          out.push({ id: j.id || n.replace(/\.json$/, ''), name: j.name || j.id || n, savedAt: j.savedAt || 0,
            nodes: Array.isArray(j.graph && j.graph.nodes) ? j.graph.nodes.length : 0,
            edges: Array.isArray(j.graph && j.graph.edges) ? j.graph.edges.length : 0 });
        } catch(_){}
      }
      return json(res, 200, out);
    }
    if(u.pathname === '/api/flows/get'){
      const id = String(u.searchParams.get('id') || '');
      const abs = within(FLOWS, id + '.json');
      if(!abs) return json(res, 400, { error: 'bad id' });
      const txt = await fs.readFile(abs, 'utf8').catch(() => null);
      if(txt == null) return json(res, 404, { error: 'нет такой схемы' });
      return json(res, 200, JSON.parse(txt));
    }
    if(u.pathname === '/api/flows/save' && req.method === 'POST'){
      const b = await readBody(req);
      const graph = (b.graph && typeof b.graph === 'object') ? b.graph : { nodes: [], edges: [] };
      const id = b.id && /^[\wа-яё.-]+$/iu.test(b.id) ? b.id : slug(b.name || 'схема');   // id содержит кириллицу — пропускаем её, иначе «дописать в ту же схему» создавало новый файл
      const obj = { id, name: String(b.name || 'Моя схема').slice(0, 80), savedAt: Date.now(),
        graph: { nodes: Array.isArray(graph.nodes) ? graph.nodes : [], edges: Array.isArray(graph.edges) ? graph.edges : [] } };
      await fs.mkdir(FLOWS, { recursive: true });
      await fs.writeFile(path.join(FLOWS, id + '.json'), JSON.stringify(obj, null, 2), 'utf8');
      return json(res, 200, { ok: true, id });
    }
    if(u.pathname === '/api/flows/delete' && req.method === 'POST'){
      const b = await readBody(req);
      const abs = within(FLOWS, String(b.id || '') + '.json');
      if(!abs) return json(res, 400, { error: 'bad id' });
      await fs.unlink(abs).catch(() => {});
      return json(res, 200, { ok: true });
    }

    // связи КУСКА в проекте: по коду/названию находим кусок, собираем рёбра всех сохранённых схем,
    // где он участвует. Возвращаем [{dir:'out'|'in', rel, other, scheme}] видами из CODE_RELATIONS.
    if(u.pathname === '/api/relations/piece' && req.method === 'POST'){
      const b = await readBody(req);
      const code = _normCode(b.code || ''), title = String(b.title || '').trim().toLowerCase();
      let pid = null, ptitle = null;
      for(const e of await store.entries()){
        if((code && _normCode(e.code) === code) || (title && (e.title || '').trim().toLowerCase() === title)){ pid = e.id; ptitle = e.title || ''; break; }
      }
      const rels = [];
      let names = [];
      try { names = (await fs.readdir(FLOWS)).filter(n => n.endsWith('.json')); } catch(_){ names = []; }
      const low = s => String(s || '').trim().toLowerCase();
      const meTitle = low(ptitle) || title;
      for(const fn of names){
        let g; try { g = JSON.parse(await fs.readFile(path.join(FLOWS, fn), 'utf8')); } catch(_){ continue; }
        const nodes = (g.graph && g.graph.nodes) || [], edges = (g.graph && g.graph.edges) || [];
        const map = {}; nodes.forEach(n => { map[n.id] = { title: (n.src && n.src.title) || n.title || '', pid: (n.src && n.src.id) || null }; });
        const isMe = nd => nd && ((pid && nd.pid === pid) || (meTitle && low(nd.title) === meTitle));
        edges.forEach(ed => { const a = map[ed.from], c = map[ed.to]; if(!a || !c) return; const rel = ed.rel || 'data';
          if(isMe(a)) rels.push({ dir: 'out', rel, other: c.title, scheme: g.name || fn });
          else if(isMe(c)) rels.push({ dir: 'in', rel, other: a.title, scheme: g.name || fn }); });
      }
      // схлопнуть одинаковые рёбра (одна и та же связь в одноимённых схемах)
      const seen = new Set(), uniq = [];
      for(const r of rels){ const k = r.dir + '|' + r.rel + '|' + r.other + '|' + r.scheme; if(seen.has(k)) continue; seen.add(k); uniq.push(r); }
      return json(res, 200, { matched: ptitle || (pid ? '' : null), relations: uniq });
    }

    // массовое пополнение словаря пояснений: {section, entries}. entries — {слово:текст} или [{word,text}]/[[w,t]].
    // Пишем в keyword-dict.json (тот же словарь читают песочница, автоподпись, бэкофилл) и сбрасываем кэш.
    if(u.pathname === '/api/dict/add' && req.method === 'POST'){
      const b = await readBody(req);
      const SECTIONS = ['words', 'htmlTags', 'htmlAttrs', 'cssProps', 'cssVals'];
      let pairs = [];
      if(Array.isArray(b.entries)) pairs = b.entries.map(e => Array.isArray(e) ? [e[0], e[1]] : [e && e.word, e && e.text]);
      else if(b.entries && typeof b.entries === 'object') pairs = Object.entries(b.entries);
      const lang = String(b.lang || '').trim().toLowerCase();
      if(lang){
        // язык — свой отдельный файл dict/langs/<lang>.json
        const r = await saveLangDict(lang, pairs);
        return json(res, 200, { ok: true, added: r.added, where: 'язык «' + lang + '» (' + r.file + ')', total: r.total });
      }
      // общее/HTML/CSS — в базовый keyword-dict.json
      let dict; try { dict = JSON.parse(await fs.readFile(DICT_BASE, 'utf8')); } catch(_){ dict = {}; }
      for(const s of SECTIONS) if(!dict[s]) dict[s] = {};
      const section = SECTIONS.includes(b.section) ? b.section : 'words';
      const target = dict[section];
      let added = 0;
      for(let [w, t] of pairs){ w = String(w || '').trim().toLowerCase(); t = String(t || '').trim(); if(!w || !t) continue; target[w] = t.slice(0, 600); added++; }
      await fs.writeFile(DICT_BASE, JSON.stringify(dict, null, 2), 'utf8'); _kwDict = null;
      return json(res, 200, { ok: true, added, where: section, total: Object.keys(target).length });
    }

    // чистка словаря от обрывков кода: ключи с несбалансированными скобками ()[]{} — это не термины,
    // а куски строк (вставляли код, парсер резал по первому двоеточию). {apply:false} — только показать.
    if(u.pathname === '/api/dict/clean' && req.method === 'POST'){
      const b = await readBody(req);
      const balanced = k => { let p = 0, c = 0, s = 0; for(const ch of String(k)){ if(ch === '(') p++; else if(ch === ')') p--; else if(ch === '{') c++; else if(ch === '}') c--; else if(ch === '[') s++; else if(ch === ']') s--; if(p < 0 || c < 0 || s < 0) return false; } return p === 0 && c === 0 && s === 0; };
      const found = [];
      // база: разделы-объекты
      let base; try { base = JSON.parse(await fs.readFile(DICT_BASE, 'utf8')); } catch(_){ base = {}; }
      const baseSects = ['words', 'htmlTags', 'htmlAttrs', 'cssProps', 'cssVals'].filter(s => base[s] && typeof base[s] === 'object');
      for(const s of baseSects) for(const k of Object.keys(base[s])) if(!balanced(k)) found.push({ where: s, key: k });
      // языки: отдельные файлы
      let langFiles = []; try { langFiles = (await fs.readdir(LANGS_DIR)).filter(n => n.endsWith('.json')); } catch(_){}
      const langData = {};
      for(const fn of langFiles){ try { const o = JSON.parse(await fs.readFile(path.join(LANGS_DIR, fn), 'utf8')); langData[fn] = o; for(const k of Object.keys(o)) if(!balanced(k)) found.push({ where: fn.replace(/\.json$/, ''), key: k }); } catch(_){} }
      if(!b.apply) return json(res, 200, { ok: true, applied: false, count: found.length, sample: found.slice(0, 40) });
      // удаляем
      let removed = 0;
      for(const s of baseSects){ for(const k of Object.keys(base[s])) if(!balanced(k)){ delete base[s][k]; removed++; } }
      if(baseSects.length) await fs.writeFile(DICT_BASE, JSON.stringify(base, null, 2), 'utf8');
      for(const fn of langFiles){ const o = langData[fn]; if(!o) continue; let touched = false; for(const k of Object.keys(o)) if(!balanced(k)){ delete o[k]; touched = true; } if(touched){ const sorted = {}; for(const kk of Object.keys(o).sort()) sorted[kk] = o[kk]; await fs.writeFile(path.join(LANGS_DIR, fn), JSON.stringify(sorted, null, 2), 'utf8'); } }
      _kwDict = null;
      return json(res, 200, { ok: true, applied: true, removed });
    }

    // ревизия «на своём ли месте»: проходим по тому, что УЖЕ загружено, и ищем перепутанное.
    // read-only — только показать. Чинится точечно через /api/dict/remove + /api/dict/synonyms + /api/delete.
    if(u.pathname === '/api/dict/audit' && req.method === 'POST'){
      const ruKeys = [], synLike = [], prosePieces = [];
      // словарь: база (разделы) + языки (файлы)
      let base; try { base = JSON.parse(await fs.readFile(DICT_BASE, 'utf8')); } catch(_){ base = {}; }
      const baseSects = ['words', 'htmlTags', 'htmlAttrs', 'cssProps', 'cssVals'].filter(s => base[s] && typeof base[s] === 'object');
      // ключ-фраза на русском, и это НЕ пояснение-понятие (нет « — »/союзов) → перепутаны стороны/синонимы.
      // пояснение-список через запятые (короткие куски, не предложение) у код-ключа → это синонимы.
      const scan = (where, obj) => { for(const [k, v] of Object.entries(obj)){ const text = String(v || '');
        if(_isRuS(k) && !_hasLat(k)){ if(!_isSentence(text)) ruKeys.push({ where, key: k, text: text.slice(0, 120) }); }
        else if(_isSynList(text)) synLike.push({ where, key: k, text: text.slice(0, 120) }); } };
      for(const s of baseSects) scan(s, base[s]);
      let langFiles = []; try { langFiles = (await fs.readdir(LANGS_DIR)).filter(n => n.endsWith('.json')); } catch(_){}
      for(const fn of langFiles){ try { const o = JSON.parse(await fs.readFile(path.join(LANGS_DIR, fn), 'utf8')); if(o && typeof o === 'object') scan(fn.replace(/\.json$/, ''), o); } catch(_){} }
      // куски: код — чистая русская проза → это не кусок
      let rows = []; try { rows = await store.rows(); } catch(_){}
      for(const r of rows){ let obj; try { obj = await store.get(r.id); } catch(_){ continue; }
        const code = obj && Array.isArray(obj.lines) ? obj.lines.map(ln => (ln || []).map(t => (t && t.v) || '').join('')).join('\n') : '';
        if(_looksProse(code)) prosePieces.push({ id: r.id, title: obj.title || r.id, lang: obj.lang || '', code: code.slice(0, 120) }); }
      return json(res, 200, { ok: true, ruKeys, synLike, prosePieces, counts: { ruKeys: ruKeys.length, synLike: synLike.length, prosePieces: prosePieces.length } });
    }

    // удалить ключи из словаря: {entries:[{where, key}]}. where = раздел базы (words/…) или язык (имя файла).
    if(u.pathname === '/api/dict/remove' && req.method === 'POST'){
      const b = await readBody(req);
      const list = Array.isArray(b.entries) ? b.entries : [];
      let base = null, baseTouched = false; const baseSects = new Set(['words', 'htmlTags', 'htmlAttrs', 'cssProps', 'cssVals']);
      try { base = JSON.parse(await fs.readFile(DICT_BASE, 'utf8')); } catch(_){ base = {}; }
      const langTouched = {}; let removed = 0;
      for(const e of list){ const where = String(e && e.where || ''), key = String(e && e.key || '').toLowerCase(); if(!where || !key) continue;
        if(baseSects.has(where)){ if(base[where] && base[where][key] != null){ delete base[where][key]; baseTouched = true; removed++; } }
        else { const fp = path.join(LANGS_DIR, where + '.json'); let o = langTouched[where]; if(!o){ try { o = JSON.parse(await fs.readFile(fp, 'utf8')); } catch(_){ o = null; } if(o) langTouched[where] = o; }
          if(o && o[key] != null){ delete o[key]; removed++; } } }
      if(baseTouched) await fs.writeFile(DICT_BASE, JSON.stringify(base, null, 2), 'utf8');
      for(const [where, o] of Object.entries(langTouched)){ const sorted = {}; for(const k of Object.keys(o).sort()) sorted[k] = o[k]; await fs.writeFile(path.join(LANGS_DIR, where + '.json'), JSON.stringify(sorted, null, 2), 'utf8'); }
      _kwDict = null;
      return json(res, 200, { ok: true, removed });
    }

    // синонимы для поиска по смыслу: {entries:[[term, "фраза1, фраза2"], …]}. Объединяем с существующими,
    // дедуп; пустой список синонимов у термина — снять термин. Хранится в dict/synonyms.json (уезжает с dict/).
    if(u.pathname === '/api/dict/synonyms' && req.method === 'POST'){
      const b = await readBody(req);
      let pairs = [];
      if(Array.isArray(b.entries)) pairs = b.entries.map(e => Array.isArray(e) ? [e[0], e[1]] : [e && e.term, e && e.syns]);
      else if(b.entries && typeof b.entries === 'object') pairs = Object.entries(b.entries);
      const syn = await loadSynonyms();
      let terms = 0, added = 0;
      for(let [term, list] of pairs){
        term = String(term || '').trim().toLowerCase(); if(!term) continue;
        const parts = String(list || '').split(/[,;\n]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
        if(!parts.length){ if(syn[term]){ delete syn[term]; terms++; } continue; }
        const set = new Set(syn[term] || []); const before = set.size;
        parts.forEach(p => set.add(p)); syn[term] = [...set].sort();
        added += set.size - before; terms++;
      }
      const sorted = {}; for(const k of Object.keys(syn).sort()) sorted[k] = syn[k];
      await fs.mkdir(DICT_DIR, { recursive: true });
      await fs.writeFile(SYN_FILE, JSON.stringify(sorted, null, 2), 'utf8'); _kwDict = null;
      return json(res, 200, { ok: true, terms, added, totalTerms: Object.keys(sorted).length });
    }

    // привязать к термину (слову/конструкции) кусок-пример: {term, piece: название|id|''(снять)}
    if(u.pathname === '/api/dict/example' && req.method === 'POST'){
      const b = await readBody(req);
      const term = String(b.term || '').trim().toLowerCase();
      if(!term) return json(res, 400, { error: 'не задан термин' });
      const ex = await loadExamples();
      const piece = String(b.piece || '').trim();
      if(!piece){ delete ex[term]; }
      else {
        let found = null;
        for(const e of await store.entries()){ if(e.id === piece || (e.title || '').trim().toLowerCase() === piece.toLowerCase()){ found = { id: e.id, title: e.title || e.id }; break; } }
        if(!found) return json(res, 404, { error: 'кусок не найден: ' + piece });
        ex[term] = found;
      }
      await fs.mkdir(DICT_DIR, { recursive: true });
      await fs.writeFile(EXAMPLES_FILE, JSON.stringify(ex, null, 2), 'utf8'); _kwDict = null;
      return json(res, 200, { ok: true, term, example: ex[term] || null });
    }

    // сборщик «непонятных слов»: из кода (или из кусков языка) собираем токены, которых НЕТ в словаре,
    // склеиваем повторы, сортируем по частоте и отдаём готовый запрос для ИИ (ответ — строки «слово: пояснение»).
    if(u.pathname === '/api/dict/unknown' && req.method === 'POST'){
      const b = await readBody(req);
      const lang = String(b.lang || '').trim().toLowerCase();
      const dict = await kwDict();
      const has = w => { const lw = w.toLowerCase();
        return !!((dict.langs && dict.langs[lang] && dict.langs[lang][lw]) || (dict.words && dict.words[lw])
          || (dict.htmlTags && dict.htmlTags[lw]) || (dict.htmlAttrs && dict.htmlAttrs[lw])
          || (dict.cssProps && dict.cssProps[lw]) || (dict.cssVals && dict.cssVals[lw])); };
      // источник кода: присланный код, иначе склейка кусков этого языка из библиотеки
      let code = String(b.code || '');
      let scanned = code ? 1 : 0;
      if(!code){ for(const e of await store.entries()){ if(!lang || String(e.lang || '').toLowerCase() === lang){ code += '\n' + String(e.code || ''); scanned++; } } }
      // токены: слова и устойчивые конструкции (std::cout, System.out.println, #include, obj->field)
      const re = /#?[A-Za-z_][A-Za-z0-9_]*(?:(?:::|->|\.)[A-Za-z_][A-Za-z0-9_]*)*/g;
      const counts = new Map(); let m;
      while((m = re.exec(code))){ const w = m[0]; if(w.length < 2 || /^\d/.test(w)) continue; if(has(w)) continue; counts.set(w, (counts.get(w) || 0) + 1); }
      const words = [...counts.entries()].map(([w, c]) => ({ w, c })).sort((a, b2) => b2.c - a.c).slice(0, 300);
      const list = words.map(x => x.w + ' (' + x.c + ')').join('\n');
      const prompt = 'Язык: ' + (lang || 'общий') + '.\n'
        + 'Ниже — слова и устойчивые конструкции из кода на этом языке, которых ещё нет в словаре пояснений (в скобках — сколько раз встретились).\n'
        + 'Выдели значимые ключевые слова и устойчивые формулировки языка и дай каждому короткое пояснение по-русски — строго по одному на строку, в формате:\n'
        + 'слово: пояснение\n'
        + 'Без нумерации и лишнего текста. Пропусти случайные имена переменных и незначимое. Эти строки я вставлю в словарь.\n\n'
        + list;
      return json(res, 200, { lang, scanned, count: words.length, words, prompt });
    }

    // ── рецепты (название + описание + список кусков) ──────────────────────────
    if(u.pathname === '/api/recipes/list'){
      let names = [];
      try { names = (await fs.readdir(RECIPES)).filter(n => n.endsWith('.json')); } catch(_){ return json(res, 200, []); }
      const out = [];
      for(const n of names.sort()){
        try { const j = JSON.parse(await fs.readFile(path.join(RECIPES, n), 'utf8'));
          out.push({ id: j.id || n.replace(/\.json$/, ''), title: j.title || '', desc: j.desc || '', savedAt: j.savedAt || 0, items: Array.isArray(j.items) ? j.items.length : 0 });
        } catch(_){}
      }
      return json(res, 200, out);
    }
    if(u.pathname === '/api/recipes/get'){
      const abs = within(RECIPES, String(u.searchParams.get('id') || '') + '.json');
      if(!abs) return json(res, 400, { error: 'bad id' });
      const txt = await fs.readFile(abs, 'utf8').catch(() => null);
      if(txt == null) return json(res, 404, { error: 'нет такого рецепта' });
      return json(res, 200, JSON.parse(txt));
    }
    if(u.pathname === '/api/recipes/save' && req.method === 'POST'){
      const b = await readBody(req);
      const id = b.id && /^[\wа-яё.-]+$/iu.test(b.id) ? b.id : slug(b.title || 'рецепт');
      const items = Array.isArray(b.items) ? b.items.slice(0, 200).map(x => ({ id: String(x.id || ''), title: String(x.title || '').slice(0, 120), note: String(x.note || '').slice(0, 300) })) : [];
      const obj = { id, title: String(b.title || 'Рецепт').slice(0, 120), desc: String(b.desc || '').slice(0, 2000), items, savedAt: Date.now() };
      await fs.mkdir(RECIPES, { recursive: true });
      await fs.writeFile(path.join(RECIPES, id + '.json'), JSON.stringify(obj, null, 2), 'utf8');
      return json(res, 200, { ok: true, id });
    }
    if(u.pathname === '/api/recipes/delete' && req.method === 'POST'){
      const b = await readBody(req);
      const abs = within(RECIPES, String(b.id || '') + '.json');
      if(!abs) return json(res, 400, { error: 'bad id' });
      await fs.unlink(abs).catch(() => {});
      return json(res, 200, { ok: true });
    }

    // какие языки установлены у пользователя
    if(u.pathname === '/api/run/langs'){ return json(res, 200, await detectLangs()); }
    // запустить код на установленном языке (выполняется ЛОКАЛЬНО на машине пользователя)
    if(u.pathname === '/api/run' && req.method === 'POST'){
      const b = await readBody(req);
      const out = await runCode(b.lang, b.code);
      return json(res, 200, out);
    }

    // словарь отдаём собранным (база + файлы языков), а не как статический файл —
    // чтобы песочница и просмотрщик видели и языки из dict/langs/*.json
    if(u.pathname === '/keyword-dict.json'){
      const d = await kwDict();
      // ?lang=X — отдать только этот язык (+ база/синонимы/примеры), чтобы клиент не грузил все языки разом
      const lang = (u.searchParams.get('lang') || '').toLowerCase();
      let out = d;
      if(lang){ out = Object.assign({}, d); out.langs = (d.langs && d.langs[lang]) ? { [lang]: d.langs[lang] } : {}; }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(out));
    }

    const rel = u.pathname === '/' ? 'index.html' : u.pathname;
    const abs = within(PUBLIC, rel);
    if(!abs) return json(res, 400, { error: 'bad path' });
    const data = await fs.readFile(abs).catch(() => null);
    if(data == null) return json(res, 404, { error: 'not found' });
    // no-store: иначе браузер показывает старый app.js/style.css после правок
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    // Настройки Mistral встраиваются в фактически отдаваемую главную страницу,
    // независимо от того, как устроена оболочка приложения.
    if (path.extname(abs) === '.html' && (u.pathname === '/' || u.pathname.endsWith('.html'))) {
      let html = data.toString('utf8');
      if (!html.includes('id="lab-mistral-settings"')) {
        const widget = `
<style>
#lab-mistral-open{position:fixed;right:20px;bottom:20px;z-index:2147483000;border:1px solid #51336e;border-radius:12px;background:#21112f;color:#f5eaff;padding:11px 15px;font:600 14px system-ui;cursor:pointer;box-shadow:0 6px 24px #0006}
#lab-mistral-settings{display:none;position:fixed;inset:0;z-index:2147483001;background:#090512cc;align-items:center;justify-content:center;font:14px system-ui;color:#f5eaff}
#lab-mistral-settings .panel{width:min(460px,calc(100vw - 32px));box-sizing:border-box;background:#160d23;border:1px solid #49305f;border-radius:16px;padding:22px;box-shadow:0 20px 80px #0009}
#lab-mistral-settings h2{margin:0 0 8px;font-size:20px}#lab-mistral-settings p{color:#bca9d8;line-height:1.5}
#lab-mistral-key{box-sizing:border-box;width:100%;background:#0d0716;color:#fff;border:1px solid #49305f;border-radius:8px;padding:12px;margin:8px 0 12px}
#lab-mistral-settings button{border:1px solid #51336e;border-radius:8px;background:#2a1740;color:#fff;padding:9px 12px;cursor:pointer;margin:3px 4px 3px 0}#lab-mistral-settings .primary{background:#6934a0}
#lab-mistral-status{min-height:20px;color:#c9b7e5}
</style>
<button id="lab-mistral-open" type="button">⚙ Настройки</button>
<div id="lab-mistral-settings" role="dialog" aria-modal="true" aria-labelledby="lab-mistral-title"><div class="panel"><h2 id="lab-mistral-title">Настройки Mistral</h2><p>Ключ хранится в этом браузере. Он отправляется локальному серверу только при запуске ИИ-описаний.</p><label for="lab-mistral-key">API-ключ</label><input id="lab-mistral-key" type="password" autocomplete="off" placeholder="Вставь ключ Mistral"><div><button class="primary" id="lab-mistral-save">Сохранить</button><button id="lab-mistral-test">Проверить подключение</button><button id="lab-mistral-delete">Удалить ключ</button><button id="lab-mistral-close">Закрыть</button><a href="/vendor.html" style="color:#c9a8ff;margin-left:10px;font-size:13px">Редактор кода…</a></div><p id="lab-mistral-status" aria-live="polite"></p></div></div>
<script>
(()=>{const $=id=>document.getElementById(id),keyName='codeLab.mistralApiKey',modal=$('lab-mistral-settings'),input=$('lab-mistral-key'),status=$('lab-mistral-status');if(!modal||!input)return;
const open=()=>{input.value=localStorage.getItem(keyName)||'';status.textContent='';modal.style.display='flex';input.focus()};$('lab-mistral-open').addEventListener('click',open);$('lab-mistral-close').addEventListener('click',()=>modal.style.display='none');modal.addEventListener('click',e=>{if(e.target===modal)modal.style.display='none'});
$('lab-mistral-save').addEventListener('click',()=>{const k=input.value.trim();if(k)localStorage.setItem(keyName,k);else localStorage.removeItem(keyName);status.textContent=k?'Ключ сохранён в этом браузере.':'Ключ очищен.'});
$('lab-mistral-delete').addEventListener('click',()=>{localStorage.removeItem(keyName);input.value='';status.textContent='Ключ удалён.'});
$('lab-mistral-test').addEventListener('click',async()=>{const k=input.value.trim()||localStorage.getItem(keyName)||'';if(!k){status.textContent='Сначала введи API-ключ.';return}status.textContent='Проверяю доступность очереди…';try{const r=await fetch('/api/jobs',{headers:{'X-Mistral-API-Key':k}});const j=await r.json();if(!r.ok)throw Error(j.error||('HTTP '+r.status));status.textContent='Сервер доступен. Очередь отвечает; настоящий запрос к Mistral выполняется при запуске описаний.'}catch(e){status.textContent='Ошибка: '+e.message}});
})();
</script>`;
        const aiTag = '\n<script src="/ai-settings.js"></script>';
        html = html.includes('</body>') ? html.replace('</body>', widget + aiTag + '</body>') : html + widget + aiTag;
      }
      res.end(html);
    } else res.end(data);
  } catch(e){ json(res, 500, { error: String(e && e.message || e) }); }
});

{
  const r = await store.init();
  await aiRuntime.load();
  await describeQueue.init();
  await search.init();
  await vendor.init();
  await migrateLangsOut();   // вынести словари языков из базового файла в dict/langs/*.json
  await migrateHtmlCssToLangs();   // HTML/CSS → обычные языки: seed-секции влить в html.json/css.json
  if(r.migrated && r.migrated.created) console.log(`Из templates/ перенесено в library/: ${r.migrated.created} (старые карточки не тронуты)`);
}
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Лаборатория кода: http://localhost:${PORT}/`);
  console.log(`Библиотека: ${LIBRARY}  (куски кода — обычные файлы; положите файл сюда — он появится в списке)`);
});
