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


  const componentValues = Object.freeze({
    'align-items': new Set(['normal','stretch','center','start','end','self-start','self-end','flex-start','flex-end','baseline']),
    'justify-items': new Set(['normal','stretch','center','start','end','self-start','self-end','left','right','baseline']),
    'align-content': new Set(['normal','stretch','center','start','end','flex-start','flex-end','space-between','space-around','space-evenly','baseline']),
    'justify-content': new Set(['normal','center','start','end','flex-start','flex-end','left','right','space-between','space-around','space-evenly']),
    'align-self': new Set(['auto','normal','stretch','center','start','end','self-start','self-end','flex-start','flex-end','baseline']),
    'justify-self': new Set(['auto','normal','stretch','center','start','end','self-start','self-end','left','right'])
  });

  function isAllowed(name, componentIndex, value) {
    const item = registry[String(name || '').trim().toLowerCase()];
    if (!item || !Number.isInteger(componentIndex) || componentIndex < 0 || componentIndex >= item.components.length) return false;
    const token = String(value || '').trim().toLowerCase();
    return !!token && !/\s/.test(token) && componentValues[item.components[componentIndex]]?.has(token) === true;
  }

  function maskCss(source) {
    const chars = String(source || '').split('');
    let quote = '', comment = false, escaped = false;
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i], next = chars[i + 1];
      if (comment) {
        if (ch !== '\n' && ch !== '\r') chars[i] = ' ';
        if (ch === '*' && next === '/') { chars[i + 1] = ' '; i++; comment = false; }
        continue;
      }
      if (quote) {
        if (ch !== '\n' && ch !== '\r') chars[i] = ' ';
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === quote) quote = '';
        continue;
      }
      if (ch === '/' && next === '*') { chars[i] = chars[i + 1] = ' '; i++; comment = true; continue; }
      if (ch === '"' || ch === "'") { chars[i] = ' '; quote = ch; }
    }
    return chars.join('');
  }

  function collapseRange(name, selection, fullCode, startOffset) {
    const item = registry[String(name || '').trim().toLowerCase()];
    if (!item) return { ok: false, reason: 'unknown-shorthand' };
    const source = String(selection || '');
    const full = String(fullCode || '');
    if (!Number.isInteger(startOffset) || startOffset < 0 ||
        full.slice(startOffset, startOffset + source.length) !== source) {
      return { ok: false, reason: 'selection-mismatch' };
    }
    if (/\/\*/.test(source)) return { ok: false, reason: 'comments-in-selection' };

    const firstProperty = item.components[0], secondProperty = item.components[1];
    const pair = new RegExp('^\\s*' + firstProperty +
      '\\s*:\\s*([a-z-]+)\\s*;\\s*' + secondProperty +
      '\\s*:\\s*([a-z-]+)\\s*;?\\s*$', 'i').exec(source);
    if (!pair) return { ok: false, reason: 'not-adjacent-component-pair' };
    if (!isAllowed(item.name, 0, pair[1]) || !isAllowed(item.name, 1, pair[2])) {
      return { ok: false, reason: 'unsupported-component-value' };
    }

    const masked = maskCss(full);
    const pairs = [], stack = [];
    for (let i = 0; i < masked.length; i++) {
      if (masked[i] === '{') stack.push(i);
      else if (masked[i] === '}' && stack.length) pairs.push([stack.pop(), i]);
    }
    const selectionEnd = startOffset + source.length;
    const containing = pairs
      .filter(([open, close]) => open < startOffset && close >= selectionEnd)
      .sort((a, b) => (a[1] - a[0]) - (b[1] - b[0]))[0];
    if (!containing) return { ok: false, reason: 'selection-not-in-rule-block' };

    const block = masked.slice(containing[0] + 1, containing[1]);
    const count = property => {
      const re = new RegExp('(?:^|[;\\s])' + property + '\\s*:', 'gi');
      return [...block.matchAll(re)].length;
    };
    if (count(firstProperty) !== 1 || count(secondProperty) !== 1 || count(item.name) !== 0) {
      return { ok: false, reason: 'duplicate-or-existing-shorthand' };
    }

    return collapse(item.name, {
      [firstProperty]: pair[1],
      [secondProperty]: pair[2]
    }, {
      commentsPreserved: true,
      noDuplicates: true,
      cascadePreserved: true,
      resetEffectsReviewed: true,
      grammarValidated: true
    });
  }

  const api = { get, forLonghand, expand, collapse, collapseRange, isAllowed };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CSSShorthands = api;
})(typeof window !== 'undefined' ? window : globalThis);
