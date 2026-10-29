// раскладка: слова, набранные не в той раскладке или вперемешку. ловит три случая:
// 1) в одном слове латиница и кириллица: соnst (русские «с» и «о»), dщcument («щ» вместо «o»);
// 2) всё слово в русской раскладке, а по клавишам это известное слово кода: сщтые → const, вшызфн → display;
// 3) всё слово в английской раскладке, а по клавишам это своё русское имя: yfgbnrb → напитки.
// строки и комментарии не трогаем — там русский текст нормален. файл общий для песочницы и тестов.
(function(root){
  'use strict';
  const RU = 'йцукенгшщзхъфывапролджэячсмитьбю.ё', EN = "qwertyuiop[]asdfghjkl;'zxcvbnm,./`";
  const R2E = {}, E2R = {};
  for(let i = 0; i < RU.length; i++){ R2E[RU[i]] = EN[i]; R2E[RU[i].toUpperCase()] = EN[i].toUpperCase(); E2R[EN[i]] = RU[i]; E2R[EN[i].toUpperCase()] = RU[i].toUpperCase(); }
  // буквы-двойники: выглядят одинаково, коды разные
  const C2L = { а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', к: 'k', А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X', У: 'Y' };
  const L2C = {}; for(const [c, l] of Object.entries(C2L)) L2C[l] = c;
  const isCyr = ch => /[А-Яа-яЁё]/.test(ch), isLat = ch => /[A-Za-z]/.test(ch);
  const ruToEn = w => [...w].map(ch => R2E[ch] || ch).join('');
  const enToRu = w => [...w].map(ch => E2R[ch] || ch).join('');

  // строки и комментарии — пробелами той же длины (позиции сохраняются); в HTML смотрим только внутри тегов
  function blank(code, lang){
    const s = String(code || ''); const L = String(lang || '').toLowerCase();
    const sp = m => m.replace(/[^\n]/g, ' ');
    if(L === 'html' || L === 'svg' || L === 'xml') return s.replace(/<!--[\s\S]*?-->/g, sp).replace(/(^|>)([^<]*)/g, (m, a, b) => a + sp(b)).replace(/"[^"]*"|'[^']*'/g, sp);
    const hash = /^(python|py|bash|sh|ruby|yaml|r|perl)$/.test(L);
    const re = hash ? /#[^\n]*|'''[\s\S]*?'''|"""[\s\S]*?"""|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g
      : L === 'css' ? /\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g
      : /\/\*[\s\S]*?\*\/|\/\/[^\n]*|`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g;
    return s.replace(re, sp);
  }

  // known — Set известных слов в нижнем регистре (словарь, ключевые слова, свои имена)
  function check(code, lang, known){
    known = known || new Set(); const k = w => known.has(String(w).toLowerCase());
    const L = String(lang || '').toLowerCase(); if(/^(txt|md|text|markdown|)$/.test(L)) return [];
    const b = blank(code, L), out = [];
    // в CSS/HTML в слове бывает дефис (font-size, data-id)
    const re = /(?:^|[^\wА-Яа-яЁё$-])([A-Za-zА-Яа-яЁё_$][\wА-Яа-яЁё$-]*)/g; let m;
    while((m = re.exec(b)) && out.length < 60){
      const w = m[1].replace(/-+$/, ''), from = m.index + m[0].length - m[1].length, to = from + w.length;
      if(w.length < 2) continue;
      const cyr = [...w].filter(isCyr), lat = [...w].filter(isLat);
      if(cyr.length && lat.length){
        // смесь: двойники → латиница, русские буквы по клавишам → латиница, двойники → кириллица; известное слово важнее
        const toLat = [...w].map(ch => C2L[ch] || ch).join(''), byKeys = [...w].map(ch => isCyr(ch) ? (R2E[ch] || ch) : ch).join(''), toCyr = [...w].map(ch => L2C[ch] || ch).join('');
        const pureLat = x => !/[А-Яа-яЁё]/.test(x), pureCyr = x => !/[A-Za-z]/.test(x);
        let fix = [toLat, byKeys].find(x => pureLat(x) && k(x)) || (pureCyr(toCyr) && k(toCyr) ? toCyr : '');
        if(!fix) fix = lat.length >= cyr.length ? (pureLat(toLat) ? toLat : byKeys) : (pureCyr(toCyr) ? toCyr : '');
        out.push({ from, to, word: w, fix, why: 'смешаны раскладки: ' + (lat.length >= cyr.length ? 'русские буквы ' + [...new Set(cyr)].map(c => '«' + c + '»').join(', ') : 'латинские буквы ' + [...new Set(lat)].map(c => '«' + c + '»').join(', ')) });
        continue;
      }
      if(cyr.length && !k(w)){
        const en = ruToEn(w); if(/^[A-Za-z_$][\w$-]*$/.test(en) && k(en)) out.push({ from, to, word: w, fix: en, why: 'набрано в русской раскладке' });
        continue;
      }
      if(lat.length && !k(w) && w.length >= 3){
        const ru = enToRu(w); if(/^[А-Яа-яЁё_]+$/.test(ru) && k(ru)) out.push({ from, to, word: w, fix: ru, why: 'набрано в английской раскладке' });
      }
    }
    return out;
  }

  const api = { check, ruToEn, enToRu, blank };
  if(typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LayoutCheck = api;
})(typeof self !== 'undefined' ? self : this);
