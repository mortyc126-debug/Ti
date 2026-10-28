// Проход по дереву задачи: вопросы → выбор варианта → собранный код. Общий для страницы «Задачи»
// и окна «🧭 задачи» в песочнице. window.TaskWalk.mount(host, task, opts) → { assembly(), reset(), setHave(set) }.
//   opts.onChange(assembly)   — после каждого выбора; assembly = [{lang, title, code, id}] в порядке дерева
//   opts.stepMode             — true: показывать вопросы по одному (новичку), false: всё дерево сразу
//   opts.simple               — true: подписи и заметки подробно, false: только подписи вариантов
(function(){
  if(window.TaskWalk) return;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const KIND = { piece: 'кусок', task: 'задача', code: 'код', skip: 'пропустить' };
  const MAX_TASK_DEPTH = 6;

  const st = document.createElement('style');
  st.textContent = `
  .tw-step{border-left:2px solid var(--border,#3a2f55);padding:4px 0 6px 11px;margin:4px 0 10px}
  .tw-step.done{border-left-color:var(--str,#52F2C9)}
  .tw-step.wait{opacity:.45}
  .tw-q{font-weight:600;font-size:13.5px;color:var(--text,#eee);margin-bottom:3px}
  .tw-q .n{display:inline-grid;place-items:center;width:19px;height:19px;border-radius:50%;background:var(--s2,#1a1030);color:var(--acc,#ff2fae);font:11px ui-monospace,monospace;margin-right:6px}
  .tw-hint{font-size:12px;color:var(--text3,#9c90c4);margin:0 0 6px;line-height:1.5;white-space:pre-wrap}
  .tw-opts{display:flex;flex-direction:column;gap:4px}
  .tw-opt{display:flex;gap:8px;align-items:flex-start;text-align:left;background:var(--bg,#0e0720);border:1px solid var(--border,#3a2f55);border-radius:8px;padding:6px 9px;cursor:pointer;color:var(--text2,#cbc2ea);font:13px system-ui,sans-serif}
  .tw-opt:hover{border-color:var(--name,#3dd9ff)}
  .tw-opt.on{border-color:var(--str,#52F2C9);background:color-mix(in srgb,var(--str,#52F2C9) 10%,var(--bg,#0e0720));color:var(--text,#eee)}
  .tw-opt.off{opacity:.5}
  .tw-opt .b{flex:1;min-width:0}
  .tw-opt .t{display:block}
  .tw-opt .d{display:block;font-size:11.5px;color:var(--text3,#9c90c4);line-height:1.45;margin-top:2px;white-space:pre-wrap}
  .tw-k{flex:0 0 auto;font:10px ui-monospace,monospace;border-radius:4px;padding:2px 5px;margin-top:2px;background:var(--s2,#1a1030);color:var(--text3,#9c90c4)}
  .tw-k.piece{color:var(--name,#3dd9ff)} .tw-k.task{color:var(--kw,#b45cff)} .tw-k.code{color:var(--str,#52F2C9)}
  .tw-k.bad{color:#ff6b6b}
  .tw-have{font-size:10.5px;color:var(--str,#52F2C9);margin-left:6px}
  .tw-peek{flex:0 0 auto;background:none;border:0;color:var(--text3,#9c90c4);cursor:pointer;font-size:12px;padding:0 2px}
  .tw-peek:hover{color:var(--acc,#ff2fae)}
  .tw-code{margin:4px 0 2px;background:var(--code-bg,var(--bg,#0e0720));border:1px solid var(--border,#3a2f55);border-radius:7px;padding:7px 9px;font:12px/1.5 ui-monospace,monospace;color:var(--text2,#cbc2ea);white-space:pre;overflow:auto;max-height:240px}
  .tw-sub{margin:6px 0 0 6px}
  .tw-sub-t{font-size:11px;color:var(--kw,#b45cff);margin:2px 0 0}
  .tw-cycle{font-size:12px;color:#ff6b6b;margin:4px 0}
  `;
  document.head.appendChild(st);

  // кэши на страницу: куски (список и код) и задачи
  let ROWS = null; const CODE = new Map(), TASKS = new Map();
  const rows = () => ROWS || (ROWS = fetch('/api/list').then(r => r.json()).then(l => { const m = new Map(); (l || []).forEach(x => m.set(x.id, x)); return m; }).catch(() => new Map()));
  const codeOf = id => { if(!CODE.has(id)) CODE.set(id, fetch('/api/template?id=' + encodeURIComponent(id)).then(r => r.json()).then(t =>
    t.code != null ? String(t.code) : (Array.isArray(t.lines) ? t.lines.map(l => (l || []).map(k => k.v != null ? k.v : '').join('')).join('\n') : '')).catch(() => '')); return CODE.get(id); };
  const taskOf = id => { if(!TASKS.has(id)) TASKS.set(id, fetch('/api/tasks/get?id=' + encodeURIComponent(id)).then(r => r.ok ? r.json() : null).catch(() => null)); return TASKS.get(id); };

  function mount(host, task, opts){
    opts = opts || {};
    const choice = new Map();          // шаг → индекс варианта (ключ — объект шага, общий для всех вхождений)
    const peek = new Set();            // открытые «👁 код» у вариантов
    let have = new Set();              // имена, которые уже есть в коде редактора (для пометки «уже есть»)
    let seq = 0, loadedRows = null;

    async function render(){
      const my = ++seq;
      loadedRows = await rows();
      const frag = document.createElement('div');
      const asm = [];
      await drawSteps(frag, task.steps, asm, [task.id], 0, { n: 0 });
      if(my !== seq) return;
      host.innerHTML = ''; host.appendChild(frag);
      if(opts.onChange) opts.onChange(asm);
    }

    // рисует список шагов; возвращает false, если в режиме «по шагу» дальше показывать не надо
    async function drawSteps(parent, steps, asm, path, depth, num){
      for(const stp of steps || []){
        const auto = stp.auto && stp.options.length === 1;
        if(auto && !choice.has(stp)) choice.set(stp, 0);
        const ci = choice.has(stp) ? choice.get(stp) : -1;
        const box = document.createElement('div'); box.className = 'tw-step' + (ci >= 0 ? ' done' : '');
        num.n++;
        box.innerHTML = '<div class="tw-q"><span class="n">' + num.n + '</span>' + esc(stp.q || (stp.options[0] && stp.options[0].label) || '') + '</div>'
          + (stp.hint && opts.simple !== false ? '<div class="tw-hint">' + esc(stp.hint) + '</div>' : '');
        const list = document.createElement('div'); list.className = 'tw-opts';
        stp.options.forEach((o, i) => list.appendChild(optRow(stp, o, i, ci)));
        box.appendChild(list);
        parent.appendChild(box);
        if(ci < 0){ if(opts.stepMode) return false; continue; }
        const o = stp.options[ci];
        if(o.kind === 'piece' && o.id){ const r = loadedRows.get(o.id); asm.push({ id: o.id, title: (r && r.title) || o.ref, lang: (r && r.lang) || task.lang || 'js', code: await codeOf(o.id) }); }
        if(o.kind === 'code' && o.code) asm.push({ id: '', title: o.label, lang: o.lang || task.lang || 'js', code: o.code });
        if(o.kind === 'task' && o.id){
          const sub = document.createElement('div'); sub.className = 'tw-sub'; box.appendChild(sub);
          if(path.includes(o.id) || depth >= MAX_TASK_DEPTH){ sub.innerHTML = '<div class="tw-cycle">задача ссылается сама на себя — дальше не раскрываю</div>'; }
          else {
            const t = await taskOf(o.id);
            if(t){ sub.innerHTML = '<div class="tw-sub-t">↳ задача «' + esc(t.title) + '»</div>';
              if(await drawSteps(sub, t.steps, asm, path.concat(o.id), depth + 1, num) === false) return false; }
            else sub.innerHTML = '<div class="tw-cycle">задача не найдена</div>';
          }
        }
        if(o.steps && o.steps.length){
          const sub = document.createElement('div'); sub.className = 'tw-sub'; box.appendChild(sub);
          if(await drawSteps(sub, o.steps, asm, path, depth, num) === false) return false;
        }
      }
      return true;
    }

    function optRow(stp, o, i, ci){
      const b = document.createElement('div'); b.className = 'tw-opt' + (ci === i ? ' on' : (ci >= 0 ? ' off' : ''));
      const r = o.kind === 'piece' && o.id ? loadedRows.get(o.id) : null;
      const broken = (o.kind === 'piece' || o.kind === 'task') && !o.id;
      const k = o.kind ? '<span class="tw-k ' + o.kind + (broken ? ' bad' : '') + '" title="' + (broken ? 'ссылка не найдена: ' + esc(o.ref) : '') + '">' + (broken ? '⚠ ' : '') + KIND[o.kind] + '</span>' : '<span class="tw-k">→</span>';
      // «уже есть в коде»: всё, что даёт кусок, в редакторе уже объявлено
      const prov = r && r.comp && r.comp.provides || [];
      const already = prov.length && prov.every(p => have.has(p));
      let d = '';
      if(opts.simple !== false){
        if(o.note) d += o.note;
        else if(r && r.desc) d += r.desc;
      }
      if(r && opts.simple !== false && r.title && r.title !== o.label) d = (d ? d + '\n' : '') + '▸ ' + r.title;
      b.innerHTML = k + '<span class="b"><span class="t">' + esc(o.label) + (already ? '<span class="tw-have">✓ уже есть в коде</span>' : '') + '</span>'
        + (d ? '<span class="d">' + esc(d) + '</span>' : '') + '</span>'
        + ((o.kind === 'piece' && o.id) || o.kind === 'code' ? '<button class="tw-peek" title="показать код">👁</button>' : '');
      b.onclick = e => {
        if(e.target.closest('.tw-peek')) return;
        if(choice.get(stp) === i && !stp.auto) choice.delete(stp); else choice.set(stp, i);
        render();
      };
      const pk = b.querySelector('.tw-peek');
      if(pk) pk.onclick = async e => {
        e.stopPropagation();
        const key = stp.q + '|' + i + '|' + (o.id || o.label);
        if(peek.has(key)){ peek.delete(key); const c = b.nextElementSibling; if(c && c.classList.contains('tw-code')) c.remove(); return; }
        peek.add(key);
        const pre = document.createElement('div'); pre.className = 'tw-code'; pre.textContent = o.kind === 'code' ? o.code : await codeOf(o.id);
        b.after(pre);
      };
      return b;
    }

    render();
    return {
      reset(){ choice.clear(); render(); },
      setMode(m){ Object.assign(opts, m); render(); },
      setHave(set){ have = set || new Set(); render(); },
      rerender: render
    };
  }

  // собрать код по языкам: одинаковые куски не повторяем
  function joinAssembly(asm){
    const by = new Map(), seen = new Set();
    for(const a of asm){ const k = a.lang + '\n' + a.code; if(!a.code || seen.has(k)) continue; seen.add(k);
      if(!by.has(a.lang)) by.set(a.lang, []); by.get(a.lang).push(a); }
    return [...by.entries()].map(([lang, list]) => ({ lang, list, code: list.map(a => a.code.replace(/\s+$/, '')).join('\n\n') }));
  }

  window.TaskWalk = { mount, joinAssembly, rows, codeOf, taskOf };
})();
