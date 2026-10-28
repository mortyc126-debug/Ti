// Текстовый формат «задач» (деревьев решений): разбор text → дерево и обратно.
// Один формат и для ручной правки, и для ответов ИИ — поэтому терпимый к отступам и мелкому мусору.
// Работает и в браузере (window.TaskFormat), и в node (require) — сервер и тесты берут тот же код.
//
//   === Реагировать на клик по кнопке | js | Интерфейс / События
//   > что собираем и зачем (можно несколько строк)
//   ~ клик, нажатие, обработчик            ← синонимы для поиска
//   ? Как найти кнопку?                     ← развилка
//   | подсказка к вопросу
//     - по классу -> кусок: querySelector по классу
//       | заметка к варианту
//     - по id -> код
//       ```js
//       const btn = document.getElementById('save');
//       ```
//     - уже есть в коде -> пропустить
//     - сделать по-другому                  ← вариант без цели, но со своими вопросами внутри
//       ? вложенный вопрос (только для этого варианта)
//         - ...
//   ! Повесить обработчик -> кусок: addEventListener click   ← шаг без выбора
(function(root){
  'use strict';

  const KIND_WORDS = { 'кусок': 'piece', 'piece': 'piece', 'задача': 'task', 'task': 'task', 'код': 'code', 'code': 'code', 'пропустить': 'skip', 'skip': 'skip', 'ничего': 'skip' };
  const KIND_RU = { piece: 'кусок', task: 'задача', code: 'код', skip: 'пропустить' };

  const indentOf = s => { let n = 0; for(const ch of s){ if(ch === ' ') n++; else if(ch === '\t') n += 2; else break; } return n; };

  // «подпись -> кусок: X» → {label, kind, ref}; стрелка любая из -> → =>
  function splitTarget(s){
    const m = String(s).match(/^(.*?)\s*(?:->|→|=>)\s*(.*)$/);
    if(!m) return { label: s.trim(), kind: '', ref: '' };
    const label = m[1].trim(), tail = m[2].trim();
    const mk = tail.match(/^([A-Za-zА-Яа-яЁё]+)\s*:?\s*(.*)$/);
    const kind = mk && KIND_WORDS[mk[1].toLowerCase()];
    if(kind) return { label, kind, ref: (mk[2] || '').trim() };
    return { label, kind: 'piece', ref: tail };   // «-> Название» без слова — считаем куском
  }

  function newStep(q, auto){ return { q: q.trim(), hint: '', auto: !!auto, options: [] }; }
  function newOpt(label, kind, ref){ return { label, kind: kind || '', ref: ref || '', note: '', code: '', lang: '', steps: [] }; }

  // разбор одного блока задачи (строки после «===»); стек — пары {indent, list шагов}
  function parseBody(lines, task, warn){
    // контексты: steps-списки с их отступом; последний шаг и последний вариант для заметок/кода
    const stack = [{ ind: -1, steps: task.steps, opt: null }];
    let lastStep = null, lastOpt = null, fence = null;
    for(let i = 0; i < lines.length; i++){
      const raw = lines[i];
      if(fence){
        if(/^\s*(```|~~~)/.test(raw)){ fence.opt.code = fence.buf.map(l => l.slice(Math.min(fence.cut, indentOf(l)))).join('\n'); fence = null; }
        else fence.buf.push(raw);
        continue;
      }
      if(!raw.trim()) continue;
      const ind = indentOf(raw), s = raw.trim();
      const mf = s.match(/^(?:```|~~~)\s*([A-Za-z0-9#+_-]*)/);
      if(mf){
        if(!lastOpt){ warn('код без варианта: ' + s); fence = { opt: newOpt(''), buf: [], cut: ind }; continue; }
        if(!lastOpt.kind || lastOpt.kind === 'piece' && !lastOpt.ref) lastOpt.kind = 'code';
        if(mf[1]) lastOpt.lang = mf[1].toLowerCase();
        fence = { opt: lastOpt, buf: [], cut: ind }; continue;
      }
      if(s[0] === '>' && lastStep === null){ task.desc = (task.desc ? task.desc + '\n' : '') + s.replace(/^>\s?/, ''); continue; }
      if(s[0] === '~' && lastStep === null){ s.slice(1).split(/[,;]/).map(x => x.trim()).filter(Boolean).forEach(x => task.aliases.push(x)); continue; }
      if(s[0] === '?' || s[0] === '!'){
        // шаг принадлежит ближайшему варианту с меньшим отступом (или корню)
        while(stack.length > 1 && (stack[stack.length - 1].ind >= ind || !stack[stack.length - 1].steps)) stack.pop();
        const auto = s[0] === '!';
        const body = s.slice(1).trim();
        let step;
        if(auto){
          const t = splitTarget(body);
          step = newStep(t.kind ? t.label : body, true);
          const o = newOpt(t.label || body, t.kind, t.ref); step.options.push(o); lastOpt = o;
          stack[stack.length - 1].steps.push(step); lastStep = step;
          stack.push({ ind, steps: o.steps, opt: o });          // у шага без выбора заметки/код — его единственного варианта
          continue;
        }
        step = newStep(body, false); lastOpt = null;
        stack[stack.length - 1].steps.push(step); lastStep = step;
        stack.push({ ind, steps: null, step, opt: null });   // маркер шага: варианты не левее него
        continue;
      }
      if(/^[-*•]\s+/.test(s)){
        // вариант: ищем ближайший шаг выше по отступу
        while(stack.length > 1 && !(stack[stack.length - 1].step && stack[stack.length - 1].ind <= ind)) stack.pop();
        const ctx = stack[stack.length - 1];
        if(!ctx.step){ warn('вариант без вопроса: ' + s); continue; }
        const t = splitTarget(s.replace(/^[-*•]\s+/, ''));
        const o = newOpt(t.label, t.kind, t.ref);
        ctx.step.options.push(o); lastOpt = o;
        stack.push({ ind, steps: o.steps, opt: o });   // вложенные вопросы этого варианта
        continue;
      }
      if(s[0] === '|'){
        const txt = s.replace(/^\|\s?/, '');
        // заметка относится к тому, что выше по тексту: вариант (если он последний и глубже шага) или шаг
        const top = stack[stack.length - 1];
        if(top.opt && lastOpt === top.opt) lastOpt.note = (lastOpt.note ? lastOpt.note + '\n' : '') + txt;
        else if(lastStep) lastStep.hint = (lastStep.hint ? lastStep.hint + '\n' : '') + txt;
        continue;
      }
      if(lastStep === null){ task.desc = (task.desc ? task.desc + '\n' : '') + s; continue; }   // свободный текст до шагов — описание
      warn('непонятная строка: ' + s);
    }
    if(fence){ fence.opt.code = fence.buf.join('\n'); warn('не закрыт блок кода ```'); }
  }

  function parse(text){
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const tasks = [], warnings = [];
    let cur = null, buf = [];
    const flush = () => { if(cur){ parseBody(buf, cur, w => warnings.push(cur.title + ': ' + w)); tasks.push(cur); } buf = []; };
    for(const raw of lines){
      const m = raw.match(/^\s*={3,}\s*(.+?)\s*$/);
      if(m){
        flush();
        const parts = m[1].replace(/=+$/, '').split('|').map(x => x.trim());
        cur = { title: parts[0] || 'Задача', lang: (parts[1] || '').toLowerCase(), group: parts[2] || '', desc: '', aliases: [], steps: [] };
        continue;
      }
      if(cur) buf.push(raw);
      else if(raw.trim()) warnings.push('строка до первой «=== Название»: ' + raw.trim().slice(0, 60));
    }
    flush();
    return { tasks, warnings };
  }

  // дерево → текст (для правки руками). refOf(opt) даёт, как записать цель (название или id:…)
  function serialize(task, refOf){
    const out = [];
    out.push('=== ' + task.title + ' | ' + (task.lang || '') + ' | ' + (task.group || ''));
    if(task.desc) String(task.desc).split('\n').forEach(l => out.push('> ' + l));
    if(task.aliases && task.aliases.length) out.push('~ ' + task.aliases.join(', '));
    const target = o => {
      if(!o.kind) return '';
      if(o.kind === 'skip') return ' -> пропустить';
      if(o.kind === 'code') return ' -> код';
      const ref = refOf ? refOf(o) : (o.ref || o.id || '');
      return ' -> ' + KIND_RU[o.kind] + ': ' + ref;
    };
    const writeSteps = (steps, pad) => {
      for(const st of steps || []){
        if(st.auto && st.options.length === 1){
          const o = st.options[0];
          out.push(pad + '! ' + (st.q || o.label) + target(o));
          writeOptBody(o, pad + '  ');
          continue;
        }
        out.push(pad + '? ' + st.q);
        if(st.hint) st.hint.split('\n').forEach(l => out.push(pad + '| ' + l));
        for(const o of st.options){
          out.push(pad + '  - ' + o.label + target(o));
          writeOptBody(o, pad + '    ');
        }
      }
    };
    const writeOptBody = (o, pad) => {
      if(o.note) o.note.split('\n').forEach(l => out.push(pad + '| ' + l));
      if(o.kind === 'code'){ out.push(pad + '```' + (o.lang || '')); String(o.code || '').split('\n').forEach(l => out.push(pad + l)); out.push(pad + '```'); }
      if(o.steps && o.steps.length) writeSteps(o.steps, pad);
    };
    writeSteps(task.steps, '');
    return out.join('\n');
  }

  // обход всех вариантов дерева (для резолва ссылок и подсчётов)
  function eachOption(steps, fn, depth){
    depth = depth || 0;
    for(const st of steps || []) for(const o of st.options || []){ fn(o, st, depth); eachOption(o.steps, fn, depth + 1); }
  }
  function stats(task){
    let steps = 0, options = 0, unresolved = 0;
    const walk = (list) => { for(const st of list || []){ steps++; for(const o of st.options){ options++; if((o.kind === 'piece' || o.kind === 'task') && !o.id) unresolved++; walk(o.steps); } } };
    walk(task.steps);
    return { steps, options, unresolved };
  }

  const api = { parse, serialize, eachOption, stats, splitTarget, KIND_RU };
  if(typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TaskFormat = api;
})(typeof window !== 'undefined' ? window : this);
