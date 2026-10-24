import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLibraryStore } from '../lib/library-store.mjs';
import { createAiAssist, normalize } from '../lib/ai-assist.mjs';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-assist-'));
try {
  const root = path.join(tmp, 'library');
  await fs.mkdir(path.join(root, 'js'), { recursive: true });
  const code = 'const total = items.reduce((a, b) => a + b, 0);\nconsole.log(total);\n';
  await fs.writeFile(path.join(root, 'js', 'sum.js'), code);
  await fs.writeFile(path.join(root, 'js', 'sum.js.meta.json'), JSON.stringify({
    schema: 1, id: 'sum', lang: 'js', title: 'Сумма', group: 'JS / Массивы', desc: 'Моё описание', tags: [], aliases: [],
    source: { desc: 'manual' }, status: 'described',
  }));
  const store = createLibraryStore({ root });
  await store.init();

  const answers = {
    desc: { desc: 'Складывает числа массива и печатает сумму.', output: 'число в консоли' },
    notes: { lineNotes: { 'console.log(total);': 'Печатает результат.', 'такой строки нет': 'мусор' }, words: { reduce: 'Сворачивает массив в одно значение.', выдумка: 'нет в коде' } },
    errors: { common_errors: [{ symptom: 'NaN', cause: 'в массиве не числа', solution: 'привести через Number' }, { symptom: '', cause: '', solution: '' }] },
  };
  let last = null;
  const fakeFetch = async (_u, opts) => {
    last = JSON.parse(opts.body);
    assert.match(opts.headers.Authorization, /Bearer k1/);
    const sec = /Раздел: «(.+?)»/.exec(last.messages[1].content)[1];
    const key = { 'Что делает': 'desc', 'Пояснения к коду': 'notes', 'Типичные ошибки': 'errors' }[sec];
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(answers[key]) } }] }) };
  };
  const ai = createAiAssist({ store, apiKey: '', fetchImpl: fakeFetch });

  // без ключа — понятная ошибка
  await assert.rejects(() => ai.suggest({ id: 'sum', section: 'desc' }), /ключ Mistral/);
  // неизвестный раздел
  await assert.rejects(() => ai.suggest({ id: 'sum', section: 'x', key: 'k1' }), /Неизвестный раздел/);

  // suggest ничего не сохраняет, но в промпт попадает уже написанное человеком + пожелание
  const s = await ai.suggest({ id: 'sum', section: 'desc', instruction: 'проще', key: 'k1' });
  assert.equal(s.suggestion.desc, 'Складывает числа массива и печатает сумму.');
  assert.match(last.messages[1].content, /Моё описание/);
  assert.match(last.messages[1].content, /проще/);
  assert.equal((await store.get('sum')).desc, 'Моё описание', 'предложение не должно записываться само');

  // notes: выдуманные строки/слова отбрасываются
  const n = await ai.suggest({ id: 'sum', section: 'notes', key: 'k1' });
  assert.deepEqual(Object.keys(n.suggestion.lineNotes), ['console.log(total);']);
  assert.deepEqual(Object.keys(n.suggestion.words), ['reduce']);

  // apply: описание, заметки сливаются, пустые ошибки отбрасываются; код не меняется
  await ai.apply({ id: 'sum', section: 'desc', value: { desc: 'Новое описание', output: 'сумма' } });
  let t = await store.get('sum');
  assert.equal(t.desc, 'Новое описание');
  assert.equal(t.output, 'сумма');
  await ai.apply({ id: 'sum', section: 'notes', value: n.suggestion });
  await ai.apply({ id: 'sum', section: 'notes', value: { lineNotes: { 'const total = items.reduce((a, b) => a + b, 0);': 'Считает сумму.' }, words: {} } });
  t = await store.get('sum');
  assert.equal(Object.keys(t.component.lineNotes).length, 2, 'новые заметки добавляются к прежним');
  assert.equal(t.component.notes.reduce, 'Сворачивает массив в одно значение.');
  const e = await ai.suggest({ id: 'sum', section: 'errors', key: 'k1' });
  assert.equal(e.suggestion.common_errors.length, 1);
  await ai.apply({ id: 'sum', section: 'errors', value: e.suggestion });
  await ai.apply({ id: 'sum', section: 'limits', value: { errors: 'Пустой массив даст 0.' } });
  await ai.apply({ id: 'sum', section: 'requirements', value: { input: 'массив чисел items', requirements: ['items объявлен'] } });
  t = await store.get('sum');
  assert.equal(t.component.views.check.common_errors[0].symptom, 'NaN');
  assert.equal(t.component.views.check.errors, 'Пустой массив даст 0.');
  assert.deepEqual(t.component.summary.requirements, ['items объявлен']);
  assert.equal(await fs.readFile(path.join(root, 'js', 'sum.js'), 'utf8'), code, 'код куска не должен меняться');

  // кусок из конструктора без id
  const p = await ai.suggest({ piece: { title: 'tmp', lang: 'js', code: 'let a = 1;' }, section: 'desc', key: 'k1' });
  assert.ok(p.suggestion.desc);
  await assert.rejects(() => ai.suggest({ piece: { title: 'x', lang: 'js', code: '  ' }, section: 'desc', key: 'k1' }), /нет кода/);

  assert.deepEqual(normalize('limits', null), { errors: '' });
  console.log('ai-assist tests passed');
} finally { await fs.rm(tmp, { recursive: true, force: true }); }
