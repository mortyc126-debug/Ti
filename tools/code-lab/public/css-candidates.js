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
    const tagNames = new Set(Object.keys(dictionary && dictionary.htmlTags || {}));
    const source = Object.assign({}, dictionary && dictionary.htmlTags || {}, dictionary && dictionary.words || {}, dictionary && dictionary.langs && dictionary.langs.css || {});
    const selectorPattern = /^(?:@[a-z][\w-]*|::?[a-z][\w-]*(?:\([^)]*\))?|[.#][\w-]+|\[[^\]]+\])$/i;
    return Object.entries(source)
      .filter(([name, explanation]) => (selectorPattern.test(name) || tagNames.has(name)) &&
        name.toLowerCase().startsWith(query) && typeof explanation === 'string')
      .map(([name, explanation]) => ({
        code: name,
        lang: 'css',
        label: 'селектор',
        note: cleanExplanation(name, explanation),
        expected: 'selector',
        contexts: ['css-selector', 'css-selector-argument'],
        languages: ['css'],
        children: []
      }));
  }

  function maskCommentsAndStrings(code) {
    let out = '', quote = '', comment = false, escaped = false;
    for (let i = 0; i < code.length; i++) {
      const ch = code[i], next = code[i + 1];
      if (comment) {
        if (ch === '*' && next === '/') { out += '  '; i++; comment = false; }
        else out += ch === '\n' ? '\n' : ' ';
        continue;
      }
      if (quote) {
        out += ch === '\n' ? '\n' : ' ';
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === quote) quote = '';
        continue;
      }
      if (ch === '/' && next === '*') { out += '  '; i++; comment = true; continue; }
      if (ch === '"' || ch === "'") { quote = ch; out += ' '; continue; }
      out += ch;
    }
    return out;
  }

  function variables(code, prefix) {
    const rawPrefix = String(prefix || '').trim();
    if (!rawPrefix.startsWith('--')) return [];
    const source = maskCommentsAndStrings(String(code || ''));
    const names = new Set();
    const pattern = /(--[a-z0-9_-]+)\s*:/gi;
    let match;
    while ((match = pattern.exec(source))) names.add(match[1]);
    return Array.from(names)
      .filter(name => name.startsWith(rawPrefix))
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


  const functionArgumentNames = new Set([
    'nth-child', 'nth-last-child', 'nth-of-type', 'nth-last-of-type', 'dir', 'lang'
  ]);

  function functionArguments(dictionary, functionName, prefix) {
    const name = String(functionName || '').trim().toLowerCase();
    if (!functionArgumentNames.has(name)) return [];
    const query = String(prefix || '').trim().toLowerCase();
    const source = Object.assign({}, dictionary && dictionary.cssVals || {},
      dictionary && dictionary.langs && dictionary.langs.css || {});
    // Имя функции берётся только из фиксированного списка, поэтому его можно безопасно вставить в шаблон.
    const pattern = new RegExp('^:' + name + '\\(([^()]*)\\)$', 'i');
    return Object.entries(source)
      .map(([key, explanation]) => {
        const match = key.match(pattern);
        return match && typeof explanation === 'string'
          ? { code: match[1].trim(), explanation }
          : null;
      })
      .filter(item => item && (!query || item.code.toLowerCase().startsWith(query)))
      .map(item => ({
        code: item.code,
        lang: 'css',
        label: 'аргумент псевдокласса',
        note: cleanExplanation(':' + name + '(' + item.code + ')', item.explanation),
        expected: 'function-argument',
        contexts: ['css-function-argument'],
        languages: ['css'],
        children: []
      }));
  }

  const api = { properties, selectors, variables, functionArguments, cleanExplanation };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CSSCandidates = api;
})(typeof window !== 'undefined' ? window : globalThis);
