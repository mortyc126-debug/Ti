(function (root) {
  'use strict';

  const aliases = new Set(['in', 'exists', 'values', 'select', 'from', 'where', 'case', 'when', 'as']);
  function resolve(snapshot) {
    if (!snapshot || String(snapshot.language || snapshot.lang || '').toLowerCase() !== 'sql') return null;
    if (snapshot.selectedText) return null;

    const code = String(snapshot.code || '');
    const cursor = snapshot.cursor || { line: 0, ch: 0 };
    const lines = code.split(/\r\n|\n|\r/);
    const line = Math.max(0, Math.min(lines.length - 1, cursor.line || 0));
    const ch = Math.max(0, Math.min(String(lines[line] || '').length, cursor.ch || 0));
    const separators = code.match(/\r\n|\n|\r/g) || [];
    const offset = lines.slice(0, line).reduce((sum, part, index) =>
      sum + part.length + (separators[index] || '').length, 0) + ch;
    const before = code.slice(0, offset);

    let depth = 0, quote = '', quoteAt = -1, lineComment = false, blockComment = false;
    const stack = [], tokens = [], statementBreaks = [];
    for (let i = 0; i < before.length; i++) {
      const c = before[i], next = before[i + 1];
      if (lineComment) {
        if (c === '\n' || c === '\r') lineComment = false;
        else continue;
      }
      if (blockComment) {
        if (c === '*' && next === '/') { blockComment = false; i++; }
        continue;
      }
      if (quote) {
        if (c === '\\') { i++; continue; }
        if (c === quote && before[i + 1] === quote) { i++; continue; }
        if (c === quote) quote = '';
        continue;
      }
      if (c === '-' && next === '-') { lineComment = true; continue; }
      if (c === '/' && next === '*') { blockComment = true; i++; continue; }
      if (c === "'" || c === '"' || c === '\`') { quote = c; quoteAt = i; continue; }
      if (c === '(') {
        const preceding = before.slice(0, i).match(/([\p{L}_][\p{L}\p{N}_$]*)\s*$/u);
        stack.push({ depth, word: preceding ? preceding[1].toLowerCase() : '' });
        depth++;
        continue;
      }
      if (c === ')') { depth = Math.max(0, depth - 1); stack.pop(); continue; }
      if (c === ';') { statementBreaks.push({ depth, offset: i }); continue; }
      if (/[\p{L}_]/u.test(c)) {
        const start = i;
        while (i + 1 < before.length && /[\p{L}\p{N}_$]/u.test(before[i + 1])) i++;
        tokens.push({ word: before.slice(start, i + 1).toLowerCase(), depth, start, end: i + 1 });
      }
    }

    if (blockComment || lineComment) {
      return { kind: 'sql-comment', expected: 'none', prefix: '', suppressAutocomplete: true, sourceRange: { from: offset, to: offset } };
    }
    if (quote) {
      return { kind: 'sql-string', expected: 'none', prefix: '', suppressAutocomplete: true, inString: true,
        sourceRange: { from: quoteAt + 1, to: offset } };
    }

    const open = stack[stack.length - 1];
    if (open && open.word && !aliases.has(open.word)) return null;

    const prefixMatch = before.match(/[\p{L}\p{N}_$.]*$/u);
    const prefix = prefixMatch ? prefixMatch[0] : '';
    const tokenStart = offset - prefix.length;
    const currentDepth = depth;
    const lastBreak = statementBreaks.filter(item => item.depth <= currentDepth).at(-1)?.offset ?? -1;
    const relevant = tokens.filter(token => token.depth <= currentDepth && token.start > lastBreak);
    let clause = 'statement';
    for (let i = 0; i < relevant.length; i++) {
      const word = relevant[i].word;
      const next = relevant[i + 1] && relevant[i + 1].depth === relevant[i].depth
        ? relevant[i + 1].word : '';
      if (word === 'select') clause = 'select-list';
      else if (word === 'from' || word === 'join' || word === 'update' || word === 'into') clause = 'table-source';
      else if (word === 'where' || word === 'having') clause = 'condition';
      else if (word === 'on') clause = 'join-condition';
      else if (word === 'group' && next === 'by') clause = 'group-order';
      else if (word === 'order' && next === 'by') clause = 'group-order';
      else if (word === 'set') clause = 'assignment';
      else if (word === 'values') clause = 'values';
      else if (word === 'limit' || word === 'offset') clause = 'limit';
    }

    const kind = ({
      statement: 'sql-statement',
      'select-list': 'sql-select-list',
      'table-source': 'sql-table-source',
      condition: 'sql-condition',
      'join-condition': 'sql-join-condition',
      'group-order': 'sql-group-order',
      assignment: 'sql-assignment',
      values: 'sql-values',
      limit: 'sql-limit'
    })[clause] || 'sql-statement';

    return {
      kind,
      expected: clause === 'table-source' ? 'table-or-cte' :
        clause === 'condition' || clause === 'join-condition' ? 'sql-condition' :
        clause === 'group-order' ? 'column-or-expression' :
        clause === 'select-list' ? 'column-or-expression' :
        clause === 'assignment' ? 'column-assignment' :
        clause === 'values' ? 'sql-value' :
        clause === 'limit' ? 'integer-expression' : 'sql-keyword',
      language: 'sql',
      prefix,
      clause,
      symbol: null,
      argumentIndex: null,
      inString: false,
      sourceRange: { from: tokenStart, to: offset },
      constraints: { depth: currentDepth, clause },
      explanation: ''
    };
  }

  const api = { resolve };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SQLContext = api;
})(typeof window !== 'undefined' ? window : globalThis);
