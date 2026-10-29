// Окно «🏷 подписи»: свои подписи к именам «даёт/нужно» пачкой и промпт для ИИ по разделу.
// Строка: «кусок | имя: подпись» (кусок — название или id:…). Пустая подпись снимает свою — вернётся автоматическая.
// В промпт уходят только имена, которым автоподпись не помогла, и строка кода, где имя объявлено. window.codelabLabels.open()
(function(){
  if(window.codelabLabels) return;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const api = (u, b) => fetch(u, b === undefined ? undefined : { method: 'POST', body: JSON.stringify(b) }).then(r => r.json());
  // «слабая» подпись: имя без пояснения, «берётся снаружи» или «результат f()» без смысла
  const weak = L => !L || !L.text || L.kind === 'имя' || L.kind === 'снаружи' || (L.kind === 'результат' && !/: /.test(L.text));
  const nk = s => String(s || '').split('/').map(x => x.trim().toLowerCase().replace(/ё/g, 'е')).filter(Boolean).join(' / ');
  const inSec = (g, sec) => { const a = nk(g), b = nk(sec); return !b || a === b || a.startsWith(b + ' / '); };

  async function open(){
    const [rows, sec] = await Promise.all([api('/api/list?labels=1').catch(() => []), api('/api/sections').catch(() => ({ tree: [] }))]);
    const tree = sec.tree || [];
    const langs = [...new Set(rows.map(r => r.lang))].sort();
    const bg = document.createElement('div'); bg.className = 'sx-bg';
    bg.innerHTML = '<div class="sx"><h3>🏷 Подписи к «даёт / нужно»</h3>'
      + '<div class="lead">Подписи к именам собираются сами — из кода и словаря. Где не вышло, можно дописать свою: строкой <code>кусок | имя: подпись</code>. '
      + 'Своя подпись побеждает автоматическую; пустая — снимает свою. Промпт ниже собирает для ИИ только имена без нормальной подписи — с той строкой кода, где имя объявлено.</div>'
      + '<div class="sx-cols"><div>'
      + '<label>Свои подписи</label><textarea id="lbT" rows="16" spellcheck="false" placeholder="querySelector — найти элемент | el: найденный элемент страницы"></textarea>'
      + '<div class="sx-row"><button class="btn" id="lbDry">🔎 проверить</button><button class="btn ok" id="lbGo">💾 сохранить</button><span class="sx-msg" id="lbMsg"></span></div>'
      + '</div><div>'
      + '<div style="display:grid;grid-template-columns:1fr 3fr;gap:8px"><div><label>Язык</label><select id="lbLang">' + langs.map(l => '<option' + (l === 'js' ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select></div>'
      + '<div><label>Раздел</label><select id="lbSec"><option value="">— все —</option>' + tree.map(t => '<option>' + esc(t.name) + '</option>' + (t.subs || []).map(s => '<option value="' + esc(t.name + ' / ' + s) + '">   ' + esc(s) + '</option>').join('')).join('') + '</select></div></div>'
      + '<label>Запрос для ИИ <span id="lbCnt"></span></label><textarea id="lbP" rows="14" spellcheck="false"></textarea>'
      + '<div class="sx-row"><button class="btn ok" id="lbCopy">⧉ скопировать запрос</button><button class="btn" id="lbX">закрыть</button></div>'
      + '</div></div></div>';
    document.body.appendChild(bg);
    bg.querySelectorAll('select').forEach(s => s.style.cssText = 'width:100%;background:var(--bg);border:1px solid var(--border);border-radius:7px;color:var(--text);padding:6px');
    const q = s => bg.querySelector(s);
    q('#lbX').onclick = () => bg.remove();
    const msg = (t, c) => { const m = q('#lbMsg'); m.className = 'sx-msg ' + (c || ''); m.textContent = t; };
    q('#lbDry').onclick = async () => { const r = await api('/api/contract/labels', { text: q('#lbT').value, dry: true }).catch(() => null);
      if(!r) return msg('сервер не ответил', 'err'); msg('подписей: ' + r.labels + ', кусков: ' + r.pieces + (r.bad.length ? '\nне разобрано:\n' + r.bad.slice(0, 20).join('\n') : ''), r.bad.length ? 'err' : 'ok'); };
    q('#lbGo').onclick = async () => { const r = await api('/api/contract/labels', { text: q('#lbT').value }).catch(() => null);
      if(!r) return msg('сервер не ответил', 'err'); msg('✓ сохранено подписей: ' + r.labels + ' в ' + r.pieces + ' кусках' + (r.bad.length ? '\nне разобрано:\n' + r.bad.slice(0, 20).join('\n') : '') + '\nОбнови страницу, чтобы увидеть.', r.bad.length ? 'err' : 'ok'); };
    let seq = 0;
    const build = async () => {
      const my = ++seq; const l = q('#lbLang').value, s = q('#lbSec').value;
      const list = rows.filter(r => r.lang === l && inSec(r.group, s) && r.comp && r.comp.labels);
      const todo = [];
      for(const r of list){ const names = Object.entries(r.comp.labels).filter(([n, L]) => !L.service && weak(L)).map(([n]) => n); if(names.length) todo.push({ r, names }); }
      const pick = todo.slice(0, 60);
      // строка объявления — чтобы ИИ понял смысл без всего кода
      const lines = await Promise.all(pick.map(async x => { const t = await fetch('/api/template?id=' + encodeURIComponent(x.r.id)).then(r => r.json()).catch(() => ({}));
        const code = t.code != null ? String(t.code) : (Array.isArray(t.lines) ? t.lines.map(l => (l || []).map(k => k.v != null ? k.v : '').join('')).join('\n') : '');
        return x.names.map(n => { const ln = code.split('\n').find(c => new RegExp('(^|[^\\w$.])' + n.replace(/[$]/g, '\\$') + '(?![\\w$])').test(c)) || ''; return x.r.title + ' | ' + n + ':' + (ln ? '        ← ' + ln.trim().slice(0, 120) : ''); }).join('\n'); }));
      if(my !== seq) return;
      q('#lbCnt').textContent = '— имён без подписи: ' + todo.reduce((a, x) => a + x.names.length, 0) + (todo.length > 60 ? ' (в запросе первые 60 кусков)' : '');
      q('#lbP').value = todo.length ? [
        'Ниже — имена из кусков кода (язык: ' + l + '). Для каждого допиши после двоеточия короткую подпись по-русски: что это такое для человека, который не помнит синтаксис (3–8 слов, без кода).',
        'После «←» — строка кода, где имя встречается; её в ответ не переписывай. Формат ответа строго: «название куска | имя: подпись», по строке на имя, без нумерации и пояснений.',
        'Пример: «Нарисовать круг | ctx: кисть для рисования на холсте».', '',
        lines.join('\n')
      ].join('\n') : 'Здесь у всех имён уже есть подписи 👍';
    };
    q('#lbLang').onchange = build; q('#lbSec').onchange = build;
    q('#lbCopy').onclick = e => { navigator.clipboard && navigator.clipboard.writeText(q('#lbP').value); e.target.textContent = '✓ скопировано'; };
    build();
  }
  window.codelabLabels = { open };
})();
