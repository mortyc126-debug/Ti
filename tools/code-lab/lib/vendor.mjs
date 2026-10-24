// Управляемая установка CodeMirror 5 для браузерной части «Лаборатории кода».
//
// Принципы:
//  • в интернет сервер ходит ТОЛЬКО по кнопкам «Проверить обновления» и «Скачать» (никаких фоновых опросов и автообновлений);
//  • скачанная версия не включается сама: она лежит в папке своей версии, её проверяют на вашей библиотеке и включают кнопкой;
//  • версии не перезаписываются: code-lab/vendor/codemirror/<версия>/ — откат это просто переключение «активной» версии;
//  • только ветка 5.x и только точные версии (никакого «latest»), только с registry.npmjs.org по https;
//  • архив проверяется по контрольной сумме из реестра, из него берутся только нужные папки, пути проверяются;
//  • для каждого файла версии записан sha256: перед включением файлы сверяются (порча диска, посторонние правки);
//  • слишком свежая версия (меньше 14 дней) ставится только с явным подтверждением;
//  • если редактор не установлен или не включён, страницы работают как раньше (запасной вариант в cm-bridge.js).
//
// Только stdlib Node (Node 18+: fetch, fs.promises).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

export const PACKAGE = 'codemirror';
const REGISTRY = 'https://registry.npmjs.org';
const REGISTRY_HOST = 'registry.npmjs.org';
const VERSION_RE = /^5\.\d{1,3}\.\d{1,3}$/;
export const YOUNG_DAYS = 14;
const MAX_TARBALL = 20 * 1024 * 1024;
const MAX_UNPACKED = 60 * 1024 * 1024;
const ALLOWED_DIRS = ['lib/', 'mode/', 'addon/', 'theme/', 'keymap/'];
const ALLOWED_FILES = new Set(['LICENSE', 'package.json']);
const SERVE_EXT = new Set(['.js', '.css']);
const HISTORY_MAX = 5;

// язык (как он назван в библиотеке, см. lib/lang.mjs) → режим CodeMirror и файлы режимов по порядку загрузки.
// Все режимы входят в пакет, докачивать их отдельно не нужно: кнопка «Проверить» показывает, чего не хватает.
export const MODE_MAP = {
  js:         { mode: 'text/javascript',          files: ['javascript'] },
  ts:         { mode: 'text/typescript',          files: ['javascript'] },
  json:       { mode: 'application/json',         files: ['javascript'] },
  css:        { mode: 'text/css',                 files: ['css'] },
  html:       { mode: 'text/html',                files: ['xml', 'javascript', 'css', 'htmlmixed'] },
  svg:        { mode: 'application/xml',          files: ['xml'] },
  sql:        { mode: 'text/x-sql',               files: ['sql'] },
  python:     { mode: 'python',                   files: ['python'] },
  bash:       { mode: 'shell',                    files: ['shell'] },
  powershell: { mode: 'powershell',               files: ['powershell'] },
  go:         { mode: 'text/x-go',                files: ['go'] },
  ruby:       { mode: 'text/x-ruby',              files: ['ruby'] },
  php:        { mode: 'application/x-httpd-php',  files: ['xml', 'javascript', 'css', 'htmlmixed', 'clike', 'php'] },
  lua:        { mode: 'text/x-lua',               files: ['lua'] },
  r:          { mode: 'text/x-rsrc',              files: ['r'] },
  perl:       { mode: 'perl',                     files: ['perl'] },
};

export class VendorError extends Error {
  constructor(message, code) { super(message); this.name = 'VendorError'; this.code = code || 'ERR'; }
}

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const cmpVer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
const modeFile = n => `mode/${n}/${n}.js`;

// ---------- минимальный разбор tar (без зависимостей) ----------
const cstr = (buf, off, len) => { let e = off; const end = off + len; while (e < end && buf[e] !== 0) e++; return buf.toString('utf8', off, e); };
function paxPath(data) {
  const s = data.toString('utf8');
  let i = 0;
  while (i < s.length) {
    const sp = s.indexOf(' ', i); if (sp < 0) break;
    const n = parseInt(s.slice(i, sp), 10); if (!n) break;
    const rec = s.slice(sp + 1, i + n - 1);
    if (rec.startsWith('path=')) return rec.slice(5);
    i += n;
  }
  return null;
}
export function* untar(buf) {
  let off = 0, nextName = null;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every(b => b === 0)) break;
    let name = cstr(h, 0, 100);
    if (cstr(h, 257, 5) === 'ustar') { const prefix = cstr(h, 345, 155); if (prefix) name = prefix + '/' + name; }
    const size = parseInt(cstr(h, 124, 12).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) throw new VendorError('Повреждённый архив (размер записи)', 'BAD_TAR');
    const type = h[156] ? String.fromCharCode(h[156]) : '0';
    const start = off + 512;
    if (start + size > buf.length) throw new VendorError('Архив обрезан', 'BAD_TAR');
    const data = buf.subarray(start, start + size);
    off = start + Math.ceil(size / 512) * 512;
    if (type === 'x') { nextName = paxPath(data) || nextName; continue; }
    if (type === 'g') continue;
    if (type === 'L') { nextName = cstr(data, 0, data.length); continue; }
    if (nextName) { name = nextName; nextName = null; }
    yield { name, type, data };
  }
}

// безопасный относительный путь внутри пакета или null, если запись нужно пропустить; кидает ошибку на явно опасные пути
function packagePath(name) {
  if (name.includes('\0') || name.includes('\\') || /^[a-zA-Z]:/.test(name) || name.startsWith('/')) throw new VendorError('В архиве опасный путь: ' + name, 'UNSAFE_PATH');
  const parts = name.split('/').filter(p => p !== '' && p !== '.');
  if (parts.includes('..')) throw new VendorError('В архиве опасный путь: ' + name, 'UNSAFE_PATH');
  if (parts.length < 2) return null;            // у npm все файлы лежат в package/…
  return parts.slice(1).join('/');
}
const allowedRel = rel => ALLOWED_FILES.has(rel) || ALLOWED_DIRS.some(d => rel.startsWith(d));

export function createVendor({ root, fetchImpl = fetch, now = () => Date.now() }) {
  const base = path.join(root, PACKAGE);
  const manifestPath = path.join(base, 'manifest.json');
  const vdir = v => path.join(base, v);
  let m = fresh();
  let chain = Promise.resolve();
  let busy = null;

  function fresh() { return { schema: 1, active: null, previous: [], installed: {}, lastCheck: null, lastGood: null }; }
  const iso = () => new Date(now()).toISOString();
  const ageDays = published => (published ? Math.floor((now() - Date.parse(published)) / 86400000) : null);

  function withLock(name, fn) {
    const run = chain.then(async () => { busy = name; try { return await fn(); } finally { busy = null; } });
    chain = run.catch(() => {});
    return run;
  }

  async function save() {
    await fs.mkdir(base, { recursive: true });
    const tmp = manifestPath + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(m, null, 2) + '\n');
    await fs.rename(tmp, manifestPath);
  }

  async function exists(p) { try { await fs.access(p); return true; } catch (_) { return false; } }

  async function init() {
    await fs.mkdir(base, { recursive: true });
    try { m = Object.assign(fresh(), JSON.parse(await fs.readFile(manifestPath, 'utf8'))); } catch (_) { m = fresh(); }
    if (!m.installed || typeof m.installed !== 'object') m.installed = {};
    if (!Array.isArray(m.previous)) m.previous = [];
    let changed = false;
    for (const name of await fs.readdir(base).catch(() => [])) {
      if (name.startsWith('.staging-')) await fs.rm(path.join(base, name), { recursive: true, force: true }).catch(() => {});
    }
    for (const v of Object.keys(m.installed)) {
      if (!VERSION_RE.test(v) || !(await exists(vdir(v)))) { delete m.installed[v]; changed = true; }
    }
    m.previous = m.previous.filter(v => m.installed[v]);
    if (m.active && !m.installed[m.active]) { m.active = null; changed = true; }
    if (changed) await save();
  }

  // ---------- сеть ----------
  async function httpGet(url, { timeout = 15000, max = 5e6, accept = 'application/json' } = {}) {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.hostname !== REGISTRY_HOST) throw new VendorError('Недопустимый адрес загрузки: ' + u.host, 'BAD_URL');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
      const r = await fetchImpl(url, { signal: ac.signal, redirect: 'error', headers: { Accept: accept, 'User-Agent': 'code-lab-vendor/1' } });
      if (!r.ok) throw new VendorError('Реестр ответил HTTP ' + r.status, 'HTTP');
      const len = Number(r.headers.get('content-length'));
      if (len > max) throw new VendorError('Ответ реестра слишком большой', 'TOO_BIG');
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > max) throw new VendorError('Ответ реестра слишком большой', 'TOO_BIG');
      return buf;
    } catch (e) {
      if (e instanceof VendorError) throw e;
      if (e && e.name === 'AbortError') throw new VendorError('Реестр не ответил вовремя (нет связи или медленный интернет)', 'TIMEOUT');
      throw new VendorError('Нет связи с реестром npm: ' + ((e && e.cause && e.cause.code) || (e && e.message) || e), 'NETWORK');
    } finally { clearTimeout(timer); }
  }
  const getJson = async (url, opts) => { try { return JSON.parse((await httpGet(url, opts)).toString('utf8')); } catch (e) { if (e instanceof VendorError) throw e; throw new VendorError('Реестр вернул неразборчивый ответ', 'BAD_JSON'); } };

  function candidateInfo(version, meta, published) {
    const age = ageDays(published);
    return {
      version, published: published || null, ageDays: age, young: age != null && age < YOUNG_DAYS,
      fileCount: meta && meta.dist && meta.dist.fileCount || null, unpackedSize: meta && meta.dist && meta.dist.unpackedSize || null,
    };
  }

  // ---------- проверка обновлений ----------
  function check() {
    return withLock('check', async () => {
      const at = iso();
      try {
        const abbr = await getJson(`${REGISTRY}/${PACKAGE}`, { accept: 'application/vnd.npm.install-v1+json', max: 8e6 });
        const all = Object.keys(abbr.versions || {}).filter(v => VERSION_RE.test(v)).sort(cmpVer);
        if (!all.length) throw new VendorError('В ответе реестра нет версий 5.x', 'EMPTY');
        const tag = abbr['dist-tags'] && abbr['dist-tags'].version5;
        const latest = tag && VERSION_RE.test(tag) ? tag : all[all.length - 1];
        const have = Object.keys(m.installed).sort(cmpVer);
        const newest = have.length ? have[have.length - 1] : null;
        const cand = all.filter(v => !m.installed[v] && (newest ? cmpVer(v, newest) > 0 : v === latest));
        let times = {};
        if (cand.length) {
          // даты публикации есть только в полном документе (он тяжёлый); без них возраст версии просто неизвестен
          try { times = (await getJson(`${REGISTRY}/${PACKAGE}`, { timeout: 30000, max: 25e6 })).time || {}; } catch (_) { times = {}; }
        }
        const candidates = cand.map(v => candidateInfo(v, abbr.versions[v], times[v]));
        m.lastGood = m.lastCheck = { at, ok: true, latest, candidates, newestInstalled: newest, datesKnown: Object.keys(times).length > 0 };
        await save();
        return m.lastGood;
      } catch (e) {
        m.lastCheck = { at, ok: false, error: e.message, code: e.code || 'ERR' };
        await save().catch(() => {});
        throw e;
      }
    });
  }

  // ---------- скачивание и распаковка ----------
  function verifyIntegrity(buf, dist) {
    const first = String(dist.integrity || '').split(' ')[0];
    const mm = /^(sha512|sha384|sha256)-(.+)$/.exec(first);
    if (mm) {
      if (crypto.createHash(mm[1]).update(buf).digest('base64') !== mm[2]) throw new VendorError('Контрольная сумма архива не совпала: файл отвергнут', 'INTEGRITY');
      return mm[1];
    }
    if (dist.shasum) {
      if (crypto.createHash('sha1').update(buf).digest('hex') !== String(dist.shasum).toLowerCase()) throw new VendorError('Контрольная сумма архива не совпала: файл отвергнут', 'INTEGRITY');
      return 'sha1';
    }
    throw new VendorError('В метаданных реестра нет контрольной суммы: установка отменена', 'NO_HASH');
  }

  async function unpack(tgz, stagingDir, version) {
    let raw;
    try { raw = zlib.gunzipSync(tgz, { maxOutputLength: MAX_UNPACKED }); }
    catch (e) { throw new VendorError('Архив не распаковался или слишком большой: ' + e.message, 'BAD_TAR'); }
    const files = {};
    let bytes = 0, skipped = 0;
    for (const ent of untar(raw)) {
      if (ent.type === '5') continue;                                   // папки создаются по файлам
      if (ent.type !== '0') { skipped++; continue; }                    // ссылки и прочее не берём никогда
      const rel = packagePath(ent.name);
      if (rel == null || !allowedRel(rel)) { skipped++; continue; }
      bytes += ent.data.length;
      if (bytes > MAX_UNPACKED) throw new VendorError('Распакованный архив слишком большой', 'TOO_BIG');
      const abs = path.join(stagingDir, ...rel.split('/'));
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, ent.data, { flag: 'wx' });
      files[rel] = sha256(ent.data);
    }
    let pkg;
    try { pkg = JSON.parse(await fs.readFile(path.join(stagingDir, 'package.json'), 'utf8')); } catch (_) { throw new VendorError('В архиве нет package.json', 'BAD_PACKAGE'); }
    if (pkg.name !== PACKAGE || pkg.version !== version) throw new VendorError(`В архиве не та версия: ${pkg.name}@${pkg.version}`, 'BAD_PACKAGE');
    for (const need of ['lib/codemirror.js', 'lib/codemirror.css', 'addon/runmode/runmode.js']) if (!files[need]) throw new VendorError('В архиве нет файла ' + need, 'BAD_PACKAGE');
    await fs.writeFile(path.join(stagingDir, 'files.json'), JSON.stringify(files, null, 1) + '\n');
    return { files, bytes, fileCount: Object.keys(files).length, skipped };
  }

  function install(version, { allowYoung = false } = {}) {
    return withLock('install', async () => {
      if (!VERSION_RE.test(String(version))) throw new VendorError('Допускаются только точные версии 5.x.y', 'BAD_VERSION');
      if (m.installed[version] || await exists(vdir(version))) throw new VendorError('Версия ' + version + ' уже установлена', 'EXISTS');
      const meta = await getJson(`${REGISTRY}/${PACKAGE}/${version}`, { max: 2e6 });
      if (meta.name !== PACKAGE || meta.version !== version || !meta.dist) throw new VendorError('Реестр вернул данные не про эту версию', 'BAD_META');
      const turl = new URL(String(meta.dist.tarball || ''));
      if (turl.protocol !== 'https:' || turl.hostname !== REGISTRY_HOST || !turl.pathname.startsWith('/' + PACKAGE + '/-/')) throw new VendorError('Адрес архива не с официального реестра: отвергнут', 'BAD_URL');

      let published = m.lastGood && (m.lastGood.candidates || []).find(c => c.version === version)?.published || null;
      if (!published) { try { published = (await getJson(`${REGISTRY}/${PACKAGE}`, { timeout: 30000, max: 25e6 })).time?.[version] || null; } catch (_) {} }
      const age = ageDays(published);
      if (age != null && age < YOUNG_DAYS && !allowYoung) throw new VendorError(`Версия опубликована ${age} дн. назад. Свежие версии лучше не ставить сразу: подтвердите, если уверены`, 'YOUNG');

      const tgz = await httpGet(meta.dist.tarball, { timeout: 120000, max: MAX_TARBALL, accept: 'application/octet-stream' });
      const algo = verifyIntegrity(tgz, meta.dist);

      const staging = path.join(base, '.staging-' + version + '-' + crypto.randomBytes(4).toString('hex'));
      try {
        await fs.mkdir(staging, { recursive: true });
        const info = await unpack(tgz, staging, version);
        await fs.rename(staging, vdir(version));
        m.installed[version] = { installedAt: iso(), published, integrity: algo, fileCount: info.fileCount, bytes: info.bytes, test: null };
        await save();
        return { version, ...m.installed[version] };
      } finally {
        await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
      }
    });
  }

  // ---------- целостность файлов версии ----------
  async function* walk(dir, prefix = '') {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? prefix + '/' + e.name : e.name;
      if (e.isDirectory()) yield* walk(path.join(dir, e.name), rel);
      else yield rel;
    }
  }
  async function verifyFiles(version) {
    if (!m.installed[version]) throw new VendorError('Версия не установлена', 'NOT_INSTALLED');
    const dir = vdir(version);
    let expected;
    try { expected = JSON.parse(await fs.readFile(path.join(dir, 'files.json'), 'utf8')); }
    catch (_) { return { ok: false, files: 0, problems: ['нет файла files.json'] }; }
    const problems = [];
    for (const [rel, h] of Object.entries(expected)) {
      try { if (sha256(await fs.readFile(path.join(dir, ...rel.split('/')))) !== h) problems.push('изменён: ' + rel); }
      catch (_) { problems.push('нет файла: ' + rel); }
    }
    for await (const rel of walk(dir)) if (rel !== 'files.json' && !(rel in expected)) problems.push('лишний файл: ' + rel);
    return { ok: problems.length === 0, files: Object.keys(expected).length, problems: problems.slice(0, 20) };
  }
  const verify = version => withLock('verify', () => verifyFiles(version));

  // ---------- включение, откат, удаление ----------
  function activateLocked(version, force) {
    return (async () => {
      if (!m.installed[version]) throw new VendorError('Версия не установлена', 'NOT_INSTALLED');
      const v = await verifyFiles(version);
      if (!v.ok) throw new VendorError('Файлы версии повреждены или изменены: ' + v.problems.slice(0, 3).join('; '), 'CORRUPT');
      if (!force && !(m.installed[version].test && m.installed[version].test.ok)) throw new VendorError('Сначала запустите проверку на вашей библиотеке: без успешной проверки версию включать нельзя', 'NOT_TESTED');
      const prev = m.active;
      m.active = version;
      m.previous = (prev && prev !== version ? [prev, ...m.previous] : m.previous).filter((x, i, a) => x !== version && a.indexOf(x) === i).slice(0, HISTORY_MAX);
      await save();
      return { active: m.active, previous: m.previous };
    })();
  }
  const activate = (version, { force = false } = {}) => withLock('activate', () => activateLocked(version, force));
  const rollback = () => withLock('rollback', async () => {
    const target = m.previous.find(v => m.installed[v]);
    if (!target) throw new VendorError('Нет предыдущей версии, на которую можно откатиться', 'NO_PREVIOUS');
    return activateLocked(target, true);
  });
  const deactivate = () => withLock('deactivate', async () => {
    if (m.active) { m.previous = [m.active, ...m.previous.filter(v => v !== m.active)].slice(0, HISTORY_MAX); m.active = null; await save(); }
    return { active: null, previous: m.previous };
  });
  const remove = version => withLock('remove', async () => {
    if (!m.installed[version]) throw new VendorError('Версия не установлена', 'NOT_INSTALLED');
    if (m.active === version) throw new VendorError('Активную версию удалить нельзя: сначала включите другую или выключите редактор', 'ACTIVE');
    delete m.installed[version];
    m.previous = m.previous.filter(v => v !== version);
    await save();
    await fs.rm(vdir(version), { recursive: true, force: true });
    return { removed: version };
  });

  // результат проверки на библиотеке (страница vendor-test.html присылает его сама)
  const recordTest = (version, r) => withLock('test', async () => {
    if (!m.installed[version]) throw new VendorError('Версия не установлена', 'NOT_INSTALLED');
    r = r && typeof r === 'object' ? r : {};
    const str = (x, n) => String(x == null ? '' : x).slice(0, n);
    m.installed[version].test = {
      ok: r.ok === true && r.cmVersion === version,
      at: iso(), cmVersion: str(r.cmVersion, 20),
      entries: Math.max(0, Number(r.entries) || 0), ms: Math.max(0, Math.round(Number(r.ms) || 0)),
      errors: (Array.isArray(r.errors) ? r.errors : []).slice(0, 20).map(e => ({ id: str(e && e.id, 80), msg: str(e && e.msg, 200) })),
      missingModes: (Array.isArray(r.missingModes) ? r.missingModes : []).slice(0, 30).map(x => str(x, 30)),
      warnings: (Array.isArray(r.warnings) ? r.warnings : []).slice(0, 20).map(x => str(x, 200)),
    };
    await save();
    return m.installed[version].test;
  });

  // ---------- выдача файлов браузеру ----------
  function resolveFile(version, rel) {
    if (!m.installed[version] || !VERSION_RE.test(String(version))) return null;
    const clean = String(rel || '').replace(/^\/+/, '');
    if (!clean || clean.includes('\0') || clean.includes('\\') || clean.split('/').includes('..')) return null;
    if (!ALLOWED_DIRS.some(d => clean.startsWith(d))) return null;
    if (!SERVE_EXT.has(path.extname(clean).toLowerCase())) return null;
    const dir = vdir(version);
    const abs = path.resolve(dir, ...clean.split('/'));
    if (!abs.startsWith(dir + path.sep)) return null;
    return abs;
  }

  async function modesMissing(version) {
    const out = [];
    for (const [lang, spec] of Object.entries(MODE_MAP)) {
      for (const f of spec.files) if (!(await exists(path.join(vdir(version), ...modeFile(f).split('/'))))) { out.push(lang); break; }
    }
    return out;
  }

  async function status() {
    const list = [];
    for (const v of Object.keys(m.installed).sort((a, b) => cmpVer(b, a))) {
      const i = m.installed[v];
      list.push({ version: v, ...i, ageDays: ageDays(i.published), isActive: m.active === v, modesMissing: await modesMissing(v) });
    }
    return { package: PACKAGE, line: '5.x', busy, active: m.active, previous: m.previous.filter(v => m.installed[v]), installed: list, lastCheck: m.lastCheck, lastGood: m.lastGood, youngDays: YOUNG_DAYS, modes: MODE_MAP };
  }

  return {
    init, status, check, install, activate, rollback, deactivate, remove, verify, recordTest, resolveFile,
    activeInfo: () => ({ version: m.active, modes: MODE_MAP }),
  };
}
