// Модель пользовательских конструкций. Независима от паспортов фрагментов и legacy-словарей.
export const CONCEPT_SCHEMA_VERSION = 2;

export const CONCEPT_RELATIONS = Object.freeze({
  equivalent: { label: 'эквивалентно', directed: false, searchable: true },
  contains: { label: 'содержит', directed: true, searchable: false },
  example: { label: 'пример для', directed: true, searchable: false },
  depends: { label: 'требует', directed: true, searchable: false },
  calls: { label: 'вызывает', directed: true, searchable: false },
  data: { label: 'передаёт данные', directed: true, searchable: false },
  returns: { label: 'возвращает', directed: true, searchable: false },
  creates: { label: 'создаёт', directed: true, searchable: false },
  transforms: { label: 'преобразует', directed: true, searchable: false },
  uses: { label: 'использует', directed: true, searchable: false },
  precedes: { label: 'предшествует', directed: true, searchable: false },
  alternative: { label: 'альтернатива', directed: false, searchable: false },
  replaces: { label: 'заменяет', directed: true, searchable: false },
  conflicts: { label: 'конфликтует', directed: false, searchable: false },
  generalizes: { label: 'обобщает', directed: true, searchable: false }
});

const text = v => typeof v === 'string' ? v.trim() : '';
const list = v => Array.isArray(v) ? v : [];
const norm = v => text(v).toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/\s+/g, ' ');

export function migrateConceptStore(input){
  if(!input || typeof input !== 'object' || Array.isArray(input)) return input;
  if(input.schemaVersion === 1){
    return { ...input, schemaVersion: CONCEPT_SCHEMA_VERSION, queryPhrases: Array.isArray(input.queryPhrases) ? input.queryPhrases : [] };
  }
  if(input.schemaVersion === CONCEPT_SCHEMA_VERSION && !Array.isArray(input.queryPhrases)){
    return { ...input, queryPhrases: [] };
  }
  return input;
}

export function createEmptyConceptStore(){
  return { schemaVersion: CONCEPT_SCHEMA_VERSION, concepts: [], relations: [], queryPhrases: [] };
}

export function validateConceptStore(input, { pieceIds } = {}){
  const errors = [], warnings = [];
  const fail = (path, message) => errors.push({ path, message });
  if(!input || typeof input !== 'object' || Array.isArray(input)) return { valid: false, errors: [{ path: '$', message: 'Ожидается объект хранилища' }], warnings };
  if(input.schemaVersion !== CONCEPT_SCHEMA_VERSION) fail('schemaVersion', 'Неизвестная версия схемы');
  if(!Array.isArray(input.concepts)) fail('concepts', 'Ожидается массив понятий');
  if(!Array.isArray(input.relations)) fail('relations', 'Ожидается массив связей');
  if(!Array.isArray(input.queryPhrases)) fail('queryPhrases', 'Ожидается массив поисковых фраз');
  const concepts = list(input.concepts), relations = list(input.relations), queryPhrases = list(input.queryPhrases);
  const byId = new Map(), aliasOwners = new Map();
  concepts.forEach((c, i) => {
    const p = 'concepts[' + i + ']';
    if(!c || typeof c !== 'object' || Array.isArray(c)){ fail(p, 'Понятие должно быть объектом'); return; }
    const id = text(c.id), name = text(c.name);
    if(!id) fail(p + '.id', 'Нужен постоянный ID');
    else if(byId.has(id)) fail(p + '.id', 'ID уже используется');
    else byId.set(id, c);
    if(!name) fail(p + '.name', 'Название не может быть пустым');
    if(typeof c.definition !== 'string') fail(p + '.definition', 'Значение должно быть строкой');
    for(const field of ['aliases','forms','tags','examples']) if(!Array.isArray(c[field])) fail(p + '.' + field, 'Ожидается массив');
    const localAliases = new Set();
    list(c.aliases).forEach((a, j) => {
      const value = typeof a === 'string' ? a : a && a.value;
      const key = norm(value);
      if(!key) fail(p + '.aliases[' + j + ']', 'Пустой вариант названия');
      else if(localAliases.has(key)) fail(p + '.aliases[' + j + ']', 'Повтор варианта внутри понятия');
      else {
        localAliases.add(key);
        if(!aliasOwners.has(key)) aliasOwners.set(key, []);
        aliasOwners.get(key).push(id || p);
      }
    });
    const localForms = new Set();
    list(c.forms).forEach((f, j) => {
      const value = text(f && f.value), language = norm(f && f.language), kind = norm(f && f.kind);
      if(!value) fail(p + '.forms[' + j + '].value', 'Вариант записи не может быть пустым');
      const key = [language, kind, norm(value)].join('|');
      if(localForms.has(key)) fail(p + '.forms[' + j + ']', 'Повтор варианта записи');
      localForms.add(key);
    });
    list(c.examples).forEach((e, j) => {
      if(!e || typeof e !== 'object' || !text(e.pieceId)) fail(p + '.examples[' + j + '].pieceId', 'Нужен ID фрагмента');
      else if(pieceIds && !pieceIds.has(e.pieceId)) fail(p + '.examples[' + j + '].pieceId', 'Фрагмент не найден');
    });
    if(c.origin != null && !['manual','import','inferred'].includes(c.origin)) fail(p + '.origin', 'Неизвестный источник понятия');
  });
  for(const [alias, owners] of aliasOwners) if(owners.length > 1) warnings.push({ path: 'aliases', message: 'Вариант «' + alias + '» используется несколькими понятиями: ' + owners.join(', ') });
  const seenRelations = new Set(), relationIds = new Set();
  relations.forEach((r, i) => {
    const p = 'relations[' + i + ']';
    if(!r || typeof r !== 'object' || Array.isArray(r)){ fail(p, 'Связь должна быть объектом'); return; }
    const relationId = text(r.id);
    if(!relationId) fail(p + '.id', 'Нужен ID связи');
    else if(relationIds.has(relationId)) fail(p + '.id', 'ID связи уже используется');
    else relationIds.add(relationId);
    if(!byId.has(r.from)) fail(p + '.from', 'Исходное понятие не найдено');
    if(!byId.has(r.to)) fail(p + '.to', 'Целевое понятие не найдено');
    if(r.from && r.from === r.to) fail(p, 'Связь понятия с самим собой запрещена');
    if(!Object.prototype.hasOwnProperty.call(CONCEPT_RELATIONS, r.type)) fail(p + '.type', 'Неизвестный тип связи');
    const relationType = CONCEPT_RELATIONS[r.type];
    const endpoints = relationType && !relationType.directed ? [r.from, r.to].sort() : [r.from, r.to];
    const key = [endpoints[0], r.type, endpoints[1]].join('|');
    if(seenRelations.has(key)) fail(p, 'Такая связь уже существует');
    seenRelations.add(key);
    if(r.origin != null && !['manual','import','inferred'].includes(r.origin)) fail(p + '.origin', 'Неизвестный источник связи');
    if(r.confidence != null && (!Number.isFinite(r.confidence) || r.confidence < 0 || r.confidence > 1)) fail(p + '.confidence', 'Уверенность должна быть числом от 0 до 1');
  });
  const phraseIds = new Set(), phraseKeys = new Set(), phraseOwners = new Map();
  queryPhrases.forEach((q, i) => {
    const p = 'queryPhrases[' + i + ']';
    if(!q || typeof q !== 'object' || Array.isArray(q)){ fail(p, 'Поисковая фраза должна быть объектом'); return; }
    const id = text(q.id), phrase = text(q.phrase), target = text(q.targetConceptId), targetKey = text(q.targetKey);
    if(!id) fail(p + '.id', 'Нужен постоянный ID поисковой фразы');
    else if(phraseIds.has(id)) fail(p + '.id', 'ID поисковой фразы уже используется');
    else phraseIds.add(id);
    if(!phrase) fail(p + '.phrase', 'Поисковая фраза не может быть пустой');
    if(Boolean(target) === Boolean(targetKey)) fail(p, 'Нужно указать ровно одну цель: targetConceptId или targetKey');
    if(target && !byId.has(target)) fail(p + '.targetConceptId', 'Целевое понятие не найдено');
    if(targetKey && targetKey.length > 240) fail(p + '.targetKey', 'Ключ цели слишком длинный');
    for(const field of ['language','scope','note']) if(q[field] != null && typeof q[field] !== 'string') fail(p + '.' + field, 'Поле должно быть строкой');
    if(text(q.language).length > 80) fail(p + '.language', 'Язык слишком длинный');
    if(text(q.scope).length > 120) fail(p + '.scope', 'Контекст слишком длинный');
    if(q.origin != null && !['manual','import','inferred'].includes(q.origin)) fail(p + '.origin', 'Неизвестный источник поисковой фразы');
    if(q.confidence != null && (!Number.isFinite(q.confidence) || q.confidence < 0 || q.confidence > 1)) fail(p + '.confidence', 'Уверенность должна быть числом от 0 до 1');
    if(q.source != null && (!q.source || typeof q.source !== 'object' || Array.isArray(q.source))) fail(p + '.source', 'Источник должен быть объектом');
    if(q.source && Object.entries(q.source).some(([k,v]) => !['file','key','group','index'].includes(k) || typeof v !== 'string' && typeof v !== 'number')) fail(p + '.source', 'Источник содержит неизвестные или некорректные поля');
    const key = [norm(phrase), target || 'key:' + targetKey, norm(q.language), norm(q.scope)].join('|');
    if(phrase && target && phraseKeys.has(key)) fail(p, 'Такая поисковая фраза уже связана с понятием в этом контексте');
    phraseKeys.add(key);
    if(phrase){ if(!phraseOwners.has(norm(phrase))) phraseOwners.set(norm(phrase), new Set()); phraseOwners.get(norm(phrase)).add(target || 'key:' + targetKey); }
  });
  for(const [phrase, owners] of phraseOwners) if(owners.size > 1) warnings.push({ path: 'queryPhrases', message: 'Фраза «' + phrase + '» ведёт к нескольким понятиям; неоднозначность сохранена' });
  return { valid: errors.length === 0, errors, warnings };
}
