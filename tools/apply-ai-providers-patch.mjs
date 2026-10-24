// Подключает провайдеры ИИ (Mistral, GigaChat, OpenAI-совместимые) к code-lab-server.mjs.
//
//   node apply-ai-providers-patch.mjs --check    только проверить, что вставки возможны
//   node apply-ai-providers-patch.mjs            применить (копия: code-lab-server.mjs.bak-<время>)
//
// Все вставки идут по якорям, повторный запуск безопасен. Если хоть один якорь не найден,
// не меняется ничего. Порядок с другими патчами не важен.
// Нужно, чтобы рядом уже лежали:  code-lab/lib/ai-providers.mjs  и  code-lab/public/ai-settings.js

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, 'code-lab-server.mjs');
const NEED = ['code-lab/lib/ai-providers.mjs', 'code-lab/public/ai-settings.js'];
const check = process.argv.includes('--check');

const GUARD_AND_RUNTIME = `const aiRuntime = createProviderRuntime({ configPath: path.join(ROOT, 'ai-config.json') });   // выбранный ИИ-сервис (ключей в файле нет)
// настройки ИИ меняют только запросы со своей страницы: проверяем Host и Origin
const aiLocalOnly = req => {
  const host = String(req.headers.host || '').toLowerCase();
  const origin = String(req.headers.origin || '').toLowerCase();
  const okHost = [\`localhost:\${PORT}\`, \`127.0.0.1:\${PORT}\`, \`[::1]:\${PORT}\`].includes(host);
  const okOrigin = !origin || [\`http://localhost:\${PORT}\`, \`http://127.0.0.1:\${PORT}\`, \`http://[::1]:\${PORT}\`].includes(origin);
  return okHost && okOrigin;
};
`;

const ROUTES = `    // ── ИИ-сервисы: выбранный провайдер и проверка ключа (ключи в файлы не пишутся) ──
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
`;

// Каждая правка: что искать (anchor), чем заменить (to), и по чему видно, что она уже сделана (done).
const EDITS = [
  { name: 'import createProviderRuntime',
    anchor: "import { createAiAssist } from './code-lab/lib/ai-assist.mjs';",
    to: "import { createAiAssist } from './code-lab/lib/ai-assist.mjs';\nimport { createProviderRuntime } from './code-lab/lib/ai-providers.mjs';",
    done: t => t.includes("lib/ai-providers.mjs'") },
  { name: 'runtime + защита + очередь описаний через провайдера',
    anchor: "const describeQueue = createDescriptionQueue({ store, statePath: path.join(DATA, 'description-jobs.json') });",
    to: GUARD_AND_RUNTIME + "const describeQueue = createDescriptionQueue({ store, statePath: path.join(DATA, 'description-jobs.json'), fetchImpl: aiRuntime.fetch });",
    done: t => t.includes('const aiRuntime = createProviderRuntime') },
  { name: 'ИИ-дополнение через провайдера',
    anchor: 'createAiAssist({ store })',
    to: 'createAiAssist({ store, fetchImpl: aiRuntime.fetch })',
    done: t => t.includes('createAiAssist({ store, fetchImpl: aiRuntime.fetch })') },
  { name: 'ИИ-создание кусков через провайдера',
    anchor: 'createAiGenerate({ store })',
    to: 'createAiGenerate({ store, fetchImpl: aiRuntime.fetch })',
    done: t => t.includes('createAiGenerate({ store, fetchImpl: aiRuntime.fetch })') },
  { name: 'маршруты /api/ai/*',
    anchor: "    if(u.pathname === '/api/describe' && req.method === 'POST'){",
    to: ROUTES + "    if(u.pathname === '/api/describe' && req.method === 'POST'){",
    done: t => t.includes("u.pathname.startsWith('/api/ai/')") },
  { name: 'загрузка настроек ИИ при старте',
    anchor: '  await describeQueue.init();',
    to: '  await aiRuntime.load();\n  await describeQueue.init();',
    done: t => t.includes('await aiRuntime.load();') },
  { name: 'скрипт ai-settings.js в окне «Настройки»',
    anchor: "html = html.includes('</body>') ? html.replace('</body>', widget + '</body>') : html + widget;",
    to: "const aiTag = '\\n<script src=\"/ai-settings.js\"></script>';\n        html = html.includes('</body>') ? html.replace('</body>', widget + aiTag + '</body>') : html + widget + aiTag;",
    done: t => t.includes('/ai-settings.js') },
];

const exists = p => fs.access(p).then(() => true, () => false);
const missingFiles = [];
for (const f of NEED) if (!(await exists(path.join(HERE, f)))) missingFiles.push(f);
if (missingFiles.length) {
  console.error('Не хватает файлов (распакуйте набор в папку tools с заменой):\n  ' + missingFiles.join('\n  '));
  process.exit(1);
}

const raw = await fs.readFile(SERVER, 'utf8');
const crlf = raw.includes('\r\n');
let text = raw.replace(/\r\n/g, '\n');
const failed = [];
let changed = 0;
for (const e of EDITS) {
  if (e.done(text)) { console.log('  уже есть  — ' + e.name); continue; }
  const first = text.indexOf(e.anchor);
  if (first < 0) { failed.push(e.name); console.log('  НЕ НАЙДЕН — ' + e.name); continue; }
  if (text.indexOf(e.anchor, first + 1) >= 0) { failed.push(e.name + ' (якорь встречается дважды)'); console.log('  ДВА МЕСТА — ' + e.name); continue; }
  text = text.slice(0, first) + e.to + text.slice(first + e.anchor.length);
  changed++; console.log('  → ' + e.name);
}

// предупреждение: ai-generate.mjs мы не видели; ему нужен параметр fetchImpl, как у соседних модулей
const gen = await fs.readFile(path.join(HERE, 'code-lab/lib/ai-generate.mjs'), 'utf8').catch(() => null);
if (gen != null && !gen.includes('fetchImpl')) console.log('\n  Внимание: в lib/ai-generate.mjs нет параметра fetchImpl, «создание кусков через ИИ» останется только на Mistral.\n  Пришлите этот файл, доработаю.');

if (failed.length) { console.error('\nПатч не применён, ничего не изменено. Не найдено: ' + failed.join('; ')); process.exit(1); }
if (check) { console.log('\nПроверка пройдена.' + (changed ? '' : ' Всё уже применено.')); process.exit(0); }
if (!changed) { console.log('\nНичего менять не нужно.'); process.exit(0); }

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
await fs.writeFile(SERVER + '.bak-' + stamp, raw);
await fs.writeFile(SERVER, crlf ? text.replace(/\n/g, '\r\n') : text);
console.log(`\nГотово. Копия: code-lab-server.mjs.bak-${stamp}. Перезапустите сервер.`);
