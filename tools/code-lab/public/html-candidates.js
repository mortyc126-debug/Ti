(function (root) {
  'use strict';

  function tags(dictionary, prefix) {
    const query = String(prefix || '').trim().toLowerCase();
    if (!query) return [];
    const section = dictionary && dictionary.htmlTags;
    if (!section || typeof section !== 'object') return [];
    return Object.entries(section)
      .filter(([name, explanation]) => /^[a-z][a-z0-9-]*$/i.test(name) &&
        name.toLowerCase().startsWith(query) && typeof explanation === 'string')
      .map(([name, explanation]) => ({
        code: name,
        lang: 'html',
        label: 'HTML-элемент',
        note: String(explanation).replace(new RegExp('^<'+name+'\\s*>\\s*[—:-]\\s*', 'i'), ''),
        expected: 'tag-name',
        contexts: ['html-tag'],
        languages: ['html'],
        children: []
      }));
  }

  const api = { tags };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.HTMLCandidates = api;
})(typeof window !== 'undefined' ? window : globalThis);
