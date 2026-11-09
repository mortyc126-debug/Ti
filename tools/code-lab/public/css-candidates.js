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

  const api = { properties, cleanExplanation };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CSSCandidates = api;
})(typeof window !== 'undefined' ? window : globalThis);
