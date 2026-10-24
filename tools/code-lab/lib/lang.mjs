// Язык ↔ расширение файла. Общий для миграции и файлового хранилища.

const EXT = {
  js: 'js', javascript: 'js', mjs: 'mjs', ts: 'ts', typescript: 'ts', jsx: 'jsx', tsx: 'tsx',
  css: 'css', html: 'html', svg: 'svg', json: 'json', sql: 'sql',
  python: 'py', py: 'py', ruby: 'rb', php: 'php', go: 'go', lua: 'lua',
  bash: 'sh', sh: 'sh', shell: 'sh', powershell: 'ps1', ps1: 'ps1', r: 'R', perl: 'pl'
};

// расширение → язык (как он назван в шаблонах)
const LANG = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'ts', tsx: 'ts',
  css: 'css', html: 'html', htm: 'html', svg: 'svg', json: 'json', sql: 'sql',
  py: 'python', rb: 'ruby', php: 'php', go: 'go', lua: 'lua',
  sh: 'bash', bash: 'bash', ps1: 'powershell', r: 'r', pl: 'perl', txt: 'txt'
};

export const extFor = lang => EXT[String(lang || '').toLowerCase()] || 'txt';
export const langForExt = ext => LANG[String(ext || '').replace(/^\./, '').toLowerCase()] || null;
// расширения, которые считаем кодом при просмотре папки библиотеки
export const CODE_EXTS = new Set(Object.keys(LANG));
export const safeName = s => String(s).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 120) || 'без-названия';
