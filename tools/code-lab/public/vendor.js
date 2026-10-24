// Управление версиями CodeMirror: проверить → скачать → проверить на библиотеке → включить / откатить.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var S = null, busy = false, allowYoung = {};

  function h(tag, attrs) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { if (k === 'onclick') el.onclick = attrs[k]; else if (k === 'class') el.className = attrs[k]; else if (attrs[k] != null) el.setAttribute(k, attrs[k]); });
    for (var i = 2; i < arguments.length; i++) { var c = arguments[i]; if (c == null || c === false) continue; el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }
    return el;
  }
  var msg = function (t, cls) { var m = $('msg'); m.textContent = t; m.className = cls || ''; };
  var fmtDate = function (iso) { return iso ? new Date(iso).toLocaleDateString('ru-RU') : 'неизвестна'; };
  var fmtDT = function (iso) { return iso ? new Date(iso).toLocaleString('ru-RU') : ''; };
  var mb = function (n) { return (n / 1048576).toFixed(1) + ' МБ'; };

  function api(path, body) {
    var opt = body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Code-Lab': '1' }, body: JSON.stringify(body) };
    return fetch(path, opt).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.error || ('HTTP ' + r.status)); e.code = j.code; throw e; } return j; }); });
  }
  function run(label, fn) {
    if (busy) return Promise.resolve();
    busy = true; msg(label + '…'); render();
    return fn().catch(function (e) { msg('Ошибка: ' + e.message, 'bad'); })
      .then(function () { busy = false; return load(); });
  }

  function load() { return api('/api/vendor/status').then(function (s) { S = s; render(); }).catch(function (e) { msg('Сервер не отвечает: ' + e.message, 'bad'); }); }

  // проверка на библиотеке: скрытое окно, у которого своя версия CodeMirror (не мешает другим)
  function runTest(version) {
    return new Promise(function (resolve) {
      var fr = document.createElement('iframe'); fr.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
      var done = false, timer;
      function fin(ok) { if (done) return; done = true; clearTimeout(timer); window.removeEventListener('message', onMsg); fr.remove(); resolve(ok); }
      function onMsg(e) { if (e.origin === location.origin && e.data && e.data.type === 'vendor-test' && e.data.version === version) fin(e.data.ok); }
      window.addEventListener('message', onMsg);
      timer = setTimeout(function () { fin(false); }, 180000);
      fr.src = '/vendor-test.html?v=' + encodeURIComponent(version);
      document.body.appendChild(fr);
    });
  }
  function testVersion(version) { return run('Проверяю версию ' + version + ' на вашей библиотеке', function () { return runTest(version).then(function (ok) { msg(ok ? 'Версия ' + version + ': проверка пройдена. Можно включать.' : 'Версия ' + version + ': проверка не пройдена, подробности в таблице.', ok ? 'ok' : 'bad'); }); }); }

  function render() {
    if (!S) return;
    var act = S.active;
    // --- сейчас ---
    var now = $('now'); now.textContent = '';
    now.appendChild(h('div', {}, act ? h('span', { class: 'ok' }, 'Включён: CodeMirror ' + act) : h('span', { class: 'warn' }, 'Не включён'),
      act ? '' : '. Страницы работают со своими обычными полями ввода.'));
    var prev = S.previous[0];
    if (act) now.appendChild(h('button', { disabled: busy || !prev ? 'disabled' : null, onclick: function () { run('Откатываю на ' + prev, function () { return api('/api/vendor/rollback', {}).then(function (r) { msg('Включена версия ' + r.active, 'ok'); }); }); } }, prev ? 'Откатить на ' + prev : 'Откатить (нет предыдущей версии)'));
    if (act) now.appendChild(h('button', { disabled: busy ? 'disabled' : null, onclick: function () { run('Выключаю редактор', function () { return api('/api/vendor/deactivate', {}).then(function () { msg('Редактор выключен: страницы вернулись к обычным полям.', 'ok'); }); }); } }, 'Выключить редактор'));
    if (S.busy) now.appendChild(h('div', { class: 'mut' }, 'Сервер занят: ' + S.busy));

    // --- установленные ---
    var box = $('installed'); box.textContent = '';
    if (!S.installed.length) box.appendChild(h('div', { class: 'card mut' }, 'Пока ничего не установлено. Нажмите «Проверить обновления», потом «Скачать».'));
    S.installed.forEach(function (v) {
      var t = v.test, canOn = !busy && !v.isActive && t && t.ok;
      var card = h('div', { class: 'card' });
      card.appendChild(h('div', {}, h('b', {}, 'CodeMirror ' + v.version), ' ', v.isActive ? h('span', { class: 'pill ok' }, 'активная') : null,
        h('span', { class: 'mut' }, ' · опубликована ' + fmtDate(v.published) + ' · файлов ' + v.fileCount + ' · ' + mb(v.bytes || 0) + ' · хэш ' + v.integrity)));
      var st = h('div', {});
      if (!t) st.appendChild(h('span', { class: 'warn' }, 'Проверка на вашей библиотеке ещё не запускалась'));
      else if (t.ok) st.appendChild(h('span', { class: 'ok' }, '✓ проверка пройдена ' + fmtDT(t.at) + ': кусков ' + t.entries + ', ' + t.ms + ' мс'));
      else st.appendChild(h('span', { class: 'bad' }, '✗ проверка не пройдена ' + fmtDT(t.at)));
      card.appendChild(st);
      if (t && (t.errors.length || t.missingModes.length || t.warnings.length)) {
        var d = h('details', {}, h('summary', {}, 'Подробности проверки'));
        if (t.missingModes.length) d.appendChild(h('div', { class: 'bad' }, 'Нет режимов: ' + t.missingModes.join(', ')));
        t.errors.forEach(function (e) { d.appendChild(h('div', { class: 'bad' }, e.id + ': ' + e.msg)); });
        t.warnings.forEach(function (w) { d.appendChild(h('div', { class: 'warn' }, w)); });
        card.appendChild(d);
      }
      if (v.modesMissing.length) card.appendChild(h('div', { class: 'bad' }, 'В этой версии нет файлов режимов для: ' + v.modesMissing.join(', ')));
      var row = h('div', {});
      row.appendChild(h('button', { disabled: busy ? 'disabled' : null, onclick: function () { testVersion(v.version); } }, 'Проверить на библиотеке'));
      row.appendChild(h('button', { class: canOn ? 'primary' : '', disabled: canOn ? null : 'disabled', title: v.isActive ? 'Уже включена' : (t && t.ok ? '' : 'Сначала успешная проверка'), onclick: function () { run('Включаю ' + v.version, function () { return api('/api/vendor/activate', { version: v.version }).then(function () { msg('Включена версия ' + v.version + '. Обновите страницы библиотеки (Ctrl+F5).', 'ok'); }); }); } }, 'Включить'));
      row.appendChild(h('button', { disabled: busy ? 'disabled' : null, onclick: function () { run('Сверяю файлы ' + v.version, function () { return api('/api/vendor/verify', { version: v.version }).then(function (r) { msg(r.ok ? 'Файлы версии ' + v.version + ' целы (' + r.files + ' шт.).' : 'Файлы изменены или повреждены: ' + r.problems.join('; '), r.ok ? 'ok' : 'bad'); }); }); } }, 'Сверить файлы'));
      row.appendChild(h('button', { disabled: busy || v.isActive ? 'disabled' : null, onclick: function () { if (confirm('Удалить версию ' + v.version + ' с диска?')) run('Удаляю ' + v.version, function () { return api('/api/vendor/remove', { version: v.version }).then(function () { msg('Версия ' + v.version + ' удалена.', 'ok'); }); }); } }, 'Удалить'));
      card.appendChild(row); box.appendChild(card);
    });

    // --- обновления ---
    $('btn-check').disabled = busy;
    var res = $('check-result'); res.textContent = '';
    var lc = S.lastCheck, lg = S.lastGood;
    if (lc && !lc.ok) res.appendChild(h('div', { class: 'bad' }, 'Последняя проверка (' + fmtDT(lc.at) + ') не удалась: ' + lc.error + '. Приложение продолжает работать с установленными версиями.'));
    if (lg) {
      res.appendChild(h('div', { class: 'mut' }, 'Данные реестра на ' + fmtDT(lg.at) + '. Последняя версия ветки 5.x: ' + lg.latest + '.'));
      if (!lg.candidates.length) res.appendChild(h('div', { class: 'ok' }, 'Новых версий нет.'));
      lg.candidates.forEach(function (c) {
        var cb = null;
        var card = h('div', { class: 'card' }, h('b', {}, 'CodeMirror ' + c.version), h('span', { class: 'mut' }, ' · опубликована ' + fmtDate(c.published) + (c.ageDays != null ? ' (' + c.ageDays + ' дн. назад)' : '') + (c.unpackedSize ? ' · ' + mb(c.unpackedSize) : '')));
        if (c.young) {
          cb = h('input', { type: 'checkbox' }); cb.onchange = function () { allowYoung[c.version] = cb.checked; render(); };
          cb.checked = !!allowYoung[c.version];
          card.appendChild(h('div', { class: 'warn' }, 'Версия совсем свежая (меньше ' + S.youngDays + ' дн.): в новых релизах ошибки находят в первые недели. ', h('label', {}, cb, ' всё равно скачать')));
        } else if (c.ageDays == null) card.appendChild(h('div', { class: 'warn' }, 'Дату публикации узнать не удалось, возраст версии неизвестен.'));
        card.appendChild(h('button', { class: 'primary', disabled: busy || (c.young && !allowYoung[c.version]) ? 'disabled' : null, onclick: function () {
          run('Скачиваю ' + c.version, function () { return api('/api/vendor/install', { version: c.version, allowYoung: !!allowYoung[c.version] }); })
            .then(function () { if (S && S.installed.some(function (x) { return x.version === c.version; })) return testVersion(c.version); });
        } }, 'Скачать и проверить'));
        res.appendChild(card);
      });
    }

    // --- языки ---
    var lbox = $('langs'); lbox.textContent = '';
    var ref = S.installed.filter(function (v) { return v.isActive; })[0] || S.installed[0];
    var tbl = h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Язык'), h('th', {}, 'Кусков'), h('th', {}, 'Режим подсветки'), h('th', {}, ref ? 'Файлы режима в ' + ref.version : ''))));
    var tb = h('tbody', {});
    var counts = {}; (S.langs || []).forEach(function (l) { counts[l.lang] = l.count; });
    Object.keys(S.modes).forEach(function (lang) {
      var okm = ref ? ref.modesMissing.indexOf(lang) < 0 : null;
      tb.appendChild(h('tr', {}, h('td', {}, lang), h('td', {}, String(counts[lang] || 0)), h('td', {}, h('code', {}, S.modes[lang].mode)), h('td', { class: okm == null ? 'mut' : okm ? 'ok' : 'bad' }, okm == null ? 'версия не установлена' : okm ? '✓ есть' : '✗ нет файла')));
    });
    var other = (S.langs || []).filter(function (l) { return !S.modes[l.lang]; });
    tbl.appendChild(tb); lbox.appendChild(tbl);
    if (other.length) lbox.appendChild(h('div', { class: 'mut' }, 'Без подсветки (обычный текст): ' + other.map(function (l) { return l.lang + ' (' + l.count + ')'; }).join(', ')));
    lbox.appendChild(h('div', { class: 'mut' }, 'Все режимы входят в пакет версии, докачивать их отдельно не нужно. Если режима нет, значит, его нет в этой версии: такую версию проверка не пропустит.'));
  }

  $('btn-check').onclick = function () {
    run('Проверяю реестр npm', function () { return api('/api/vendor/check', {}).then(function (r) { msg(r.candidates.length ? 'Доступно новых версий: ' + r.candidates.length + '.' : 'Новых версий нет.', r.candidates.length ? 'ok' : ''); }); });
  };
  load().then(function () { if (S) msg(S.active ? 'Готово. Включён CodeMirror ' + S.active + '.' : (S.installed.length ? 'Редактор установлен, но не включён.' : 'Редактор не установлен. Нажмите «Проверить обновления».')); });
})();
