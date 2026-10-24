// Миграция «Лаборатории кода»: шаблоны-карточки (templates/*.json с токенами)
//   →  обычные файлы кода + файл описания рядом.
//
//   library/css/<id>.css
//   library/css/<id>.css.meta.json
//
// Исходные templates/*.json НЕ изменяются и не удаляются — это бэкап.
// Повторный запуск пропускает уже созданные файлы (чтобы не затереть ваши правки);
// --force пересоздаёт всё. Сервер делает то же автоматически при первом запуске,
// если library/ пуста, а templates/ — нет; эта команда нужна, чтобы сделать миграцию вручную.
//
//   node tools/migrate-templates.mjs
//   node tools/migrate-templates.mjs --dry                  # только отчёт, ничего не пишет
//   node tools/migrate-templates.mjs --force                # перезаписать уже созданные
//   node tools/migrate-templates.mjs --src <папка> --out <папка>

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateTemplates } from './code-lab/lib/migrate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, 'code-lab');
const args = process.argv.slice(2);
const opt = (n, def) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? path.resolve(args[i + 1]) : def; };

const r = await migrateTemplates({
  src: opt('--src', path.join(ROOT, 'templates')),
  out: opt('--out', path.join(ROOT, 'library')),
  dictPath: opt('--dict', path.join(ROOT, 'public', 'keyword-dict.json')),
  dry: args.includes('--dry'),
  force: args.includes('--force')
});

console.log(`Шаблонов в ${r.src}: ${r.total}`);
console.log(`${r.dry ? '[dry] было бы создано' : 'Создано'}: ${r.created}, пропущено (уже есть): ${r.skippedExisting}, ошибок: ${r.errors.length}`);
console.log('По языкам:', Object.entries(r.byLang).map(([k, v]) => `${k} ${v}`).join(', '));
console.log(`Пояснений слов: из словаря ${r.notes.dict}, свои ${r.notes.custom}`);
console.log(`Без описания (нужен ИИ или ручное): ${r.emptyDesc.length}`);
if(r.errors.length){ console.log('Ошибки:'); r.errors.forEach(e => console.log(' ', e.file, '—', e.error)); process.exitCode = 1; }
if(!r.dry) console.log('Результат:', r.out);
