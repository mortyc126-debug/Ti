import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createEmptyConceptStore, migrateConceptStore, validateConceptStore } from './concept-model.mjs';

export function createConceptStore({ filePath, getPieceIds = async () => new Set() }) {
  if (!filePath) throw new Error('Нужен путь к файлу хранилища понятий');
  const target = path.resolve(filePath);
  let cached = createEmptyConceptStore();
  let cachedStamp;
  let lock = Promise.resolve();
  const withLock = fn => { const next = lock.then(fn, fn); lock = next.catch(() => {}); return next; };

  async function stamp() {
    const stat = await fs.lstat(target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!stat) return null;
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Файл хранилища понятий должен быть обычным файлом: ' + target);
    return String(stat.mtimeMs) + ':' + String(stat.size);
  }

  async function load(force = false) {
    const currentStamp = await stamp();
    if (!force && currentStamp === cachedStamp) return cached;
    if (currentStamp === null) cached = createEmptyConceptStore();
    else {
      const parsed = JSON.parse(await fs.readFile(target, 'utf8'));
      const migrated = migrateConceptStore(parsed);
      const result = validateConceptStore(migrated);
      if (!result.valid) {
        const error = new Error('Файл хранилища понятий не прошёл проверку');
        error.validation = result;
        throw error;
      }
      cached = migrated;
    }
    cachedStamp = currentStamp;
    return cached;
  }

  async function validate(input) {
    const ids = await getPieceIds();
    const pieceIds = ids instanceof Set ? ids : new Set(Array.isArray(ids) ? ids : []);
    return validateConceptStore(input, { pieceIds });
  }

  return {
    filePath: target,
    async get() {
      const value = await load();
      return JSON.parse(JSON.stringify(value));
    },
    async validate(input) { return validate(migrateConceptStore(input)); },
    save(input) {
      return withLock(async () => {
        await load();
        const next = migrateConceptStore(JSON.parse(JSON.stringify(input)));
        const result = await validate(next);
        if (!result.valid) {
          const error = new Error('Данные понятий не прошли проверку');
          error.validation = result;
          throw error;
        }
        await fs.mkdir(path.dirname(target), { recursive: true });
        const temp = target + '.tmp-' + process.pid + '-' + randomUUID();
        try {
          await fs.writeFile(temp, JSON.stringify(next, null, 2) + '\n', 'utf8');
          const existing = await fs.lstat(target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
          if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new Error('Файл хранилища понятий должен быть обычным файлом: ' + target);
          await fs.rename(temp, target);
        } finally {
          await fs.unlink(temp).catch(() => {});
        }
        cached = next;
        cachedStamp = await stamp();
        return {
          ok: true,
          count: next.concepts.length,
          relationCount: next.relations.length,
          queryPhraseCount: next.queryPhrases.length,
          warnings: result.warnings
        };
      });
    }
  };
}
