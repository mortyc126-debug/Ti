// Только dry-run. По умолчанию ничего не записывает; --out создаёт новый manifest без перезаписи.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLegacyQueryPhraseImport } from '../lib/query-phrase-import.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(here, '..', 'public', 'dict', 'synonyms.json');
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outPath = outIndex >= 0 ? args[outIndex + 1] : '';
if (outIndex >= 0 && (!outPath || outPath.startsWith('--'))) throw new Error('После --out укажи путь нового файла');
const source = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
const result = buildLegacyQueryPhraseImport(source);
if (outPath) {
  const target = path.resolve(outPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(result.manifest, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
}
process.stdout.write(JSON.stringify({ ...result.stats, output: outPath ? path.resolve(outPath) : null }, null, 2) + '\n');
if (result.warnings.length) process.exitCode = 1;
