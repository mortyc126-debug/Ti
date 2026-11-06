import assert from 'node:assert/strict';
import { createEmptyConceptStore, validateConceptStore, CONCEPT_RELATIONS } from '../lib/concept-model.mjs';

const base = () => ({
  schemaVersion: 1,
  concepts: [
    { id: 'debounce', name: 'Задержка частых вызовов', definition: 'Откладывает вызов до паузы во входном потоке.', aliases: ['debounce', 'отложенный вызов'], forms: [{ value: 'debounce(fn, delay)', language: 'js', kind: 'syntax', note: 'Функция-обёртка' }], tags: ['таймеры'], examples: [{ pieceId: 'js-debounce', note: 'Пример реализации' }], origin: 'manual' },
    { id: 'timer', name: 'Таймер', definition: 'Механизм отложенного выполнения.', aliases: ['таймер'], forms: [], tags: [], examples: [] }
  ],
  relations: [{ id: 'r1', from: 'debounce', to: 'timer', type: 'depends', origin: 'manual' }]
});

assert.deepEqual(createEmptyConceptStore(), { schemaVersion: 1, concepts: [], relations: [] });
assert.equal(validateConceptStore(base(), { pieceIds: new Set(['js-debounce']) }).valid, true);
assert.equal(CONCEPT_RELATIONS.depends.searchable, false);

const missingPiece = base();
missingPiece.concepts[0].examples[0].pieceId = 'missing';
assert.equal(validateConceptStore(missingPiece, { pieceIds: new Set(['js-debounce']) }).errors[0].path, 'concepts[0].examples[0].pieceId');

const duplicateId = base();
duplicateId.concepts[1].id = 'debounce';
assert.ok(validateConceptStore(duplicateId).errors.some(e => e.path === 'concepts[1].id'));

const duplicateAlias = base();
duplicateAlias.concepts[0].aliases.push('DEBOUNCE');
assert.ok(validateConceptStore(duplicateAlias).errors.some(e => e.message.includes('Повтор варианта')));

const ambiguousAlias = base();
ambiguousAlias.concepts[1].aliases.push('debounce');
assert.ok(validateConceptStore(ambiguousAlias).warnings.some(w => w.message.includes('несколькими понятиями')));

const invalidRelation = base();
invalidRelation.relations[0].type = 'synonym-bag';
assert.ok(validateConceptStore(invalidRelation).errors.some(e => e.path === 'relations[0].type'));

const relationExpansion = base();
assert.equal(validateConceptStore(relationExpansion).valid, true);
relationExpansion.relations.push({ id: 'r2', from: 'debounce', to: 'timer', type: 'depends' });
assert.ok(validateConceptStore(relationExpansion).errors.some(e => e.message.includes('Такая связь уже существует')));

console.log('concept-model: 8 checks passed');
