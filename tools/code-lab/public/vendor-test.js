// Проверка выбранной версии CodeMirror на вашей библиотеке. Ничего не меняет: только читает куски
// и прогоняет их через разбор подсветки. Результат отправляется серверу и родительской странице.
(function () {
  'use strict';
  var out = document.getElementById('out');
  function log(t) { out.textContent += t + '\n'; }
  var v = new URLSearchParams(location.search).get('v') || '';
  var R = { ok: false, cmVersion: null, entries: 0, ms: 0, errors: [], missingModes: [], warnings: [] };
  var SAMPLES = {
    js: 'const a = (x) => x * 2; // hi\nfunction f(){ return `t${a(1)}`; }', ts: 'let x: number = 1; interface A { b: string }',
    json: '{"a": [1, 2, {"b": null}]}', css: '.a:hover > b { color: #fff; margin: 0 auto }',
    html: '<div class="a"><script>let x=1<\/script><style>a{b:c}</style></div>', svg: '<svg viewBox="0 0 1 1"><circle r="1"/></svg>',
    sql: 'SELECT a, count(*) FROM t WHERE b = 1 GROUP BY a;', python: 'def f(x):\n    return [i for i in range(x)]  # c',
    bash: 'for f in *.txt; do echo "$f"; done', powershell: 'Get-ChildItem | Where-Object { $_.Length -gt 1 }',
    go: 'func main() { fmt.Println("hi") }', ruby: 'def f(x) = x.map { |i| i * 2 }', php: '<?php echo "hi"; ?><b>x</b>',
    lua: 'local function f(x) return x * 2 end', r: 'f <- function(x) x * 2', perl: 'my @a = map { $_ * 2 } (1..3);'
  };

  async function finish() {
    R.ok = R.errors.length === 0 && R.missingModes.length === 0 && R.cmVersion === v;
    log('\nИтог: ' + (R.ok ? 'ВСЁ В ПОРЯДКЕ' : 'ЕСТЬ ПРОБЛЕМЫ') + ' (кусков: ' + R.entries + ', ' + R.ms + ' мс)');
    try {
      await fetch('/api/vendor/test-result', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Code-Lab': '1' }, body: JSON.stringify({ version: v, result: R }) });
    } catch (e) { log('Не удалось отправить результат серверу: ' + e.message); }
    try { parent.postMessage({ type: 'vendor-test', version: v, ok: R.ok }, location.origin); } catch (e) {}
  }

  async function run() {
    var t0 = performance.now();
    if (!/^5\.\d+\.\d+$/.test(v)) { R.errors.push({ id: '-', msg: 'не указана версия' }); return; }
    log('Версия: ' + v);
    CMBridge.configure({ version: v });
    if (!(await CMBridge.ready())) { R.errors.push({ id: '-', msg: 'CodeMirror ' + v + ' не загрузился' }); return; }
    R.cmVersion = window.CodeMirror && CodeMirror.version;
    log('Загружен CodeMirror ' + R.cmVersion);
    if (R.cmVersion !== v) R.errors.push({ id: '-', msg: 'версия в файле (' + R.cmVersion + ') не совпадает с папкой (' + v + ')' });

    // 1) все режимы, которые знает приложение
    var info = await fetch('/api/vendor/active', { cache: 'no-store' }).then(function (r) { return r.json(); });
    var langs = Object.keys(info.modes || {});
    for (var i = 0; i < langs.length; i++) {
      var mode = await CMBridge.loadMode(langs[i]);
      if (!mode || CodeMirror.getMode({}, mode).name === 'null') R.missingModes.push(langs[i]);
    }
    log('Режимов проверено: ' + langs.length + (R.missingModes.length ? ', нет: ' + R.missingModes.join(', ') : ', все на месте'));

    // 2) настоящие редакторы с примером кода на каждом языке
    var host = document.createElement('div'); document.body.appendChild(host);
    langs.forEach(function (l) {
      try {
        var el = document.createElement('div'); host.appendChild(el);
        var cm = CodeMirror(el, { value: SAMPLES[l] || '', mode: info.modes[l].mode });
        if (cm.getValue() !== (SAMPLES[l] || '')) throw new Error('значение изменилось');
        cm.refresh();
      } catch (e) { R.errors.push({ id: 'редактор ' + l, msg: e.message }); }
    });
    host.remove();

    // 3) прослойка: textarea остаётся «настоящим» (value читается и пишется как раньше)
    try {
      var ta = document.createElement('textarea'); ta.value = 'abc'; document.body.appendChild(ta);
      var cm2 = await CMBridge.enhance(ta, 'js');
      if (!cm2) throw new Error('enhance вернул null');
      if (ta.value !== 'abc') throw new Error('начальное значение потеряно');
      ta.value = 'x = 1'; if (cm2.getValue() !== 'x = 1') throw new Error('запись в ta.value не дошла до редактора');
      cm2.setValue('y = 2'); if (ta.value !== 'y = 2') throw new Error('чтение ta.value не видит правку');
      CMBridge.destroy(ta); if (ta.value !== 'y = 2') throw new Error('после destroy значение потеряно');
      ta.remove();
    } catch (e) { R.errors.push({ id: 'прослойка', msg: e.message }); }

    // 4) ваша библиотека: каждый кусок через разбор подсветки
    var sample = await fetch('/api/vendor/sample', { cache: 'no-store' }).then(function (r) { return r.json(); });
    var list = sample.entries || [];
    for (var j = 0; j < list.length; j++) {
      var e = list[j], md = await CMBridge.loadMode(e.lang);
      R.entries++;
      if (!md) continue;                         // язык без режима (txt и т.п.) — обычный текст
      try {
        var s = performance.now(), n = 0;
        CodeMirror.runMode(e.code, md, function () { n++; });
        var dt = performance.now() - s;
        if (dt > 3000) R.warnings.push('медленный разбор: ' + e.id + ' (' + Math.round(dt) + ' мс)');
      } catch (err) { R.errors.push({ id: e.id, msg: err && err.message || String(err) }); }
      if (j % 25 === 0) log('  разобрано кусков: ' + (j + 1) + ' / ' + list.length);
    }
    R.ms = Math.round(performance.now() - t0);
    if (R.errors.length) log('Ошибки: ' + R.errors.slice(0, 5).map(function (x) { return x.id + ': ' + x.msg; }).join(' | '));
  }

  run().catch(function (e) { R.errors.push({ id: '-', msg: 'сбой проверки: ' + (e && e.message || e) }); }).then(function () { if (!R.ms) R.ms = 0; return finish(); });
})();
