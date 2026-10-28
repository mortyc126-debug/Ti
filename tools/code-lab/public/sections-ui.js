// Окно «🗂 дерево разделов»: общее дерево (library/_sections.json) и правила переноса старых разделов.
// Слева правишь дерево и правила текстом, справа сразу видно «было → станет» и что останется вне дерева.
// Ничего не меняется в кусках и задачах, пока не нажата «применить». window.codelabSections.open()
(function(){
  if(window.codelabSections) return;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const api = (u, b) => fetch(u, b === undefined ? undefined : { method: 'POST', body: JSON.stringify(b) }).then(r => r.json());

  const st = document.createElement('style');
  st.textContent = `
  .sx-bg{position:fixed;inset:0;background:rgba(5,2,14,.72);display:flex;align-items:flex-start;justify-content:center;z-index:60;overflow:auto;padding:22px 14px}
  .sx{background:var(--bg2);border:1px solid var(--border);border-radius:14px;width:100%;max-width:1180px;padding:16px 18px;color:var(--text)}
  .sx h3{margin:0 0 4px;font-size:17px}
  .sx .lead{color:var(--text3);font-size:12.5px;line-height:1.55;margin:0 0 10px}
  .sx-cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px}
  .sx label{display:block;font-size:11px;color:var(--text3);margin:6px 0 4px}
  .sx textarea{width:100%;box-sizing:border-box;background:var(--code-bg,var(--bg));border:1px solid var(--border);border-radius:8px;color:var(--text);font:12px/1.5 ui-monospace,monospace;padding:8px 10px;resize:vertical}
  .sx-prev{border:1px solid var(--border);border-radius:9px;padding:8px 10px;max-height:72vh;overflow:auto;font-size:12.5px}
  .sx-h{font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--text3);margin:10px 0 4px}
  .sx-h:first-child{margin-top:0}
  .sx-sum{font-size:13px;margin-bottom:6px}
  .sx-out{color:#ff6b6b;cursor:pointer;padding:2px 0} .sx-out:hover{text-decoration:underline}
  .sx-top{margin:4px 0}
  .sx-top>summary{cursor:pointer;font-weight:600}
  .sx-top .n,.sx-mv .n{font:11px ui-monospace,monospace;color:var(--text3)}
  .sx-sub{padding:1px 0 1px 16px;color:var(--text2)}
  .sx-sub.bad{color:#ff9b6b}
  .sx-mv{padding:2px 0;color:var(--text2)} .sx-mv b{color:var(--text)}
  .sx-row{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px;align-items:center}
  .sx-msg{font-size:12px;color:var(--text3);white-space:pre-wrap}
  .sx-msg.err{color:#ff6b6b} .sx-msg.ok{color:var(--str)}
  @media (max-width:900px){ .sx-cols{grid-template-columns:1fr} }
  `;
  document.head.appendChild(st);

  async function open(){
    const cfg = await api('/api/sections').catch(() => null);
    if(!cfg){ alert('сервер не ответил'); return; }
    const bg = document.createElement('div'); bg.className = 'sx-bg';
    bg.innerHTML = '<div class="sx"><h3>🗂 Дерево разделов</h3>'
      + '<div class="lead">Одно дерево на всё: библиотеку, задачи, промпты. Язык в название раздела не пишем — он отдельный фильтр. '
      + 'Правила переносят старые разделы: <code>старый путь =&gt; новый путь</code>, побеждает самое длинное совпадение, <code>/ *</code> в конце — оставить прежний подраздел. '
      + 'Пока не нажата «применить», куски и задачи не меняются; откатить применённое можно через git.</div>'
      + '<div class="sx-cols"><div>'
      + '<label>Дерево: «Раздел: подраздел; подраздел»</label><textarea id="sxTree" rows="12" spellcheck="false"></textarea>'
      + '<label>Правила переноса</label><textarea id="sxRules" rows="18" spellcheck="false"></textarea>'
      + '</div><div><label>Что получится</label><div class="sx-prev" id="sxPrev">считаю…</div></div></div>'
      + '<div class="sx-row"><button class="btn" id="sxSave" title="сохранить дерево и правила, ничего не перенося">💾 сохранить</button>'
      + '<button class="btn ok" id="sxApply" title="сохранить и переписать раздел у кусков и задач по правилам">✅ применить к кускам и задачам</button>'
      + '<button class="btn" id="sxSort" title="подобрать раздел кускам из «Не разобрано» по самым похожим разложенным кускам">🧭 разложить неразобранное</button>'
      + '<button class="btn" id="sxX">закрыть</button><span class="sx-msg" id="sxMsg"></span></div></div>';
    document.body.appendChild(bg);
    const q = s => bg.querySelector(s);
    q('#sxX').onclick = () => bg.remove();
    q('#sxTree').value = cfg.treeText || '';
    q('#sxRules').value = (cfg.rules || []).join('\n');
    const body = () => ({ treeText: q('#sxTree').value, rules: q('#sxRules').value });

    let seq = 0, timer = null;
    const schedule = () => { clearTimeout(timer); timer = setTimeout(preview, 500); };
    q('#sxTree').oninput = schedule; q('#sxRules').oninput = schedule;
    async function preview(){
      const my = ++seq;
      const p = await api('/api/sections/plan', body()).catch(() => null);
      if(my !== seq) return;
      const box = q('#sxPrev');
      if(!p){ box.innerHTML = '<div class="sx-msg err">сервер не ответил</div>'; return; }
      let h = '<div class="sx-sum">Перенесётся <b>' + p.changed + '</b> из ' + p.total + ' (куски и задачи).</div>';
      if(p.bad.length) h += '<div class="sx-h">Непонятные строки правил</div>' + p.bad.map(b => '<div class="sx-msg err">' + esc(b) + '</div>').join('');
      if(p.outside.length){
        h += '<div class="sx-h">Останется вне дерева — клик добавит заготовку правила</div>'
          + p.outside.map(o => '<div class="sx-out" data-p="' + esc(o.path) + '">⚠ ' + esc(o.path) + ' <span class="n">' + cnt(o) + (o.top ? ' · подраздела нет в дереве' : ' · раздела нет в дереве') + '</span></div>').join('');
      }
      // итог по дереву: разделы в порядке дерева, внутри подразделы с числами
      const tree = treeFrom(q('#sxTree').value); const byTop = new Map();
      p.after.forEach(a => { const [t, ...r] = a.path.split(' / '); const s = r.join(' / '); if(!byTop.has(t)) byTop.set(t, new Map()); const m = byTop.get(t); const o = m.get(s) || { pieces: 0, tasks: 0 }; o.pieces += a.pieces; o.tasks += a.tasks; m.set(s, o); });
      const order = tree.map(t => t.name).concat([...byTop.keys()].filter(k => !tree.some(t => t.name === k)));
      h += '<div class="sx-h">Итог по разделам</div>' + order.map(t => {
        const m = byTop.get(t) || new Map(); const tt = tree.find(x => x.name === t);
        const subs = (tt ? tt.subs : []).concat([...m.keys()].filter(s => s && !(tt && tt.subs.includes(s))));
        const tot = [...m.values()].reduce((a, o) => ({ pieces: a.pieces + o.pieces, tasks: a.tasks + o.tasks }), { pieces: 0, tasks: 0 });
        return '<details class="sx-top"><summary>' + esc(t) + ' <span class="n">' + cnt(tot) + '</span>' + (tt ? '' : ' <span class="n" style="color:#ff6b6b">не в дереве</span>') + '</summary>'
          + (m.get('') ? '<div class="sx-sub">без подраздела <span class="n">' + cnt(m.get('')) + '</span></div>' : '')
          + subs.map(s => { const o = m.get(s); const inTree = tt && tt.subs.includes(s); return '<div class="sx-sub' + (inTree ? '' : ' bad') + '">' + esc(s) + ' <span class="n">' + (o ? cnt(o) : 'пусто') + '</span></div>'; }).join('') + '</details>';
      }).join('');
      h += '<details><summary class="sx-h" style="cursor:pointer">Все переносы (' + p.moves.length + ')</summary>'
        + p.moves.map(mv => '<div class="sx-mv">' + esc(mv.from) + ' → <b>' + esc(mv.to) + '</b> <span class="n">' + cnt(mv) + '</span></div>').join('') + '</details>';
      box.innerHTML = h;
      box.querySelectorAll('.sx-out').forEach(d => d.onclick = () => {
        const ta = q('#sxRules'); ta.value = ta.value.replace(/\s*$/, '') + '\n' + d.dataset.p + ' => '; ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
      });
    }
    const cnt = o => (o.pieces ? o.pieces + ' кус.' : '') + (o.pieces && o.tasks ? ' · ' : '') + (o.tasks ? o.tasks + ' зад.' : '') || '0';
    const treeFrom = text => text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => { const i = l.indexOf(':'); return { name: (i < 0 ? l : l.slice(0, i)).trim(), subs: i < 0 ? [] : l.slice(i + 1).split(';').map(x => x.trim()).filter(Boolean) }; });
    const msg = (t, cls) => { const m = q('#sxMsg'); m.className = 'sx-msg ' + (cls || ''); m.textContent = t; };
    q('#sxSave').onclick = async () => {
      const r = await api('/api/sections/save', body()).catch(() => null);
      if(r && r.ok) msg('✓ сохранено', 'ok'); else msg((r && r.error) || 'не сохранилось', 'err');
    };
    q('#sxApply').onclick = async () => {
      if(!confirm('Переписать разделы у кусков и задач по этим правилам? Откатить можно через git.')) return;
      msg('применяю…');
      const r = await api('/api/sections/apply', body()).catch(() => null);
      if(!r || !r.ok){ msg((r && r.error) || 'не вышло', 'err'); return; }
      msg('✓ Перенесено: кусков ' + r.pieces + ', задач ' + r.tasks + '. Обнови страницу, чтобы увидеть новые разделы.', 'ok');
      preview();
    };
    q('#sxSort').onclick = () => sortUnsorted(body());
    preview();
  }

  // ── «разложить неразобранное»: таблица «кусок → раздел», применяется только отмеченное ──
  async function sortUnsorted(cfgBody){
    const bg = document.createElement('div'); bg.className = 'sx-bg';
    bg.innerHTML = '<div class="sx"><h3>🧭 Разложить неразобранное</h3>'
      + '<div class="lead">Раздел подобран по самым похожим уже разложенным кускам (название, теги, описание, код). Если есть кусок с тем же названием — первым идёт его раздел. '
      + '«дубль» — тот же код, что у одноимённого куска (отличается только комментариями): такой можно удалить. Меняется только отмеченное.</div>'
      + '<div class="sx-row" style="margin:0 0 8px"><button class="btn" id="suConf">отметить уверенные (от 50 %)</button><button class="btn" id="suAll">отметить все</button><button class="btn" id="suNone">снять</button>'
      + '<button class="btn" id="suDups" title="отметить «удалить» у всех точных дублей">🗑 отметить дубли к удалению</button><span class="sx-msg" id="suInfo">считаю…</span></div>'
      + '<div class="sx-prev" id="suList" style="max-height:64vh"></div>'
      + '<div class="sx-row"><button class="btn ok" id="suGo">✅ применить отмеченное</button><button class="btn" id="suX">закрыть</button><span class="sx-msg" id="suMsg"></span></div></div>';
    document.body.appendChild(bg);
    const q = s => bg.querySelector(s);
    q('#suX').onclick = () => bg.remove();
    const r = await api('/api/sections/suggest', cfgBody).catch(() => null);
    if(!r){ q('#suInfo').textContent = 'сервер не ответил'; return; }
    const items = r.items || [];
    const all = []; (r.tree || []).forEach(t => { all.push(t.name); (t.subs || []).forEach(sb => all.push(t.name + ' / ' + sb)); });
    q('#suInfo').textContent = items.length ? 'кусков: ' + items.length + ', дублей: ' + items.filter(x => x.twin && x.twin.same).length : 'неразобранных нет 👍';
    q('#suList').innerHTML = items.map((x, i) => {
      const best = x.options[0];
      const opts = x.options.map(o => '<option value="' + esc(o.path) + '">' + esc(o.path) + (o.twin ? '  — как у одноимённого' : '  — ' + o.share + ' %') + '</option>').join('')
        + '<option disabled>──────────</option>' + all.filter(p => !x.options.some(o => o.path === p)).map(p => '<option value="' + esc(p) + '">' + esc(p) + '</option>').join('');
      return '<div class="su-it" data-i="' + i + '" style="display:grid;grid-template-columns:24px minmax(0,1.2fr) minmax(0,1.4fr) auto;gap:8px;align-items:center;padding:5px 0;border-bottom:1px solid var(--border)">'
        + '<input type="checkbox" class="su-on" title="перенести">'
        + '<div><a href="/component.html?id=' + encodeURIComponent(x.id) + '" target="_blank" style="color:var(--text);text-decoration:none">' + esc(x.title) + '</a> <span class="n" style="font:11px ui-monospace,monospace;color:var(--text3)">' + esc((x.lang || '').toUpperCase()) + '</span>'
        + '<div style="font-size:11px;color:var(--text3)">похоже на: ' + esc(x.like.join(' · ')) + '</div></div>'
        + '<select class="su-to" style="background:var(--bg);border:1px solid var(--border);border-radius:7px;color:var(--text);padding:5px;font-size:12px;max-width:100%">' + opts + '</select>'
        + (x.twin && x.twin.same ? '<label style="font-size:11.5px;color:#ff9b6b;white-space:nowrap" title="тот же код, что у одноимённого куска — удалить этот"><input type="checkbox" class="su-del"> дубль: удалить</label>' : '<span></span>')
        + '</div>';
    }).join('');
    const rows = [...bg.querySelectorAll('.su-it')];
    const conf = i => { const b = items[i].options[0]; return !!b && (b.twin || b.share >= 50); };
    q('#suConf').onclick = () => rows.forEach(el => el.querySelector('.su-on').checked = conf(+el.dataset.i));
    q('#suAll').onclick = () => rows.forEach(el => el.querySelector('.su-on').checked = true);
    q('#suNone').onclick = () => rows.forEach(el => { el.querySelector('.su-on').checked = false; const d = el.querySelector('.su-del'); if(d) d.checked = false; });
    q('#suDups').onclick = () => rows.forEach(el => { const d = el.querySelector('.su-del'); if(d) d.checked = true; });
    q('#suGo').onclick = async () => {
      const map = {}, del = [];
      rows.forEach(el => { const x = items[+el.dataset.i]; const d = el.querySelector('.su-del');
        if(d && d.checked) del.push(x.id); else if(el.querySelector('.su-on').checked) map[x.id] = el.querySelector('.su-to').value; });
      if(!Object.keys(map).length && !del.length){ q('#suMsg').textContent = 'ничего не отмечено'; return; }
      if(del.length && !confirm('Удалить ' + del.length + ' дубл(ей)? Одноимённые куски с тем же кодом останутся. Вернуть можно через git.')) return;
      q('#suMsg').textContent = 'применяю…';
      const a = Object.keys(map).length ? await api('/api/sections/assign', { map }).catch(() => null) : { changed: 0 };
      let removed = 0; for(const id of del){ const d = await api('/api/delete', { id }).catch(() => null); if(d && !d.error) removed++; }
      q('#suMsg').className = 'sx-msg ok';
      q('#suMsg').textContent = '✓ Перенесено: ' + ((a && a.changed) || 0) + ', удалено дублей: ' + removed + '.';
      rows.forEach(el => { const x = items[+el.dataset.i]; if(map[x.id] || del.includes(x.id)) el.style.opacity = '.35'; });
    };
  }

  window.codelabSections = { open };
})();
