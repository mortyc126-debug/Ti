// Миграция шаблонов-карточек (templates/*.json с токенами) в обычные файлы кода + .meta.json рядом.
// Исходные templates/*.json не изменяются. Повторный запуск пропускает уже созданные файлы.
// Используется и командой tools/migrate-templates.mjs, и сервером (автоматически при первом запуске).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { extFor, safeName } from './lang.mjs';
import { mapGroup, parseRules } from './sections.mjs';

// Токен без поля v — одиночный пробел (так выглядит sp в части шаблонов).
export const tokText = t => (t.v != null ? String(t.v) : (t.k === 'sp' ? ' ' : ''));
export const lineText = line => line.map(tokText).join('');
export const codeFromLines = lines => lines.map(lineText).join('\n');

// Пояснение совпало со словарём? (в любом его разделе)
export function buildDictLookup(dict){
  const sections = ['words', 'htmlTags', 'htmlAttrs', 'cssProps', 'cssVals'];
  const map = new Map();
  for(const s of sections) for(const [k, v] of Object.entries((dict && dict[s]) || {})){
    const key = k.toLowerCase();
    if(!map.has(key)) map.set(key, new Set());
    map.get(key).add(String(v));
  }
  return (word, note) => { const set = map.get(String(word).toLowerCase()); return !!(set && set.has(String(note))); };
}

// Пояснения слов вместе с позицией (строка, смещение): их можно снова привязать к слову после правки кода.
// source: 'dict' — совпало со словарём; 'custom' — написано отдельно (рукой или ИИ), его стоит беречь.
export function wordNotes(lines, inDict){
  const out = [];
  lines.forEach((line, li) => {
    let col = 0;
    for(const t of line){
      const text = tokText(t);
      if(t.e != null){
        out.push({ line: li, col, text, kind: t.k, note: String(t.e), source: inDict(text, t.e) ? 'dict' : 'custom' });
      }
      col += text.length;
    }
  });
  return out;
}

const exists = p => fs.access(p).then(() => true, () => false);
const normalizeCode = code => String(code || '').replace(/\r\n/g, '\n').trim();

async function indexExistingCode(out){
  const index = new Map();
  let dirs = [];
  try { dirs = await fs.readdir(out, { withFileTypes: true }); } catch(_) { return index; }
  for(const dirent of dirs){
    if(!dirent.isDirectory()) continue;
    const dir = path.join(out, dirent.name);
    let files = [];
    try { files = await fs.readdir(dir, { withFileTypes: true }); } catch(_) { continue; }
    for(const file of files){
      if(!file.isFile() || file.name.endsWith('.meta.json')) continue;
      const abs = path.join(dir, file.name);
      let body = '';
      try { body = await fs.readFile(abs, 'utf8'); } catch(_) { continue; }
      const key = dirent.name + '\\u0000' + normalizeCode(body);
      if(!index.has(key)) index.set(key, []);
      index.get(key).push(path.relative(out, abs).split(path.sep).join('/'));
    }
  }
  return index;
}

// src — папка templates, out — папка library
export async function migrateTemplates({ src, out, dictPath, dry = false, force = false, log = () => {} }){
  let names = [];
  try { names = (await fs.readdir(src)).filter(n => n.toLowerCase().endsWith('.json')).sort(); } catch(_){ names = []; }
  const dict = dictPath ? await fs.readFile(dictPath, 'utf8').then(JSON.parse).catch(() => null) : null;
  const inDict = buildDictLookup(dict);

  const report = { src, out, dry, total: names.length, created: 0, skippedExisting: 0, skippedDuplicate: 0, duplicateContent: [], errors: [], byLang: {}, notes: { dict: 0, custom: 0 }, emptyDesc: [], withComponent: 0, groupsRemapped: 0, groupMoves: {} };
  let groupRules = [];
  try { const sections = JSON.parse(await fs.readFile(path.join(out, '_sections.json'), 'utf8')); groupRules = parseRules(sections.rules || []).rules; } catch(_) {}
  const usedPaths = new Map(); // нижний регистр пути → id (коллизии на Windows/macOS)
  const existingCodes = await indexExistingCode(out);

  for(const name of names){
    let j;
    try { j = JSON.parse(await fs.readFile(path.join(src, name), 'utf8')); }
    catch(e){ report.errors.push({ file: name, error: 'не разобрался JSON: ' + e.message }); continue; }
    if(!Array.isArray(j.lines)){ report.errors.push({ file: name, error: 'нет поля lines' }); continue; }

    const id = String(j.id || path.basename(name, '.json'));
    const lang = String(j.lang || 'txt');
    const ext = extFor(lang);
    let base = safeName(id);
    let rel = path.join(safeName(lang), base + '.' + ext);
    if(usedPaths.has(rel.toLowerCase())){ base += '-' + Math.random().toString(36).slice(2, 6); rel = path.join(safeName(lang), base + '.' + ext); }
    usedPaths.set(rel.toLowerCase(), id);

    const codeFile = path.join(out, rel);
    const metaFile = codeFile + '.meta.json';
    if(!force && (await exists(codeFile) || await exists(metaFile))){ report.skippedExisting++; continue; }

    const code = codeFromLines(j.lines);
    const codeKey = safeName(lang) + '\\u0000' + normalizeCode(code);
    const duplicateFiles = existingCodes.get(codeKey) || [];
    if(!force && duplicateFiles.length){
      report.skippedDuplicate++;
      report.duplicateContent.push({ file:name, id, lang, existingFiles:duplicateFiles });
      continue;
    }
    const notes = wordNotes(j.lines, inDict);
    notes.forEach(n => { report.notes[n.source]++; });
    const hasDesc = !!(j.desc && String(j.desc).trim());
    const tags = Array.isArray(j.tags) ? [...new Set(j.tags.map(x => String(x).trim()).filter(Boolean))] : [];
    const aliases = Array.isArray(j.aliases) ? [...new Set(j.aliases.map(x => String(x).trim()).filter(Boolean))] : [];
    const originalGroup = j.group || '';
    const group = groupRules.length ? mapGroup(originalGroup, groupRules).to : originalGroup;
    if(group !== originalGroup){ report.groupsRemapped++; const move = originalGroup + ' => ' + group; report.groupMoves[move] = (report.groupMoves[move] || 0) + 1; }
    if(!hasDesc) report.emptyDesc.push(id);
    if(j.component) report.withComponent++;
    report.byLang[lang] = (report.byLang[lang] || 0) + 1;

    const meta = {
      schema: 1,
      id,
      file: base + '.' + ext,
      title: j.title || id,
      lang,
      group,
      desc: j.desc || '',
      output: j.output || '',
      tags,
      aliases,
      // кто автор каждого поля: manual — вы, imported — из архива/старых шаблонов, ai — модель.
      // Правило: manual никогда не перезаписывается ИИ.
      source: { title: 'imported', desc: hasDesc ? 'imported' : null, tags: tags.length ? 'imported' : null, aliases: aliases.length ? 'imported' : null },
      status: hasDesc ? 'described' : 'needs_description',
      wordNotes: notes,
      ...(j.component ? { component: j.component } : {}),
      legacy: {
        template: name,
        ...(j.descAt != null ? { descAt: j.descAt } : {}),
        ...(j.summary != null ? { summary: j.summary } : {})
      }
    };

    if(!dry){
      await fs.mkdir(path.dirname(codeFile), { recursive: true });
      await fs.writeFile(codeFile, code, 'utf8');
      await fs.writeFile(metaFile, JSON.stringify(meta, null, 2) + '\n', 'utf8');
    }
    report.created++;
    if(!existingCodes.has(codeKey)) existingCodes.set(codeKey, []);
    existingCodes.get(codeKey).push(rel.split(path.sep).join('/'));
  }

  if(!dry && (report.created || report.skippedDuplicate)){
    await fs.mkdir(out, { recursive: true });
    await fs.writeFile(path.join(out, '_migration-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  }
  log(report);
  return report;
}
