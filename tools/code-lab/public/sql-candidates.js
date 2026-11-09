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

  function visibleSql(code) {
    return String(code || '')
      .replace(/--[^\r\n]*/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/'(?:''|[^'])*'/g, ' ');
  }

  function ctes(code) {
    const found = [];
    const re = /\b(?:with|,)\s*([\p{L}_][\p{L}\p{N}_$]*)\s+as\s*\(/giu;
    for (const match of visibleSql(code).matchAll(re)) found.push(match[1]);
    return [...new Set(found)];
  }

  function scope(code) {
    const source = visibleSql(code);
    const reserved = new Set(['where','join','left','right','inner','outer','full','cross','on','group','order',
      'having','limit','offset','set','values','union','except','intersect','as']);
    const refs = [];
    const re = /\b(?:from|join|update|into)\s+([\p{L}_][\p{L}\p{N}_$]*(?:\.[\p{L}_][\p{L}\p{N}_$]*)?)(?:\s+(?:as\s+)?([\p{L}_][\p{L}\p{N}_$]*))?/giu;
    for (const match of source.matchAll(re)) {
      const table = match[1];
      const possibleAlias = match[2] || '';
      const alias = possibleAlias && !reserved.has(possibleAlias.toLowerCase()) ? possibleAlias : '';
      const qualifier = alias || table;
      if (!refs.some(ref => ref.qualifier.toLowerCase() === qualifier.toLowerCase())) {
        refs.push({ table, alias, qualifier });
      }
    }
    return { ctes: ctes(source), sources: refs };
  }

  function candidates(dictionary, context, code) {
    if (!context || !choices[context.kind]) return [];
    const entries = dictionary && dictionary.langs && dictionary.langs.sql || {};
    const prefix = String(context.prefix || '').toLowerCase();
    const queryScope = scope(code);
    const items = choices[context.kind].map(key => ({ key, code: key.toUpperCase() }));
    if (context.kind === 'sql-table-source') {
      items.unshift(...queryScope.ctes.map(name => ({ key: name.toLowerCase(), code: name, cte: true })));
    }
    if (['sql-select-list','sql-condition','sql-join-condition','sql-group-order'].includes(context.kind)) {
      items.push(...queryScope.sources.map(ref => ({
        key: ref.qualifier.toLowerCase() + '.',
        code: ref.qualifier + '.',
        qualifier: true,
        table: ref.table
      })));
    }
    const seen = new Set();
    return items.filter(item => {
      const hasExplanation = Boolean(entries[item.key]) || item.cte === true || item.qualifier === true;
      const key = item.code.toLowerCase();
      if (!hasExplanation || seen.has(key) || (prefix && !key.startsWith(prefix))) return false;
      seen.add(key);
      return true;
    }).map(item => {
      const key = item.key;
      const note = item.qualifier
        ? 'Источник «' + item.table + '» доступен в текущем запросе; после точки можно указать столбец.'
        : entries[key] || 'Объявленный CTE — именованный результат запроса.';
      const isFunction = ['count','sum','avg','min','max','coalesce','nullif','concat','lower','upper','length','substring','round'].includes(key);
      return {
        code: item.code,
        lang: 'sql',
        label: item.qualifier ? 'источник' : isFunction ? 'функция' : 'SQL',
        note,
        expected: context.expected,
        contexts: [context.kind],
        languages: ['sql'],
        children: []
      };
    });
  }

  const api = { candidates, ctes, scope };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SQLCandidates = api;
})(typeof window !== 'undefined' ? window : globalThis);
