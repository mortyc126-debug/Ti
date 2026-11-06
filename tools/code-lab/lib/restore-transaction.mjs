import { randomUUID } from 'node:crypto';
import { promises as defaultFs } from 'node:fs';
import path from 'node:path';

const isMissing = error => error?.code === 'ENOENT';

async function removeIfPresent(fs, target){
  try { await fs.unlink(target); }
  catch(error){ if(!isMissing(error)) throw error; }
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
