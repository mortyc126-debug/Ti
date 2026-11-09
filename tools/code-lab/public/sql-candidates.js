(function (root) {
  'use strict';

  const choices = Object.freeze({
    'sql-statement': ['select', 'with', 'insert', 'update', 'delete', 'create'],
    'sql-select-list': ['distinct', 'as', 'count', 'sum', 'avg', 'min', 'max', 'coalesce', 'nullif', 'concat', 'lower', 'upper', 'length', 'substring', 'round', 'case', 'from'],
    'sql-table-source': ['join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'on', 'where', 'group', 'order', 'limit', 'offset'],
    'sql-condition': ['and', 'or', 'not', 'in', 'is', 'null', 'between', 'like', 'exists', 'group', 'order', 'having', 'limit', 'offset'],
    'sql-join-condition': ['and', 'or', 'not', 'in', 'is', 'null', 'between', 'like'],
    'sql-group-order': ['having', 'order', 'asc', 'desc', 'limit', 'offset'],
    'sql-assignment': ['default', 'null', 'where'],
    'sql-values': ['default', 'null'],
    'sql-limit': ['offset']
  });

  function ctes(code) {
    const found = [];
    const source = String(code || '')
      .replace(/--[^\r\n]*/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/'(?:''|[^'])*'/g, ' ');
    const re = /\b(?:with|,)\s*([\p{L}_][\p{L}\p{N}_$]*)\s+as\s*\(/giu;
    for (const match of source.matchAll(re)) found.push(match[1]);
    return [...new Set(found)];
  }

  function candidates(dictionary, context, code) {
    if (!context || !choices[context.kind]) return [];
    const entries = dictionary && dictionary.langs && dictionary.langs.sql || {};
    const prefix = String(context.prefix || '').toLowerCase();
    const cteNames = context.kind === 'sql-table-source' ? ctes(code) : [];
    const items = choices[context.kind].map(key => ({ key, code: key.toUpperCase() }));
    if (cteNames.length) items.unshift(...cteNames.map(name => ({ key: name.toLowerCase(), code: name, cte: true })));
    const seen = new Set();
    return items.filter(item => {
      const hasExplanation = Boolean(entries[item.key]) || item.cte === true;
      if (!hasExplanation || seen.has(item.key) || (prefix && !item.key.startsWith(prefix))) return false;
      seen.add(item.key);
      return true;
    }).map(item => {
      const key = item.key;
      const note = entries[key] || 'Объявленный CTE — именованный результат запроса.';
      const isFunction = ['count','sum','avg','min','max','coalesce','nullif','concat','lower','upper','length','substring','round'].includes(key);
      return {
        code: item.code,
        lang: 'sql',
        label: isFunction ? 'функция' : 'SQL',
        note,
        expected: context.expected,
        contexts: [context.kind],
        languages: ['sql'],
        children: []
      };
    });
  }

  const api = { candidates, ctes };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SQLCandidates = api;
})(typeof window !== 'undefined' ? window : globalThis);
