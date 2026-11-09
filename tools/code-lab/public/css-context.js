(function (root) {
  'use strict';

  function offsetAt(code, cursor) {
    if (!cursor || !Number.isInteger(cursor.line) || !Number.isInteger(cursor.ch)) return String(code || '').length;
    const lines = String(code || '').split(/\r?\n/);
    let offset = 0;
    for (let i = 0; i < Math.min(cursor.line, lines.length); i++) offset += lines[i].length + 1;
    return Math.min(String(code || '').length, offset + Math.max(0, cursor.ch));
  }

  function functionBefore(code, openIndex) {
    const before = code.slice(0, openIndex);
    const match = before.match(/([a-z_-][\w-]*)\s*$/i);
    return match ? match[1].toLowerCase() : null;
  }

  function resolve(codeOrSnapshot, cursorOffset) {
    const snapshot = typeof codeOrSnapshot === 'object' && codeOrSnapshot !== null ? codeOrSnapshot : null;
    const code = String(snapshot ? snapshot.code || '' : codeOrSnapshot || '');
    const end = Math.max(0, Math.min(code.length,
      Number.isInteger(cursorOffset) ? cursorOffset : offsetAt(code, snapshot && snapshot.cursor)));
    let braceDepth = 0, segmentStart = 0, colonAt = -1;
    let quote = '', quoteStart = -1, comment = false, escaped = false;
    const parens = [];

    for (let i = 0; i < end; i++) {
      const ch = code[i], next = code[i + 1];
      if (comment) {
        if (ch === '*' && next === '/') { comment = false; i++; }
        continue;
      }
      if (quote) {
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === quote) { quote = ''; quoteStart = -1; }
        continue;
      }
      if (ch === '/' && next === '*') { comment = true; i++; continue; }
      if (ch === '"' || ch === "'") { quote = ch; quoteStart = i; continue; }
      if (ch === '(') {
        parens.push({ name: functionBefore(code.slice(0, end), i), index: 0, open: i });
        continue;
      }
      if (ch === ')') { if (parens.length) parens.pop(); continue; }
      if (ch === ',' && parens.length) { parens[parens.length - 1].index++; continue; }
      if (parens.length) continue;

      if (ch === '{') { braceDepth++; segmentStart = i + 1; colonAt = -1; continue; }
      if (ch === '}') { braceDepth = Math.max(0, braceDepth - 1); segmentStart = i + 1; colonAt = -1; continue; }
      if (ch === ';') { segmentStart = i + 1; colonAt = -1; continue; }
      if (ch === ':' && braceDepth > 0 && colonAt < 0) colonAt = i;
    }

    const currentLine = code.slice(Math.max(code.lastIndexOf('\n', end - 1) + 1, 0), end);
    const prefixOf = value => (String(value || '').match(/[-_a-zA-Z0-9]*$/) || [''])[0];
    const selectorPrefixOf = value => {
      const match = String(value || '').match(/(?:^|[\s>+~,(])((?:::?|[.#@])?[-_a-zA-Z0-9]*)$/);
      return match ? match[1] : prefixOf(value);
    };

    if (comment) {
      return { kind: 'css-comment', expected: 'none', suppressAutocomplete: true, prefix: '' };
    }
    if (quote) {
      return {
        kind: 'css-string',
        expected: 'string-content',
        suppressAutocomplete: true,
        inString: true,
        prefix: code.slice(quoteStart + 1, end),
        sourceRange: { from: quoteStart + 1, to: end }
      };
    }

    if (parens.length) {
      const active = parens[parens.length - 1];
      const argumentText = code.slice(active.open + 1, end);
      const selectorFunctions = new Set(['is', 'where', 'not', 'has', 'host', 'host-context', 'slotted']);
      if (selectorFunctions.has(active.name)) {
        return {
          kind: 'css-selector-argument',
          expected: 'selector',
          functionName: active.name,
          symbol: ':' + active.name,
          argumentIndex: active.index,
          prefix: selectorPrefixOf(argumentText),
          sourceRange: { from: active.open + 1, to: end },
          constraints: { selectorFunction: active.name, selectorList: true }
        };
      }
      return {
        kind: 'css-function-argument',
        expected: 'function-argument',
        functionName: active.name,
        symbol: active.name,
        argumentIndex: active.index,
        prefix: prefixOf(argumentText),
        sourceRange: { from: active.open + 1, to: end }
      };
    }

    const segment = code.slice(segmentStart, end);
    if (braceDepth > 0 && colonAt >= segmentStart) {
      const property = code.slice(segmentStart, colonAt).trim().toLowerCase();
      const valueText = code.slice(colonAt + 1, end);
      return {
        kind: 'css-value',
        expected: 'property-value',
        property,
        symbol: property,
        prefix: prefixOf(valueText),
        sourceRange: { from: colonAt + 1, to: end },
        constraints: { property, declarationBlock: true }
      };
    }

    if (braceDepth > 0) {
      return {
        kind: 'css-property',
        expected: 'property-name',
        prefix: prefixOf(segment),
        sourceRange: { from: segmentStart, to: end },
        constraints: { declarationBlock: true }
      };
    }

    return {
      kind: 'css-selector',
      expected: 'selector',
      prefix: selectorPrefixOf(currentLine),
      sourceRange: { from: end - currentLine.length, to: end },
      constraints: { declarationBlock: false }
    };
  }

  const api = { resolve, offsetAt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CSSContext = api;
})(typeof window !== 'undefined' ? window : globalThis);
