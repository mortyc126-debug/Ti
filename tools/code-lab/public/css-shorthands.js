(function (root) {
  'use strict';

  const registry = Object.freeze({
    'place-items': Object.freeze({
      name: 'place-items',
      components: Object.freeze(['align-items', 'justify-items']),
      valueOrder: Object.freeze(['align-items', 'justify-items']),
      singleValue: 'both',
      contexts: Object.freeze(['grid-container']),
      notes: Object.freeze([
        'Первое значение задаёт align-items, второе — justify-items.',
        'Одно значение применяется к обеим составляющим.',
        'В flex-контейнере justify-items не выравнивает flex-элементы.'
      ])
    }),
    'place-content': Object.freeze({
      name: 'place-content',
      components: Object.freeze(['align-content', 'justify-content']),
      valueOrder: Object.freeze(['align-content', 'justify-content']),
      singleValue: 'both',
      contexts: Object.freeze(['grid-container', 'flex-container', 'multicol-container']),
      notes: Object.freeze([
        'Первое значение задаёт align-content, второе — justify-content.',
        'Одно значение применяется к обеим составляющим.',
        'Эффект зависит от свободного пространства и типа раскладки.'
      ])
    }),
    'place-self': Object.freeze({
      name: 'place-self',
      components: Object.freeze(['align-self', 'justify-self']),
      valueOrder: Object.freeze(['align-self', 'justify-self']),
      singleValue: 'both',
      contexts: Object.freeze(['grid-item', 'absolutely-positioned-item']),
      notes: Object.freeze([
        'Первое значение задаёт align-self, второе — justify-self.',
        'Одно значение применяется к обеим составляющим.',
        'У flex-элемента justify-self не управляет выравниванием по главной оси.'
      ])
    })
  });

  function get(name) {
    const item = registry[String(name || '').trim().toLowerCase()];
    if (!item) return null;
    return {
      name: item.name,
      components: item.components.slice(),
      valueOrder: item.valueOrder.slice(),
      singleValue: item.singleValue,
      contexts: item.contexts.slice(),
      notes: item.notes.slice()
    };
  }

  function forLonghand(name) {
    const key = String(name || '').trim().toLowerCase();
    return Object.values(registry).filter(item => item.components.includes(key)).map(item => get(item.name));
  }

  // values are grammar-separated component values, not an unparsed CSS declaration string.
  function expand(name, values) {
    const item = registry[String(name || '').trim().toLowerCase()];
    if (!item) return { ok: false, reason: 'unknown-shorthand' };
    if (!Array.isArray(values) || values.length < 1 || values.length > item.components.length ||
        values.some(value => typeof value !== 'string' || !value.trim())) {
      return { ok: false, reason: 'invalid-component-values' };
    }
    const parts = values.length === 1 ? [values[0], values[0]] : values;
    return {
      ok: true,
      shorthand: item.name,
      declarations: Object.fromEntries(item.valueOrder.map((property, index) => [property, parts[index]])),
      notes: item.notes.slice()
    };
  }

  // Collapse is intentionally opt-in: the caller must prove that the source range is safe.
  function collapse(name, declarations, safety) {
    const item = registry[String(name || '').trim().toLowerCase()];
    if (!item) return { ok: false, reason: 'unknown-shorthand' };
    const values = item.components.map(property => declarations && declarations[property]);
    if (values.some(value => typeof value !== 'string' || !value.trim())) {
      return { ok: false, reason: 'missing-component' };
    }
    const checks = [
      'commentsPreserved',
      'noDuplicates',
      'cascadePreserved',
      'resetEffectsReviewed',
      'grammarValidated'
    ];
    const missing = checks.filter(key => !safety || safety[key] !== true);
    if (missing.length) return { ok: false, reason: 'unsafe-source-range', missing };
    return {
      ok: true,
      shorthand: item.name,
      value: values[0] === values[1] ? values[0] : values.join(' '),
      components: item.components.slice()
    };
  }

  const api = { get, forLonghand, expand, collapse };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CSSShorthands = api;
})(typeof window !== 'undefined' ? window : globalThis);
