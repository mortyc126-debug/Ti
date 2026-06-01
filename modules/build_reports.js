const fs = require('fs');

const html  = fs.readFileSync('/home/user/Ti/index.html', 'utf8');
const appjs = fs.readFileSync('/home/user/Ti/app.js', 'utf8');
const lines_html = html.split('\n');
const lines_js   = appjs.split('\n');

let reportsHtmlRaw = lines_html.slice(1740, 3928).join('\n');

// Убираем кнопку расширения
reportsHtmlRaw = reportsHtmlRaw.replace(
  /<button[^>]*onclick="repCopyInnsForExtension\(\)"[\s\S]*?<\/button>/g, ''
);

// Убираем эмодзи со всех кнопок верхней панели
const emojiRe = /[\u{1F300}-\u{1FFFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}⬇️⬆️]/gu;
reportsHtmlRaw = reportsHtmlRaw.replace(emojiRe, '').replace(/^\s+/gm, s => s);

// app.js — вырезаем авто-init
let allJs = lines_js.slice();
allJs[5873] = '// (renderYtm/renderSbLists — skip in module)';
allJs[5697] = '// (loadState — will be called by module init)';

let jsText = allJs.join('\n');

// prompt() → инлайн-поле
jsText = jsText.replace(
  /const inn = prompt\([^)]+\);/,
  "const inn = (document.getElementById('rep-inn-search-input')||{value:''}).value.trim() || '';"
);

// .addEventListener без ?. → с ?.
jsText = jsText.replace(
  /document\.getElementById\(([^)]+)\)\.addEventListener/g,
  'document.getElementById($1)?.addEventListener'
);

// CSS по tailwind.config.js из web/
const shellCss = `

:root{
  --bg:#0a0e14;
  --s1:#11161e;
  --s2:#1a212c;
  --s3:#1f2836;
  --border:#222a37;
  --border2:#2e3847;
  --acc:#00d4ff;
  --acc2:#0099bb;
  --acc-dim:#0a3a4a;
  --green:#22d3a0;
  --green-dim:rgba(34,211,160,.1);
  --warn:#f5a623;
  --danger:#ff4d6d;
  --danger-dim:rgba(255,77,109,.1);
  --purple:#a78bfa;
  --pos:#22d3a0;
  --neg:#ff4d6d;
  --text:#e6edf3;
  --text1:#e6edf3;
  --text2:#9ba3b1;
  --text3:#5e6573;
  --mono:'JetBrains Mono',ui-monospace,monospace;
  --sans:'Inter',ui-sans-serif,system-ui,sans-serif;
  --serif:'Cormorant Garamond',Georgia,serif;
  --radius:6px;
  --radius-md:8px;
  --radius-lg:10px;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{overflow:auto!important;background:var(--bg);color:var(--text2);font-family:var(--sans);font-size:14px;-webkit-font-smoothing:antialiased}

.page{display:none;padding:16px 20px}
#page-reports{display:block!important}

/* Скроллбар */
::-webkit-scrollbar{width:8px;height:8px}
::-webkit-scrollbar-track{background:var(--s1)}
::-webkit-scrollbar-thumb{background:var(--border2);border-radius:4px}
::-webkit-scrollbar-thumb:hover{background:var(--text3)}

/* Кнопки — Inter, скруглённые */
.btn{
  display:inline-flex;align-items:center;gap:5px;
  background:var(--s2);border:1px solid var(--border2);color:var(--text2);
  font-family:var(--sans);font-size:.75rem;font-weight:500;
  padding:6px 12px;cursor:pointer;border-radius:var(--radius);
  transition:all .15s;white-space:nowrap;letter-spacing:.01em}
.btn:hover{color:var(--text);border-color:var(--acc);background:var(--acc-dim)}
.btn-sm{font-size:.7rem;padding:4px 10px}
.btn-p,.btn-primary{border-color:var(--acc);color:var(--acc);background:var(--acc-dim)}
.btn-p:hover,.btn-primary:hover{background:var(--acc);color:var(--bg)}
.btn-d,.btn-danger{border-color:var(--danger);color:var(--danger);background:transparent}
.btn-d:hover{background:var(--danger-dim)}
.btn.active,.btn-sm.active{border-color:var(--acc);color:var(--acc);background:var(--acc-dim)}
.rep-tf-btn{font-size:.68rem;padding:3px 10px;border-radius:20px}
.rep-tf-btn.active{border-color:var(--acc);color:var(--acc);background:var(--acc-dim)}

/* Текст */
.page-title{font-family:var(--serif);font-size:1.5rem;color:var(--acc);margin-bottom:2px;font-weight:600}
.page-sub{font-size:.65rem;letter-spacing:.1em;text-transform:uppercase;color:var(--text3);margin-bottom:14px}

/* Инпуты */
input,select,textarea{
  background:var(--s2);border:1px solid var(--border2);color:var(--text);
  font-family:var(--sans);font-size:.8rem;padding:6px 10px;
  outline:none;border-radius:var(--radius);transition:border .15s}
input:focus,select:focus{border-color:var(--acc);box-shadow:0 0 0 2px rgba(0,212,255,.1)}
input::placeholder{color:var(--text3)}
select option{background:var(--s1);color:var(--text)}

/* Таблицы */
table{width:100%;border-collapse:collapse;font-size:.75rem;font-family:var(--mono)}
th{color:var(--text3);font-weight:500;text-align:left;padding:6px 10px;
  border-bottom:1px solid var(--border2);letter-spacing:.06em;
  text-transform:uppercase;font-size:.62rem;font-family:var(--sans)}
td{padding:5px 10px;border-bottom:1px solid var(--border);color:var(--text2);vertical-align:top}
tr:hover td{background:var(--s2);color:var(--text)}
.num{text-align:right;font-variant-numeric:tabular-nums}

/* Карточки */
.rep-card,.card{
  background:var(--s1);border:1px solid var(--border);
  border-radius:var(--radius-md);padding:14px 16px;margin-bottom:10px;
  box-shadow:0 1px 0 rgba(255,255,255,.02) inset,0 4px 16px -8px rgba(0,0,0,.5)}
.section-title,.rep-sec-title{
  font-size:.62rem;letter-spacing:.12em;text-transform:uppercase;
  color:var(--acc);margin:14px 0 8px;padding-left:8px;
  border-left:2px solid var(--acc);font-family:var(--sans);font-weight:600}

/* Бейджи */
.badge{font-size:.65rem;padding:2px 7px;border-radius:20px;
  background:var(--s2);border:1px solid var(--border2);color:var(--text3);font-family:var(--sans)}
.badge.ok{background:var(--green-dim);border-color:rgba(34,211,160,.3);color:var(--green)}
.badge.err{background:var(--danger-dim);border-color:rgba(255,77,109,.3);color:var(--danger)}
.badge.warn{background:rgba(245,166,35,.1);border-color:rgba(245,166,35,.3);color:var(--warn)}

/* Сайдбар эмитентов */
.rep-sidebar{width:230px;flex-shrink:0;border-right:1px solid var(--border);
  background:var(--s1);overflow-y:auto;max-height:calc(100vh - 120px)}
.rep-issuer-item{padding:8px 14px;cursor:pointer;font-size:.75rem;color:var(--text2);
  border-left:2px solid transparent;transition:all .12s;font-family:var(--sans)}
.rep-issuer-item:hover{color:var(--text);background:var(--s2);border-left-color:var(--border2)}
.rep-issuer-item.active{color:var(--acc);background:var(--acc-dim);border-left-color:var(--acc)}

/* Модалки */
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:1000;
  display:none;align-items:center;justify-content:center}
.modal-overlay.open{display:flex}
.modal-box{background:var(--s1);border:1px solid var(--border2);
  border-radius:var(--radius-lg);padding:24px;min-width:380px;
  max-width:90vw;max-height:90vh;overflow-y:auto;
  box-shadow:0 8px 32px rgba(0,0,0,.6)}
.modal-title{font-family:var(--serif);font-size:1.15rem;color:var(--acc);
  margin-bottom:16px;font-weight:600}

/* Утилиты */
.text-muted{color:var(--text3)}.text-acc{color:var(--acc)}
.text-green{color:var(--green)}.text-danger{color:var(--danger)}.text-warn{color:var(--warn)}
.flex{display:flex}.gap-6{gap:6px}.gap-10{gap:10px}.flex-wrap{flex-wrap:wrap}
.mt-8{margin-top:8px}.mb-8{margin-bottom:8px}

/* Дополнительное из оригинала */
.dossier-pill{display:inline-block;padding:2px 8px;font-size:.62rem;border-radius:20px;font-weight:500}
.dossier-pill.ok{background:var(--green-dim);color:var(--green)}
.dossier-pill.warn{background:rgba(245,166,35,.1);color:var(--warn)}
.dossier-pill.err{background:var(--danger-dim);color:var(--danger)}
.dossier-pill.nd{background:var(--s2);color:var(--text3)}
`;

// localStorage прокси — если браузер блокирует в blob-iframe
const lsProxy = `
(function(){
  var _ok = true;
  try { localStorage.getItem('__test__'); } catch(e){ _ok = false; }
  if(_ok) return;
  // Блокировка localStorage — используем in-memory + синк с shell через postMessage
  var _store = {};
  var _fake = {
    getItem:    function(k){ return k in _store ? _store[k] : null; },
    setItem:    function(k,v){ _store[k]=String(v); try{window.parent.postMessage({type:'DB_WRITE',key:k,value:String(v)},'*');}catch(e){} },
    removeItem: function(k){ delete _store[k]; },
    clear:      function(){ _store={}; },
    key:        function(i){ return Object.keys(_store)[i]||null; },
    get length(){ return Object.keys(_store).length; }
  };
  try{ Object.defineProperty(window,'localStorage',{value:_fake,writable:false,configurable:true}); }catch(e){}
  // Запросить начальные данные у shell
  ['ba_v2','bondan_refs','bondan_girbo_proxy','ba_apikey','bondan_windows'].forEach(function(k){
    var reqId = 'ls_init_'+k;
    window.parent.postMessage({type:'DB_READ',reqId:reqId,key:k},'*');
  });
  window.addEventListener('message',function(e){
    var d=e.data; if(!d) return;
    if(d.type==='DB_RESPONSE' && d.key && d.value!==undefined && d.value!==null){
      _store[d.key] = typeof d.value==='string' ? d.value : JSON.stringify(d.value);
    }
  });
})();
`;

const innSearchWidget = `
<div style="display:flex;gap:6px;align-items:center;margin-top:6px">
  <input id="rep-inn-search-input" type="text" placeholder="ИНН или название..."
    style="width:260px" onkeydown="if(event.key==='Enter')repDiagnoseInn()">
  <button class="btn btn-sm" onclick="repDiagnoseInn()">Диагностика</button>
</div>`;

reportsHtmlRaw = reportsHtmlRaw.replace(
  /(<button[^>]*onclick="repDiagnoseInn\(\)"[^>]*>[\s\S]*?<\/button>)/,
  '$1' + innSearchWidget
);

// ── Filter panel JS injected after jsText ──────────────────────────────────
const filterJs = `
window._repFilter = { ratings: [], industries: [], mults: {} };

var _FILTER_RATINGS = ['AAA','AA+','AA','AA-','A+','A','A-','BBB+','BBB','BBB-','BB+','BB','BB-','B+','B','B-','CCC','D','none'];

var _FILTER_IND_GROUPS = [
  { label:'Ресурсы и сырьё', items:[{id:'agro',label:'Агро'},{id:'metals',label:'Металлы'},{id:'oil-gas',label:'Нефть/газ'}] },
  { label:'Промышленность', items:[{id:'auto',label:'Авто'},{id:'wood',label:'Дерево'},{id:'machinery',label:'Машиностроение'},{id:'furniture',label:'Мебель'},{id:'metalware',label:'Металлоизделия'},{id:'plastics',label:'Пластмассы'},{id:'building-mat',label:'Стройматериалы'},{id:'textile',label:'Текстиль'},{id:'pharma',label:'Фармацевтика'},{id:'chemistry',label:'Химия'},{id:'electronics',label:'Электроника'}] },
  { label:'Энергетика и ЖКХ', items:[{id:'utilities',label:'Электроэнергетика'}] },
  { label:'Стройка', items:[{id:'realestate',label:'Недвижимость'},{id:'construction',label:'Строительство'}] },
  { label:'Торговля', items:[{id:'retail',label:'Ритейл'}] },
  { label:'Транспорт', items:[{id:'logistics',label:'Транспорт/логистика'}] },
  { label:'IT и медиа', items:[{id:'media',label:'Медиа'},{id:'telecom',label:'Телеком'},{id:'it',label:'IT'}] },
  { label:'Финансы', items:[{id:'banks',label:'Банки'},{id:'leasing',label:'Лизинг'},{id:'mfo',label:'МФО'},{id:'insurance',label:'Страхование'},{id:'holdings',label:'Холдинги'}] },
  { label:'Услуги', items:[{id:'rental',label:'Аренда'},{id:'hospitality',label:'Гостиницы'},{id:'healthcare',label:'Медицина'},{id:'entertainment',label:'Развлечения'},{id:'science',label:'Наука'},{id:'education',label:'Образование'},{id:'consulting',label:'Консалтинг'},{id:'services-etc',label:'Прочие услуги'}] },
  { label:'Прочее', items:[{id:'other',label:'Прочее'}] }
];

var _FILTER_MULTS = [
  { id:'de',         label:'Долг/EBITDA',       fmt:'x', tip:'≤3 норма, >5 риск' },
  { id:'nde',        label:'Чист.долг/EBITDA',  fmt:'x', tip:'(Долг−Кэш)/EBITDA' },
  { id:'icr',        label:'ICR',               fmt:'x', tip:'EBIT/Проценты. ≥3 хорошо' },
  { id:'roa',        label:'ROA, %',            fmt:'%', tip:'ЧП/Активы×100' },
  { id:'ebitdaMarg', label:'EBITDA-маржа, %',   fmt:'%', tip:'EBITDA/Выручка×100' },
  { id:'currentR',   label:'Current Ratio',     fmt:'x', tip:'ОА/КО. ≥1.2 хорошо' },
  { id:'cashR',      label:'Cash Ratio',        fmt:'x', tip:'Кэш/КО' },
  { id:'equityR',    label:'Equity Ratio, %',   fmt:'%', tip:'Капитал/Активы×100' },
];

function _repInjectFilterPanel() {
  var sidebar = document.getElementById('rep-sidebar');
  if (!sidebar || document.getElementById('rep-filter-extra')) return;
  var wrap = document.createElement('div');
  wrap.id = 'rep-filter-extra';
  sidebar.appendChild(wrap);
  _repFilterRender();
}

function _repFilterRender() {
  var el = document.getElementById('rep-filter-extra');
  if (!el) return;
  var f = window._repFilter;
  var hasFilter = f.ratings.length || f.industries.length ||
    Object.values(f.mults).some(function(m){ return m && (m.min !== '' || m.max !== ''); });

  var ratHtml = _FILTER_RATINGS.map(function(r) {
    var on = f.ratings.indexOf(r) !== -1;
    var lbl = r === 'none' ? 'без рейтинга' : r;
    return '<button type="button" onclick="_repFilterToggleRating(\\'' + r + '\\')" style="padding:1px 5px;border-radius:12px;font-size:.5rem;font-family:var(--mono);border:1px solid ' + (on?'var(--acc)':'var(--border2)') + ';background:' + (on?'var(--acc-dim)':'var(--s2)') + ';color:' + (on?'var(--acc)':'var(--text3)') + ';cursor:pointer;margin:1px;white-space:nowrap">' + lbl + '</button>';
  }).join('');

  var indHtml = _FILTER_IND_GROUPS.map(function(g) {
    return '<div style="font-size:.48rem;color:var(--text3);text-transform:uppercase;letter-spacing:.08em;margin:4px 0 2px;font-family:var(--sans)">' + g.label + '</div>' +
      g.items.map(function(it) {
        var on = f.industries.indexOf(it.id) !== -1;
        return '<button type="button" onclick="_repFilterToggleInd(\\'' + it.id + '\\')" style="padding:1px 5px;border-radius:12px;font-size:.5rem;font-family:var(--mono);border:1px solid ' + (on?'var(--acc)':'var(--border2)') + ';background:' + (on?'var(--acc-dim)':'var(--s2)') + ';color:' + (on?'var(--acc)':'var(--text3)') + ';cursor:pointer;margin:1px;white-space:nowrap">' + it.label + '</button>';
      }).join('');
  }).join('');

  var multHtml = _FILTER_MULTS.map(function(m) {
    var mf = f.mults[m.id] || {min:'',max:''};
    return '<div style="display:flex;align-items:center;gap:3px;margin-bottom:3px">' +
      '<span title="' + m.tip + '" style="font-size:.52rem;font-family:var(--mono);color:var(--text2);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:help">' + m.label + '</span>' +
      '<input type="number" step="any" placeholder="min" value="' + (mf.min||'') + '" oninput="_repFilterSetMult(\\'' + m.id + '\\',\\'min\\',this.value)" style="width:42px;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:2px 4px;font-size:.52rem;font-family:var(--mono);color:var(--text);outline:none">' +
      '<span style="color:var(--text3);font-size:.5rem">–</span>' +
      '<input type="number" step="any" placeholder="max" value="' + (mf.max||'') + '" oninput="_repFilterSetMult(\\'' + m.id + '\\',\\'max\\',this.value)" style="width:42px;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:2px 4px;font-size:.52rem;font-family:var(--mono);color:var(--text);outline:none">' +
      '<span style="color:var(--text3);font-size:.48rem;width:10px;text-align:right">' + m.fmt + '</span>' +
      '</div>';
  }).join('');

  el.innerHTML =
    '<div style="border-top:1px solid var(--border);margin-top:6px;padding-top:6px">' +
    '<div style="display:flex;align-items:center;gap:4px;margin-bottom:6px">' +
      '<span style="font-size:.54rem;color:var(--text3);text-transform:uppercase;letter-spacing:.1em;font-family:var(--sans);flex:1">Фильтр по эмитенту</span>' +
      (hasFilter ? '<button type="button" onclick="_repFilterReset()" style="font-size:.5rem;color:var(--danger);background:none;border:none;cursor:pointer;font-family:var(--mono);padding:0">сброс</button>' : '') +
    '</div>' +
    '<div style="margin-bottom:8px">' +
      '<div style="font-size:.48rem;color:var(--text3);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px;font-family:var(--sans)">Рейтинг</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:1px">' + ratHtml + '</div>' +
    '</div>' +
    '<details style="margin-bottom:6px">' +
      '<summary style="font-size:.5rem;color:var(--text3);text-transform:uppercase;letter-spacing:.08em;cursor:pointer;font-family:var(--sans);list-style:none;display:flex;align-items:center;gap:4px;outline:none">' +
        '<span style="color:var(--acc)">▸</span><span>Отрасли</span>' +
        (f.industries.length ? '<span style="color:var(--acc);font-size:.48rem">' + f.industries.length + ' выбрано</span>' : '') +
      '</summary>' +
      '<div style="margin-top:6px">' + indHtml + '</div>' +
    '</details>' +
    '<details open style="margin-bottom:4px">' +
      '<summary style="font-size:.5rem;color:var(--text3);text-transform:uppercase;letter-spacing:.08em;cursor:pointer;font-family:var(--sans);list-style:none;display:flex;align-items:center;gap:4px;outline:none;margin-bottom:6px">' +
        '<span style="color:var(--acc)">▸</span><span>Мультипликаторы</span>' +
      '</summary>' +
      multHtml +
    '</details>' +
    '</div>';
}

function _repFilterToggleRating(r) {
  var f = window._repFilter;
  var idx = f.ratings.indexOf(r);
  if (idx === -1) f.ratings.push(r); else f.ratings.splice(idx, 1);
  _repFilterRender();
  repRenderIssuerList();
}

function _repFilterToggleInd(id) {
  var f = window._repFilter;
  var idx = f.industries.indexOf(id);
  if (idx === -1) f.industries.push(id); else f.industries.splice(idx, 1);
  _repFilterRender();
  repRenderIssuerList();
}

function _repFilterSetMult(mid, key, val) {
  var f = window._repFilter;
  if (!f.mults[mid]) f.mults[mid] = {min:'',max:''};
  f.mults[mid][key] = val;
  repRenderIssuerList();
}

function _repFilterReset() {
  window._repFilter = { ratings: [], industries: [], mults: {} };
  _repFilterRender();
  repRenderIssuerList();
}

function _repFilterMatch(id, iss) {
  var f = window._repFilter || {};
  if (f.industries && f.industries.length > 0) {
    if (f.industries.indexOf(iss.ind || 'other') === -1) return false;
  }
  if (f.ratings && f.ratings.length > 0) {
    var issRatings = (iss.ratings || []).map(function(r){ return r && r.rating; }).filter(Boolean);
    var hasMatch = issRatings.some(function(r){ return f.ratings.indexOf(r) !== -1; });
    var wantsNone = f.ratings.indexOf('none') !== -1;
    if (!hasMatch && !(wantsNone && issRatings.length === 0)) return false;
  }
  if (f.mults) {
    var calcM = _repCalcMultipliers(iss);
    var lp = _repLatestPeriod(iss);
    var p = lp ? lp.period : null;
    var allMults = {
      de: calcM.de,
      icr: calcM.icr,
      currentR: calcM.cur,
      cashR: calcM.cashR,
      equityR: calcM.eqr != null ? calcM.eqr * 100 : null,
      nde: (p && p.ebitda != null && p.ebitda !== 0) ? ((p.debt||0) - (p.cash||0)) / p.ebitda : null,
      roa: (p && p.assets) ? ((p.np||0) / p.assets * 100) : null,
      ebitdaMarg: (p && p.rev) ? ((p.ebitda||0) / p.rev * 100) : null,
    };
    for (var mid in f.mults) {
      var mf = f.mults[mid];
      if (!mf) continue;
      var val = allMults[mid];
      if (val == null || !isFinite(val)) continue;
      if (mf.min !== '' && mf.min !== null && val < parseFloat(mf.min)) return false;
      if (mf.max !== '' && mf.max !== null && val > parseFloat(mf.max)) return false;
    }
  }
  return true;
}

function _repFilterApplyDOM() {
  var f = window._repFilter || {};
  var hasRating = f.ratings && f.ratings.length > 0;
  var hasInd = f.industries && f.industries.length > 0;
  var hasMult = f.mults && Object.values(f.mults).some(function(m){ return m && (m.min !== '' || m.max !== ''); });
  if (!hasRating && !hasInd && !hasMult) return;
  var listEl = document.getElementById('rep-sidebar-list');
  if (!listEl) return;
  var items = listEl.querySelectorAll('[onclick]');
  var shown = 0;
  items.forEach(function(el) {
    var oc = el.getAttribute('onclick') || '';
    var m2 = oc.match(/repSelectIssuerById\\('([^']+)'\\)/);
    if (!m2) { shown++; return; }
    var issId = m2[1];
    var iss = (window.reportsDB || {})[issId];
    if (iss && _repFilterMatch(issId, iss)) { el.style.display = ''; shown++; }
    else el.style.display = 'none';
  });
  var cnt = document.getElementById('rep-sidebar-count');
  if (cnt) cnt.textContent = String(shown);
}

// Monkeypatch repRenderIssuerList to apply extra DOM filter pass
(function(){
  var _orig = repRenderIssuerList;
  window.repRenderIssuerList = function() {
    _orig();
    _repFilterApplyDOM();
  };
})();
`;

const out = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>База отчётности</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400&display=swap" rel="stylesheet">
<style>${shellCss}</style>
</head>
<body>

<div style="display:none">
  <span id="sb-rep">0</span>
  <input id="rep-dyn-from"><input id="rep-dyn-to">
  <input id="api-key-input">
</div>

${reportsHtmlRaw}

<script>
${lsProxy}

(function(){
  var _orig = document.getElementById.bind(document);
  var _dummy = {
    value:'',textContent:'',innerHTML:'',checked:false,disabled:false,
    selectedIndex:0,selectedOptions:[],
    style:new Proxy({},{get:function(){return '';},set:function(){return true;}}),
    classList:{add:function(){},remove:function(){},toggle:function(){return false;},contains:function(){return false;}},
    options:{length:0,add:function(){}},
    addEventListener:function(){},removeEventListener:function(){},
    focus:function(){},click:function(){},select:function(){},
    appendChild:function(){return this;},querySelector:function(){return null;},
    querySelectorAll:function(){return [];},closest:function(){return null;},
    getBoundingClientRect:function(){return {top:0,left:0,width:0,height:0};},
    contains:function(){return false;},matches:function(){return false;},
    dispatchEvent:function(){return false;}
  };
  document.getElementById = function(id){ return _orig(id)||_dummy; };
})();

function showPage(){}
function renderYtm(){}
function renderPort(){}
function renderPortCharts(){}
function renderWL(){}
function renderSbLists(){}
function renderCalendar(){}
function renderCalendarMonth(){}
function renderEventCard(){}
function renderIssuer(){}
function ytmInit(){}
function calInit(){}
function industriesInit(){}
function compareInit(){}
function portfolioInit(){}
function issuerInit(){}

${jsText}

${filterJs}

showPage = function(){
  var rp = document.getElementById('page-reports');
  if(rp) rp.style.display = '';
};

// Запуск — даём localStorage-прокси 200мс заполниться данными от shell
setTimeout(function(){
  try { loadState(); } catch(e){ console.warn('loadState:',e); }
  try { repInit(); } catch(e){ console.error('repInit:',e); }
  setTimeout(_repInjectFilterPanel, 80);
}, 200);

window.addEventListener('message',function(e){
  var d=e.data; if(!d) return;
  if(d.type==='SHELL_STATE'){
    if(d.token) try{ localStorage.setItem('ba_apikey',d.token); }catch(ex){}
  }
});
<\/script>
</body>
</html>`;

fs.writeFileSync('/home/user/Ti/modules/reports-full.html', out);
console.log('Size:', Math.round(Buffer.byteLength(out)/1024)+'KB');
