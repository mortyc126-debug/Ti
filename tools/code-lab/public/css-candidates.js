(function (root) {
  'use strict';

  function cleanExplanation(name, value) {
    const text = String(value || '').trim();
    return text.replace(new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[—:-]\\s*', 'i'), '');
  }

  function properties(dictionary, prefix) {
    const query = String(prefix || '').trim().toLowerCase();
    if (!query) return [];
    const section = dictionary && dictionary.cssProps;
    if (!section || typeof section !== 'object') return [];
    return Object.entries(section)
      .filter(([name, explanation]) => name.toLowerCase().startsWith(query) && typeof explanation === 'string')
      .map(([name, explanation]) => ({
        code: name,
        lang: 'css',
        label: 'свойство',
        note: cleanExplanation(name, explanation),
        expected: 'property-name',
        contexts: ['css-property'],
        languages: ['css'],
        children: []
      }));
  }

  function selectors(dictionary, prefix) {
    const query = String(prefix || '').trim().toLowerCase();
    if (!query) return [];
    const source = dictionary && dictionary.langs && dictionary.langs.css;
    if (!source || typeof source !== 'object') return [];
    const selectorPattern = /^(?:@[a-z][\w-]*|::?[a-z][\w-]*(?:\([^)]*\))?|[.#][\w-]+|\[[^\]]+\])$/i;
    return Object.entries(source)
      .filter(([name, explanation]) => selectorPattern.test(name) &&
        name.toLowerCase().startsWith(query) && typeof explanation === 'string')
      .map(([name, explanation]) => ({
        code: name,
        lang: 'css',
        label: 'селектор',
        note: cleanExplanation(name, explanation),
        expected: 'selector',
        contexts: ['css-selector'],
        languages: ['css'],
        children: []
      }));
  }

  function variables(code, prefix) {
    const query = String(prefix || '').trim().toLowerCase();
    if (!query.startsWith('--')) return [];
    const source = String(code || '')
      .replace(/\\/\\*[\\s\\S]*?\\*\\//g, ' ')
      .replace(/(["'])(?:\\\\.|(?!\\1)[^\\\\])*?\\1/g, ' ');
    const names = new Set();
    const pattern = /(--[a-z0-9_-]+)\\s*:/gi;
    let match;
    while ((match = pattern.exec(source))) names.add(match[1]);
    return Array.from(names)
      .filter(name => name.toLowerCase().startsWith(query))
      .sort()
      .map(name => ({
        code: name,
        lang: 'css',
        label: 'переменная CSS',
        note: 'пользовательское свойство, объявленное в текущем коде',
        expected: 'function-argument',
        contexts: ['css-function-argument'],
        languages: ['css'],
        children: []
      }));
  }

  const api = { properties, selectors, variables, cleanExplanation };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CSSCandidates = api;
})(typeof window !== 'undefined' ? window : globalThis);
