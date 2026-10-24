// Разбор текстового списка кусков кода (txt) на отдельные куски.
//
// Форматы (можно смешивать):
//   1) Разделитель «=== Название | язык | раздел»  — язык и раздел необязательны.
//      Сразу под ним можно написать строки-пометки:
//         описание: …   теги: a, b, c   синонимы: x, y   раздел: …   язык: …   вывод: …
//      Всё остальное до следующего разделителя — код.
//   2) Блоки кода в тройных обратных кавычках: ```css  … ```
//      Строка прямо перед блоком (если она не пустая и не код) — название, пометки — как выше.
//   3) Нет ни того, ни другого — весь текст считается одним куском.
// Язык, если не указан, определяется по коду.

const KEYS = {
  'описание': 'desc', 'desc': 'desc', 'description': 'desc',
  'теги': 'tags', 'tags': 'tags',
  'синонимы': 'aliases', 'aliases': 'aliases', 'synonyms': 'aliases',
  'раздел': 'group', 'группа': 'group', 'group': 'group',
  'язык': 'lang', 'lang': 'lang',
  'вывод': 'output', 'результат': 'output', 'output': 'output'
};
const LANG_ALIAS = { javascript: 'js', node: 'js', mjs: 'js', typescript: 'ts', py: 'python', python3: 'python', htm: 'html', shell: 'bash', sh: 'bash', zsh: 'bash', yml: 'yaml' };
export const normLang = l => { const s = String(l || '').trim().toLowerCase(); return LANG_ALIAS[s] || s; };

const META_RE = /^\s*(?:#|\/\/|--)?\s*([A-Za-zА-Яа-яЁё]+)\s*:\s*(.*)$/;
const list = s => String(s).split(/[,;]/).map(x => x.trim()).filter(Boolean);

export function detectLang(code){
  const s = String(code);
  const sc = { html: 0, css: 0, js: 0, python: 0, sql: 0, bash: 0, json: 0 };
  if(/^\s*<(!doctype|html|div|span|p|ul|ol|a|button|input|form|table|section|head|body)\b/im.test(s)) sc.html += 3;
  if(/<\/\w+>/.test(s)) sc.html += 2;
  if(/^[\s]*[.#@]?[\w\-:\[\]="'>+~* ,.]+\s*\{[^}]*:[^}]*;?/m.test(s) && !/\b(function|const|let|var|=>)\b/.test(s)) sc.css += 3;
  if(/^\s*[\w-]+\s*:\s*[^;{}\n]+;\s*$/m.test(s) && !/[(){}]\s*$/m.test(s.split('\n')[0] || '')) sc.css += 1;
  if(/\b(const|let|var|function|=>|document\.|console\.|addEventListener|await|import .* from)\b/.test(s)) sc.js += 3;
  if(/^\s*(def |class \w+.*:|import \w+$|from \w+ import|print\(|elif |if .*:\s*$|for .* in .*:\s*$)/m.test(s)) sc.python += 3;
  if(/\b(select|insert into|update|delete from|create table|alter table)\b/i.test(s) && /\b(from|into|set|values|table)\b/i.test(s)) sc.sql += 3;
  if(/^\s*(#!\/bin\/(ba)?sh|echo |cd |ls |grep |chmod |sudo |export \w+=)/m.test(s)) sc.bash += 3;
  if(/^\s*[\[{][\s\S]*[\]}]\s*$/.test(s) && /"[^"]+"\s*:/.test(s) && !/\b(function|=>)\b/.test(s)) sc.json += 2;
  let best = 'txt', top = 0;
  for(const [k, v] of Object.entries(sc)) if(v > top){ top = v; best = k; }
  return top >= 2 ? best : 'txt';
}

function guessTitle(code, lang){
  for(const raw of code.split('\n')){
    const l = raw.trim(); if(!l) continue;
    const m = /^(?:\/\/|#|--|\/\*+|<!--)\s*(.+?)\s*(?:\*\/|-->)?$/.exec(l);
    const t = (m ? m[1] : l).replace(/[{;]\s*$/, '').trim();
    if(t) return t.slice(0, 60);
  }
  return 'Без названия';
}

function takeMeta(lines, piece){
  // пометки сразу в начале блока
  let i = 0;
  while(i < lines.length){
    if(!lines[i].trim() && i === 0){ i++; continue; }
    const m = META_RE.exec(lines[i]);
    const key = m && KEYS[m[1].toLowerCase()];
    if(!key) break;
    const v = m[2].trim();
    if(key === 'tags' || key === 'aliases') piece[key] = [...(piece[key] || []), ...list(v)];
    else if(key === 'lang') piece.lang = normLang(v);
    else piece[key] = v;
    i++;
  }
  return lines.slice(i);
}

const trimBlank = a => { let s = 0, e = a.length; while(s < e && !a[s].trim()) s++; while(e > s && !a[e - 1].trim()) e--; return a.slice(s, e); };

export function parseSnippets(text, defaults = {}){
  const src = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const pieces = [], warnings = [];
  const SEP = /^={3,}\s*(.*?)\s*=*\s*$/;
  const FENCE = /^```\s*([\w+#-]*)\s*(.*)$/;
  const hasSep = lines.some(l => SEP.test(l));
  const hasFence = lines.some(l => FENCE.test(l));

  const push = (p, body) => {
    body = takeMeta(trimBlank(body), p);
    const code = trimBlank(body).join('\n');
    if(!code.trim()){ warnings.push(`пустой кусок «${p.title || '?'}» пропущен`); return; }
    p.code = code;
    p.lang = normLang(p.lang || defaults.lang) || detectLang(code);
    if(!p.lang || p.lang === 'auto') p.lang = detectLang(code);
    if(!p.title) p.title = guessTitle(code, p.lang);
    if(!p.group && defaults.group) p.group = defaults.group;
    pieces.push(p);
  };

  if(hasSep){
    let cur = null, body = [];
    const flush = () => { if(cur) push(cur, body); cur = null; body = []; };
    for(const l of lines){
      const m = SEP.exec(l);
      if(m){
        flush();
        const [title, lang, group] = m[1].split('|').map(x => x.trim());
        cur = { title: title || '', ...(lang ? { lang: normLang(lang) } : {}), ...(group ? { group } : {}) };
      } else if(cur) body.push(l);
      else if(l.trim()) warnings.push('текст до первого разделителя пропущен: «' + l.trim().slice(0, 40) + '»');
    }
    flush();
  } else if(hasFence){
    let i = 0, prev = '';
    while(i < lines.length){
      const m = FENCE.exec(lines[i]);
      if(m){
        const lang = normLang(m[1]);
        const body = []; i++;
        while(i < lines.length && !/^```\s*$/.test(lines[i])){ body.push(lines[i]); i++; }
        i++;
        const p = { title: (m[2] || prev || '').replace(/^[#>*\-\s]+|[:*\s]+$/g, ''), ...(lang && lang !== 'text' ? { lang } : {}) };
        push(p, body); prev = '';
      } else { if(lines[i].trim()) prev = lines[i].trim(); i++; }
    }
  } else if(src.trim()){
    push({ title: '' }, lines);
    warnings.push('разделителей нет — весь текст принят за один кусок');
  }
  return { pieces, warnings };
}
