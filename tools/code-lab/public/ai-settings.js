// Окно «Настройки»: провайдеры ИИ и их ключи (Mistral, GigaChat, любой OpenAI-совместимый).
// Ключи хранятся только в этом браузере (localStorage). На сервер уходят в заголовке запроса,
// а не в файлы. Ключ активного провайдера дублируется в старый ключ codeLab.mistralApiKey,
// поэтому остальные страницы (Опись, «создать куски», страница куска) работают без изменений.
(() => {
  const panel = document.querySelector('#lab-mistral-settings .panel');
  if (!panel || panel.dataset.aiProviders) return;
  panel.dataset.aiProviders = '1';

  const STORE = 'codeLab.aiProviders', OLD_KEY = 'codeLab.mistralApiKey';
  const TYPES = {
    mistral:  { label: 'Mistral',  model: 'mistral-small-latest', hint: 'Ключ берётся в личном кабинете Mistral (La Plateforme).' },
    gigachat: { label: 'GigaChat', model: 'GigaChat', hint: 'Нужен «ключ авторизации» из проекта GigaChat API в Studio. Его показывают один раз при создании. Токен доступа сервер получает и обновляет сам.' },
    openai:   { label: 'OpenAI-совместимый', model: '', hint: 'Любой сервис с адресом вида …/v1 (OpenAI, OpenRouter, локальный LM Studio или Ollama).' },
  };
  const uid = () => 'p' + Math.random().toString(36).slice(2, 9);
  const mask = k => !k ? 'ключа нет' : '••••' + String(k).slice(-4);

  // ── состояние ──
  let st = { active: null, items: [] };
  try { const s = JSON.parse(localStorage.getItem(STORE) || 'null'); if (s && Array.isArray(s.items)) st = s; } catch {}
  if (!st.items.length) {                                    // перенос старого ключа Mistral
    let old = ''; try { old = localStorage.getItem(OLD_KEY) || ''; } catch {}
    if (old) { const it = { id: uid(), type: 'mistral', name: 'Mistral', key: old, model: '', baseUrl: '', scope: '' }; st = { active: it.id, items: [it] }; }
  }
  const active = () => st.items.find(i => i.id === st.active) || null;
  const persist = () => {
    try {
      localStorage.setItem(STORE, JSON.stringify(st));
      const a = active();
      if (a && a.key) localStorage.setItem(OLD_KEY, a.key); else localStorage.removeItem(OLD_KEY);
    } catch {}
  };
  const post = (url, body, key) => fetch(url, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Code-Lab': '1', ...(key ? { 'X-Mistral-API-Key': key } : {}) },
    body: JSON.stringify(body || {}) }).then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; });
  const syncServer = () => { const a = active(); return a ? post('/api/ai/config', { type: a.type, model: a.model || '', baseUrl: a.baseUrl || '', scope: a.scope || '' }).catch(e => setStatus('Не удалось передать настройки серверу: ' + e.message, true)) : Promise.resolve(); };

  // ── мелкий помощник для DOM (пользовательский текст идёт только через textContent) ──
  const h = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v); }
    kids.flat().forEach(c => e.append(c instanceof Node ? c : document.createTextNode(String(c))));
    return e;
  };

  // Всё рисуется ТОЛЬКО в свой контейнер. Панель .panel и вкладки «API / Стиль» (theme.js) не трогаем:
  // theme.js переносит содержимое панели во вкладку «API» и следит за ней, так что замена содержимого панели ломает окно.
  const root = h('div', { id: 'ais-root' });
  panel.append(root);
  function hideLegacy() {                                               // прежний экран с одним полем ключа Mistral
    const pane = panel.querySelector('.st-pane:not(.th-emb)') || panel; // вкладка «API», если вкладки уже построены
    [...pane.children].forEach(c => { if (c !== root && !c.contains(root)) { c.hidden = true; c.style.display = 'none'; } });
  }
  hideLegacy();
  window.addEventListener('load', hideLegacy);
  setTimeout(hideLegacy, 400);

  // ── стили ──
  if (!document.getElementById('ai-settings-css')) document.head.append(h('style', { id: 'ai-settings-css' }, `
    #ais-root .ais-card{display:flex;align-items:center;gap:10px;border:1px solid var(--border,#49305f);border-radius:10px;padding:9px 11px;margin:7px 0;background:var(--bg,#0d0716)}
    #ais-root .ais-card.on{border-color:var(--acc,#8a55c8);background:var(--s2,#1d1030)}
    #ais-root .ais-card .nm{flex:1;min-width:0}#ais-root .ais-card .nm b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #ais-root .ais-card .nm span{color:var(--text3,#bca9d8);font-size:12px}
    #ais-root .ais-form{border:1px dashed var(--border,#51336e);border-radius:10px;padding:11px;margin:9px 0}
    #ais-root .ais-form label{display:block;margin:8px 0 3px;font-size:12.5px;color:var(--text2,#d9c9f1)}
    #ais-root .ais-form input,#ais-root .ais-form select{box-sizing:border-box;width:100%;background:var(--bg,#0d0716);color:var(--text,#fff);border:1px solid var(--border,#49305f);border-radius:8px;padding:9px}
    #ais-root .ais-form .row{display:flex;gap:8px}#ais-root .ais-form .row>*{flex:1}
    #ais-root .ais-note{color:var(--text3,#bca9d8);font-size:12.5px;line-height:1.45;margin:6px 0}
    #ais-root .ais-err{color:#ff9a9a}#ais-root .ais-ok{color:#8df0c9}
    #ais-root .ais-tls{margin-top:10px;font-size:13px}#ais-root .ais-tls summary{cursor:pointer;color:var(--text2,#d9c9f1)}
    #ais-root .danger{border-color:#7a3340;background:#3a1620}
    #lab-mistral-settings .svc{display:none}   /* старую карточку ключа Mistral (её строит theme.js) заменяет этот список */
  `));

  let editing = null;      // null | 'new' | id
  let models = [];
  const status = h('p', { id: 'ais-status', 'aria-live': 'polite' });
  function setStatus(t, err, ok) { status.textContent = t || ''; status.className = err ? 'ais-err' : ok ? 'ais-ok' : ''; }

  // ── форма добавления / правки ──
  function form(it) {
    const isNew = !it;
    const cur = it || { type: 'mistral', name: '', key: '', model: '', baseUrl: '', scope: '' };
    const type = h('select', {}, Object.entries(TYPES).map(([v, t]) => h('option', { value: v, selected: v === cur.type }, t.label)));
    const name = h('input', { value: cur.name || '', placeholder: 'например: GigaChat личный', maxlength: 60 });
    const key = h('input', { type: 'password', autocomplete: 'off', placeholder: isNew ? 'вставь ключ' : 'оставь пустым, чтобы не менять', spellcheck: 'false' });
    const show = h('button', { type: 'button', onclick: () => { key.type = key.type === 'password' ? 'text' : 'password'; show.textContent = key.type === 'password' ? 'показать' : 'скрыть'; } }, 'показать');
    const modelList = h('datalist', { id: 'ais-models' });
    const model = h('input', { value: cur.model || '', list: 'ais-models', placeholder: '' });
    const base = h('input', { value: cur.baseUrl || '', placeholder: '' });
    const scope = h('input', { value: cur.scope || '', placeholder: 'GIGACHAT_API_PERS' });
    const hint = h('p', { class: 'ais-note' });
    const baseRow = h('div'), scopeRow = h('div');
    baseRow.append(h('label', {}, 'Адрес API'), base); scopeRow.append(h('label', {}, 'Scope (версия API)'), scope);

    const refresh = () => {
      const t = TYPES[type.value];
      hint.textContent = t.hint;
      model.placeholder = t.model || 'название модели';
      base.placeholder = type.value === 'gigachat' ? 'https://api.giga.chat/v1' : type.value === 'mistral' ? 'https://api.mistral.ai/v1 (менять не нужно)' : 'https://api.openai.com/v1';
      baseRow.style.display = type.value === 'mistral' ? 'none' : '';
      scopeRow.style.display = type.value === 'gigachat' ? '' : 'none';
      if (!name.value || Object.values(TYPES).some(x => x.label === name.value)) name.value = t.label;
    };
    type.addEventListener('change', refresh); refresh();

    const draft = () => ({ type: type.value, model: model.value.trim(), baseUrl: base.value.trim(), scope: scope.value.trim() });
    const keyNow = () => key.value.trim() || (it ? it.key : '');

    const check = h('button', { type: 'button', onclick: async () => {
      const k = keyNow(); if (!k) return setStatus('Сначала введи ключ.', true);
      setStatus('Проверяю ключ и загружаю список моделей…');
      try {
        const r = await post('/api/ai/models', draft(), k);
        models = r.models || []; modelList.replaceChildren(...models.map(m => h('option', { value: m })));
        setStatus(`Ключ работает. Моделей доступно: ${models.length}. Выбери из списка в поле «Модель».`, false, true);
      } catch (e) { setStatus('Ошибка: ' + e.message, true); }
    } }, 'Проверить ключ');

    const saveBtn = h('button', { type: 'button', class: 'primary', onclick: () => {
      const k = keyNow(); if (!k) return setStatus('Нужен ключ.', true);
      const d = draft(); if (d.type === 'openai' && !d.baseUrl) return setStatus('Для этого типа нужен адрес API.', true);
      const rec = { ...(it || { id: uid() }), ...d, name: name.value.trim() || TYPES[d.type].label, key: k };
      if (isNew) { st.items.push(rec); if (!st.active) st.active = rec.id; } else st.items = st.items.map(x => x.id === rec.id ? rec : x);
      persist(); syncServer(); editing = null; setStatus('Сохранено.', false, true); render();
    } }, 'Сохранить');
    const cancel = h('button', { type: 'button', onclick: () => { editing = null; setStatus(''); render(); } }, 'Отмена');

    return h('div', { class: 'ais-form' },
      h('label', {}, 'Сервис'), type,
      h('label', {}, 'Название в списке'), name,
      h('label', {}, 'Ключ'), h('div', { class: 'row' }, key, h('div', { style: 'flex:none' }, show)),
      hint, baseRow, scopeRow,
      h('label', {}, 'Модель (можно оставить пустой — возьмётся стандартная)'), model, modelList,
      h('div', { style: 'margin-top:10px' }, saveBtn, check, cancel));
  }

  // ── сертификат Минцифры для GigaChat (хранится на сервере, это не секрет) ──
  function tlsBox() {
    const ca = h('input', { placeholder: 'C:\\certs\\russian_trusted_root_ca.pem' });
    const insecure = h('input', { type: 'checkbox' });
    const msg = h('div', { class: 'ais-note' });
    fetch('/api/ai/config').then(r => r.json()).then(j => { ca.value = (j.config && j.config.caPath) || ''; insecure.checked = !!(j.config && j.config.insecureTls); }).catch(() => {});
    const save = h('button', { type: 'button', onclick: async () => {
      try { await post('/api/ai/config', { caPath: ca.value.trim(), insecureTls: insecure.checked }); msg.textContent = 'Сохранено.'; msg.className = 'ais-note ais-ok'; }
      catch (e) { msg.textContent = 'Ошибка: ' + e.message; msg.className = 'ais-note ais-err'; }
    } }, 'Сохранить сертификат');
    return h('details', { class: 'ais-tls' }, h('summary', {}, 'GigaChat: сертификат Минцифры'),
      h('p', { class: 'ais-note' }, 'Серверы Сбера подписаны корневым сертификатом Минцифры. Если проверка ключа пишет «ошибка сертификата», скачай этот сертификат со страницы документации Сбера и укажи здесь путь к файлу .pem.'),
      h('label', { class: 'ais-note' }, 'Путь к файлу сертификата'), ca,
      h('label', { class: 'ais-note' }, insecure, ' не проверять сертификат вообще (небезопасно, только если иначе не работает)'),
      save, msg);
  }

  // ── редактор кода (CodeMirror): статус и вход на страницу управления версиями ──
  function editorBox() {
    const state = h('span', {}, 'проверяю…');
    fetch('/api/vendor/active').then(r => r.json()).then(j => {
      state.textContent = j && j.version ? 'установлен и включён: CodeMirror ' + j.version : 'не установлен или выключен: в песочнице остаётся простое поле без номеров строк';
      state.className = j && j.version ? 'ais-ok' : 'ais-err';
    }).catch(() => { state.textContent = 'сервер не ответил'; state.className = 'ais-err'; });
    return h('div', { class: 'ais-form' },
      h('b', {}, 'Редактор кода (CodeMirror)'),
      h('p', { class: 'ais-note' }, state),
      h('a', { href: '/vendor.html', target: '_blank', rel: 'noopener' }, 'Установить, включить, откатить версию →'));
  }

  // ── главный экран ──
  function render() {
    const list = st.items.length ? st.items.map(it => h('div', { class: 'ais-card' + (it.id === st.active ? ' on' : '') },
      h('input', { type: 'radio', name: 'ais-active', checked: it.id === st.active, title: 'использовать этот', onchange: () => { st.active = it.id; persist(); syncServer(); setStatus(`Теперь используется: ${it.name}.`, false, true); render(); } }),
      h('div', { class: 'nm' }, h('b', {}, it.name), h('span', {}, `${TYPES[it.type]?.label || it.type} · ${mask(it.key)}${it.model ? ' · ' + it.model : ''}`)),
      h('button', { type: 'button', onclick: () => { editing = it.id; setStatus(''); render(); } }, 'Изменить'),
      h('button', { type: 'button', class: 'danger', onclick: () => {
        if (!confirm(`Удалить «${it.name}» и его ключ из этого браузера?`)) return;
        st.items = st.items.filter(x => x.id !== it.id);
        if (st.active === it.id) st.active = st.items[0]?.id || null;
        persist(); syncServer(); editing = null; setStatus('Удалено.', false, true); render();
      } }, 'Удалить')))
      : [h('p', { class: 'ais-note' }, 'Пока нет ни одного ключа. Добавь Mistral, GigaChat или другой сервис.')];

    const body = [
      h('h2', {}, 'Сервисы и ключи'),
      h('p', { class: 'ais-note' }, 'Ключи хранятся только в этом браузере. Сервер получает ключ вместе с запросом и в файлы его не пишет. Отмеченный сервис используется для описаний, пояснений и создания кусков.'),
      ...list,
      editing === 'new' ? form(null) : editing ? form(st.items.find(i => i.id === editing)) : h('button', { type: 'button', class: 'primary', onclick: () => { editing = 'new'; setStatus(''); render(); } }, '+ Добавить ключ'),
      editorBox(), tlsBox(), status,
      h('div', { style: 'margin-top:8px' }, h('button', { type: 'button', onclick: () => { document.getElementById('lab-mistral-settings').style.display = 'none'; } }, 'Закрыть'))
    ];
    root.replaceChildren(...body);
  }

  persist();            // перенос старого ключа и выравнивание codeLab.mistralApiKey
  syncServer();         // сервер узнаёт, какой сервис выбран (без ключа)
  render();
})();
