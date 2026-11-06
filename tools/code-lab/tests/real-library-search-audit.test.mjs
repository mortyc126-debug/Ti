// Полный HTTP-аудит теневого поиска на реальной библиотеке checkout.
// Запуск из корня репозитория: node tools/code-lab/tests/real-library-search-audit.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SERVER = path.join(ROOT, 'tools', 'code-lab-server.mjs');
const TESTSET = path.join(ROOT, 'tools', 'code-lab', 'SYNONYM-QUERY-TESTSET.md');
const OUT = path.join(ROOT, 'query-phrase-audit.json');
const port = 21000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const srv = spawn(process.execPath, [SERVER, String(port)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
srv.stdout.on('data', d => log += d);
srv.stderr.on('data', d => log += d);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const get = async url => {
  const response = await fetch(base + url);
  const body = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body).slice(0, 500)}`);
  return body;
};
const tokenText = token => token?.v != null ? String(token.v) : token?.k === 'sp' ? ' ' : '';
const templateText = template => (template?.lines || []).map(line => line.map(tokenText).join('')).join('\n');

async function main() {
  for (let i = 0; i < 180 && !log.includes('Лаборатория кода'); i++) await sleep(100);
  assert.ok(log.includes('Лаборатория кода'), 'HTTP-сервер не запустился:\n' + log.slice(-5000));

  const markdown = await fs.readFile(TESTSET, 'utf8');
  const queries = [...new Set(markdown.split(/\r?\n/)
    .filter(line => /^\|/.test(line))
    .map(line => line.split('|')[1]?.trim().replace(/`/g, ''))
    .filter(value => value && value !== 'Запрос' && !/^[-: ]+$/.test(value)))];
  assert.ok(queries.length >= 50, `Контрольный набор неожиданно мал: ${queries.length}`);

  const templateCache = new Map();
  const readTemplate = async id => {
    if (!templateCache.has(id)) {
      const value = await get('/api/template?id=' + encodeURIComponent(id));
      templateCache.set(id, {
        id: value.id, title: value.title, lang: value.lang, group: value.group,
        desc: value.desc, code: templateText(value)
      });
    }
    return templateCache.get(id);
  };

  const expectedCuratedTargets = {
    'отступ внутри элемента': ['padding'],
    'отступ снаружи элемента': ['margin'],
    'обводка вокруг элемента': ['border', 'outline'],
    'толщина шрифта': ['font-weight'],
    'межбуквенный интервал': ['letter-spacing'],
    'выровнять текст по центру': ['text-align'],
    'выровнять элементы по центру': ['align-items', 'justify-content'],
    'расположить элемент поверх другого': ['z-index'],
    'обтекание изображения текстом': ['float'],
    'спрятать элемент, сохранив место': ['visibility'],
    'скрыть элемент из потока': ['display'],
    'плавно изменить свойство': ['transition'],
    'медиазапрос для телефона': ['@media'],
    'объявить переменную': ['const', 'let', 'var'],
    'объявить константу': ['const'],
    'функция с именем': ['function', 'def'],
    'пройти по массиву': ['for', 'for...of', 'foreach'],
    'условие иначе': ['else'],
    'список Python': ['list'],
    'словарь Python': ['dict'],
    'разбить строку по разделителю': ['split', 's.split(",")'],
    'соединить элементы массива в строку': ['join', '"".join(it)'],
    'округлить до двух знаков': ['tofixed', 'round(x, n)'],
    'асинхронно дождаться результата': ['await'],
    'разобрать JSON': ['parse', 'json.loads(s)'],
    'сериализовать в JSON': ['stringify', 'json.dumps(obj)'],
    'подписаться на клик': ['addeventlistener'],
    'запросить данные по HTTP': ['fetch'],
    'записать файл': ['f.write(s)'],
    'подменить функцию в тесте': ['monkeypatch.setattr("module.name", value)', 'mock.patch("module.name")'],
    'подготовка перед тестом': ['def setup(self)'],
    'очистка после теста': ['def teardown(self)'],
    'дисперсия доходности': ['statistics.variance(data) statistics.pvariance(data)'],
    'корреляция двух рядов': ['statistics.correlation(x, y)']
  };
  const results = [];
  for (const query of queries) {
    const comparison = await get('/api/search/shadow?q=' + encodeURIComponent(query) + '&limit=100');
    const legacy = comparison.legacy || { hits: [] };
    const shadow = comparison.shadow || { hits: [] };
    const expectedTargets = expectedCuratedTargets[query];
    if (expectedTargets) {
      const foundTargets = new Set((shadow.hits || []).map(hit => hit.targetKey));
      for (const target of expectedTargets) {
        assert.ok(foundTargets.has(target), `Курируемая фраза «${query}» не нашла цель «${target}» через HTTP`);
      }
    }
    const legacyHits = (legacy.hits || []).slice(0, 10).map((hit, index) => ({
      position: index + 1, id: hit.id, title: hit.title || hit.name || '',
      score: hit.score ?? hit.match?.score ?? null, why: hit.why || []
    }));
    const legacyPositions = new Map(legacyHits.map(hit => [hit.id, hit.position]));
    const shadowHits = [];
    for (const [index, hit] of shadow.hits.slice(0, 20).entries()) {
      const pieces = [];
      for (const [pieceIndex, piece] of (hit.pieces || []).slice(0, 3).entries()) {
        try {
          const full = await readTemplate(piece.id);
          pieces.push({ ...full, shadowTargetPosition: index + 1, piecePositionWithinTarget: pieceIndex + 1, legacyPosition: legacyPositions.get(piece.id) ?? null });
        } catch (error) {
          pieces.push({ id: piece.id, title: piece.title, fetchError: String(error) });
        }
      }
      shadowHits.push({
        position: index + 1, targetKey: hit.targetKey, score: hit.score,
        phrases: hit.phrases, sections: hit.sections, pieces
      });
    }
    const shadowRankedTop10 = await Promise.all((shadow.rankedPieces || []).slice(0, 10).map(async hit => {
      try { return { ...hit, fragment: await readTemplate(hit.id), legacyPosition: legacyPositions.get(hit.id) ?? null }; }
      catch (error) { return { ...hit, fetchError: String(error), legacyPosition: legacyPositions.get(hit.id) ?? null }; }
    }));
    const shadowRankedIds = new Set(shadowRankedTop10.map(hit => hit.id));
    results.push({
      query, legacyTotal: legacy.total ?? legacyHits.length,
      legacyTop10: await Promise.all(legacyHits.map(async hit => {
        try { return { ...hit, fragment: await readTemplate(hit.id) }; }
        catch (error) { return { ...hit, fetchError: String(error) }; }
      })),
      shadowTotal: shadow.total ?? shadow.hits.length,
      shadowAmbiguous: shadow.ambiguous,
      shadowTop20: shadowHits,
      shadowRankedTop10,
      legacyOnlyTop10: legacyHits.filter(hit => !shadowRankedIds.has(hit.id)),
      shadowOnlyTop10: shadowRankedTop10.filter(hit => hit.legacyPosition == null),
      productionSearchChanged: comparison.productionSearchChanged
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    branch: 'audit/fixes-2026-11-06',
    commit: process.env.GITHUB_SHA || null,
    libraryMode: 'real repository checkout; no synthetic fixture',
    shadowRanking: 'fragment-level; phrase match score plus title/description/tags/aliases relevance; deterministic heuristic, not semantic model ranking',
    comparisonNote: 'shadow and legacy now expose fragment positions; their scoring systems differ, so compare rank movement and content relevance rather than raw score values',
    queryCount: queries.length,
    phraseCount: (await get('/api/search/shadow?q=' + encodeURIComponent(queries[0]) + '&limit=1')).shadowPhraseCount,
    templateCount: templateCache.size,
    results
  };
  await fs.writeFile(OUT, JSON.stringify(report, null, 2) + '\n');
  const httpErrors = results.filter(result => result.productionSearchChanged !== false);
  assert.equal(httpErrors.length, 0, 'Один или несколько ответов не подтвердили неизменность production search');
  console.log(`REAL LIBRARY HTTP AUDIT: ${queries.length} queries; ${templateCache.size} full fragments; report: ${OUT}`);
  console.log(`Queries with shadow hits: ${results.filter(result => result.shadowTotal > 0).length}`);
  console.log(`Queries with ambiguous targets: ${results.filter(result => result.shadowAmbiguous).length}`);
}

try {
  await main();
} finally {
  srv.kill('SIGTERM');
  await sleep(300);
  if (srv.exitCode == null) srv.kill('SIGKILL');
}
