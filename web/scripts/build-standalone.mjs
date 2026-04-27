// Скрипт-склейка: берёт web/dist/index.html и инлайнит ссылочные
// /assets/*.js, /assets/*.css в bondan-standalone.html. Нужен чтобы
// открывать всё приложение одним файлом через githack/локально, без
// CF Pages и SPA-fallback.
//
// Запуск (из корня репо):  node web/scripts/build-standalone.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dist = resolve(root, 'web/dist');
const out  = resolve(root, 'bondan-standalone.html');

let html = readFileSync(resolve(dist, 'index.html'), 'utf8');

// Инлайним каждый <link rel="stylesheet" href="/assets/...css"> в <style>...
html = html.replace(/<link\s+rel="stylesheet"[^>]*href="(\/assets\/[^"]+)"[^>]*\/?>/g, (_, p) => {
  const css = readFileSync(resolve(dist, p.replace(/^\//, '')), 'utf8');
  return `<style>${css}</style>`;
});

// Инлайним <script type="module" src="/assets/...js"> в <script type="module">...
html = html.replace(/<script\s+type="module"[^>]*src="(\/assets\/[^"]+)"[^>]*><\/script>/g, (_, p) => {
  const js = readFileSync(resolve(dist, p.replace(/^\//, '')), 'utf8');
  return `<script type="module">${js}</script>`;
});

// Помечаем сборку как standalone и ставим timestamp.
html = html.replace(/<title>[^<]*<\/title>/, `<title>БондАналитик · standalone</title>
  <meta name="description" content="Standalone HTML-сборка БондАналитика для локального запуска">
  <meta name="generated" content="${new Date().toISOString()}">`);

writeFileSync(out, html);
// Также кладём копию рядом с собранным dist/, чтобы CF Pages раздавала
// её под /standalone.html — это резервный URL на случай проблем со
// SPA-fallback'ом.
const distCopy = resolve(dist, 'standalone.html');
writeFileSync(distCopy, html);
console.log(`OK · ${out} · ${(html.length / 1024).toFixed(1)} KB`);
console.log(`OK · ${distCopy}`);
