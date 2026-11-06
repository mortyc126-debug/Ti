import { randomUUID } from 'node:crypto';
import { promises as defaultFs } from 'node:fs';
import path from 'node:path';

const isMissing = error => error?.code === 'ENOENT';

async function removeIfPresent(fs, target){
  try { await fs.unlink(target); }
  catch(error){ if(!isMissing(error)) throw error; }
}

function safeRelative(value){
  if(typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\')) return false;
  if(path.posix.isAbsolute(value) || /^[a-z]:/i.test(value)) return false;
  const parts = value.split('/');
  return parts.every(part => part && part !== '.' && part !== '..');
}

function allowedTarget(rootName, relative){
  if(rootName === 'library') return true;
  if(rootName !== 'app') return false;
  const value = relative.toLowerCase();
  if(['tasks/', 'recipes/', 'flows/', 'data/', 'workspace/', 'templates/'].some(prefix => value.startsWith(prefix))) {
    if(value === 'data/restore-backups' || value.startsWith('data/restore-backups/') || value === 'data/description-jobs.json') return false;
    return true;
  }
  return value.startsWith('public/dict/') || value === 'public/keyword-dict.json';
}

async function assertSafeTarget(fs, root, target){
  const rootStat = await fs.lstat(root).catch(error => isMissing(error) ? null : Promise.reject(error));
  if(rootStat?.isSymbolicLink() || (rootStat && !rootStat.isDirectory())) throw new Error('Корень восстановления небезопасен: ' + root);
  const relative = path.relative(root, target);
  if(!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Путь восстановления выходит за корень');
  let current = root;
  const parts = relative.split(path.sep);
  for(const part of parts.slice(0, -1)){
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch(error => isMissing(error) ? null : Promise.reject(error));
    if(stat?.isSymbolicLink() || (stat && !stat.isDirectory())) throw new Error('Небезопасная папка восстановления: ' + current);
  }
  const targetStat = await fs.lstat(target).catch(error => isMissing(error) ? null : Promise.reject(error));
  if(targetStat?.isSymbolicLink() || (targetStat && !targetStat.isFile())) throw new Error('Небезопасный файл восстановления: ' + target);
  return targetStat;
}

async function hasSafeMarker(fs, dir, name){
  const marker = path.join(dir, name);
  const stat = await fs.lstat(marker).catch(error => isMissing(error) ? null : Promise.reject(error));
  if(!stat) return false;
  if(stat.isSymbolicLink() || !stat.isFile()) throw new Error('Небезопасный маркер транзакции: ' + marker);
  return true;
}

async function writeAtomicNewFile(fs, target, content){
  const temp = path.join(path.dirname(target), '.restore-journal-' + randomUUID() + '.tmp');
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(temp, content, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temp, target);
  } finally {
    await removeIfPresent(fs, temp);
  }
}

// Копируем резервную копию во временный файл рядом с целью и только затем
// заменяем целевой файл rename. При ошибке копирования исходный файл не тронут.
export async function copyFileAtomic(source, target, fs = defaultFs){
  const dir = path.dirname(target);
  const temp = path.join(dir, `.restore-${path.basename(target)}-${randomUUID()}.tmp`);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.copyFile(source, temp);
    await fs.rename(temp, target);
  } finally {
    await removeIfPresent(fs, temp);
  }
}

// Откатываем журнал в обратном порядке. Ошибки каждого шага сохраняются,
// чтобы вызывающий маршрут мог сообщить о неполном восстановлении.
export async function rollbackRestore({ fs = defaultFs, written = [], deleted = [], backups = new Map() } = {}){
  const errors = [];
  const writtenSet = new Set(written);
  for(const op of [...written, ...deleted].reverse()){
    try {
      const backupPath = backups.get(op.abs);
      if(backupPath) await copyFileAtomic(backupPath, op.abs, fs);
      else if(writtenSet.has(op)) await removeIfPresent(fs, op.abs);
    } catch(error){
      errors.push(String(error?.message || error));
    }
  }
  return errors;
}

// Журнал содержит и перезаписи, и удаляемые файлы, и новые файлы без старой копии.
// Он атомарно публикуется целиком ДО первой модификации пользовательских данных.
export async function prepareRestoreTransaction({ fs = defaultFs, backupRoot, root, rootName, writes = [], deletions = [], backups = new Map() } = {}){
  if(!backupRoot || !root || !['library', 'app'].includes(rootName)) throw new Error('Некорректные параметры журнала восстановления');
  await fs.mkdir(backupRoot, { recursive: true });
  const operations = [];
  for(const [action, items] of [['write', writes], ['delete', deletions]]){
    for(const op of items){
      const target = path.relative(root, op.abs).split(path.sep).join('/');
      if(!safeRelative(target) || !allowedTarget(rootName, target)) throw new Error('Недопустимый путь в журнале восстановления: ' + target);
      const backupPath = backups.get(op.abs) || null;
      const backup = backupPath ? path.relative(backupRoot, backupPath).split(path.sep).join('/') : null;
      if(backup && !safeRelative(backup)) throw new Error('Недопустимый путь резервной копии: ' + backup);
      if(backup && !await fs.lstat(backupPath).then(stat => stat.isFile() && !stat.isSymbolicLink()).catch(() => false)) {
        throw new Error('Резервная копия не найдена или небезопасна: ' + backup);
      }
      operations.push({ action, target, existed: Boolean(backup), backup });
    }
  }
  const manifest = {
    format: 'code-lab-restore-transaction',
    version: 2,
    root: rootName,
    createdAt: new Date().toISOString(),
    files: [...backups.entries()].map(([target, backup]) => ({
      target: path.relative(root, target).split(path.sep).join('/'),
      backup: path.relative(backupRoot, backup).split(path.sep).join('/')
    })),
    operations
  };
  await writeAtomicNewFile(fs, path.join(backupRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + String.fromCharCode(10));
  return manifest;
}

export async function markRestoreTransaction({ fs = defaultFs, backupRoot, state } = {}){
  if(!['COMMITTED', 'ROLLED_BACK'].includes(state)) throw new Error('Неизвестное состояние транзакции восстановления');
  const marker = path.join(backupRoot, state);
  await writeAtomicNewFile(fs, marker, new Date().toISOString() + String.fromCharCode(10));
}

// Восстановление выполняется до загрузки хранилищ и запуска HTTP-сервера.
// Если процесс снова упадёт во время отката, следующий запуск безопасно повторит его.
export async function recoverRestoreTransactions({ fs = defaultFs, backupDir, roots } = {}){
  const dirStat = await fs.lstat(backupDir).catch(error => isMissing(error) ? null : Promise.reject(error));
  if(!dirStat) return [];
  if(dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error('Каталог журналов восстановления небезопасен');
  const recovered = [];
  for(const entry of await fs.readdir(backupDir, { withFileTypes: true })){
    if(entry.isSymbolicLink()) throw new Error('Символическая ссылка в каталоге журналов восстановления: ' + entry.name);
    if(!entry.isDirectory()) continue;
    const transactionDir = path.join(backupDir, entry.name);
    const manifestPath = path.join(transactionDir, 'manifest.json');
    const manifestStat = await fs.lstat(manifestPath).catch(error => isMissing(error) ? null : Promise.reject(error));
    if(!manifestStat) continue; // процесс мог упасть во время подготовки копий, до начала изменений
    if(manifestStat.isSymbolicLink() || !manifestStat.isFile()) throw new Error('Небезопасный манифест восстановления: ' + entry.name);
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    if(manifest?.format == null && manifest?.version == null) continue; // старые пользовательские backup-манифесты
    if(manifest?.format !== 'code-lab-restore-transaction' || manifest.version !== 2) throw new Error('Неподдерживаемый формат журнала восстановления: ' + entry.name);
    if(await hasSafeMarker(fs, transactionDir, 'COMMITTED')) continue;
    if(await hasSafeMarker(fs, transactionDir, 'ROLLED_BACK')) continue;
    const root = roots?.[manifest.root];
    if(!root || !Array.isArray(manifest.operations)) throw new Error('Журнал восстановления содержит неизвестный корень или список операций: ' + entry.name);
    const operations = manifest.operations;
    for(const op of [...operations].reverse()){
      if(!op || !['write', 'delete'].includes(op.action) || !safeRelative(op.target) || !allowedTarget(manifest.root, op.target) || typeof op.existed !== 'boolean') {
        throw new Error('Повреждённая операция в журнале восстановления: ' + entry.name);
      }
      const target = path.resolve(root, ...op.target.split('/'));
      const rel = path.relative(root, target);
      if(!rel || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('Путь восстановления выходит за разрешённый корень');
      await assertSafeTarget(fs, root, target);
      if(op.existed){
        if(!safeRelative(op.backup)) throw new Error('В журнале отсутствует путь резервной копии: ' + op.target);
        const backup = path.resolve(transactionDir, ...op.backup.split('/'));
        const backupRel = path.relative(transactionDir, backup);
        if(!backupRel || backupRel.startsWith('..' + path.sep) || path.isAbsolute(backupRel)) throw new Error('Путь резервной копии выходит за каталог транзакции');
        await assertSafeTarget(fs, transactionDir, backup);
        const backupStat = await fs.lstat(backup);
        if(!backupStat?.isFile()) throw new Error('Резервная копия отсутствует: ' + op.backup);
        await copyFileAtomic(backup, target, fs);
      } else {
        await removeIfPresent(fs, target);
      }
    }
    await markRestoreTransaction({ fs, backupRoot: transactionDir, state: 'ROLLED_BACK' });
    recovered.push(entry.name);
  }
  return recovered;
}
