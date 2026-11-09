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
    // Контекст инициализируется только для основной страницы: sandboxed preview iframe
    // намеренно не имеет same-origin и не должен получать доступ к localStorage.
    if (window.top !== window) return;
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
    const api = window.CodeLabContext;
    return api && api.listProviders().some(provider => provider.id === 'call-arguments') &&
      api.listProviders().some(provider => provider.id === 'html-attributes') &&
      api.listProviders().some(provider => provider.id === 'html-tags');
  }, undefined, { timeout: 15_000 });
  const registeredAdapters = await page.evaluate(() => window.CodeLabContext.listProviders());
  assert.ok(registeredAdapters.some(provider => provider.contexts?.includes('css-value')),
    'CSS value context was not registered');
  assert.ok(registeredAdapters.some(provider => provider.languages?.includes('html')),
    'HTML context adapter was not registered');

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
    await page.keyboard.type('.card { align-items: en');
    await page.waitForFunction(() => {
      const popup = document.querySelector('.ac-pop');
      return popup && [...popup.querySelectorAll('.ac-r')].some(row => /^end$/i.test(row.dataset.code || ''));
    }, undefined, { timeout: 15_000 });
    const contextualValues = await page.locator('.ac-pop .ac-r').evaluateAll(rows => rows.map(row => row.dataset.code || ''));
    assert.ok(contextualValues.some(value => /^end$/i.test(value)),
      'CSS value suggestions did not use the align-items property context');
    await page.keyboard.press('Escape');

    await cm.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('.card { /* align-items: en');
    await delay(250);
    assert.equal(await page.locator('.ac-pop').count(), 0,
      'CSS autocomplete opened inside a comment');

    await cm.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('.card { content: "hello');
    await delay(250);
    assert.equal(await page.locator('.ac-pop').count(), 0,
      'CSS autocomplete opened inside a string');

    await cm.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('.card { d');
    await page.waitForFunction(() => {
      const popup = document.querySelector('.ac-pop');
      return popup && [...popup.querySelectorAll('.ac-r')].some(row => row.dataset.code === 'display');
    }, undefined, { timeout: 10_000 });
    const propertyRows = await page.locator('.ac-pop .ac-r').evaluateAll(rows =>
      rows.filter(row => row.dataset.code).map(row => ({
        code: row.dataset.code,
        note: row.querySelector('.ac-d')?.textContent || ''
      }))
    );
    assert.ok(propertyRows.some(row => row.code === 'display' && /раскладк/i.test(row.note)),
      'CSS declaration context did not offer the Russian-explained display property');
    await page.keyboard.press('Escape');

    await cm.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('.card :ho');
    await page.waitForFunction(() => {
      const popup = document.querySelector('.ac-pop');
      return popup && [...popup.querySelectorAll('.ac-r')].some(row => row.dataset.code === ':hover');
    }, undefined, { timeout: 10_000 });
    const selectorRows = await page.locator('.ac-pop .ac-r').evaluateAll(rows =>
      rows.filter(row => row.dataset.code).map(row => row.dataset.code)
    );
    assert.ok(selectorRows.includes(':hover'),
      'CSS selector context did not offer the matching pseudo-class');
    await page.keyboard.press('Escape');

    await cm.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('.card:has(> .ca');
    await page.waitForFunction(() => {
      const popup = document.querySelector('.ac-pop');
      return popup && [...popup.querySelectorAll('.ac-r')].some(row => row.dataset.code === '.card');
    }, undefined, { timeout: 10_000 });
    assert.ok((await page.locator('.ac-pop .ac-r').evaluateAll(rows => rows.map(row => row.dataset.code))).includes('.card'),
      'CSS :has() selector argument did not offer matching class selectors');
    await page.keyboard.press('Escape');

    await cm.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type(':is(di');
    await page.waitForFunction(() => {
      const popup = document.querySelector('.ac-pop');
      return popup && [...popup.querySelectorAll('.ac-r')].some(row => row.dataset.code === 'div');
    }, undefined, { timeout: 10_000 });
    assert.ok((await page.locator('.ac-pop .ac-r').evaluateAll(rows => rows.map(row => row.dataset.code))).includes('div'),
      'CSS :is() selector argument did not offer HTML type selectors');
    await page.keyboard.press('Escape');

    await cm.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type(':nth-child(od');
    await page.waitForFunction(() => {
      const popup = document.querySelector('.ac-pop');
      return popup && [...popup.querySelectorAll('.ac-r')].some(row => row.dataset.code === 'odd');
    }, undefined, { timeout: 10_000 });
    assert.ok((await page.locator('.ac-pop .ac-r').evaluateAll(rows => rows.map(row => row.dataset.code))).includes('odd'),
      'CSS :nth-child() did not offer matching formula arguments');
    await page.keyboard.press('Escape');

    await cm.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type(':root { --gap: 1rem; } .card { gap: var(--ga');
    await page.waitForFunction(() => {
      const popup = document.querySelector('.ac-pop');
      return popup && [...popup.querySelectorAll('.ac-r')].some(row => row.dataset.code === '--gap');
    }, undefined, { timeout: 10_000 });
    const variableNotes = await page.locator('.ac-pop .ac-r').evaluateAll(rows =>
      rows.filter(row => row.dataset.code).map(row => ({
        code: row.dataset.code,
        note: row.querySelector('.ac-d')?.textContent || ''
      }))
    );
    assert.ok(variableNotes.some(row => row.code === '--gap' && /пользовательское свойство/.test(row.note)),
      'CSS var() did not suggest a declared custom property with an explanation');
    await page.keyboard.press('Escape');

    await cm.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('.card { place-items: center; }');
    await cssEditor.evaluate(ed => {
      const ta = ed.querySelector('textarea');
      const editor = ta && ta.__cm;
      editor.setSelection({ line: 0, ch: 8 }, { line: 0, ch: 28 });
    });
    await page.evaluate(async () => { await window.codelabSelExplain.open(); });
    await page.waitForSelector('.se', { timeout: 10_000 });
    const shorthandExplanation = await page.locator('.se').innerText();
    assert.match(shorthandExplanation, /align-items/);
    assert.match(shorthandExplanation, /justify-items/);
    const shorthandPreview = await page.locator('.se-transform pre').innerText();
    assert.match(shorthandPreview, /align-items: center;/);
    assert.match(shorthandPreview, /justify-items: center;/);
    await page.locator('.se .se-h button').click();

    await cm.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('.card { align-items: center;\n  justify-items: end; }');
    await cssEditor.evaluate(ed => {
      const editor = ed.querySelector('textarea')?.__cm;
      editor.setSelection({ line: 0, ch: 8 }, { line: 1, ch: 21 });
    });
    await page.evaluate(async () => { await window.codelabSelExplain.open(); });
    await page.waitForFunction(() => {
      const preview = document.querySelector('.se-transform pre');
      return preview && /place-items: center end;/.test(preview.textContent || '');
    }, undefined, { timeout: 10_000 });
    await page.locator('.se .se-h button').click();

    await cm.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('.card {\n  align-items: center;\n  justify-items: end;\n  align-items: start;\n}');
    await cssEditor.evaluate(ed => {
      const editor = ed.querySelector('textarea')?.__cm;
      editor.setSelection({ line: 1, ch: 0 }, { line: 2, ch: editor.getLine(2).length });
    });
    await page.evaluate(async () => { await window.codelabSelExplain.open(); });
    await page.waitForSelector('.se', { timeout: 10_000 });
    assert.equal(await page.locator('.se-transform').count(), 0,
      'CSS shorthand collapse preview ignored a duplicate declaration in the same rule');
    await page.locator('.se .se-h button').click();

    await cm.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('.card { place-items: left; }');
    await cssEditor.evaluate(ed => {
      const editor = ed.querySelector('textarea')?.__cm;
      editor.setSelection({ line: 0, ch: 8 }, { line: 0, ch: 26 });
    });
    await page.evaluate(async () => { await window.codelabSelExplain.open(); });
    await page.waitForSelector('.se', { timeout: 10_000 });
    assert.equal(await page.locator('.se-transform').count(), 0,
      'CSS shorthand expansion preview accepted a value invalid for align-items');
    await page.locator('.se .se-h button').click();

    const collapseSource = '.card {\n  align-items: center;\n  justify-items: end;\n}';
    await cssEditor.evaluate((ed, source) => {
      const editor = ed.querySelector('textarea')?.__cm;
      editor.setValue(source);
      editor.setSelection({ line: 1, ch: 2 }, { line: 2, ch: 21 });
    }, collapseSource);
    const collapseDiagnostic = await cssEditor.evaluate(ed => {
      const editor = ed.querySelector('textarea')?.__cm;
      const full = editor.getValue(), source = editor.getSelection();
      const offset = window.CSSContext.offsetAt(full, editor.getCursor('from'));
      return { source, offset, result: window.CSSShorthands.collapseRange('place-items', source, full, offset) };
    });
    assert.equal(collapseDiagnostic.result.ok, true,
      'CSS collapse preflight rejected browser selection: ' + JSON.stringify(collapseDiagnostic));
    await page.evaluate(async () => { await window.codelabSelExplain.open(); });
    await page.waitForSelector('.se-transform [data-css-apply]', { timeout: 10_000 });
    await page.locator('.se-transform [data-css-apply]').click();
    let transformed = await cssEditor.evaluate(ed => ed.querySelector('textarea')?.__cm.getValue());
    assert.match(transformed, /place-items: center end;/,
      'explicit CSS shorthand action did not replace the selected longhand pair');
    await cssEditor.evaluate(ed => ed.querySelector('textarea')?.__cm.undo());
    assert.equal(await cssEditor.evaluate(ed => ed.querySelector('textarea')?.__cm.getValue()), collapseSource,
      'CSS shorthand collapse could not be undone in CodeMirror history');

    const expandSource = '.card { place-items: center; }';
    await cm.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type(expandSource);
    await cssEditor.evaluate(ed => {
      const editor = ed.querySelector('textarea')?.__cm;
      editor.setSelection({ line: 0, ch: 8 }, { line: 0, ch: 28 });
    });
    await page.evaluate(async () => { await window.codelabSelExplain.open(); });
    await page.waitForSelector('.se-transform [data-css-apply]', { timeout: 10_000 });
    await page.locator('.se-transform [data-css-apply]').click();
    transformed = await cssEditor.evaluate(ed => ed.querySelector('textarea')?.__cm.getValue());
    assert.match(transformed, /align-items: center;\s*justify-items: center;/,
      'explicit CSS shorthand expansion did not replace the selected declaration');
    await cssEditor.evaluate(ed => ed.querySelector('textarea')?.__cm.undo());
    assert.equal(await cssEditor.evaluate(ed => ed.querySelector('textarea')?.__cm.getValue()), expandSource,
      'CSS shorthand expansion could not be undone in CodeMirror history');

    await cm.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type(expandSource);
    await cssEditor.evaluate(ed => {
      const editor = ed.querySelector('textarea')?.__cm;
      editor.setSelection({ line: 0, ch: 8 }, { line: 0, ch: 28 });
    });
    await page.evaluate(async () => { await window.codelabSelExplain.open(); });
    await page.waitForSelector('.se-transform [data-css-apply]', { timeout: 10_000 });
    await cssEditor.evaluate(ed => {
      ed.querySelector('textarea')?.__cm.setSelection({ line: 0, ch: 0 }, { line: 0, ch: 5 });
    });
    await page.locator('.se-transform [data-css-apply]').click();
    assert.equal(await cssEditor.evaluate(ed => ed.querySelector('textarea')?.__cm.getValue()), expandSource,
      'stale CSS preview changed code after the editor selection moved');
    assert.equal(await page.locator('.se-transform [data-css-apply]').isDisabled(), true,
      'stale CSS preview did not disable its apply action');
    await page.locator('.se .se-h button').click();
  }
  if (await cm.count() && await cm.isVisible()) {
    await cm.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('m'); // однобуквенный префикс должен сразу открыть CSS-варианты
  } else {
    const textarea = cssEditor.locator('textarea.sb-code');
    await textarea.waitFor({ state: 'visible' });
    await textarea.fill('margin');
    await textarea.evaluate(el => el.setSelectionRange(el.value.length, el.value.length));
  }

  let autoPopupOpened = false;
  try {
    await page.waitForSelector('.ac-pop', { timeout: 5_000 });
    autoPopupOpened = true;
  } catch (_) {}
  if (!autoPopupOpened) {
    await page.keyboard.press('Control+Space');
    await page.waitForSelector('.ac-pop', { timeout: 5_000 });
  }
  assert.ok(autoPopupOpened, 'typing a code token did not open autocomplete automatically');
  const popup = page.locator('.ac-pop');
  const popupCodes = await popup.locator('.ac-r').evaluateAll(rows => rows.map(row => row.dataset.code || ''));
  assert.ok(popupCodes.some(code => /margin/i.test(code)), 'CSS margin variant was not shown');
  assert.ok(await popup.locator('.ac-d').count() > 0, 'variant rows do not include explanation fields');
  const explanations = await popup.locator('.ac-d').allTextContents();
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
    return visible.findIndex(row => row.dataset.code && /margin/i.test(row.dataset.code) && !row.classList.contains('ac-grp'));
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
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'margin' }));
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
  await page.keyboard.type('margin');
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

  const htmlIndex = await page.locator('#sbEds .sb-ed').evaluateAll(eds =>
    eds.findIndex(ed => ed.querySelector('.sb-lang')?.value === 'html')
  );
  assert.ok(htmlIndex >= 0, 'default HTML editor was not created');
  const htmlEditor = page.locator('#sbEds .sb-ed').nth(htmlIndex);
  await page.locator('#sbTabs .sb-tab').filter({ hasText: 'index.html' }).first().click();
  await htmlEditor.waitFor({ state: 'visible' });
  const htmlCm = htmlEditor.locator('.CodeMirror');
  if (await htmlCm.count() && await htmlCm.isVisible()) {
    await htmlCm.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('<di');
  } else {
    const htmlTextarea = htmlEditor.locator('textarea.sb-code');
    await htmlTextarea.fill('<di');
    await htmlTextarea.evaluate(el => el.setSelectionRange(el.value.length, el.value.length));
    await page.keyboard.press('Control+Space');
  }
  await page.waitForFunction(() => {
    const popup = document.querySelector('.ac-pop');
    return popup && [...popup.querySelectorAll('.ac-r')].some(row => row.dataset.code === 'div');
  }, undefined, { timeout: 10_000 });
  const tagRows = await page.locator('.ac-pop .ac-r').evaluateAll(rows =>
    rows.filter(row => row.dataset.code).map(row => ({
      code: row.dataset.code,
      note: row.querySelector('.ac-d')?.textContent || ''
    }))
  );
  assert.ok(tagRows.some(row => row.code === 'div' && /контейнер/.test(row.note)),
    'HTML tag context did not offer the Russian-explained div element');
  await page.keyboard.press('Escape');

  const callContexts = await htmlEditor.evaluate(ed => {
    const cm = ed.querySelector('textarea')?.__cm;
    if(!cm) return null;
    const original = cm.getValue();
    const resolve = (language, code) => {
      cm.setValue(code);
      const snapshot = window.CodeLabContext.createSnapshot({
        editor: ed, language, code, cursor: { line: 0, ch: code.length }
      });
      const result = window.CodeLabContext.resolve(snapshot);
      return result && {
        provider: result.provider,
        kind: result.kind,
        expected: result.expected,
        symbol: result.symbol,
        argumentIndex: result.argumentIndex,
        prefix: result.prefix,
        inString: result.inString
      };
    };
    try {
      return {
        javascript: resolve('javascript', 'fetch(url, signal'),
        python: resolve('python', 'open(path, "r'),
        sql: resolve('sql', 'COALESCE(price, 0')
      };
    } finally {
      cm.setValue(original);
    }
  });
  assert.ok(callContexts, 'CodeMirror editor was unavailable for cross-language context checks');
  assert.deepEqual(callContexts.javascript, {
    provider: 'call-arguments', kind: 'call-argument', expected: 'argument',
    symbol: 'fetch', argumentIndex: 1, prefix: 'signal', inString: false
  }, 'JavaScript call argument did not resolve through the shared context contract');
  assert.deepEqual(callContexts.python, {
    provider: 'call-arguments', kind: 'call-argument', expected: 'argument-value',
    symbol: 'open', argumentIndex: 1, prefix: 'r', inString: true
  }, 'Python quoted argument did not resolve through the shared context contract');
  assert.deepEqual(callContexts.sql, {
    provider: 'call-arguments', kind: 'call-argument', expected: 'argument',
    symbol: 'COALESCE', argumentIndex: 1, prefix: '0', inString: false
  }, 'SQL function argument did not resolve through the shared context contract');

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
