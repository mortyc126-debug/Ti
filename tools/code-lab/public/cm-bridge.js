// Прослойка между страницами и CodeMirror 5.
// Если CodeMirror не установлен, не включён или не загрузился, все функции тихо возвращают null/false,
// а страница остаётся с обычными <textarea> и прежней подсветкой, так что обновление не может её сломать.
//
//   CMBridge.enhance(textarea, 'python')          — превратить textarea в редактор (ta.value работает как раньше)
//   CMBridge.setLang(textarea, 'sql')             — сменить язык подсветки
//   CMBridge.highlightInto(element, code, 'js')   — раскрасить код в элементе (без редактора)
//   CMBridge.destroy(textarea)                    — вернуть обычный textarea
(function () {
  'use strict';
  var cfg = { version: null };                 // vendor-test.html задаёт проверяемую версию до первого ready()
  var st = { ready: null, version: null, modes: {}, files: {} };
  var ALIAS = { javascript: 'js', mjs: 'js', cjs: 'js', jsx: 'js', typescript: 'ts', tsx: 'ts', py: 'python', rb: 'ruby',
    sh: 'bash', shell: 'bash', ps1: 'powershell', htm: 'html', pl: 'perl', rscript: 'r' };

  function norm(lang) { var l = String(lang == null ? '' : lang).toLowerCase().trim(); return ALIAS[l] || l; }
  function warn() { try { console.warn.apply(console, ['[CMBridge]'].concat([].slice.call(arguments))); } catch (e) {} }

  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = src; s.async = false;
      s.onload = function () { res(); }; s.onerror = function () { rej(new Error('не загрузился ' + src)); };
      document.head.appendChild(s);
    });
  }
  function loadCss(href) {
    return new Promise(function (res, rej) {
      var l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href;
      l.onload = function () { res(); }; l.onerror = function () { rej(new Error('не загрузился ' + href)); };
      document.head.appendChild(l);
    });
  }

  // цвета: тёмная или светлая палитра выбирается по фону страницы
  function isDark() {
    try {
      var c = getComputedStyle(document.body).backgroundColor, m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
      if (!m) return true;
      return (0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3]) < 128;
    } catch (e) { return true; }
  }
  function injectTheme() {
    if (document.getElementById('cm-bridge-theme')) return;
    var dark = isDark();
    var css = '.CodeMirror{height:auto;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;border:1px solid var(--border,' + (dark ? '#241638' : '#d0d7de') + ');border-radius:8px;' +
      'background:var(--bg2,' + (dark ? '#140A24' : '#fff') + ');color:var(--text,' + (dark ? '#F6F4FF' : '#1f2328') + ')}' +
      '.CodeMirror-scroll{min-height:9em;max-height:65vh}.CodeMirror-gutters{background:transparent;border-right:1px solid var(--border,' + (dark ? '#241638' : '#d0d7de') + ')}' +
      '.CodeMirror-linenumber{color:' + (dark ? '#6f6490' : '#8c959f') + '}.CodeMirror-focused{outline:1px solid var(--acc,#7c4dff)}';
    if (dark) {
      css += '.CodeMirror-cursor{border-left:1px solid #fff}.CodeMirror-selected{background:#49305f!important}.CodeMirror-matchingbracket{color:#52F2C9!important;text-decoration:underline}' +
        '.cm-s-default .cm-keyword{color:#c792ea}.cm-s-default .cm-def{color:#82aaff}.cm-s-default .cm-string,.cm-s-default .cm-string-2{color:#c3e88d}' +
        '.cm-s-default .cm-number,.cm-s-default .cm-atom{color:#f78c6c}.cm-s-default .cm-comment{color:#7f7a99;font-style:italic}' +
        '.cm-s-default .cm-variable-2,.cm-s-default .cm-qualifier,.cm-s-default .cm-attribute{color:#ffcb6b}.cm-s-default .cm-variable-3,.cm-s-default .cm-type,.cm-s-default .cm-operator{color:#89ddff}' +
        '.cm-s-default .cm-property,.cm-s-default .cm-builtin{color:#82aaff}.cm-s-default .cm-tag{color:#ff5370}.cm-s-default .cm-meta{color:#9d95bb}' +
        '.cm-s-default .cm-bracket,.cm-s-default .cm-punctuation{color:#b9b0d6}.cm-s-default .cm-variable{color:inherit}';
    }
    var s = document.createElement('style'); s.id = 'cm-bridge-theme'; s.textContent = css; document.head.appendChild(s);
  }

  function ready() {
    if (st.ready) return st.ready;
    st.ready = (function () {
      return fetch('/api/vendor/active', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (info) {
        var v = cfg.version || info.version;
        if (!v) return false;                                   // редактор не установлен или выключен — запасной вариант
        st.modes = info.modes || {};
        var base = '/vendor/cm/' + v + '/';
        return loadCss(base + 'lib/codemirror.css')
          .then(function () { return loadScript(base + 'lib/codemirror.js'); })
          .then(function () { return loadScript(base + 'addon/runmode/runmode.js'); })
          .then(function () { return loadScript(base + 'addon/edit/matchbrackets.js').catch(function () {}); })
          .then(function () { st.version = v; st.base = base; injectTheme(); return true; });
      }).catch(function (e) { warn('редактор недоступен, работаю без него:', e && e.message || e); return false; });
    })();
    return st.ready;
  }

  // режим для языка; файлы режимов грузятся по одному разу и в нужном порядке
  function loadMode(lang) {
    return ready().then(function (ok) {
      if (!ok) return null;
      var spec = st.modes[norm(lang)];
      if (!spec) return null;
      var chain = Promise.resolve();
      spec.files.forEach(function (f) {
        chain = chain.then(function () {
          if (!st.files[f]) st.files[f] = loadScript(st.base + 'mode/' + f + '/' + f + '.js');
          return st.files[f];
        });
      });
      return chain.then(function () { return spec.mode; }).catch(function (e) { warn('режим не загрузился:', e && e.message || e); return null; });
    });
  }

  function enhance(ta, lang, opts) {
    if (!ta || ta.tagName !== 'TEXTAREA') return Promise.resolve(null);
    if (ta.__cm) return Promise.resolve(ta.__cm);
    ta.__cmLang = lang;
    return loadMode(lang).then(function (mode) {
      if (ta.__cm) return ta.__cm;
      if (!st.version || !window.CodeMirror || !ta.isConnected) return null;
      if (ta.__cmLang !== lang) return loadMode(ta.__cmLang).then(function (m2) { return build(ta, m2, opts); });
      return build(ta, mode, opts);
    }).catch(function (e) { warn('enhance не удался, оставляю обычное поле:', e && e.message || e); return null; });
  }

  function build(ta, mode, opts) {
    if (ta.__cm) return ta.__cm;
    var cm = CodeMirror.fromTextArea(ta, Object.assign({
      lineNumbers: true, mode: mode || 'null', indentUnit: 2, tabSize: 2, indentWithTabs: false, lineWrapping: false,
      matchBrackets: !!(CodeMirror.optionHandlers && CodeMirror.optionHandlers.matchBrackets),
      extraKeys: { Tab: function (c) { if (c.somethingSelected()) c.execCommand('indentMore'); else c.execCommand('insertSoftTab'); },
                   'Shift-Tab': function (c) { c.execCommand('indentLess'); } }
    }, opts || {}));
    // прозрачность: остальной код продолжает читать и писать ta.value, а редактор остаётся в курсе
    Object.defineProperty(ta, 'value', {
      configurable: true,
      get: function () { return cm.getValue(); },
      set: function (v) { v = v == null ? '' : String(v); if (v !== cm.getValue()) cm.setValue(v); }
    });
    ta.focus = function () { cm.focus(); };
    cm.on('change', function () { try { ta.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {} });
    ta.__cm = cm;
    return cm;
  }

  function setLang(target, lang) {
    var ta = target && target.getTextArea ? target.getTextArea() : target;
    if (ta) ta.__cmLang = lang;
    var cm = (ta && ta.__cm) || (target && target.setOption ? target : null);
    if (!cm) return Promise.resolve(false);                      // редактор ещё создаётся: enhance сам возьмёт свежий язык
    return loadMode(lang).then(function (mode) { cm.setOption('mode', mode || 'null'); return true; }).catch(function () { return false; });
  }

  function highlightInto(el, code, lang) {
    return loadMode(lang).then(function (mode) {
      if (!el || !window.CodeMirror || !CodeMirror.runMode) return false;
      el.textContent = '';
      if (!el.classList.contains('cm-s-default')) el.classList.add('cm-s-default');
      CodeMirror.runMode(String(code == null ? '' : code), mode || 'null', el);
      return true;
    }).catch(function () { return false; });
  }

  function destroy(ta) {
    var cm = ta && ta.__cm; if (!cm) return false;
    var val = cm.getValue(); delete ta.value; delete ta.focus;
    cm.toTextArea(); ta.value = val; ta.__cm = null; return true;
  }

  window.CMBridge = {
    configure: function (o) { if (st.ready) return false; if (o && o.version) cfg.version = String(o.version); return true; },
    ready: ready, loadMode: loadMode, enhance: enhance, setLang: setLang, highlightInto: highlightInto, destroy: destroy,
    version: function () { return st.version; }, normLang: norm
  };
})();
