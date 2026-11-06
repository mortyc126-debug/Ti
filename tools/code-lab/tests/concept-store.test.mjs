import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConceptStore } from '../lib/concept-store.mjs';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codelab-concepts-'));
try {
  const filePath = path.join(tmp, 'library', '_concepts.json');
  const store = createConceptStore({ filePath, getPieceIds: async () => new Set(['js-example']) });
  const empty = await store.get();
  assert.deepEqual(empty, { schemaVersion: 1, concepts: [], relations: [] });
  const data = {
    schemaVersion: 1,
    concepts: [{ id: 'debounce', name: 'Задержка частых вызовов', definition: 'Откладывает вызов до паузы.', aliases: ['debounce', 'отложенный вызов'], forms: [{ value: 'debounce(fn, delay)', language: 'js', kind: 'syntax', note: 'Вызов' }], tags: ['таймеры'], examples: [{ pieceId: 'js-example' }], origin: 'manual' }],
    relations: []
  };
  const saved = await store.save(data);
  assert.equal(saved.ok, true);
  assert.equal((await store.get()).concepts[0].id, 'debounce');
  data.concepts[0].examples[0].pieceId = 'missing';
  await assert.rejects(store.save(data), error => error.validation.errors.some(item => item.path === 'concepts[0].examples[0].pieceId'));
  assert.equal((await store.get()).concepts[0].examples[0].pieceId, 'js-example');
  const ambiguous = await store.validate({ ...data, concepts: [
    { ...data.concepts[0], examples: [], aliases: ['общий вариант'] },
    { id: 'second', name: 'Второе', definition: '', aliases: ['общий вариант'], forms: [], tags: [], examples: [] }
  ], relations: [] });
  assert.ok(ambiguous.warnings.some(item => item.message.includes('несколькими понятиями')));
  await fs.writeFile(filePath, '{ invalid', 'utf8');
  await assert.rejects(store.get(), SyntaxError);
  console.log('concept-store: 7 checks passed');
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
