import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateTemplates } from '../lib/migrate.mjs';

async function fixture({ withSections = true, group = 'Браузер / DOM' } = {}){
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codelab-migrate-'));
  const src = path.join(root, 'templates');
  const out = path.join(root, 'library');
  await fs.mkdir(src, { recursive: true });
  await fs.mkdir(out, { recursive: true });
  if(withSections){
    await fs.writeFile(path.join(out, '_sections.json'), JSON.stringify({
      tree: [{ name: 'Страница и браузер', subs: ['Работа с DOM'] }],
      rules: ['Браузер / DOM => Страница и браузер / Работа с DOM']
    }, null, 2));
  }
  await fs.writeFile(path.join(src, 'dom-example.json'), JSON.stringify({
    id: 'dom-example',
    title: 'Изменить элемент на странице',
    lang: 'js',
    group,
    desc: 'Проверочный пример миграции.',
    tags: ['dom', 'пример'],
    aliases: ['изменить DOM'],
    lines: [[
      { k: 'kw', v: 'const' }, { k: 'sp' }, { k: 'name', v: 'value' },
      { k: 'op', v: '=' }, { k: 'num', v: '1' }, { k: 'op', v: ';' }
    ]]
  }, null, 2));
  return { root, src, out };
}

test('migrateTemplates applies current section rules to newly imported templates', async () => {
  const f = await fixture();
  try {
    const report = await migrateTemplates({ src: f.src, out: f.out, dictPath: null });
    const meta = JSON.parse(await fs.readFile(path.join(f.out, 'js', 'dom-example.js.meta.json'), 'utf8'));
    assert.equal(report.created, 1);
    assert.equal(report.groupsRemapped, 1);
    assert.deepEqual(report.groupMoves, {
      'Браузер / DOM => Страница и браузер / Работа с DOM': 1
    });
    assert.equal(meta.group, 'Страница и браузер / Работа с DOM');
    assert.deepEqual(meta.tags, ['dom', 'пример']);
    assert.deepEqual(meta.aliases, ['изменить DOM']);
    assert.equal(meta.source.tags, 'imported');
    assert.equal(meta.source.aliases, 'imported');
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('migrateTemplates preserves the original group when no section rules exist', async () => {
  const f = await fixture({ withSections: false });
  try {
    const report = await migrateTemplates({ src: f.src, out: f.out, dictPath: null });
    const meta = JSON.parse(await fs.readFile(path.join(f.out, 'js', 'dom-example.js.meta.json'), 'utf8'));
    assert.equal(report.created, 1);
    assert.equal(report.groupsRemapped, 0);
    assert.equal(meta.group, 'Браузер / DOM');
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('migrateTemplates skips duplicate code and reports the existing library file', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.out, 'js'), { recursive: true });
    await fs.writeFile(path.join(f.out, 'js', 'existing.js'), 'const value=1;', 'utf8');
    const report = await migrateTemplates({ src: f.src, out: f.out, dictPath: null });
    assert.equal(report.created, 0);
    assert.equal(report.skippedDuplicate, 1);
    assert.deepEqual(report.duplicateContent, [{
      file: 'dom-example.json',
      id: 'dom-example',
      lang: 'js',
      existingFiles: ['js/existing.js']
    }]);
    assert.equal(report.groupsRemapped, 0);
    await assert.rejects(fs.access(path.join(f.out, 'js', 'dom-example.js')));
    const savedReport = JSON.parse(await fs.readFile(path.join(f.out, '_migration-report.json'), 'utf8'));
    assert.equal(savedReport.skippedDuplicate, 1);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('migrateTemplates reports a same-ID code conflict without overwriting the library file', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.out, 'js'), { recursive: true });
    const target = path.join(f.out, 'js', 'dom-example.js');
    await fs.writeFile(target, 'const value=2;', 'utf8');
    await fs.writeFile(target + '.meta.json', JSON.stringify({ id: 'dom-example', title: 'Существующая запись' }), 'utf8');
    const report = await migrateTemplates({ src: f.src, out: f.out, dictPath: null });
    assert.equal(report.created, 0);
    assert.equal(report.skippedExisting, 1);
    assert.equal(report.codeConflicts.length, 1);
    assert.deepEqual(report.codeConflicts[0], {
      file: 'dom-example.json',
      id: 'dom-example',
      codeFile: 'js/dom-example.js',
      templateLength: 'const value=1;'.length,
      existingLength: 'const value=2;'.length
    });
    assert.equal(await fs.readFile(target, 'utf8'), 'const value=2;');
    const savedReport = JSON.parse(await fs.readFile(path.join(f.out, '_migration-report.json'), 'utf8'));
    assert.equal(savedReport.codeConflicts.length, 1);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('migrateTemplates classifies language-specific and TypeScript fallback notes as dictionary notes', async () => {
  const f = await fixture();
  try {
    const file = path.join(f.src, 'dom-example.json');
    const card = JSON.parse(await fs.readFile(file, 'utf8'));
    card.lang = 'sql';
    card.lines = [[
      { k: 'kw', v: 'FROM', e: 'FROM — источник таблиц SQL' },
      { k: 'sp' },
      { k: 'name', v: 'таблица', e: 'имя таблицы' }
    ]];
    await fs.writeFile(file, JSON.stringify(card), 'utf8');
    const dict = { words: {}, langs: { sql: { from: 'FROM — источник таблиц SQL' } } };
    const report = await migrateTemplates({ src: f.src, out: f.out, dict });
    const meta = JSON.parse(await fs.readFile(path.join(f.out, 'sql', 'dom-example.sql.meta.json'), 'utf8'));
    assert.equal(report.created, 1);
    assert.equal(meta.wordNotes[0].source, 'dict');
    assert.equal(meta.wordNotes[1].source, 'custom');
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
