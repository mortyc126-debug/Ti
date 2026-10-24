// Панель «ИИ» на странице «Опись»: создать куски, описать куски без описания, ключ Mistral.
// Всё, что раньше жило в скрытом «Каталоге», теперь здесь. Ничего не пишется в библиотеку
// без явного подтверждения; код предложений нигде не запускается.
(() => {
  const KEY = 'codeLab.mistralApiKey';
  const host = document.querySelector('.inv .lead');
  if (!host) return;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const key = () => { try { return localStorage.getItem(KEY) || ''; } catch (_) { return ''; } };
  const post = async (url, body) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-mistral-api-key': key() }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  };

  // ── стили ──
  const st = document.createElement('style');
  st.textContent = `
  .ai-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0 0 16px;padding:10px 12px;background:var(--bg2);border:1px solid var(--border);border-radius:10px}
  .ai-bar button,.aiw button{background:var(--s2);border:1px solid var(--border);border-radius:7px;color:var(--text);padding:7px 10px;cursor:pointer;font-size:12px}
  .ai-bar button.primary,.aiw button.primary{border-color:rgba(255,0,110,.55);color:var(--acc)}
  .ai-bar button:disabled,.aiw button:disabled{opacity:.45;cursor:wait}
  .ai-st{font-size:12px;color:var(--text3)} .ai-st.bad{color:#FFB18A}
  .aiw{position:fixed;inset:0;background:rgba(5,2,14,.78);display:none;align-items:center;justify-content:center;z-index:100;padding:18px}
  .aiw.open{display:flex}
  .aiw-p{width:min(760px,100%);max-height:90vh;overflow:auto;background:var(--bg2);border:1px solid var(--border);border-radius:14px;padding:20px;box-shadow:0 20px 70px #0008}
  .aiw-p.sm{width:min(480px,100%)} .aiw-p h2{margin:0 0 6px;font-size:17px}
  .gen-lead{font-size:12.5px;color:var(--text2);margin:4px 0 12px}
  .gen-form{display:flex;gap:8px;margin-bottom:8px}.gen-n{width:70px;flex:none}
  .gen-in{width:100%;box-sizing:border-box;background:var(--bg);border:1px solid var(--border);border-radius:7px;color:var(--text);font:13px/1.5 system-ui,sans-serif;padding:7px 10px;margin:0 0 6px}
  .gen-in:focus{outline:none;border-color:var(--name)}
  .gen-bar{display:flex;align-items:center;gap:10px;margin:4px 0 10px}
  .gen-gaps{display:flex;align-items:center;gap:10px;margin:0 0 6px}.gen-gaps button{background:none!important;border:1px dashed var(--border)!important;border-radius:12px!important;color:var(--text2)!important;padding:4px 11px!important}
  .gen-gaps button:hover{color:var(--acc)!important;border-color:var(--acc)!important}
  .gen-chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px}
  .gen-chip{font-size:12px;background:var(--s2)!important;border-radius:12px!important;text-align:left}.gen-chip.on{border-color:var(--str)!important;color:var(--str)!important}
  .gen-card{border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:10px;background:var(--bg)}
  .gen-top{display:flex;gap:8px;align-items:center}.gen-title{font-weight:600}
  .gen-badges{display:flex;flex-wrap:wrap;gap:6px;margin:2px 0 6px}
  .gen-b{font-size:11px;border:1px solid var(--border);border-radius:10px;padding:1px 8px;color:var(--text3)}.gen-b.ok{color:var(--str);border-color:rgba(82,242,201,.4)}.gen-b.bad{color:#FFB18A;border-color:#E8895A}
  .gen-code{font:12.5px/1.5 ui-monospace,monospace;white-space:pre}
  .aiw-act{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
  `;
  document.head.appendChild(st);

  // ── панель ──
  const bar = el('div', 'ai-bar');
  const bGen = el('button', 'primary', '✦ Создать куски через ИИ');
  const bDesc = el('button', '', '✦ Описать все без описания');
  const bKey = el('button', '', '⚙ Ключ Mistral');
  const stat = el('span', 'ai-st', key() ? '' : 'Для работы ИИ сохраните ключ Mistral (⚙).');
  [bGen, bDesc, bKey].forEach(b => b.type = 'button');
  bar.append(bGen, bDesc, bKey, stat);
  host.after(bar);
  const setStat = (t, bad) => { stat.textContent = t || ''; stat.className = 'ai-st' + (bad ? ' bad' : ''); };

  const modal = (html, small) => {
    const w = el('div', 'aiw'); const p = el('section', 'aiw-p' + (small ? ' sm' : '')); p.innerHTML = html; w.appendChild(p);
    w.addEventListener('click', e => { if (e.target === w) w.classList.remove('open'); });
    document.body.appendChild(w); return { w, p, open: () => w.classList.add('open'), close: () => w.classList.remove('open') };
  };
  document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelectorAll('.aiw.open').forEach(x => x.classList.remove('open')); });

  // ── ключ Mistral ──
  const km = modal(`<h2>Ключ Mistral</h2>
    <p class="gen-lead">Хранится только в этом браузере (localStorage) и отправляется локальному серверу при запросах к ИИ. В файлы проекта не записывается. Не используйте на чужом компьютере.</p>
    <input id="aiKeyIn" class="gen-in" type="password" autocomplete="off" spellcheck="false" placeholder="Вставьте API-ключ Mistral">
    <div id="aiKeySt" class="ai-st"></div>
    <div class="aiw-act"><button id="aiKeyDel" type="button">Удалить</button><button id="aiKeyNo" type="button">Закрыть</button><button id="aiKeyOk" class="primary" type="button">Сохранить</button></div>`, true);
  const kin = km.p.querySelector('#aiKeyIn'), kst = km.p.querySelector('#aiKeySt');
  const openKey = () => { kin.value = key(); kst.textContent = key() ? 'Ключ сохранён в этом браузере.' : 'Ключ не задан.'; km.open(); kin.focus(); };
  bKey.onclick = openKey;
  km.p.querySelector('#aiKeyNo').onclick = km.close;
  km.p.querySelector('#aiKeyOk').onclick = () => { const v = kin.value.trim(); try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); kst.textContent = v ? 'Сохранено.' : 'Ключ удалён.'; setStat(v ? '' : 'Для работы ИИ сохраните ключ Mistral (⚙).', !v); setTimeout(km.close, 500); } catch (_) { kst.textContent = 'Браузер не разрешил сохранить ключ.'; } };
  km.p.querySelector('#aiKeyDel').onclick = () => { try { localStorage.removeItem(KEY); } catch (_) {} kin.value = ''; kst.textContent = 'Ключ удалён.'; setStat('Для работы ИИ сохраните ключ Mistral (⚙).', true); };
  const needKey = () => { setStat('Нет ключа Mistral — нажмите «⚙ Ключ Mistral».', true); openKey(); };

  // ── описать все без описания (очередь на сервере) ──
  async function poll() {
    try {
      const j = await fetch('/api/jobs', { headers: { 'x-mistral-api-key': key() }, cache: 'no-store' }).then(r => r.json());
      const busy = j.active || j.queued || j.running;
      setStat('Описано: ' + j.completed + ' из ' + j.total + (j.failed ? ' · ошибок: ' + j.failed : '') + (busy ? ' …' : ' · готово. Обновите страницу, чтобы увидеть.'), !!j.failed && !busy);
      if (busy) setTimeout(poll, 2500); else bDesc.disabled = false;
    } catch (_) { setStat('Сервер недоступен.', true); bDesc.disabled = false; }
  }
  bDesc.onclick = async () => {
    if (!key()) return needKey();
    bDesc.disabled = true; setStat('Ставлю в очередь…');
    try { const r = await post('/api/describe', {}); setStat(r.added ? 'В очереди: ' + r.added : 'Всё уже описано.'); poll(); }
    catch (e) { setStat('⛔ ' + e.message, true); bDesc.disabled = false; }
  };

  // ── создать куски ──
  const gm = modal(`<h2>Создать куски через ИИ</h2>
    <p class="gen-lead">Выберите язык и напишите, что дополнить. ИИ предложит новые куски, которых ещё нет в библиотеке. В библиотеку попадёт только то, что вы отметите. Код не запускается — проверьте его сами.</p>
    <div class="gen-form"><select id="genLang" class="gen-in"></select><input id="genCount" class="gen-in gen-n" type="number" min="1" max="8" value="4" title="сколько кусков предложить"></div>
    <div class="gen-gaps"><button id="genGaps" type="button" title="ИИ посмотрит названия уже имеющихся кусков этого языка и предложит темы, которых не хватает">🔍 что тут не хватает?</button><span id="genGapsHint" class="ai-st"></span></div>
    <div id="genChips" class="gen-chips"></div>
    <textarea id="genTopic" class="gen-in" rows="2" placeholder="что дополнить: «работа со строками», «чтение и запись файлов», «JOIN между таблицами»… (можно оставить пустым)"></textarea>
    <div class="gen-bar"><button id="genGo" class="primary" type="button">предложить</button><span id="genStatus" class="ai-st"></span></div>
    <div id="genList"></div>
    <div class="aiw-act"><button id="genClose" type="button">Закрыть</button><button id="genAdd" class="primary" type="button" style="display:none">добавить отмеченные</button></div>`);
  const $ = id => gm.p.querySelector('#' + id);
  const sel = $('genLang'), topic = $('genTopic'), count = $('genCount'), go = $('genGo'), gst = $('genStatus'), list = $('genList'), add = $('genAdd');
  const chips = $('genChips'), gapsBtn = $('genGaps'), gapsHint = $('genGapsHint');
  let rows = [];
  const gSet = (t, bad) => { gst.textContent = t || ''; gst.className = 'ai-st' + (bad ? ' bad' : ''); };

  bGen.onclick = async () => {
    list.innerHTML = ''; chips.innerHTML = ''; gapsHint.textContent = ''; add.style.display = 'none'; gSet(key() ? '' : 'Нет ключа Mistral — закройте окно и нажмите «⚙ Ключ Mistral».', !key());
    gm.open();
    try {
      const r = await fetch('/api/ai-langs', { cache: 'no-store' }).then(x => x.json());
      const cur = sel.value || 'python'; sel.innerHTML = '';
      Object.entries(r.langs).forEach(([k, name]) => { const o = el('option', '', name + ' — уже ' + (r.counts[k] || 0)); o.value = k; sel.appendChild(o); });
      sel.value = r.langs[cur] ? cur : 'python';
    } catch (_) { gSet('Сервер недоступен.', true); }
    topic.focus();
  };
  $('genClose').onclick = gm.close;
  sel.addEventListener('change', () => { chips.innerHTML = ''; gapsHint.textContent = ''; });

  gapsBtn.onclick = async () => {
    if (!key()) { gSet('Нет ключа Mistral.', true); return; }
    gapsBtn.disabled = true; chips.innerHTML = ''; gapsHint.textContent = 'смотрю, что уже есть…';
    try {
      const r = await post('/api/ai-gaps', { lang: sel.value });
      gapsHint.textContent = r.topics.length ? 'По названиям кусков (код ИИ не читал). Клик — добавить тему в поле.' : 'ИИ не нашёл, что предложить.';
      r.topics.forEach(t => {
        const c = el('button', 'gen-chip', t.topic); c.type = 'button'; c.title = t.why || '';
        c.onclick = () => {
          const parts = topic.value.split(';').map(x => x.trim()).filter(Boolean), i = parts.indexOf(t.topic);
          if (i >= 0) { parts.splice(i, 1); c.classList.remove('on'); } else { parts.push(t.topic); c.classList.add('on'); }
          topic.value = parts.join('; ');
        };
        chips.appendChild(c);
      });
    } catch (e) { gapsHint.textContent = '⛔ ' + e.message; }
    gapsBtn.disabled = false;
  };

  function draw(res) {
    list.innerHTML = ''; rows = [];
    if (!res.pieces.length) { gSet('ИИ ничего не предложил. Уточните тему и попробуйте ещё раз.', true); add.style.display = 'none'; return; }
    gSet('Предложено ' + res.pieces.length + '. Отметьте нужные, поправьте и нажмите «добавить».');
    res.pieces.forEach(p => {
      const card = el('div', 'gen-card'), top = el('div', 'gen-top');
      const keep = document.createElement('input'); keep.type = 'checkbox'; keep.checked = !p.dupOf && p.check.status !== 'error';
      const title = document.createElement('input'); title.className = 'gen-in gen-title'; title.value = p.title;
      top.append(keep, title); card.appendChild(top);
      const badges = el('div', 'gen-badges');
      const b = (t, cls) => badges.appendChild(el('span', 'gen-b ' + (cls || ''), t));
      b(p.check.note, p.check.status === 'ok' ? 'ok' : p.check.status === 'error' ? 'bad' : '');
      if (p.dupOf) b('похоже на уже существующий: ' + p.dupOf, 'bad');
      card.appendChild(badges);
      const group = document.createElement('input'); group.className = 'gen-in'; group.value = p.group; group.placeholder = 'Раздел / Подраздел';
      const desc = document.createElement('textarea'); desc.className = 'gen-in'; desc.rows = 2; desc.value = p.desc; desc.placeholder = 'описание';
      const code = document.createElement('textarea'); code.className = 'gen-in gen-code'; code.rows = Math.min(14, p.code.split('\n').length + 1); code.value = p.code; code.spellcheck = false;
      card.append(group, desc, code); list.appendChild(card);
      rows.push({ keep, title, group, desc, code, p });
    });
    add.style.display = '';
  }
  go.onclick = async () => {
    if (!key()) { gSet('Нет ключа Mistral.', true); return; }
    go.disabled = true; go.textContent = 'думаю…'; list.innerHTML = ''; add.style.display = 'none'; gSet('ИИ пишет куски…');
    try { draw(await post('/api/ai-generate', { lang: sel.value, topic: topic.value, count: Number(count.value) || 4 })); }
    catch (e) { gSet('⛔ ' + e.message, true); }
    go.disabled = false; go.textContent = 'предложить';
  };
  add.onclick = async () => {
    const chosen = rows.filter(r => r.keep.checked).map(r => ({ title: r.title.value, lang: r.p.lang, group: r.group.value, desc: r.desc.value, output: r.p.output, tags: r.p.tags, aliases: r.p.aliases, code: r.code.value }));
    if (!chosen.length) { gSet('Ничего не отмечено.', true); return; }
    add.disabled = true; add.textContent = 'добавляю…';
    try {
      const r = await post('/api/ai-create', { pieces: chosen });
      const skipped = r.skipped.map(s => s.title + ' — ' + s.reason).join('; ');
      gSet('Добавлено: ' + r.created.length + (skipped ? '. Пропущено: ' + skipped : '.') + (r.created.length ? ' Обновляю список…' : ''), !r.created.length);
      if (r.created.length) setTimeout(() => location.reload(), 1200);
    } catch (e) { gSet('⛔ ' + e.message, true); }
    add.disabled = false; add.textContent = 'добавить отмеченные';
  };
})();
