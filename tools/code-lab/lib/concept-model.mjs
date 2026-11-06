// Модель пользовательских конструкций. Независима от паспортов фрагментов и словарей поиска.
export const CONCEPT_SCHEMA_VERSION = 1;

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

export function createEmptyConceptStore(){
  return { schemaVersion: CONCEPT_SCHEMA_VERSION, concepts: [], relations: [] };
}

export function validateConceptStore(input, { pieceIds } = {}){
  const errors = [], warnings = [];
  const fail = (path, message) => errors.push({ path, message });
  if(!input || typeof input !== 'object' || Array.isArray(input)) return { valid: false, errors: [{ path: '$', message: 'Ожидается объект хранилища' }], warnings };
  if(input.schemaVersion !== CONCEPT_SCHEMA_VERSION) fail('schemaVersion', 'Неизвестная версия схемы');
  if(!Array.isArray(input.concepts)) fail('concepts', 'Ожидается массив понятий');
  if(!Array.isArray(input.relations)) fail('relations', 'Ожидается массив связей');
  const concepts = list(input.concepts), relations = list(input.relations);
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
    if(!Array.isArray(c.aliases)) fail(p + '.aliases', 'Варианты названия должны быть массивом');
    if(!Array.isArray(c.forms)) fail(p + '.forms', 'Варианты записи должны быть массивом');
    if(!Array.isArray(c.tags)) fail(p + '.tags', 'Теги должны быть массивом');
    if(!Array.isArray(c.examples)) fail(p + '.examples', 'Примеры должны быть массивом');
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
  const seenRelations = new Set();
  relations.forEach((r, i) => {
    const p = 'relations[' + i + ']';
    if(!r || typeof r !== 'object' || Array.isArray(r)){ fail(p, 'Связь должна быть объектом'); return; }
    if(!text(r.id)) fail(p + '.id', 'Нужен ID связи');
    if(!byId.has(r.from)) fail(p + '.from', 'Исходное понятие не найдено');
    if(!byId.has(r.to)) fail(p + '.to', 'Целевое понятие не найдено');
    if(r.from && r.from === r.to) fail(p, 'Связь понятия с самим собой запрещена');
    if(!Object.prototype.hasOwnProperty.call(CONCEPT_RELATIONS, r.type)) fail(p + '.type', 'Неизвестный тип связи');
    const key = [r.from, r.type, r.to].join('|');
    if(seenRelations.has(key)) fail(p, 'Такая связь уже существует');
    seenRelations.add(key);
    if(r.origin != null && !['manual','import','inferred'].includes(r.origin)) fail(p + '.origin', 'Неизвестный источник связи');
    if(r.confidence != null && (!Number.isFinite(r.confidence) || r.confidence < 0 || r.confidence > 1)) fail(p + '.confidence', 'Уверенность должна быть числом от 0 до 1');
  });
  return { valid: errors.length === 0, errors, warnings };
}
