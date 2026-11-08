import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const port = 8878;
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['tools/code-lab-server.mjs', String(port)], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', chunk => { serverLog += chunk.toString(); });
server.stderr.on('data', chunk => { serverLog += chunk.toString(); });

let browser;
try {
  const deadline = Date.now() + 120_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error('Code Lab server exited early:\n' + serverLog);
    try {
      const response = await fetch(origin + '/constructor.html');
      if (response.ok) { ready = true; break; }
    } catch (_) {}
    await delay(500);
  }
  assert.ok(ready, 'Code Lab server did not start:\n' + serverLog);

  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext();
  await context.addInitScript(() => {
    localStorage.removeItem('codelab_sandbox');
    localStorage.removeItem('codelab_sb_active');
    localStorage.setItem('codelab_mode', 'sandbox');
    localStorage.setItem('codelab_ac', 'on');
    localStorage.setItem('codelab_ac_speed', 'instant');
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(origin + '/constructor.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#sbEds .sb-ed', { timeout: 30_000 });
  await page.waitForFunction(() => {
    const box = document.querySelector('#sandbox');
    return box && getComputedStyle(box).display !== 'none';
  }, undefined, { timeout: 30_000 });

  const cssIndex = await page.locator('#sbEds .sb-ed').evaluateAll(eds =>
    eds.findIndex(ed => ed.querySelector('.sb-lang')?.value === 'css')
  );
  assert.ok(cssIndex >= 0, 'default CSS editor was not created');
  const cssEditor = page.locator('#sbEds .sb-ed').nth(cssIndex);
  await page.locator('#sbTabs').waitFor({ state: 'visible' });
  const cssTab = page.locator('#sbTabs .sb-tab').filter({ hasText: 'style.css' }).first();
  await cssTab.click();
  await cssEditor.waitFor({ state: 'visible' });
  const cm = cssEditor.locator('.CodeMirror');
  if (await cm.count() && await cm.isVisible()) {
    await cm.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('margin');
  } else {
    const textarea = cssEditor.locator('textarea.sb-code');
    await textarea.waitFor({ state: 'visible' });
    await textarea.fill('margin');
    await textarea.evaluate(el => el.setSelectionRange(el.value.length, el.value.length));
  }

  const browserDebug = await page.evaluate(() => ({
    sandboxApi: !!window.codelabSandbox,
    sandboxVisible: getComputedStyle(document.querySelector('#sandbox')).display,
    editorTabs: [...document.querySelectorAll('#sbTabs .sb-tab')].map(tab => tab.innerText),
    activeId: localStorage.getItem('codelab_sb_active'),
    autocompleteStyle: [...document.querySelectorAll('style')].some(style => style.textContent.includes('.ac-pop'))
  }));
  const editorDebug = await cssEditor.evaluate(ed => ({
    className: ed.className,
    display: getComputedStyle(ed).display,
    file: ed.__f && { name: ed.__f.name, lang: ed.__f.lang, code: ed.__f.code },
    textareas: [...ed.querySelectorAll('textarea')].map(ta => ({
      className: ta.className, display: getComputedStyle(ta).display,
      visibility: getComputedStyle(ta).visibility, value: ta.value,
      hasCodeMirror: !!ta.__cm, rect: ta.getBoundingClientRect().toJSON()
    })),
    codeMirror: [...ed.querySelectorAll('.CodeMirror')].map(cm => ({
      display: getComputedStyle(cm).display, visibility: getComputedStyle(cm).visibility,
      rect: cm.getBoundingClientRect().toJSON()
    }))
  }));
  console.log('browser debug:', JSON.stringify({ browserDebug, editorDebug }));

  await page.waitForSelector('.ac-pop', { timeout: 20_000 });
  const popup = page.locator('.ac-pop');
  const popupCodes = await popup.locator('.ac-r').evaluateAll(rows => rows.map(row => row.dataset.code || ''));
  assert.ok(popupCodes.some(code => /margin/i.test(code)), 'CSS margin variant was not shown');
  assert.ok(await popup.locator('.ac-note').count() > 0, 'variant rows do not include explanation fields');
  const explanations = await popup.locator('.ac-note').allTextContents();
  assert.ok(explanations.some(note => /[А-Яа-яЁё]/.test(note)), 'variant rows have no Russian explanations');

  const expandableIndex = await popup.locator('.ac-r').evaluateAll(rows => {
    const visible = rows.filter(row => row.offsetParent !== null);
    return visible.findIndex(row => row.nextElementSibling?.classList.contains('ac-kids'));
  });
  assert.ok(expandableIndex >= 0, 'variant tree has no expandable group');
  for (let i = 0; i < expandableIndex; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  const expanded = await popup.locator('.ac-r.sel').evaluate(row =>
    row.nextElementSibling?.classList.contains('ac-kids') && !row.nextElementSibling.hidden
  );
  assert.ok(expanded, 'ArrowRight did not expand the selected variant group');
  await page.keyboard.press('ArrowDown');
  assert.equal(await popup.locator('.ac-r.sel').count(), 1, 'keyboard navigation lost the selected row');

  const insertIndex = await popup.locator('.ac-r').evaluateAll(rows => {
    const visible = rows.filter(row => row.offsetParent !== null);
    return visible.findIndex(row => row.dataset.code && row.dataset.code.trim() && !row.classList.contains('ac-grp'));
  });
  assert.ok(insertIndex >= 0, 'variant tree has no insertable code row');
  const selectedIndex = await popup.locator('.ac-r').evaluateAll(rows => {
    const visible = rows.filter(row => row.offsetParent !== null);
    return visible.indexOf(visible.find(row => row.classList.contains('sel')));
  });
  assert.ok(selectedIndex >= 0, 'keyboard selection is missing');
  const delta = insertIndex - selectedIndex;
  for (let i = 0; i < Math.abs(delta); i++) await page.keyboard.press(delta > 0 ? 'ArrowDown' : 'ArrowUp');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.ac-pop'));
  let code = await cssEditor.evaluate(ed => ed.__f.code);
  assert.match(code, /margin|padding|gap/i, 'Enter did not insert the selected variant');

  // IME: intermediate input must not open the popup; compositionend must resume suggestions.
  await cssEditor.evaluate(ed => {
    const original = ed.querySelector('textarea.sb-code') || ed.querySelector('textarea');
    const cm = original && original.__cm;
    if (cm && cm.getWrapperElement().offsetParent !== null) {
      cm.setValue('margin'); cm.setCursor({ line: 0, ch: 6 });
    } else {
      original.value = 'margin';
      original.setSelectionRange(6, 6);
    }
    ed.__f.code = 'margin';
    const input = cm && cm.getWrapperElement().offsetParent !== null
      ? ed.querySelector('.CodeMirror textarea') : original;
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    input.dispatchEvent(new InputEvent('input', {
      bubbles: true, isComposing: true, inputType: 'insertCompositionText', data: 'margin'
    }));
  });
  await delay(100);
  assert.equal(await page.locator('.ac-pop').count(), 0, 'autocomplete opened during IME composition');
  await cssEditor.evaluate(ed => {
    const original = ed.querySelector('textarea.sb-code') || ed.querySelector('textarea');
    const cm = original && original.__cm;
    const input = cm && cm.getWrapperElement().offsetParent !== null
      ? ed.querySelector('.CodeMirror textarea') : original;
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'отступ' }));
  });
  await page.waitForSelector('.ac-pop', { timeout: 15_000 });

  // A slow template response must not insert into the editor after the popup is closed.
  let templateStarted = false;
  await page.route('**/api/template?id=*', async route => {
    templateStarted = true;
    await delay(900);
    try { await route.continue(); } catch (_) {}
  });
  for (let attempt = 0; attempt < 20; attempt++) {
    const collapsedIndex = await popup.locator('.ac-r').evaluateAll(rows =>
      rows.findIndex(row => row.offsetParent !== null &&
        row.nextElementSibling?.classList.contains('ac-kids') && row.nextElementSibling.hidden)
    );
    if (collapsedIndex < 0) break;
    await popup.locator('.ac-r').nth(collapsedIndex).locator('.ac-t').click();
  }
  const pieceIndex = await popup.locator('.ac-r').evaluateAll(rows =>
    rows.findIndex(row => row.offsetParent !== null && row.dataset.piece)
  );
  assert.ok(pieceIndex >= 0, 'variant tree did not expose a library example for cancellation test');
  const requestPromise = page.waitForRequest(request => request.url().includes('/api/template?id='), { timeout: 10_000 });
  await popup.locator('.ac-r').nth(pieceIndex).click();
  await requestPromise;
  await page.keyboard.press('Escape');
  await delay(1_100);
  assert.ok(templateStarted, 'template request did not start');
  code = await cssEditor.evaluate(ed => ed.__f.code);
  assert.equal(code, 'margin', 'stale template response inserted code after the tree was closed');
  assert.equal(await page.locator('.ac-pop').count(), 0, 'Escape did not close the variant tree');

  // A stale variant-search response must not replace results for the newer query.
  let staleVariantStarted = false;
  await page.route('**/api/variants**', async route => {
    const query = new URL(route.request().url()).searchParams.get('q');
    if (query === 'margin') {
      staleVariantStarted = true;
      await delay(900);
    }
    try { await route.continue(); } catch (_) {}
  });
  const staleVariantRequest = page.waitForRequest(request =>
    new URL(request.url()).pathname === '/api/variants' &&
    new URL(request.url()).searchParams.get('q') === 'margin',
    { timeout: 10_000 }
  );
  await page.keyboard.press('Control+A');
  await page.keyboard.type('отступ');
  await staleVariantRequest;
  await page.keyboard.press('Control+A');
  await page.keyboard.type('padding');
  await page.waitForFunction(() => {
    const popup = document.querySelector('.ac-pop');
    return popup && [...popup.querySelectorAll('.ac-r')].some(row => /padding/i.test(row.dataset.code || ''));
  }, undefined, { timeout: 15_000 });
  await delay(1_000);
  const latestCodes = await page.locator('.ac-pop .ac-r').evaluateAll(rows => rows.map(row => row.dataset.code || ''));
  assert.ok(staleVariantStarted, 'slow old variant request did not start');
  assert.ok(latestCodes.some(value => /padding/i.test(value)), 'newer CSS padding query did not win');
  assert.ok(!latestCodes.some(value => /margin/i.test(value)), 'stale margin results replaced the newer padding query');

  assert.deepEqual(pageErrors, [], 'browser page raised uncaught errors: ' + pageErrors.join('; '));
  console.log('Browser smoke passed: variant tree, expansion, keyboard insertion, IME and stale-template cancellation.');
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => server.once('exit', resolve)),
      delay(5_000)
    ]);
  }
  if (server.exitCode !== null && server.exitCode !== 0) {
    console.error('Code Lab server exit code:', server.exitCode, serverLog);
  }
}
