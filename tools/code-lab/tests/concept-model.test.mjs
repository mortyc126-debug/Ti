import assert from 'node:assert/strict';
import { createEmptyConceptStore, migrateConceptStore, validateConceptStore, CONCEPT_RELATIONS } from '../lib/concept-model.mjs';

const base = () => ({
  schemaVersion: 2,
  concepts: [
    { id: 'debounce', name: 'Задержка частых вызовов', definition: 'Откладывает вызов до паузы во входном потоке.', aliases: ['debounce', 'отложенный вызов'], forms: [{ value: 'debounce(fn, delay)', language: 'js', kind: 'syntax', note: 'Функция-обёртка' }], tags: ['таймеры'], examples: [{ pieceId: 'js-debounce', note: 'Пример реализации' }], origin: 'manual' },
    { id: 'timer', name: 'Таймер', definition: 'Механизм отложенного выполнения.', aliases: ['таймер'], forms: [], tags: [], examples: [] }
  ],
  relations: [{ id: 'r1', from: 'debounce', to: 'timer', type: 'depends', origin: 'manual' }],
  queryPhrases: []
});

assert.deepEqual(createEmptyConceptStore(), { schemaVersion: 2, concepts: [], relations: [], queryPhrases: [] });
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


const symmetricDuplicate = base();
symmetricDuplicate.relations = [
  { id: 'r1', from: 'debounce', to: 'timer', type: 'equivalent' },
  { id: 'r2', from: 'timer', to: 'debounce', type: 'equivalent' }
];
assert.ok(validateConceptStore(symmetricDuplicate).errors.some(e => e.message.includes('Такая связь уже существует')));

const duplicateRelationId = base();
duplicateRelationId.relations.push({ id: 'r1', from: 'timer', to: 'debounce', type: 'calls' });
assert.ok(validateConceptStore(duplicateRelationId).errors.some(e => e.path === 'relations[1].id'));

console.log('concept-model: 10 checks passed');

const migratedV1 = migrateConceptStore({ schemaVersion: 2, concepts: [], relations: [] });
assert.deepEqual(migratedV1, { schemaVersion: 2, concepts: [], relations: [], queryPhrases: [] });
assert.equal(validateConceptStore(migratedV1).valid, true);

const phraseStore = base();
phraseStore.queryPhrases = [
  { id: 'q1', phrase: 'запустить после паузы', targetConceptId: 'debounce', language: 'js', scope: 'timer', origin: 'manual', confidence: 0.9, source: { file: 'dict.json', key: 'debounce' } },
  { id: 'q2', phrase: 'запустить после паузы', targetConceptId: 'timer', language: 'py', scope: 'asyncio', origin: 'import' }
];
assert.equal(validateConceptStore(phraseStore).valid, true);
assert.ok(validateConceptStore(phraseStore).warnings.some(w => w.message.includes('неоднозначность сохранена')));
const badPhrase = base();
badPhrase.queryPhrases = [{ id: 'q1', phrase: '', targetConceptId: 'missing', language: '', scope: '', origin: 'manual' }];
const badPhraseResult = validateConceptStore(badPhrase);
assert.ok(badPhraseResult.errors.some(e => e.path === 'queryPhrases[0].phrase'));
assert.ok(badPhraseResult.errors.some(e => e.path === 'queryPhrases[0].targetConceptId'));
const duplicatePhrase = base();
duplicatePhrase.queryPhrases = [
  { id: 'q1', phrase: 'та же фраза', targetConceptId: 'debounce', language: 'js', scope: 'timer' },
  { id: 'q2', phrase: 'ТА ЖЕ ФРАЗА', targetConceptId: 'debounce', language: 'JS', scope: 'timer' }
];
assert.ok(validateConceptStore(duplicatePhrase).errors.some(e => e.message.includes('Такая поисковая фраза уже связана')));
console.log('concept-model: schema v2 and query phrase checks passed');

const migratedV1 = migrateConceptStore({ schemaVersion: 1, concepts: [], relations: [] });
assert.deepEqual(migratedV1, { schemaVersion: 2, concepts: [], relations: [], queryPhrases: [] });
assert.equal(validateConceptStore(migratedV1).valid, true);

const phraseStore = base();
phraseStore.queryPhrases = [
  { id: 'q1', phrase: 'запустить после паузы', targetConceptId: 'debounce', language: 'js', scope: 'timer', origin: 'manual', confidence: 0.9, source: { file: 'dict.json', key: 'debounce' } },
  { id: 'q2', phrase: 'запустить после паузы', targetConceptId: 'timer', language: 'py', scope: 'asyncio', origin: 'import' },
  { id: 'q3', phrase: 'запустить после паузы', targetKey: 'legacy-key', origin: 'import', source: { file: 'synonyms.json', key: 'legacy-key', index: 0 } }
];
assert.equal(validateConceptStore(phraseStore).valid, true);
assert.ok(validateConceptStore(phraseStore).warnings.some(w => w.message.includes('неоднозначность сохранена')));
const badPhrase = base();
badPhrase.queryPhrases = [{ id: 'q1', phrase: '', targetConceptId: 'missing', language: '', scope: '', origin: 'manual' }];
const badPhraseResult = validateConceptStore(badPhrase);
assert.ok(badPhraseResult.errors.some(e => e.path === 'queryPhrases[0].phrase'));
assert.ok(badPhraseResult.errors.some(e => e.path === 'queryPhrases[0].targetConceptId'));
const invalidTarget = base();
invalidTarget.queryPhrases = [{ id: 'q1', phrase: 'x', targetKey: 'k', targetConceptId: 'debounce' }];
assert.ok(validateConceptStore(invalidTarget).errors.some(e => e.message.includes('ровно одну цель')));
const duplicatePhrase = base();
duplicatePhrase.queryPhrases = [
  { id: 'q1', phrase: 'та же фраза', targetConceptId: 'debounce', language: 'js', scope: 'timer' },
  { id: 'q2', phrase: 'ТА ЖЕ ФРАЗА', targetConceptId: 'debounce', language: 'JS', scope: 'timer' }
];
assert.ok(validateConceptStore(duplicatePhrase).errors.some(e => e.message.includes('Такая поисковая фраза уже связана')));
console.log('concept-model: schema v2 and query phrase checks passed');
