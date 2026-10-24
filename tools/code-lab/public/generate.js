// «Создать куски через ИИ»: выбираешь язык и тему → ИИ предлагает куски → отмечаешь/правишь → «добавить».
// Пока не нажато «добавить», в библиотеку ничего не пишется, а код предложений нигде не запускается.
(() => {
  const KEY = 'codeLab.mistralApiKey';
  const modal = document.getElementById('genModal');
  if (!modal) return;
  const $ = id => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const key = () => { try { return localStorage.getItem(KEY) || ''; } catch (_) { return ''; } };
  const post = async (url, body) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-mistral-api-key': key() }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  };
  const sel = $('genLang'), topic = $('genTopic'), count = $('genCount'), go = $('genGo'), status = $('genStatus'), list = $('genList'), add = $('genAdd');
  let rows = [];   // { keep, title, group, desc, code, lang, ... }

  const setStatus = (t, bad) => { status.textContent = t || ''; status.style.color = bad ? '#FFB18A' : ''; };
  const open = async () => {
    modal.classList.add('open'); list.innerHTML = ''; add.style.display = 'none'; setStatus(key() ? '' : 'Нет ключа Mistral: сохраните его в ⚙ Настройки.', !key());
    try {
      const r = await fetch('/api/ai-langs', { cache: 'no-store' }).then(x => x.json());
      const cur = sel.value || 'python'; sel.innerHTML = '';
      Object.entries(r.langs).forEach(([k, name]) => { const o = el('option', '', name + ' — уже ' + (r.counts[k] || 0)); o.value = k; sel.appendChild(o); });
      sel.value = r.langs[cur] ? cur : 'python';
    } catch (_) { setStatus('Сервер недоступен.', true); }
    topic.focus();
  };
  const close = () => modal.classList.remove('open');

  function draw(res) {
    list.innerHTML = ''; rows = [];
    if (!res.pieces.length) { setStatus('ИИ ничего не предложил. Уточните тему и попробуйте ещё раз.', true); add.style.display = 'none'; return; }
    setStatus('Предложено ' + res.pieces.length + '. Отметьте нужные, поправьте и нажмите «добавить». Код не запускался — проверьте сами.');
    res.pieces.forEach(p => {
      const card = el('div', 'gen-card');
      const top = el('div', 'gen-top');
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
      card.append(group, desc, code);
      list.appendChild(card);
      rows.push({ keep, title, group, desc, code, p });
    });
    add.style.display = '';
  }

  go.onclick = async () => {
    if (!key()) { setStatus('Нет ключа Mistral: сохраните его в ⚙ Настройки.', true); return; }
    go.disabled = true; go.textContent = 'думаю…'; list.innerHTML = ''; add.style.display = 'none'; setStatus('ИИ пишет куски…');
    try { draw(await post('/api/ai-generate', { lang: sel.value, topic: topic.value, count: Number(count.value) || 4 })); }
    catch (e) { setStatus('⛔ ' + e.message, true); }
    go.disabled = false; go.textContent = 'предложить';
  };

  add.onclick = async () => {
    const chosen = rows.filter(r => r.keep.checked).map(r => ({ title: r.title.value, lang: r.p.lang, group: r.group.value, desc: r.desc.value, output: r.p.output, tags: r.p.tags, aliases: r.p.aliases, code: r.code.value }));
    if (!chosen.length) { setStatus('Ничего не отмечено.', true); return; }
    add.disabled = true; add.textContent = 'добавляю…';
    try {
      const r = await post('/api/ai-create', { pieces: chosen });
      const skipped = r.skipped.map(s => s.title + ' — ' + s.reason).join('; ');
      setStatus('Добавлено: ' + r.created.length + (skipped ? '. Пропущено: ' + skipped : '.'), !r.created.length);
      if (r.created.length) { list.innerHTML = ''; add.style.display = 'none'; if (typeof loadAll === 'function') loadAll(); }
    } catch (e) { setStatus('⛔ ' + e.message, true); }
    add.disabled = false; add.textContent = 'добавить отмеченные';
  };

  // необязательный помощник: ИИ предлагает темы-пробелы, клик по теме добавляет её в поле «что дополнить»
  const gapsBtn = $('genGaps'), chips = $('genChips'), gapsHint = $('genGapsHint');
  sel.addEventListener('change', () => { chips.innerHTML = ''; gapsHint.textContent = ''; });
  gapsBtn.onclick = async () => {
    if (!key()) { setStatus('Нет ключа Mistral: сохраните его в ⚙ Настройки.', true); return; }
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

  $('genOpen').addEventListener('click', open);
  $('genClose').addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && modal.classList.contains('open')) close(); });
})();
