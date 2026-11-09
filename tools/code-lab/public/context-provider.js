(function (root) {
  'use strict';

  const aliases = {
    javascript: 'js', typescript: 'ts', py: 'python', htm: 'html',
    xml: 'html', jsx: 'js', tsx: 'ts', shell: 'bash', sh: 'bash'
  };
  const providers = new Map();

  function normalizeLanguage(value) {
    const lang = String(value || '').trim().toLowerCase();
    return aliases[lang] || lang;
  }

  function register(provider) {
    if (!provider || !provider.id || typeof provider.resolve !== 'function') {
      throw new TypeError('Контекстный провайдер должен иметь id и resolve()');
    }
    const entry = {
      id: provider.id,
      priority: Number.isFinite(provider.priority) ? provider.priority : 0,
      languages: provider.languages ? new Set(provider.languages.map(normalizeLanguage)) : null,
      contexts: provider.contexts ? new Set(provider.contexts.map(value => String(value))) : null,
      resolve: provider.resolve
    };
    providers.set(provider.id, entry);
    return function unregister() {
      if (providers.get(provider.id) === entry) providers.delete(provider.id);
    };
  }

  function createSnapshot(input) {
    const source = input || {};
    const language = normalizeLanguage(source.language || source.lang);
    const code = String(source.code == null ? '' : source.code);
    const lines = code.split(/\\r\\n|\\n|\\r/);
    const cursorLine = source.cursor && Number.isInteger(source.cursor.line)
      ? Math.min(lines.length - 1, Math.max(0, source.cursor.line))
      : null;
    const cursor = cursorLine !== null && Number.isInteger(source.cursor.ch)
      ? { line: cursorLine, ch: Math.max(0, Math.min(String(lines[cursorLine] || '').length, source.cursor.ch)) }
      : null;
    const currentLine = cursor ? String(lines[cursor.line] || '') : String(source.currentLine || '');
    const beforeCursor = cursor ? currentLine.slice(0, cursor.ch) : String(source.beforeCursor || '');
    const afterCursor = cursor ? currentLine.slice(cursor.ch) : String(source.afterCursor || '');
    return Object.assign({}, source, {
      language,
      code,
      cursor,
      currentLine,
      beforeCursor,
      afterCursor,
      selectedText: String(source.selectedText || ''),
      prefix: String(source.prefix == null ? (beforeCursor.match(/[\w$-]*$/) || [''])[0] : source.prefix)
    });
  }

  function normalizeContext(provider, raw, snapshot) {
    if (!raw) return null;
    const language = normalizeLanguage(raw.language || raw.lang || snapshot.language);
    const position = raw.position || {
      x: raw.x,
      y: raw.y
    };
    return Object.assign({}, raw, {
      provider,
      language,
      kind: raw.kind || raw.mode || 'token',
      syntaxPosition: raw.syntaxPosition || raw.kind || raw.mode || 'token',
      expected: raw.expected || raw.expectedKind || 'construct',
      prefix: String(raw.prefix == null ? raw.word || '' : raw.prefix),
      symbol: raw.symbol || raw.fn || raw.attr || raw.tag || null,
      argumentIndex: Number.isInteger(raw.argumentIndex) ? raw.argumentIndex : (Number.isInteger(raw.arg) ? raw.arg : null),
      inString: Boolean(raw.inString || raw.inQuote),
      position,
      replace: raw.replace || raw.put || null,
      legacy: raw.legacy || raw,
      constraints: raw.constraints || null,
      candidates: Array.isArray(raw.candidates) ? raw.candidates : [],
      relations: Array.isArray(raw.relations) ? raw.relations : [],
      explanation: String(raw.explanation || raw.note || ''),
      source: raw.source || provider,
      sourceRange: raw.sourceRange || null,
      confidence: Number.isFinite(raw.confidence) ? raw.confidence : 1,
      scope: raw.scope || null,
      container: raw.container || null,
      callable: raw.callable || raw.fn || null,
      property: raw.property || (language === 'css' ? raw.fn || null : null)
    });
  }

  function resolve(snapshot) {
    const input = createSnapshot(snapshot);
    const ordered = Array.from(providers.values())
      .filter(p => !p.languages || p.languages.has(input.language))
      .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));

    for (const provider of ordered) {
      let raw;
      try {
        raw = provider.resolve(input);
      } catch (error) {
        if (input.onProviderError) input.onProviderError(error, provider.id);
        continue;
      }
      const context = normalizeContext(provider.id, raw, input);
      if (context) return context;
    }
    return null;
  }

  function rankCandidates(candidates, context) {
    const ctx = context || {};
    const prefix = String(ctx.prefix || '').trim().toLowerCase();
    const expected = String(ctx.expected || '').toLowerCase();
    const kind = String(ctx.kind || '').toLowerCase();
    const seen = new Set();
    return (Array.isArray(candidates) ? candidates : []).map((item, index) => {
      const code = String(item && (item.code || item.insert || item.show || item.label) || '');
      const lower = code.toLowerCase();
      const itemExpected = item && (item.expected || item.expectedKind);
      const itemKinds = item && (item.contexts || item.kinds);
      const itemLangs = item && item.languages;
      const blocked = item && (item.disabled || item.applicable === false);
      const expectedMismatch = expected && itemExpected && String(itemExpected).toLowerCase() !== expected;
      const kindMismatch = kind && Array.isArray(itemKinds) && itemKinds.length &&
        !itemKinds.map(x => String(x).toLowerCase()).includes(kind);
      const languageMismatch = ctx.language && Array.isArray(itemLangs) && itemLangs.length &&
        !itemLangs.map(normalizeLanguage).includes(normalizeLanguage(ctx.language));
      const prefixScore = !prefix ? 0 : lower.startsWith(prefix) ? 1000 : lower.includes(prefix) ? 100 : -1;
      const contextScore = item && itemExpected && !expectedMismatch ? 80 : 0;
      const priority = Number.isFinite(item && item.priority) ? item.priority : 0;
      const key = [code, item && item.label || '', item && item.lang || ''].join('|').toLowerCase();
      return { item, index, key, score: prefixScore + contextScore + priority, prefixMismatch: prefixScore < 0,
        blocked: !!blocked || !!expectedMismatch || !!kindMismatch || !!languageMismatch };
    }).filter(row => {
      if (row.blocked || (prefix && row.prefixMismatch) || !row.item) return false;
      if (row.key === '||' || seen.has(row.key)) return false;
      seen.add(row.key);
      return true;
    }).sort((a, b) => b.score - a.score || a.index - b.index)
      .map(row => row.item);
  }

  function listProviders() {
    return Array.from(providers.values())
      .map(provider => ({
        id: provider.id,
        priority: provider.priority,
        languages: provider.languages ? Array.from(provider.languages) : null,
        contexts: provider.contexts ? Array.from(provider.contexts) : null
      }))
      .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  }

  const api = { normalizeLanguage, createSnapshot, register, resolve, rankCandidates, listProviders };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CodeLabContext = api;
})(typeof window !== 'undefined' ? window : globalThis);
