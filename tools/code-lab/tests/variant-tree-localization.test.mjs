import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildVariants } from '../lib/variant-tree.mjs';

const read = path => JSON.parse(fs.readFileSync(new URL(path, import.meta.url), 'utf8'));
const dict = read('../public/keyword-dict.json');
dict.langs = {};
for (const lang of ['css', 'html', 'js', 'python', 'sql', 'ts']) {
  dict.langs[lang] = read(\`../public/dict/langs/\${lang}.json\`);
}
const synonyms = read('../public/dict/synonyms.json');
const hasRussian = value => /[А-Яа-яЁё]/.test(String(value || ''));
const flatten = nodes => nodes.flatMap(node => [node, ...flatten(node.children || [])]);

test('реальные варианты конструкций имеют русскую подпись или пояснение', () => {
  const cases = [
    { q: 'внутренний отступ', lang: 'css', term: 'padding' },
    { q: 'кнопка', lang: 'html', term: 'button' },
    { q: 'обработчик нажатия кнопки', lang: 'js', term: 'addeventlistener' },
    { q: 'условие', lang: 'js', term: 'if' },
    { q: 'readonly', lang: 'ts', term: 'readonly' }
  ];
  for (const item of cases) {
    const result = buildVariants({ ...item, dict, rows: [], synonyms });
    const root = result.roots.find(node => node.term.toLowerCase() === item.term.toLowerCase());
    assert.ok(root, \`не найден вариант \${item.term} для запроса «\${item.q}»\`);
    assert.ok(hasRussian(root.label) || hasRussian(root.note), \`\${item.term}: нет русской подписи или пояснения\`);
    for (const node of flatten(root.children)) {
      if (node.group) {
        assert.ok(hasRussian(node.label), \`\${item.term}: группа \${node.label} не подписана по-русски\`);
      } else if (node.term || node.show) {
        assert.ok(
          hasRussian(node.label) || hasRussian(node.note) || hasRussian(node.show),
          \`\${item.term} → \${node.term || node.show}: нет русской подписи или пояснения\`
        );
      }
    }
  }
});
