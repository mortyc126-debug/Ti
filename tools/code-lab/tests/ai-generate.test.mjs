import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLibraryStore } from '../lib/library-store.mjs';
import { createAiGenerate, checkSyntax, normalizePieces } from '../lib/ai-generate.mjs';

// проверка синтаксиса без запуска
assert.equal(checkSyntax('js', 'const a = 1;').status, 'ok');
assert.equal(checkSyntax('js', 'const = ;').status, 'error');
assert.equal(checkSyntax('js', 'const r = await fetch("/x");').status, 'ok', 'await на верхнем уровне допустим');
assert.equal(checkSyntax('json', '{"a":').status, 'error');
assert.equal(checkSyntax('python', 'print(1)').status, 'unchecked', 'для python честно «не проверено»');
globalThis.__ran = false;
checkSyntax('js', 'globalThis.__ran = true;');
assert.equal(globalThis.__ran, false, 'код не должен выполняться при проверке');

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-gen-'));
try {
  const root = path.join(tmp, 'library');
  await fs.mkdir(path.join(root, 'python'), { recursive: true });
  await fs.writeFile(path.join(root, 'python', 'have.py'), 'print("hi")\n');
  await fs.writeFile(path.join(root, 'python', 'have.py.meta.json'), JSON.stringify({ schema: 1, id: 'have', lang: 'python', title: 'Приветствие', group: 'Основы / Python', desc: 'x', tags: [], aliases: [], source: {}, status: 'described' }));
  const store = createLibraryStore({ root });
  await store.init();

  let sent = null;
  const answer = { pieces: [
    { title: 'Развернуть строку', group: 'Строки / Срезы', desc: 'Переворачивает строку.', output: 'строка наоборот', tags: ['строки'], aliases: ['reverse'], code: 's = "abc"\nprint(s[::-1])' },
    { title: 'Приветствие', group: 'Основы / Python', code: 'print("другой код")' },      // то же название
    { title: 'Дубль кода', group: 'Основы / Python', code: 'print("hi")' },               // тот же код
    { title: 'Развернуть строку', code: 'print(1)' },                                      // повтор названия в ответе
    { title: '', code: 'x' }, { title: 'Пустой', code: '   ' },                            // мусор
  ] };
  const fake = async (_u, opts) => { sent = JSON.parse(opts.body); assert.match(opts.headers.Authorization, /Bearer k/); return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(answer) } }] }) }; };
  const gen = createAiGenerate({ store, apiKey: '', fetchImpl: fake });

  await assert.rejects(() => gen.propose({ lang: 'python' }), /ключ Mistral/);
  await assert.rejects(() => gen.propose({ lang: 'cobol', key: 'k' }), /Неизвестный язык/);

  const r = await gen.propose({ lang: 'python', topic: 'строки', count: 99, key: 'k' });
  assert.match(sent.messages[1].content, /Приветствие/, 'в промпт попадают уже существующие названия');
  assert.match(sent.messages[1].content, /ровно 8/, 'количество ограничено 8');
  assert.equal(r.pieces.length, 3, 'пустые и повторы названий выброшены');
  assert.equal(r.pieces[0].dupOf, null);
  assert.equal(r.pieces[1].dupOf, 'have', 'то же название — помечено как дубль');
  assert.equal(r.pieces[2].dupOf, 'have', 'тот же код — помечен как дубль');
  assert.equal(r.pieces[0].check.status, 'unchecked');
  assert.equal(await store.count(), 1, 'propose ничего не сохраняет');
  assert.equal(normalizePieces(null, 'js').length, 0);
  console.log('ai-generate tests passed');
} finally { await fs.rm(tmp, { recursive: true, force: true }); }

// ── поиск пробелов ──
{
  const { normalizeTopics } = await import('../lib/ai-generate.mjs');
  assert.deepEqual(normalizeTopics({ topics: [{ topic: 'Файлы', why: 'частая задача' }, { topic: 'файлы' }, 'Строки', { topic: '' }, null] }).map(t => t.topic), ['Файлы', 'Строки']);
  assert.equal(normalizeTopics({ topics: Array.from({ length: 20 }, (_, i) => 'т' + i) }).length, 8);
  assert.deepEqual(normalizeTopics(undefined), []);
  const tmp2 = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-gaps-'));
  try {
    const root = path.join(tmp2, 'library'); await fs.mkdir(path.join(root, 'python'), { recursive: true });
    await fs.writeFile(path.join(root, 'python', 'a.py'), 'print(1)\n');
    await fs.writeFile(path.join(root, 'python', 'a.py.meta.json'), JSON.stringify({ schema: 1, id: 'a', lang: 'python', title: 'Вывод на экран', group: 'Основы / Python', desc: 'x', tags: [], aliases: [], source: {}, status: 'described' }));
    const store2 = createLibraryStore({ root }); await store2.init();
    let prompt = '';
    const gen2 = createAiGenerate({ store: store2, apiKey: '', fetchImpl: async (_u, o) => { prompt = JSON.parse(o.body).messages[1].content; return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ topics: [{ topic: 'Чтение файлов', why: 'нужно часто' }] }) } }] }) }; } });
    await assert.rejects(() => gen2.gaps({ lang: 'python' }), /ключ Mistral/);
    await assert.rejects(() => gen2.gaps({ lang: 'cobol', key: 'k' }), /Неизвестный язык/);
    const g = await gen2.gaps({ lang: 'python', key: 'k' });
    assert.deepEqual(g.topics, [{ topic: 'Чтение файлов', why: 'нужно часто' }]);
    assert.match(prompt, /Вывод на экран/, 'в запрос попадают названия существующих кусков');
    assert.equal(await store2.count(), 1, 'поиск пробелов ничего не сохраняет');
  } finally { await fs.rm(tmp2, { recursive: true, force: true }); }
  console.log('ai-gaps tests passed');
}
