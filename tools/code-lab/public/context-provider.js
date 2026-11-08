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
    providers.set(provider.id, {
      id: provider.id,
      priority: Number.isFinite(provider.priority) ? provider.priority : 0,
      languages: provider.languages ? new Set(provider.languages.map(normalizeLanguage)) : null,
      resolve: provider.resolve
    });
    return function unregister() { providers.delete(provider.id); };
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
      legacy: raw.legacy || raw
    });
  }

  function resolve(snapshot) {
    const input = Object.assign({}, snapshot || {});
    input.language = normalizeLanguage(input.language || input.lang);
    const ordered = Array.from(providers.values())
      .filter(p => !p.languages || p.languages.has(input.language))
      .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));

    for (const provider of ordered) {
      const raw = provider.resolve(input);
      const context = normalizeContext(provider.id, raw, input);
      if (context) return context;
    }
    return null;
  }

  function rankCandidates(candidates, context) {
    const prefix = String(context && context.prefix || '').toLowerCase();
    return (Array.isArray(candidates) ? candidates : []).map((item, index) => {
      const code = String(item && (item.code || item.show || item.label) || '');
      const note = String(item && (item.note || item.description) || '');
      const lower = code.toLowerCase();
      const score = !prefix ? 0 : lower.startsWith(prefix) ? 100 : lower.includes(prefix) ? 35 : 0;
      return { item, index, score: score + (item && item.priority || 0) };
    }).filter(row => !prefix || row.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map(row => row.item);
  }

  const api = { normalizeLanguage, register, resolve, rankCandidates };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CodeLabContext = api;
})(typeof window !== 'undefined' ? window : globalThis);
