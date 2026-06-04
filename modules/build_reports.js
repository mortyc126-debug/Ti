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

// ── Заменяем sidebar целиком новой структурой (D1 + поиск + фильтры) ──────
const newSidebar = `<div id="rep-sidebar" style="width:340px;flex-shrink:0;position:sticky;top:8px;max-height:calc(100vh - 100px);display:flex;flex-direction:column;background:var(--s1);border:1px solid var(--border);border-radius:var(--radius-md);overflow:hidden">

  <!-- Строка 1: загрузка D1 + счётчик + источники -->
  <div style="display:flex;align-items:center;gap:4px;padding:8px 8px 4px;flex-shrink:0">
    <button id="rep-d1-load-btn" type="button" onclick="_repD1Load()" style="flex:1;font-size:.62rem;font-family:var(--sans);font-weight:600;padding:5px 10px;border:1px solid var(--acc);border-radius:var(--radius);background:var(--acc-dim);color:var(--acc);cursor:pointer;letter-spacing:.02em;text-transform:uppercase;transition:all .15s">↓ Загрузить базу</button>
    <span id="rep-sidebar-count" style="font-size:.52rem;color:var(--text3);min-width:28px;text-align:center;font-family:var(--mono)">0</span>
    <button type="button" onclick="_repSourcesModal()" title="Источники данных, импорт, инструменты" style="width:28px;height:28px;border:1px solid var(--border2);border-radius:var(--radius);background:var(--s2);color:var(--text3);cursor:pointer;font-size:.8rem;line-height:1;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all .15s">⚙</button>
  </div>
  <!-- Строка статуса загрузки -->
  <div id="rep-d1-log" style="display:none;padding:2px 8px 5px;font-size:.54rem;color:var(--text3);font-family:var(--mono);line-height:1.4;border-bottom:1px solid var(--border)"></div>

  <!-- Строка 2: поиск с выпадашкой -->
  <div style="position:relative;padding:0 8px 6px;flex-shrink:0">
    <input id="rep-search-main" type="search" placeholder="Поиск: эмитент, ИНН, облигация…"
      oninput="_repSearchInput(this.value)"
      onfocus="if(this.value.trim())_repSearchDropRender(this.value.trim())"
      style="width:100%;background:var(--bg);border:1px solid var(--border2);color:var(--text);font-family:var(--mono);font-size:.65rem;padding:6px 10px;outline:none;border-radius:var(--radius)">
    <div id="rep-search-drop" style="display:none;position:absolute;left:8px;right:8px;top:calc(100% - 4px);background:var(--s1);border:1px solid var(--border2);border-radius:var(--radius-md);z-index:200;max-height:320px;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,.5)"></div>
    <!-- скрыт, нужен repRenderIssuerList для чтения текста поиска -->
    <input id="rep-sidebar-search" value="" style="display:none" oninput="repRenderIssuerList()">
  </div>

  <!-- Collapsible: фильтры и сортировка -->
  <details id="rep-filter-details" style="border-top:1px solid var(--border);border-bottom:1px solid var(--border);flex-shrink:0">
    <summary style="display:flex;align-items:center;gap:6px;padding:6px 8px;cursor:pointer;font-size:.52rem;color:var(--text3);text-transform:uppercase;letter-spacing:.1em;font-family:var(--sans);font-weight:600;background:var(--s2);list-style:none;outline:none;user-select:none" onclick="var a=document.getElementById('rep-filter-arrow');if(a)setTimeout(function(){a.textContent=document.getElementById('rep-filter-details').open?'▾':'▸'},0)">
      <span id="rep-filter-arrow" style="color:var(--acc);font-size:.65rem">▸</span>
      <span>Фильтры</span>
      <span id="rep-filter-badge" style="margin-left:auto;font-size:.46rem;color:var(--acc);background:var(--acc-dim);padding:1px 6px;border-radius:10px;display:none">●</span>
    </summary>
    <div style="padding:8px;display:flex;flex-direction:column;gap:6px;background:var(--s1);overflow-y:auto;max-height:55vh">
      <label style="display:flex;gap:4px;align-items:center">
        <span style="font-size:.5rem;color:var(--text3);white-space:nowrap;font-family:var(--sans)">Сорт:</span>
        <select id="rep-sidebar-sort" onchange="repRenderIssuerList()" style="flex:1;background:var(--bg);border:1px solid var(--border2);color:var(--text);font-family:var(--mono);font-size:.58rem;padding:3px 5px;outline:none;border-radius:var(--radius)">
          <option value="name_asc">Имя А → Я</option>
          <option value="name_desc">Имя Я → А</option>
          <option value="year_desc">Свежесть (новые сверху)</option>
          <option value="roe_best">ROE (лучшие)</option>
          <option value="roe_worst">ROE (худшие)</option>
          <option value="de_best">Долг/EBITDA (лучшие)</option>
          <option value="de_worst">Долг/EBITDA (худшие)</option>
          <option value="icr_best">ICR (лучшие)</option>
          <option value="icr_worst">ICR (худшие)</option>
          <option value="dde_best">D/E (лучшие)</option>
          <option value="dde_worst">D/E (худшие)</option>
        </select>
      </label>
      <label style="display:flex;gap:4px;align-items:center">
        <span style="font-size:.5rem;color:var(--text3);white-space:nowrap;font-family:var(--sans)">Данные:</span>
        <select id="rep-sidebar-status" onchange="repRenderIssuerList()" style="flex:1;background:var(--bg);border:1px solid var(--border2);color:var(--text);font-family:var(--mono);font-size:.58rem;padding:3px 5px;outline:none;border-radius:var(--radius)">
          <option value="corp_moex" selected>корпоративные (MOEX)</option>
          <option value="has_moex">все с бумагами на MOEX</option>
          <option value="all">все</option>
          <option value="has_periods">есть периоды</option>
          <option value="no_periods">нет периодов</option>
          <option value="only_inn">только ИНН, пусто</option>
          <option value="no_inn">без ИНН</option>
          <option value="stale">нет свежего (&gt;2 лет)</option>
          <option value="no_moex">нет бумаг на MOEX</option>
          <option value="spv_no_parent">SPV без матери</option>
        </select>
      </label>
      <label style="display:flex;gap:4px;align-items:center">
        <span style="font-size:.5rem;color:var(--text3);white-space:nowrap;font-family:var(--sans)">Отрасль:</span>
        <select id="rep-sidebar-industry" onchange="repRenderIssuerList()" style="flex:1;background:var(--bg);border:1px solid var(--border2);color:var(--text);font-family:var(--mono);font-size:.58rem;padding:3px 5px;outline:none;border-radius:var(--radius)">
          <option value="all">все</option>
        </select>
      </label>
      <div>
        <div style="font-size:.5rem;color:var(--text3);margin-bottom:3px;font-family:var(--sans)">Год последнего отчёта:</div>
        <div id="rep-sidebar-years" style="display:flex;gap:2px;flex-wrap:wrap"></div>
      </div>
      <!-- расширенный фильтр: рейтинги / отрасли-пилюли / мультипликаторы -->
      <div id="rep-filter-extra"></div>
    </div>
  </details>

  <!-- Список эмитентов -->
  <div id="rep-sidebar-list" style="overflow-y:auto;flex:1;padding:4px;min-height:120px">
  </div>
</div>`;

// Заменяем sidebar в reportsHtmlRaw
reportsHtmlRaw = reportsHtmlRaw.replace(
  /<div id="rep-sidebar"[\s\S]*?<\/div>\s*(?=<div style="flex:1;min-width:0">)/,
  newSidebar + '\n'
);

// Скрываем кнопки тулбара которые переехали в модалку ⚙
// [^<]* вместо [^>]* — не ломается на > внутри title атрибутов
const toolbarHideOnclick = [
  'openGirboImportModal', 'openAuditItImportModal', 'repOpenMergeModal',
  'repRunAudit', 'repImportAffiliatedFromClipboard', 'repCleanEmptyPeriods',
  'repDiagnoseInn',
];
for (const fn of toolbarHideOnclick) {
  reportsHtmlRaw = reportsHtmlRaw.replace(
    new RegExp(`<button[^<]*onclick="${fn}\\(\\)"[^<]*<\\/button>`, 'g'),
    ''
  );
}
// Скрываем весь первый тулбар (верхняя строка — Удалить / Диагностика / ИНН-виджет)
reportsHtmlRaw = reportsHtmlRaw.replace(
  /<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">[\s\S]*?<\/div>/,
  ''
);

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
  --bg:#0B0613;
  --panel:#140A24;
  --card:#1A1030;
  --s1:#140A24;
  --s2:#1A1030;
  --s3:#221640;
  --border:rgba(255,255,255,0.06);
  --border2:rgba(255,0,128,0.12);
  --brd:rgba(255,255,255,0.06);
  --brdm:rgba(255,0,128,0.12);
  --brdp:rgba(170,90,255,0.12);
  --acc:#FF006E;
  --acc2:#cc0058;
  --acc-dim:rgba(255,0,110,.08);
  --pur:#AA5AFF;
  --green:#52F2C9;
  --green-dim:rgba(82,242,201,.1);
  --warn:#E8895A;
  --danger:#FF4D7A;
  --danger-dim:rgba(255,77,122,.1);
  --purple:#AA5AFF;
  --pos:#52F2C9;
  --neg:#FF4D7A;
  --text:#F2F0FF;
  --text1:#F2F0FF;
  --text2:#A79BC9;
  --text3:#6F648F;
  --t:#F2F0FF;
  --t2:#A79BC9;
  --t3:#6F648F;
  --t4:#7E74A8;
  --glow:0 0 0 1px rgba(255,0,140,0.05),0 0 18px rgba(255,0,140,0.06),inset 0 0 20px rgba(255,255,255,0.01);
  --mono:'JetBrains Mono',ui-monospace,monospace;
  --sans:'Inter',ui-sans-serif,system-ui,sans-serif;
  --serif:'Cormorant Garamond',Georgia,serif;
  --radius:0px;
  --radius-md:0px;
  --radius-lg:0px;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{overflow:auto!important;background:linear-gradient(180deg,#0A0615 0%,#0D0718 35%,#12091F 100%);color:var(--text2);font-family:var(--sans);font-size:13px;-webkit-font-smoothing:antialiased}

.page{display:none;padding:16px 20px}
#page-reports{display:block!important}

/* Скроллбар */
::-webkit-scrollbar{width:8px;height:8px}
::-webkit-scrollbar-track{background:var(--s1)}
::-webkit-scrollbar-thumb{background:var(--border2);border-radius:4px}
::-webkit-scrollbar-thumb:hover{background:var(--text3)}

/* Кнопки */
.btn{
  display:inline-flex;align-items:center;gap:5px;
  background:rgba(255,255,255,0.02);border:1px solid var(--brd);color:var(--text2);
  font-family:var(--sans);font-size:.72rem;font-weight:600;
  padding:5px 12px;cursor:pointer;border-radius:0;
  transition:all .13s;white-space:nowrap;letter-spacing:.04em}
.btn:hover{color:var(--text);border-color:var(--brdp);background:rgba(255,255,255,0.04)}
.btn-sm{font-size:.65rem;padding:3px 8px}
.btn-p,.btn-primary,.btn-acc{border-color:rgba(255,0,110,.4);color:var(--acc);background:rgba(255,0,110,.08)}
.btn-p:hover,.btn-primary:hover,.btn-acc:hover{background:rgba(255,0,110,.15)}
.btn-d,.btn-danger{border-color:rgba(255,77,122,.3);color:var(--danger);background:transparent}
.btn-d:hover{background:var(--danger-dim)}
.btn.active,.btn-sm.active{border-color:var(--acc);color:var(--acc);background:var(--acc-dim)}
.rep-tf-btn{font-size:.65rem;padding:2px 8px;border-radius:0}
.rep-tf-btn.active{border-color:var(--acc);color:var(--acc);background:var(--acc-dim)}

/* Текст */
.page-title{font-family:var(--serif);font-size:1.4rem;color:var(--acc);margin-bottom:2px;font-weight:600}
.page-sub{font-size:.6rem;letter-spacing:.12em;text-transform:uppercase;color:var(--t3);margin-bottom:14px}

/* Инпуты */
input,select,textarea{
  background:var(--bg);border:1px solid var(--brdp);color:var(--text);
  font-family:var(--sans);font-size:.75rem;padding:5px 9px;
  outline:none;border-radius:0;transition:border .15s}
input:focus,select:focus{border-color:rgba(255,0,110,.5);box-shadow:none}
input::placeholder{color:var(--t3)}
select option{background:var(--panel);color:var(--text)}

/* Таблицы */
table{width:100%;border-collapse:collapse;font-size:.72rem;font-family:var(--mono)}
th{color:var(--t3);font-weight:600;text-align:left;padding:6px 10px;
  border-bottom:1px solid var(--brd);letter-spacing:.1em;
  text-transform:uppercase;font-size:.58rem;font-family:var(--sans)}
td{padding:5px 10px;border-bottom:1px solid var(--brd);color:var(--t2);vertical-align:top}
tr:hover td{background:rgba(255,255,255,0.012);color:var(--text)}
.num{text-align:right;font-variant-numeric:tabular-nums}

/* Карточки */
.rep-card,.card{
  background:var(--panel);border:1px solid var(--brd);
  border-radius:0;padding:14px 16px;margin-bottom:10px}
.section-title,.rep-sec-title{
  font-size:.58rem;letter-spacing:.14em;text-transform:uppercase;
  color:var(--t4);margin:14px 0 8px;display:flex;align-items:center;gap:9px;
  font-family:var(--sans);font-weight:700}
.section-title::after,.rep-sec-title::after{content:'';flex:1;height:1px;background:var(--brd)}

/* Бейджи */
.badge{font-size:.62rem;padding:1px 6px;border-radius:0;
  background:rgba(255,255,255,0.04);border:1px solid var(--brd);color:var(--t3);font-family:var(--sans)}
.badge.ok{background:rgba(82,242,201,.08);border-color:rgba(82,242,201,.3);color:var(--green)}
.badge.err{background:var(--danger-dim);border-color:rgba(255,77,122,.3);color:var(--danger)}
.badge.warn{background:rgba(232,137,90,.1);border-color:rgba(232,137,90,.3);color:var(--warn)}

/* Сайдбар эмитентов */
.rep-sidebar{width:230px;flex-shrink:0;border-right:1px solid var(--brdm);
  background:var(--panel);overflow-y:auto;max-height:calc(100vh - 120px)}
.rep-issuer-item{padding:8px 9px;cursor:pointer;font-size:.72rem;color:var(--t2);
  border:1px solid var(--brd);border-left:2px solid transparent;
  transition:all .12s;font-family:var(--sans);position:relative;margin-bottom:3px;background:transparent}
.rep-issuer-item:hover{background:rgba(255,255,255,0.016);border-color:var(--brdm)}
.rep-issuer-item[data-active="1"]{background:var(--card);border-color:var(--brdm);box-shadow:var(--glow)}

/* Issuer list items — новый стиль */
.iss-item{padding:8px 9px;border:1px solid var(--brd);margin-bottom:3px;
  cursor:pointer;transition:background .1s,border-color .1s;position:relative;background:transparent}
.iss-item::before{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;
  background:transparent;transition:background .1s}
.iss-item:hover{background:rgba(255,255,255,0.016);border-color:var(--brdm)}
.iss-item[data-active="1"]{background:var(--card);border-color:var(--brdm);box-shadow:var(--glow)}
.iss-item[data-active="1"]::before{background:var(--acc)}
.iss-name{font-size:11px;font-weight:600;color:var(--t);line-height:1.3;margin-bottom:2px;
  display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.iss-meta{font-size:9px;color:var(--t3);font-family:var(--mono);
  display:flex;gap:4px;align-items:center;flex-wrap:wrap;margin-bottom:4px}
.ind-badge{padding:1px 4px;font-size:8.5px;font-weight:600;border:1px solid;border-radius:0}
.rtg-badge{padding:1px 4px;font-size:8.5px;font-family:var(--mono);font-weight:600;border:1px solid;border-radius:0}
.mult-row{display:flex;gap:9px}
.mult-item{display:flex;flex-direction:column;gap:1px}
.mult-lbl{font-size:8px;letter-spacing:.07em;color:var(--t3);text-transform:uppercase}
.mult-val{font-size:10.5px;font-weight:600;font-family:var(--mono)}
.c-pos{color:var(--pos)}.c-warn{color:var(--warn)}.c-neg{color:var(--neg)}

/* Issuer header */
.iss-hdr{padding:16px 20px 14px;border-bottom:1px solid rgba(255,0,128,0.18);
  background:linear-gradient(180deg,rgba(36,20,64,0.95) 0%,rgba(28,14,52,0.85) 100%)}
.iss-hdr-top{display:flex;align-items:flex-start;gap:16px;margin-bottom:11px}
.iss-title-blk{flex:1}
.iss-title{font-size:18px;font-weight:700;color:var(--t);letter-spacing:-.02em;
  display:flex;align-items:center;gap:9px}
.iss-sub{font-size:10px;color:var(--t3);font-family:var(--mono);margin-top:3px;
  display:flex;gap:7px;align-items:center;flex-wrap:wrap}
.iss-actions{display:flex;gap:4px;align-items:center;flex-shrink:0}

/* Score tiles */
.score-row{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:4px}
.score-tile{padding:10px 13px;background:rgba(255,255,255,0.018);border:1px solid var(--brd);
  display:flex;align-items:center;gap:12px}
.score-info{flex:1;min-width:0}
.score-lbl{font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--t3);margin-bottom:5px}
.score-bw{height:2px;background:rgba(255,255,255,0.05);margin-bottom:5px}
.score-b{height:100%;transition:width .55s}
.score-comps{font-size:9px;color:var(--t3);font-family:var(--mono)}
.score-val{font-size:20px;font-weight:700;font-family:var(--mono);letter-spacing:-.03em;flex-shrink:0}

/* Period nav */
.period-nav-new{padding:0 20px;border-bottom:1px solid var(--brd);
  display:flex;align-items:flex-end;gap:2px;background:rgba(20,10,36,0.28);flex-shrink:0}
.ptab{padding:7px 13px;font-size:11px;font-weight:600;cursor:pointer;
  border:1px solid transparent;border-bottom:none;color:var(--t3);background:transparent;
  transition:all .1s;position:relative;display:flex;align-items:center;gap:5px}
.ptab:hover{color:var(--t2);border-color:var(--brdm)}
.ptab.active{background:rgba(26,16,48,0.85);border-color:var(--brdm);color:var(--t)}
.ptab.active::after{content:'';position:absolute;bottom:-1px;left:0;right:0;
  height:1px;background:rgba(26,16,48,0.85)}
.p-badge{font-size:9px;padding:1px 4px;background:rgba(255,255,255,0.04);
  color:var(--t3);border:1px solid rgba(255,255,255,0.05)}
.ptab.active .p-badge{background:rgba(255,0,110,.09);color:var(--acc);border-color:rgba(255,0,110,.22)}

/* Zone accordion */
.zone{margin-bottom:4px;border:1px solid var(--brd);overflow:hidden}
.zone-hdr{display:flex;align-items:stretch;border-bottom:1px solid var(--brd);
  cursor:pointer;background:rgba(255,255,255,0.01);transition:background .1s}
.zone-hdr:hover{background:rgba(255,255,255,0.02)}
.zone-stripe{width:3px;flex-shrink:0}
.zone-inner{flex:1;padding:7px 12px;display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.zone-name{font-size:9.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--t4)}
.zone-summ{display:flex;gap:12px;margin-left:auto;flex-wrap:wrap}
.zone-si{display:flex;align-items:center;gap:3px;font-size:9.5px;font-family:var(--mono)}
.zone-sl{color:var(--t3);font-size:9px;margin-right:2px}
.zone-chev{padding:7px 11px;font-size:9px;color:var(--t3);display:flex;align-items:center;transition:transform .18s}
.zone.collapsed .zone-chev{transform:rotate(-90deg)}
.zone.collapsed .zone-body{display:none}

/* Dynamics row */
.drow{padding:9px 14px;border-bottom:1px solid rgba(255,255,255,0.026);transition:background .08s}
.drow:last-child{border-bottom:none}
.drow:hover{background:rgba(255,255,255,0.013)}
.drow-top{display:flex;align-items:baseline;gap:7px;margin-bottom:5px}
.d-lbl{font-size:11px;color:var(--t2);display:flex;align-items:center;gap:5px;flex:1}
.d-lbl.bold{color:var(--t);font-weight:600}
.d-pct{font-size:11px;font-family:var(--mono);font-weight:700}
.d-vals{display:flex;align-items:baseline;gap:4px;flex-shrink:0;font-family:var(--mono);font-size:10.5px;margin-left:auto}
.d-old{color:var(--t3)}.d-arr{color:var(--t3);font-size:9px}.d-new{font-weight:600;color:var(--t)}
.d-new.red{color:var(--neg)}.d-new.wrn{color:var(--warn)}
.d-bar{height:4px;background:rgba(255,255,255,0.05);position:relative;overflow:hidden}
.d-bar-ax{position:absolute;left:50%;top:0;bottom:0;width:1px;background:rgba(255,255,255,0.2)}
.d-bar-f{position:absolute;top:0;bottom:0}

/* Ratio row */
.rrow{padding:9px 14px;border-bottom:1px solid rgba(255,255,255,0.026);transition:background .08s}
.rrow:last-child{border-bottom:none}
.rrow:hover{background:rgba(255,255,255,0.013)}
.rrow-top{display:flex;align-items:baseline;gap:7px;margin-bottom:5px;flex-wrap:wrap}
.r-norm{margin-left:auto;font-size:9px;color:var(--t3);font-family:var(--mono)}
.r-track{height:5px;background:rgba(255,255,255,0.05);position:relative;overflow:hidden}
.r-zone{position:absolute;top:0;bottom:0}
.r-fill{position:absolute;left:0;top:0;bottom:0}
.r-prev{position:absolute;top:0;bottom:0;width:1px;background:rgba(255,255,255,0.5);z-index:2}
.r-nl{position:absolute;top:0;bottom:0;width:1px;background:rgba(255,255,255,0.2);z-index:1}
/* Засечки: relative container, absolute positions */
.r-ticks{position:relative;height:14px;font-size:8px;font-family:var(--mono);color:var(--t3);margin-top:3px}
.r-tick{position:absolute;transform:translateX(-50%)}
.r-tick-start{position:absolute;left:0;transform:none}
.r-tick-end{position:absolute;right:0;transform:none}

/* Note row */
.note-row{padding:6px 14px;font-size:9px;color:var(--t3);font-family:var(--mono);
  border-bottom:1px solid rgba(255,255,255,0.025);display:flex;align-items:flex-start;gap:6px;
  line-height:1.5;background:rgba(232,137,90,0.03)}
.note-row::before{content:'△';font-size:8px;color:var(--warn);flex-shrink:0;margin-top:1px}

/* Модалки */
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:1000;
  display:none;align-items:center;justify-content:center}
.modal-overlay.open{display:flex}
.modal-box{background:var(--panel);border:1px solid var(--brdp);
  border-radius:0;padding:24px;min-width:380px;
  max-width:90vw;max-height:90vh;overflow-y:auto;
  box-shadow:0 8px 32px rgba(0,0,0,.7)}
.modal-title{font-size:1.1rem;color:var(--acc);
  margin-bottom:16px;font-weight:700}

/* Утилиты */
.text-muted{color:var(--t3)}.text-acc{color:var(--acc)}
.text-green{color:var(--green)}.text-danger{color:var(--danger)}.text-warn{color:var(--warn)}
.flex{display:flex}.gap-6{gap:6px}.gap-10{gap:10px}.flex-wrap{flex-wrap:wrap}
.mt-8{margin-top:8px}.mb-8{margin-bottom:8px}

/* Дополнительное из оригинала */
.dossier-pill{display:inline-block;padding:1px 6px;font-size:.6rem;border-radius:0;font-weight:600}
.dossier-pill.ok{background:rgba(82,242,201,.08);color:var(--green)}
.dossier-pill.warn{background:rgba(232,137,90,.1);color:var(--warn)}
.dossier-pill.err{background:var(--danger-dim);color:var(--danger)}
.dossier-pill.nd{background:rgba(255,255,255,.04);color:var(--t3)}

/* Поиск — выпадающий список */
#rep-search-drop{position:absolute;left:0;right:0;top:100%;margin-top:2px;
  background:var(--panel);border:1px solid var(--brdp);border-radius:0;
  z-index:200;max-height:340px;overflow-y:auto;
  box-shadow:0 8px 24px rgba(0,0,0,.6)}
#rep-search-drop .sd-group{padding:4px 8px 2px;font-size:.46rem;color:var(--t3);
  text-transform:uppercase;letter-spacing:.1em;font-family:var(--sans);border-top:1px solid var(--brd)}
#rep-search-drop .sd-item{display:flex;align-items:center;gap:6px;padding:5px 10px;
  cursor:pointer;font-size:.65rem;transition:background .1s}
#rep-search-drop .sd-item:hover{background:rgba(255,255,255,0.03)}
#rep-search-drop .sd-item .sd-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--t)}
#rep-search-drop .sd-item .sd-sub{font-size:.54rem;color:var(--t3);font-family:var(--mono);white-space:nowrap}
#rep-search-drop .sd-item .sd-acc{font-size:.58rem;color:var(--acc);font-family:var(--mono);white-space:nowrap}

/* Сайдбар */
details summary::-webkit-details-marker{display:none}
details summary{outline:none}
::-webkit-scrollbar{width:3px;height:3px}
::-webkit-scrollbar-track{background:var(--panel)}
::-webkit-scrollbar-thumb{background:var(--brdp);border-radius:0}
::-webkit-scrollbar-thumb:hover{background:var(--acc-dim)}
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

// ══════════════════════════════════════════════════════════════════════
// JS-блок: D1 загрузка, поиск, сайдбар, фильтр, модалка источников
// ══════════════════════════════════════════════════════════════════════
const extJs = `
// ── D1 API base ────────────────────────────────────────────────────
var _d1Base = null;
function _getD1Base(){
  if(_d1Base) return _d1Base;
  var v = localStorage.getItem('bondan_girbo_proxy') || localStorage.getItem('shell_api_url') || '';
  _d1Base = v.replace(/\\/$/, '') || 'https://bondan-backend.marginacall.workers.dev';
  return _d1Base;
}
var _d1Catalog = null; // {issuers, bonds, stocks}

// ── D1 Загрузка ────────────────────────────────────────────────────
var _d1Loading = false;
async function _repD1Load(){
  if(_d1Loading) return;
  _d1Loading = true;
  var btn = document.getElementById('rep-d1-load-btn');
  var log = document.getElementById('rep-d1-log');
  function setBtn(t){ if(btn){ btn.textContent = t; } }
  function setLog(t, isErr){
    if(!log) return;
    log.style.display = t ? '' : 'none';
    log.style.color = isErr ? 'var(--danger)' : 'var(--text3)';
    log.textContent = t;
  }
  if(btn) btn.disabled = true;
  setBtn('↻ каталог…');
  setLog('Шаг 1/3: загрузка каталога…');
  try{
    var base = _getD1Base();
    // 1. Каталог
    var r = await fetch(base + '/catalog');
    if(!r.ok) throw new Error('HTTP ' + r.status + ' при /catalog');
    var cat = await r.json();
    _d1Catalog = cat;
    var issuers = Array.isArray(cat.issuers) ? cat.issuers : [];
    setLog('Шаг 1/3: каталог ✓ (' + issuers.length + ' эмитентов)');

    // 2. Мёрдж эмитентов в reportsDB
    // ВАЖНО: мутируем объект на месте, не переприсваиваем reportsDB —
    // иначе app.js потеряет ссылку и repRenderIssuerList увидит старые данные
    setBtn('↻ мёрдж…');
    setLog('Шаг 2/3: мёрдж в базу…');
    var added = 0, updated = 0;
    if(!reportsDB) reportsDB = {};
    var rdb = reportsDB;
    for(var ci = 0; ci < issuers.length; ci++){
      var ci2 = issuers[ci];
      if(!ci2.inn) continue;
      var existId = null;
      for(var eid in rdb){
        if(rdb[eid] && rdb[eid].inn === ci2.inn){ existId = eid; break; }
      }
      var ind = _d1SectorToInd(ci2.sector);
      // Аффилиация из каталога: основной учредитель-юрлицо
      var related = null;
      if(ci2.parent_inn){
        related = [{ inn: ci2.parent_inn, name: ci2.parent_name || null, role: 'related', source: 'd1', roleHint: 'founder' }];
      }
      if(!existId){
        var nid = 'i_' + ci2.inn;
        if(!rdb[nid]){
          rdb[nid] = {
            name: ci2.name || ci2.inn, inn: ci2.inn,
            ind: ind, kind: ci2.kind || null, status: ci2.status || null,
            ogrn: ci2.ogrn || null, okved: ci2.okved || null,
            related: related || [],
            bondsCount: ci2.bonds_count || 0,
            periods: {}
          };
          added++;
        }
      } else {
        var ex = rdb[existId];
        if(!ex.ind || ex.ind === 'other') ex.ind = ind;
        if(!ex.name && ci2.name) ex.name = ci2.name;
        if(!ex.kind && ci2.kind) ex.kind = ci2.kind;
        if(!ex.status && ci2.status) ex.status = ci2.status;
        if(!ex.ogrn && ci2.ogrn) ex.ogrn = ci2.ogrn;
        if((!ex.related || !ex.related.length) && related) ex.related = related;
        if(ci2.bonds_count != null) ex.bondsCount = ci2.bonds_count;
        updated++;
      }
    }
    setLog('Шаг 2/3: +' + added + ' новых, ' + updated + ' обновлено');
    repRenderIssuerList();

    // 3. Подтянуть отчёты — только для эмитентов у которых has_reports:true в каталоге
    // Остальные точно пустые — не тратим N×1355 запросов
    var catalogByInn = {};
    for(var ci3 = 0; ci3 < issuers.length; ci3++){
      if(issuers[ci3].inn) catalogByInn[issuers[ci3].inn] = issuers[ci3];
    }

    var toFetch = [];
    var rdb2 = reportsDB || {};
    for(var eid2 in rdb2){
      var e2 = rdb2[eid2];
      if(!e2 || !e2.inn) continue;
      if(Object.keys(e2.periods || {}).length > 0) continue;
      if(e2._d1_checked) continue;
      var catEntry = catalogByInn[e2.inn];
      // Загружаем только тех у кого has_reports:true в каталоге
      if(!catEntry || !catEntry.has_reports){
        e2._d1_checked = true;
        continue;
      }
      toFetch.push({ id: eid2, inn: e2.inn });
    }
    var loaded = 0, errors = 0;
    var total = toFetch.length;
    setBtn('↻ 0/' + total);
    setLog('Шаг 3/3: загрузка отчётов 0/' + total + '…');

    // Перерисовать список сразу — не ждать конца загрузки
    repRenderIssuerList();
    try { repRebuildSelect(); } catch(_){}

    var BATCH = 8;
    for(var ti = 0; ti < total; ti += BATCH){
      var batch = toFetch.slice(ti, ti + BATCH);
      await Promise.all(batch.map(function(entry){
        var ctrl = new AbortController();
        var t = setTimeout(function(){ ctrl.abort(); }, 8000);
        return fetch(base + '/issuer/' + entry.inn + '/reports', { signal: ctrl.signal })
          .then(function(r2){ clearTimeout(t); return r2.ok ? r2.json() : null; })
          .then(function(data){
            if(data && Array.isArray(data.data) && data.data.length){
              _d1MergeReports(entry.id, entry.inn, data.data);
              loaded++;
            }
            var rdbRef = reportsDB || {};
            if(rdbRef[entry.id]) rdbRef[entry.id]._d1_checked = true;
          })
          .catch(function(err){
            clearTimeout(t);
            errors++;
          });
      }));
      var done = Math.min(ti + BATCH, total);
      setBtn('↻ ' + done + '/' + total);
      setLog('Шаг 3/3: ' + done + '/' + total + ' отчётов' + (errors ? ', ошибок: ' + errors : '') + '…');
    }

    // 4. Сохранить и перерисовать
    var saveErr = null;
    try {
      save();
    } catch(e) {
      saveErr = e;
      // Fallback: попробовать сохранить напрямую через postMessage к shell
      try {
        var snap = JSON.stringify({ reportsDB: reportsDB });
        localStorage.setItem('ba_rep_d1_cache', snap);
      } catch(e2) {
        try { window.parent.postMessage({ type: 'DB_WRITE', key: 'ba_rep_d1_cache', value: JSON.stringify({ reportsDB: reportsDB }) }, '*'); } catch(e3) {}
      }
    }
    repRenderIssuerList();
    // Перестроить legacy-select чтобы repSelectIssuerById работал после D1-загрузки
    try { repRebuildSelect(); } catch(_){}
    var rdbFinal = reportsDB || {};
    var totalIss = Object.keys(rdbFinal).length;
    var withPeriods = Object.keys(rdbFinal).filter(function(k){ return Object.keys(rdbFinal[k].periods||{}).length > 0; }).length;
    // Счётчик не перезаписываем — repRenderIssuerList уже поставил отфильтрованный
    var summary = (added > 0 ? '+' + added + ' эм.' : '') + (loaded > 0 ? (added?' ':'') + '+' + loaded + ' отч.' : '') || 'без изменений';
    setBtn('✓ ' + withPeriods + '/' + totalIss);
    setLog('Готово: ' + summary + ' | с отчётами: ' + withPeriods + '/' + totalIss +
      (errors ? ' | ошибок: ' + errors : '') +
      (saveErr ? ' | ⚠ сохранение: ' + saveErr.message : ''));
    if(btn) btn.disabled = false;

  }catch(e){
    console.error('D1 load:', e);
    setBtn('↓ Загрузить базу');
    setLog('Ошибка: ' + (e.message || String(e)), true);
    if(btn) btn.disabled = false;
  }
  _d1Loading = false;
}

// D1 period codes → app.js period names
var _D1_PERIOD_MAP = { 'FY':'Год', '9M':'9М', 'H1':'Полугодие', 'Q1':'1 квартал', 'Q3':'3 квартал' };

function _d1MergeReports(issId, inn, rows){
  var rdb = reportsDB || {};
  if(!rdb[issId]) return;
  var iss = rdb[issId];
  if(!iss.periods) iss.periods = {};
  for(var i = 0; i < rows.length; i++){
    var row = rows[i];
    var periodName = _D1_PERIOD_MAP[row.period] || row.period || 'Год';
    var pk = row.fy_year + '_' + periodName + '_' + (row.std || 'РСБУ');
    if(!iss.periods[pk]){
      iss.periods[pk] = {
        year: row.fy_year, period: periodName, type: row.std || 'РСБУ',
        // D1 хранит значения в млн ₽, app.js ожидает млрд → делим на 1000
        rev:    _d1bn(row.rev),   ebitda: _d1bn(row.ebitda), ebit: _d1bn(row.ebit),
        np:     _d1bn(row.np),    int:    _d1bn(row.int_exp), tax: _d1bn(row.tax_exp),
        assets: _d1bn(row.assets),ca:     _d1bn(row.ca),      cl:  _d1bn(row.cl),
        debt:   _d1bn(row.debt),  cash:   _d1bn(row.cash),    ret: _d1bn(row.ret),
        eq:     _d1bn(row.eq),    _src: 'd1'
      };
    }
  }
}
// D1 хранит финансовые показатели в млн ₽; app.js везде работает в млрд ₽
function _d1bn(v){ return v != null ? Number(v) / 1000 : null; }
function _d1v(v){ return v != null ? Number(v) : null; }

// Маппинг sector (из D1 issuers) → ind (наши ключи из industry-peers)
var _D1_SECTOR_MAP = {
  'metals': 'metals', 'oil-gas': 'oil-gas', 'chemistry': 'chemistry',
  'agro': 'agro', 'retail': 'retail', 'construction': 'construction',
  'realestate': 'realestate', 'logistics': 'logistics', 'banks': 'banks',
  'leasing': 'leasing', 'mfo': 'mfo', 'holdings': 'holdings',
  'it': 'it', 'telecom': 'telecom', 'utilities': 'utilities',
  'media': 'media', 'pharma': 'pharma', 'machinery': 'machinery',
  'auto': 'auto', 'wood': 'wood', 'finance': 'holdings',
  'food': 'agro', 'manufacturing': 'machinery', 'services': 'other',
  'insurance': 'holdings', 'state': 'other', 'municipal': 'other',
};
function _d1SectorToInd(s){ return (s && _D1_SECTOR_MAP[s]) || 'other'; }

// ── Поиск (fuzzy по reportsDB + catalog) ──────────────────────────
var _repSearchTimer = null;
var _repSearchOpen = false;

function _repSearchInput(val){
  clearTimeout(_repSearchTimer);
  // Синхронизировать с оригинальным инпутом для repRenderIssuerList
  var orig = document.getElementById('rep-sidebar-search');
  if(orig && orig !== document.getElementById('rep-search-main')) orig.value = val;
  _repSearchTimer = setTimeout(function(){
    if(val.trim().length < 1){ _repSearchDropClose(); repRenderIssuerList(); return; }
    _repSearchDropRender(val.trim());
    repRenderIssuerList();
  }, 120);
}

function _repSearchDropRender(q){
  var drop = document.getElementById('rep-search-drop');
  if(!drop) return;
  var ql = q.toLowerCase();

  // Эмитенты из reportsDB
  var rdb = reportsDB || {};
  var issuers = [];
  for(var id in rdb){
    var iss = rdb[id];
    if(!iss || !iss.name) continue;
    var nm = (iss.name || '').toLowerCase();
    var inn = (iss.inn || '').toLowerCase();
    if(nm.includes(ql) || inn.includes(ql)){
      issuers.push({ id: id, iss: iss });
      if(issuers.length >= 6) break;
    }
  }

  // Облигации из каталога D1
  var bonds = [];
  if(_d1Catalog && _d1Catalog.bonds){
    var bl = _d1Catalog.bonds;
    for(var bi = 0; bi < bl.length && bonds.length < 5; bi++){
      var b = bl[bi];
      var bn = ((b.name || b.shortname || '') + ' ' + (b.isin || '')).toLowerCase();
      if(bn.includes(ql)) bonds.push(b);
    }
  }

  var html = '';
  if(issuers.length){
    html += '<div class="sd-group">Эмитенты · ' + issuers.length + '</div>';
    html += issuers.map(function(x){
      var m = _repCalcMultipliers(x.iss);
      var yr = m.year ? ' · ' + m.year : '';
      return '<div class="sd-item" onclick="_repSearchSelectIssuer(\\'' + x.id + '\\')">' +
        '<span style="color:var(--text3)">🏢</span>' +
        '<span class="sd-name">' + _escHtml(x.iss.name) + '</span>' +
        '<span class="sd-sub">' + (x.iss.inn ? x.iss.inn : '') + yr + '</span>' +
        '</div>';
    }).join('');
  }
  if(bonds.length){
    html += '<div class="sd-group">Облигации · ' + bonds.length + '</div>';
    html += bonds.map(function(b){
      var ytm = b.ytm != null ? '<span class="sd-acc">' + Number(b.ytm).toFixed(1) + '%</span>' : '';
      return '<div class="sd-item">' +
        '<span style="color:var(--text3)">📄</span>' +
        '<span class="sd-name">' + _escHtml(b.name || b.shortname || b.isin) + '</span>' +
        '<span class="sd-sub">' + (b.isin || '') + '</span>' +
        ytm +
        '</div>';
    }).join('');
  }
  if(!html) html = '<div style="padding:10px;text-align:center;font-size:.62rem;color:var(--text3)">Ничего не найдено</div>';

  drop.innerHTML = html;
  drop.style.display = 'block';
  _repSearchOpen = true;
}

function _repSearchSelectIssuer(id){
  repSelectIssuerById(id);
  _repSearchDropClose();
  var inp = document.getElementById('rep-search-main');
  if(inp){ inp.value = ''; var orig = document.getElementById('rep-sidebar-search'); if(orig) orig.value = ''; }
  repRenderIssuerList();
}

function _repSearchDropClose(){
  var drop = document.getElementById('rep-search-drop');
  if(drop) drop.style.display = 'none';
  _repSearchOpen = false;
}

// ── Инициализация после repInit (HTML sidebar уже вшит в сборке) ──
function _repStructureSidebar(){
  // Закрытие выпадашки поиска по клику вне контейнера
  document.addEventListener('click', function(e){
    var wrap = document.getElementById('rep-search-main');
    var drop = document.getElementById('rep-search-drop');
    if(drop && wrap && !wrap.parentElement.contains(e.target)){
      _repSearchDropClose();
    }
  });
  // Рендерим расширенный фильтр (рейтинги/отрасли/мультипликаторы)
  try { _repFilterRender(); } catch(err){ console.warn('filterRender:', err); }
}

// ── Модалка «Источники» ────────────────────────────────────────────
var _SRC_BTNS = [
  { label: 'Импорт ГИРБО (CSV/XML)',        fn: 'openGirboImportModal()',               desc: 'Выгрузка с bo.nalog.gov.ru' },
  { label: 'Импорт audit-it HTML',           fn: 'openAuditItImportModal()',             desc: 'HTML страницы или JSON от bookmarklet, до 11 лет РСБУ' },
  { label: 'Объединить эмитентов',           fn: 'repOpenMergeModal()',                  desc: 'Перенести периоды из одного в другой' },
  { label: 'Аудит данных',                  fn: 'repRunAudit()',                        desc: '14 правил проверки консистентности' },
  { label: 'Диагностика по ИНН',            fn: 'repDiagnoseInn()',                     desc: 'Запросить данные с ГИР БО по ИНН' },
  { label: 'Импорт аффилированных',         fn: 'repImportAffiliatedFromClipboard()',   desc: 'JSON структуры аффилированных из расширения' },
  { label: 'Удалить пустые периоды',        fn: 'repCleanEmptyPeriods()',               desc: 'Удалить периоды без числовых значений' },
  { label: 'Импорт JSON эмитента',          fn: "document.getElementById('rep-issuer-import').click()", desc: 'Импорт одного эмитента из JSON-файла' },
];

function _repSourcesModal(){
  var overlay = document.getElementById('rep-sources-overlay');
  if(overlay){ overlay.classList.add('open'); return; }

  overlay = document.createElement('div');
  overlay.id = 'rep-sources-overlay';
  overlay.className = 'modal-overlay';
  overlay.onclick = function(e){ if(e.target === overlay) overlay.classList.remove('open'); };

  var btnS = 'display:block;width:100%;text-align:left;padding:10px 14px;margin-bottom:6px;border:1px solid var(--border2);border-radius:var(--radius);background:var(--s2);cursor:pointer;font-family:var(--sans);transition:all .15s';
  var rows = _SRC_BTNS.map(function(b){
    return '<button type="button" style="' + btnS + '" onclick="document.getElementById(\\'rep-sources-overlay\\').classList.remove(\\'open\\');' + b.fn + '">' +
      '<div style="font-size:.72rem;font-weight:500;color:var(--text);margin-bottom:2px">' + b.label + '</div>' +
      '<div style="font-size:.6rem;color:var(--text3)">' + b.desc + '</div>' +
    '</button>';
  }).join('');

  overlay.innerHTML = '<div class="modal-box" style="min-width:420px">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">' +
      '<span class="modal-title" style="margin:0">Источники и инструменты</span>' +
      '<button type="button" onclick="document.getElementById(\\'rep-sources-overlay\\').classList.remove(\\'open\\')" style="background:none;border:none;color:var(--text3);font-size:1.2rem;cursor:pointer;line-height:1">✕</button>' +
    '</div>' +
    '<div style="font-size:.6rem;color:var(--text3);margin-bottom:14px">Основной источник — «↓ Загрузить базу» в панели. Остальные — ручной импорт и утилиты.</div>' +
    rows + '</div>';
  document.body.appendChild(overlay);
  overlay.classList.add('open');
}

// ── Расширенный фильтр (рейтинги + пилюли-отрасли + мульты) ──────
window._repFilter = { ratings: [], industries: [], mults: {} };

var _FILTER_RATINGS = ['AAA','AA+','AA','AA-','A+','A','A-','BBB+','BBB','BBB-','BB+','BB','BB-','B+','B','B-','CCC','D','none'];

var _FILTER_IND_GROUPS = [
  { label:'Ресурсы', items:[{id:'agro',label:'Агро'},{id:'metals',label:'Металлы'},{id:'oil-gas',label:'Нефть/газ'}] },
  { label:'Промышленность', items:[{id:'auto',label:'Авто'},{id:'wood',label:'Дерево'},{id:'machinery',label:'Машиностроение'},{id:'furniture',label:'Мебель'},{id:'metalware',label:'Металлоизделия'},{id:'plastics',label:'Пластмассы'},{id:'building-mat',label:'Стройматериалы'},{id:'textile',label:'Текстиль'},{id:'pharma',label:'Фарма'},{id:'chemistry',label:'Химия'},{id:'electronics',label:'Электроника'}] },
  { label:'Энергетика', items:[{id:'utilities',label:'ЭЭ и ЖКХ'}] },
  { label:'Стройка', items:[{id:'realestate',label:'Недвижимость'},{id:'construction',label:'Строительство'}] },
  { label:'Торговля', items:[{id:'retail',label:'Ритейл'}] },
  { label:'Транспорт', items:[{id:'logistics',label:'Транспорт/лог.'}] },
  { label:'IT и медиа', items:[{id:'media',label:'Медиа'},{id:'telecom',label:'Телеком'},{id:'it',label:'IT'}] },
  { label:'Финансы', items:[{id:'banks',label:'Банки'},{id:'leasing',label:'Лизинг'},{id:'mfo',label:'МФО'},{id:'insurance',label:'Страхование'},{id:'holdings',label:'Холдинги'}] },
  { label:'Услуги', items:[{id:'rental',label:'Аренда'},{id:'hospitality',label:'Гостиницы'},{id:'healthcare',label:'Медицина'},{id:'entertainment',label:'Развлечения'},{id:'education',label:'Образование'},{id:'consulting',label:'Консалтинг'}] },
  { label:'Прочее', items:[{id:'other',label:'Прочее'}] }
];

var _FILTER_MULTS = [
  { id:'de',         label:'Долг/EBITDA',      fmt:'x' },
  { id:'nde',        label:'ЧД/EBITDA',        fmt:'x' },
  { id:'icr',        label:'ICR',              fmt:'x' },
  { id:'roa',        label:'ROA',              fmt:'%' },
  { id:'ebitdaMarg', label:'EBITDA-маржа',     fmt:'%' },
  { id:'currentR',   label:'Current Ratio',   fmt:'x' },
  { id:'cashR',      label:'Cash Ratio',      fmt:'x' },
  { id:'equityR',    label:'Equity Ratio',    fmt:'%' },
];

function _repFilterRender(){
  var el = document.getElementById('rep-filter-extra');
  if(!el) return;
  var f = window._repFilter;
  var hasRat = f.ratings.length > 0;
  var hasInd = f.industries.length > 0;
  var hasMult = Object.values(f.mults).some(function(m){ return m && (m.min !== '' || m.max !== ''); });
  var hasFilter = hasRat || hasInd || hasMult;

  // Обновить бейдж на summary
  var badge = document.getElementById('rep-filter-badge');
  if(badge) badge.style.display = hasFilter ? 'inline' : 'none';

  function pill(lbl, on, onclick){
    return '<button type="button" onclick="' + onclick + '" style="padding:1px 6px;border-radius:12px;font-size:.5rem;font-family:var(--mono);border:1px solid ' + (on?'var(--acc)':'var(--border2)') + ';background:' + (on?'var(--acc-dim)':'var(--bg)') + ';color:' + (on?'var(--acc)':'var(--text3)') + ';cursor:pointer;margin:1px;white-space:nowrap">' + lbl + '</button>';
  }

  var ratHtml = _FILTER_RATINGS.map(function(r){
    return pill(r==='none'?'без рейтинга':r, f.ratings.indexOf(r)!==-1, "_repFilterToggleRating('" + r + "')");
  }).join('');

  var indHtml = _FILTER_IND_GROUPS.map(function(g){
    return '<div style="font-size:.46rem;color:var(--text3);text-transform:uppercase;letter-spacing:.08em;margin:5px 0 2px;font-family:var(--sans)">' + g.label + '</div>' +
      g.items.map(function(it){
        return pill(it.label, f.industries.indexOf(it.id)!==-1, "_repFilterToggleInd('" + it.id + "')");
      }).join('');
  }).join('');

  var multHtml = _FILTER_MULTS.map(function(m){
    var mf = f.mults[m.id] || {min:'',max:''};
    return '<div style="display:flex;align-items:center;gap:3px;margin-bottom:3px">' +
      '<span style="font-size:.52rem;font-family:var(--mono);color:var(--text2);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + m.label + '</span>' +
      '<input type="number" step="any" placeholder="min" value="' + (mf.min||'') + '" oninput="_repFilterSetMult(\\'' + m.id + '\\',\\'min\\',this.value)" style="width:44px;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:2px 4px;font-size:.52rem;font-family:var(--mono);color:var(--text);outline:none">' +
      '<span style="color:var(--text3);font-size:.5rem">–</span>' +
      '<input type="number" step="any" placeholder="max" value="' + (mf.max||'') + '" oninput="_repFilterSetMult(\\'' + m.id + '\\',\\'max\\',this.value)" style="width:44px;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:2px 4px;font-size:.52rem;font-family:var(--mono);color:var(--text);outline:none">' +
      '<span style="color:var(--text3);font-size:.46rem;width:9px;text-align:right">' + m.fmt + '</span>' +
      '</div>';
  }).join('');

  el.innerHTML =
    '<div style="border-top:1px solid var(--border);margin-top:4px;padding-top:8px">' +
    (hasFilter ? '<div style="text-align:right;margin-bottom:4px"><button type="button" onclick="_repFilterReset()" style="font-size:.5rem;color:var(--danger);background:none;border:none;cursor:pointer;font-family:var(--mono)">× сброс фильтра</button></div>' : '') +

    '<details style="margin-bottom:4px">' +
      '<summary style="font-size:.5rem;color:var(--text3);text-transform:uppercase;letter-spacing:.08em;cursor:pointer;font-family:var(--sans);font-weight:600;display:flex;align-items:center;gap:4px;padding:2px 0">' +
        '<span style="color:var(--acc)">▸</span><span>Рейтинг</span>' +
        (hasRat ? '<span style="margin-left:auto;font-size:.46rem;color:var(--acc)">' + f.ratings.length + '</span>' : '') +
      '</summary>' +
      '<div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:1px">' + ratHtml + '</div>' +
    '</details>' +

    '<details style="margin-bottom:4px">' +
      '<summary style="font-size:.5rem;color:var(--text3);text-transform:uppercase;letter-spacing:.08em;cursor:pointer;font-family:var(--sans);font-weight:600;display:flex;align-items:center;gap:4px;padding:2px 0">' +
        '<span style="color:var(--acc)">▸</span><span>Отрасли</span>' +
        (hasInd ? '<span style="margin-left:auto;font-size:.46rem;color:var(--acc)">' + f.industries.length + '</span>' : '') +
      '</summary>' +
      '<div style="margin-top:4px">' + indHtml + '</div>' +
    '</details>' +

    '<details open style="margin-bottom:4px">' +
      '<summary style="font-size:.5rem;color:var(--text3);text-transform:uppercase;letter-spacing:.08em;cursor:pointer;font-family:var(--sans);font-weight:600;display:flex;align-items:center;gap:4px;padding:2px 0;margin-bottom:4px">' +
        '<span style="color:var(--acc)">▾</span><span>Мультипликаторы</span>' +
        (hasMult ? '<span style="margin-left:auto;font-size:.46rem;color:var(--acc)">active</span>' : '') +
      '</summary>' +
      multHtml +
    '</details>' +
    '</div>';
}

function _repFilterToggleRating(r){
  var f = window._repFilter, idx = f.ratings.indexOf(r);
  if(idx===-1) f.ratings.push(r); else f.ratings.splice(idx,1);
  _repFilterRender(); repRenderIssuerList();
}
function _repFilterToggleInd(id){
  var f = window._repFilter, idx = f.industries.indexOf(id);
  if(idx===-1) f.industries.push(id); else f.industries.splice(idx,1);
  _repFilterRender(); repRenderIssuerList();
}
function _repFilterSetMult(mid, key, val){
  var f = window._repFilter;
  if(!f.mults[mid]) f.mults[mid] = {min:'',max:''};
  f.mults[mid][key] = val;
  repRenderIssuerList();
}
function _repFilterReset(){
  window._repFilter = { ratings: [], industries: [], mults: {} };
  _repFilterRender(); repRenderIssuerList();
}

function _repFilterMatch(id, iss){
  var f = window._repFilter || {};
  if(f.industries && f.industries.length > 0){
    if(f.industries.indexOf(iss.ind || 'other') === -1) return false;
  }
  if(f.ratings && f.ratings.length > 0){
    var issRatings = (iss.ratings || []).map(function(r){ return r && r.rating; }).filter(Boolean);
    var hasMatch = issRatings.some(function(r){ return f.ratings.indexOf(r) !== -1; });
    var wantsNone = f.ratings.indexOf('none') !== -1;
    if(!hasMatch && !(wantsNone && issRatings.length === 0)) return false;
  }
  if(f.mults){
    var calcM = _repCalcMultipliers(iss);
    var lp = _repLatestPeriod(iss);
    var p = lp ? lp.period : null;
    var allMults = {
      de: calcM.de, icr: calcM.icr, currentR: calcM.cur, cashR: calcM.cashR,
      equityR: calcM.eqr != null ? calcM.eqr * 100 : null,
      nde: (p && p.ebitda != null && p.ebitda !== 0) ? ((p.debt||0)-(p.cash||0))/p.ebitda : null,
      roa: (p && p.assets) ? ((p.np||0)/p.assets*100) : null,
      ebitdaMarg: (p && p.rev) ? ((p.ebitda||0)/p.rev*100) : null,
    };
    for(var mid in f.mults){
      var mf = f.mults[mid];
      if(!mf) continue;
      var val = allMults[mid];
      if(val == null || !isFinite(val)) continue;
      if(mf.min !== '' && mf.min !== null && val < parseFloat(mf.min)) return false;
      if(mf.max !== '' && mf.max !== null && val > parseFloat(mf.max)) return false;
    }
  }
  return true;
}

function _repFilterApplyDOM(){
  var f = window._repFilter || {};
  var hasRating = f.ratings && f.ratings.length > 0;
  var hasInd = f.industries && f.industries.length > 0;
  var hasMult = f.mults && Object.values(f.mults).some(function(m){ return m && (m.min!==''||m.max!==''); });
  if(!hasRating && !hasInd && !hasMult) return;
  var listEl = document.getElementById('rep-sidebar-list');
  if(!listEl) return;
  var items = listEl.querySelectorAll('[onclick]');
  var shown = 0;
  items.forEach(function(el){
    var oc = el.getAttribute('onclick') || '';
    var m2 = oc.match(/repSelectIssuerById\\('([^']+)'\\)/);
    if(!m2){ shown++; return; }
    var issId = m2[1];
    var iss = (reportsDB || {})[issId];
    if(iss && _repFilterMatch(issId, iss)){ el.style.display=''; shown++; }
    else el.style.display='none';
  });
  var cnt = document.getElementById('rep-sidebar-count');
  if(cnt) cnt.textContent = String(shown);
}

// Переопределяем _repHasMoexBonds — используем bondsCount из D1
// (window._moexCatalog в модуле не загружается)
window._repHasMoexBonds = function(id, iss){
  if(!iss) return false;
  // bondsCount > 0 — есть активные выпуски по данным D1 на момент загрузки
  if(iss.bondsCount != null) return iss.bondsCount > 0;
  // Fallback: есть периоды → скорее всего эмитент
  return Object.keys(iss.periods || {}).length > 0;
};

// Обработка status='has_moex'/'corp_moex' — оригинал не знает эти коды
var _NON_CORP_KINDS = { subfederal: 1, municipal: 1, federal: 1 };
var _NON_CORP_SECTORS = { state: 1 };
var _GOV_NAME_RE = /^(администрация|правительство|министерство|департамент|комитет|служба|агентство|инспекция|управление)\b/i;
(function(){
  var _origRIL = repRenderIssuerList;
  window.repRenderIssuerList = function(){
    var st = document.getElementById('rep-sidebar-status');
    var origVal = st ? st.value : '';
    var needCustom = origVal === 'has_moex' || origVal === 'corp_moex';
    if(st && needCustom) st.value = 'all';
    _origRIL();
    _repFilterApplyDOM();
    if(st && needCustom){
      st.value = origVal;
      var listEl = document.getElementById('rep-sidebar-list');
      if(listEl){
        var shown = 0;
        listEl.querySelectorAll('[onclick]').forEach(function(el){
          if(el.style.display === 'none') return;
          var oc = el.getAttribute('onclick') || '';
          var m = oc.match(/repSelectIssuerById\('([^']+)'\)/);
          if(!m){ shown++; return; }
          var iss = reportsDB[m[1]];
          var hasB = iss && (iss.bondsCount > 0);
          // corp_moex: исключаем субфедеральные/мун./ОФЗ/банки/гос.органы
          var isCorpOk = origVal !== 'corp_moex' || (iss &&
            !_NON_CORP_KINDS[iss.kind] && iss.kind !== 'bank' &&
            !_NON_CORP_SECTORS[iss.ind] &&
            !_GOV_NAME_RE.test(iss.name || ''));
          if(!hasB || !isCorpOk) el.style.display = 'none';
          else shown++;
        });
        var cnt = document.getElementById('rep-sidebar-count');
        if(cnt) cnt.textContent = String(shown);
      }
    }
  };
})();

// Надёжный выбор эмитента: напрямую через repActiveIssuerId + рендер,
// не через legacy-select (второй клик на тот же id не триггерит change)
(function(){
  var _lastFetched = {};
  window.repSelectIssuerById = function(id){
    if(!id) return;
    // Синхронно устанавливаем активного — напрямую, без select
    repActiveIssuerId = id;
    var sel = document.getElementById('rep-issuer-sel');
    if(sel) sel.value = id;
    // Показать панель, скрыть empty-state
    var ev = document.getElementById('rep-issuer-view');
    var em = document.getElementById('rep-empty');
    if(ev) ev.style.display = 'block';
    if(em) em.style.display = 'none';
    ['rep-add-period-btn','rep-pdf-btn','rep-del-issuer-btn',
     'rep-compare-btn','rep-edit-issuer-btn','rep-export-issuer-btn',
     'rep-dossier-btn','rep-edit-period-btn','rep-del-period-btn'].forEach(function(bid){
      var b = document.getElementById(bid); if(b) b.style.display = '';
    });
    // Рендерим шапку и периоды
    try { _repRenderActiveIssuerHeader(); } catch(_){}
    try { repRenderRef(); } catch(_){}
    try { repBuildPeriodTabs(); } catch(_){}
    // Подсветка активного в списке — только классы, без полного перерендера
    document.querySelectorAll('.rep-issuer-item').forEach(function(el){
      var oc = el.getAttribute('onclick') || '';
      var m = oc.match(/repSelectIssuerById\('([^']+)'\)/);
      var itemId = m ? m[1] : null;
      var active = itemId === id;
      el.style.background = active ? 'var(--s3)' : 'var(--bg)';
      el.style.borderColor = active ? 'var(--acc)' : 'var(--border2)';
    });
    // Аффилиации из D1 — один раз на id
    if(_lastFetched[id]) return;
    _lastFetched[id] = true;
    var iss = reportsDB[id];
    if(!iss || !iss.inn) return;
    var base = _getD1Base();
    fetch(base + '/issuer/' + iss.inn + '/affiliations')
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(data){
        if(!data) return;
        var iss2 = reportsDB[id];
        if(!iss2) return;
        var rel = [];
        // Учредители
        (data.founders || []).forEach(function(f){
          if(f.role === 'not_in_egrul') return;
          rel.push({ inn: f.parent_inn||null, name: f.parent_name||null, role: 'related', source: 'd1', roleHint: 'founder', share: f.share_pct||null });
        });
        // Руководство
        (data.management || []).forEach(function(f){
          rel.push({ inn: null, name: f.parent_name||null, role: 'related', source: 'd1', roleHint: f.role||'management' });
        });
        // Дочки
        (data.children || []).forEach(function(c){
          rel.push({ inn: c.child_inn||null, name: c.child_name||null, role: 'related', source: 'd1', roleHint: 'child', share: c.share_pct||null });
        });
        if(rel.length){
          iss2.related = rel;
          // Перерисовать если этот эмитент сейчас активен
          if(typeof repActiveIssuerId !== 'undefined' && repActiveIssuerId === id){
            if(typeof _repRenderActiveIssuerHeader === 'function') _repRenderActiveIssuerHeader();
          }
        }
      })
      .catch(function(e){ console.warn('affiliations fetch:', id, e); });
  };
})();

// ── Дополнительные стили ──────────────────────────────────────────────────────
(function(){
  var st = document.createElement('style');
  st.textContent = [
    '#rep-sidebar-list{display:flex;flex-direction:column;gap:0;padding:4px}',
    '#rep-issuer-header{padding:0!important;background:transparent!important;border:none!important}',
    '#rep-period-tabs{display:flex;align-items:flex-end;gap:2px;flex-wrap:wrap;padding:0 16px;border-bottom:1px solid var(--brd);background:rgba(20,10,36,0.28)}',
    '#rep-period-tabs .ptab,.ptab{padding:7px 13px;font-size:11px;font-weight:600;cursor:pointer;border:1px solid transparent;border-bottom:none;color:var(--t3);background:transparent;transition:all .1s;position:relative;display:inline-flex;align-items:center;gap:5px;font-family:var(--sans);border-radius:0;margin-bottom:0}',
    '#rep-period-tabs .ptab:hover,.ptab:hover{color:var(--t2);border-color:var(--brdm)}',
    '#rep-period-tabs .ptab.active,.ptab.active{background:rgba(26,16,48,.85);border-color:var(--brdm);color:var(--t)}',
    "#rep-period-tabs .ptab.active::after,.ptab.active::after{content:'';position:absolute;bottom:-1px;left:0;right:0;height:1px;background:rgba(26,16,48,.85)}",
    '.rhp{display:inline-flex;align-items:center;gap:3px;padding:3px 8px;border:1px solid;font-size:10px;font-family:var(--mono);border-radius:0}',
    '.rhp-label{font-size:8px;opacity:.7}',
    '.rhp-val{font-weight:700}',
    '.rhp-g{border-color:rgba(82,242,201,.35);background:rgba(82,242,201,.06);color:var(--pos)}',
    '.rhp-w{border-color:rgba(232,137,90,.35);background:rgba(232,137,90,.06);color:var(--warn)}',
    '.rhp-r{border-color:rgba(255,77,122,.35);background:rgba(255,77,122,.06);color:var(--neg)}',
    '.rhp-n{border-color:var(--brdp);background:rgba(255,255,255,.02);color:var(--t3)}',
    '#rep-dyn-panel{margin-bottom:4px}',
    '.score-comps{font-size:9px;color:var(--t3);font-family:var(--mono)}',
  ].join('');
  document.head.appendChild(st);
})();

// ── Генератор новой шапки эмитента (.iss-hdr) ─────────────────────────────
function _repBuildIssuerHeader(iss, issId){
  var indKey = iss.ind||'other';
  var indLabel = (window._industryData&&window._industryData.industries&&
    window._industryData.industries[indKey]&&window._industryData.industries[indKey].label)||indKey;
  var innStr = iss.inn ? '<span>ИНН <strong style="color:var(--t2);font-weight:600">'+_escHtml(iss.inn)+'</strong></span><span>·</span>' : '';
  var ratingsHtml = '';
  if(Array.isArray(iss.ratings)&&iss.ratings.length){
    ratingsHtml = '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:5px">'
      + iss.ratings.slice(0,4).map(function(r){
        if(!r||!r.rating) return '';
        var rk = (typeof _ratingRank==='function'&&_ratingRank(r.rating))||0;
        var rc = rk>=12?'var(--pos)':rk>=6?'var(--warn)':'var(--neg)';
        var outlook = r.outlook==='positive'?'↗':r.outlook==='negative'?'↘':r.outlook==='stable'?'→':'';
        return '<span class="rtg-badge" style="color:'+rc+';border-color:'+rc+'44">'
          +(r.agency?_escHtml(r.agency)+' ':'')+_escHtml(r.rating)+outlook+'</span>';
      }).join('')+'</div>';
  }
  var indHtml = '<span style="color:var(--pur);border:1px solid rgba(170,90,255,0.22);padding:1px 5px;font-size:9px">'+_escHtml(indLabel)+'</span>';
  var actHtml = '<div style="display:flex;gap:4px;align-items:center;flex-shrink:0">'
    + '<button class="btn" onclick="repEditIssuer&&repEditIssuer()">✎ отрасль</button>'
    + '<button class="btn" onclick="repRunAudit&&repRunAudit()">аудит</button>'
    + '<button class="btn" id="rep-add-period-btn" onclick="repNewPeriodModal&&repNewPeriodModal()">+ период</button>'
    + '<button class="btn btn-acc" id="rep-compare-btn" onclick="repOpenCrossCompare&&repOpenCrossCompare()">≡ Сравнить</button>'
    + '</div>';
  var mult = _repCalcMultipliers(iss);
  var lp = (typeof _repLatestPeriod==='function') ? _repLatestPeriod(iss) : null;
  var p = lp ? lp.period : null;
  var yr = mult.year ? ' · '+mult.year : '';
  var ndEb = p&&p.debt!=null&&p.cash!=null&&p.ebitda&&p.ebitda>0 ? (p.debt-p.cash)/p.ebitda : null;
  // Stress score
  var stressScore=null, stressColor='var(--warn)', stressComps='—';
  try {
    var st2 = (typeof _repStressScore==='function') ? _repStressScore(iss) : null;
    if(st2&&st2.score!=null){ stressScore=st2.score; stressColor=(typeof _repStressColor==='function'&&_repStressColor(st2.score))||'var(--warn)'; }
    var icrTxt=(st2&&st2.stressIcrVal!=null)?'Stress-ICR '+st2.stressIcrVal.toFixed(2):(mult.icr!=null&&isFinite(mult.icr)?'ICR '+mult.icr.toFixed(2)+'×':'ICR —');
    var dwTxt=(st2&&st2.debtWallRatio!=null)?'Долг.стена '+st2.debtWallRatio.toFixed(2)+'×':(ndEb!=null?'ЧД/Е '+ndEb.toFixed(1)+'×':'');
    stressComps = icrTxt+(dwTxt?' · '+dwTxt:'');
  } catch(e2){
    stressComps=(mult.icr!=null&&isFinite(mult.icr)?'ICR '+mult.icr.toFixed(2)+'×':'—');
  }
  if(stressScore==null){
    var ss2=[];
    if(mult.icr!=null&&isFinite(mult.icr)) ss2.push(mult.icr>=3?100:mult.icr>=1.5?(mult.icr-1.5)/1.5*50+50:mult.icr/1.5*50);
    if(mult.de!=null&&isFinite(mult.de)) ss2.push(mult.de<=2?100:mult.de<=5?100-(mult.de-2)/3*50:mult.de<=8?50-(mult.de-5)/3*50:0);
    if(ss2.length) stressScore=Math.round(ss2.reduce(function(a,b){return a+b;},0)/ss2.length);
    stressColor=stressScore!=null?(stressScore>=70?'var(--pos)':stressScore>=40?'var(--warn)':'var(--neg)'):'var(--t3)';
  }
  // Quality score
  var qualScore=null, qualColor='var(--warn)', qualComps='—';
  var qs2=[];
  if(mult.cur!=null&&isFinite(mult.cur)){ var cr2=Math.max(0,mult.cur); qs2.push(cr2>=2?100:cr2>=1?(cr2-1)*100:cr2>=0.5?(cr2-0.5)*100:0); }
  if(p&&p.assets>0&&p.eq!=null){ var er2=p.eq/p.assets; qs2.push(er2>=0.5?100:er2>=0.2?er2/0.5*100:er2>=0?er2/0.2*40:0); }
  if(qs2.length) qualScore=Math.round(qs2.reduce(function(a,b){return a+b;},0)/qs2.length);
  qualColor=qualScore!=null?(qualScore>=70?'var(--pos)':qualScore>=40?'var(--warn)':'var(--neg)'):'var(--t3)';
  if(p){
    var cashPct=p.assets>0&&p.cash!=null?(p.cash/p.assets*100).toFixed(1)+'%':null;
    var eqPct=p.assets>0&&p.eq!=null?(p.eq/p.assets*100).toFixed(1)+'%':null;
    qualComps=[cashPct?'Cash/A '+cashPct:null,eqPct?'Eq/A '+eqPct:null,mult.cur!=null&&isFinite(mult.cur)?'CR '+mult.cur.toFixed(2)+'×':null].filter(Boolean).join(' · ')||'—';
  }
  function scoreTile(lbl, score, color, comps){
    var sw=score!=null?score:0;
    return '<div class="score-tile"><div class="score-info">'
      +'<div class="score-lbl">'+lbl+yr+'</div>'
      +'<div class="score-bw"><div class="score-b" style="width:'+sw+'%;background:'+color+'"></div></div>'
      +'<div class="score-comps">'+comps+'</div>'
      +'</div><div class="score-val" style="color:'+color+'">'+(score!=null?score:'—')
      +'<span style="font-size:9px;color:var(--t3)">/100</span></div></div>';
  }
  function rhp(lbl,val,fmt,lowGood,tGood,tWarn){
    var txt=(val==null||!isFinite(val))?'—':fmt==='pct'?(val*100).toFixed(1)+'%':val.toFixed(2)+'×';
    var cls='rhp-n';
    if(val!=null&&isFinite(val)&&tGood!=null){var ok=lowGood?val<=tGood:val>=tGood,med=lowGood?val<=tWarn:val>=tWarn;cls=ok?'rhp-g':med?'rhp-w':'rhp-r';}
    return '<span class="rhp '+cls+'"><span class="rhp-label">'+lbl+'</span><span class="rhp-val">'+txt+'</span></span>';
  }
  var ebitdaM=(p&&p.ebitda!=null&&p.rev>0)?p.ebitda/p.rev:null;
  var roa=(p&&p.np!=null&&p.assets>0)?p.np/p.assets:null;
  var pillsHtml='<div style="display:flex;flex-wrap:wrap;gap:5px;padding:10px 16px;border-bottom:1px solid var(--brd)">'
    +rhp('Долг/EBITDA',mult.de,'x',true,2.5,4.5)
    +rhp('ЧД/EBITDA',ndEb,'x',true,2.5,4.0)
    +rhp('ICR',mult.icr,'x',false,3.0,1.5)
    +rhp('ROA',roa,'pct',false,0.10,0.03)
    +rhp('EBITDA%',ebitdaM,'pct',false,0.25,0.10)
    +rhp('D/E',mult.dde,'x',true,1.0,2.5)
    +rhp('Current',mult.cur,'x',false,1.5,1.0)
    +'</div>';
  return '<div class="iss-hdr">'
    +'<div class="iss-hdr-top">'
    +'<div class="iss-title-blk">'
    +'<div class="iss-title">'+_escHtml(iss.name||'—')+'</div>'
    +'<div class="iss-sub">'+innStr+indHtml+'</div>'
    +ratingsHtml+'</div>'+actHtml+'</div>'
    +'<div class="score-row" style="margin-top:10px">'
    +scoreTile('Запас прочности',stressScore,stressColor,stressComps)
    +scoreTile('Качество баланса',qualScore,qualColor,qualComps)
    +'</div></div>'+pillsHtml;
}

// ── Override header: REPLACE innerHTML entirely ────────────────────────────
(function(){
  var _origHdr = _repRenderActiveIssuerHeader;
  window._repRenderActiveIssuerHeader = function(){
    _origHdr();
    var box = document.getElementById('rep-issuer-header');
    if(!box) return;
    var iss = repActiveIssuerId ? reportsDB[repActiveIssuerId] : null;
    if(!iss) return;
    box.innerHTML = _repBuildIssuerHeader(iss, repActiveIssuerId);
  };
})();

// ── Индикатор полноты периода в табах ─────────────────────────────────────
(function(){
  var _origBuild = typeof repBuildPeriodTabs === 'function' ? repBuildPeriodTabs : null;
  if(!_origBuild) return;
  window.repBuildPeriodTabs = function(){
    _origBuild();
    var tabsEl = document.getElementById('rep-period-tabs') || document.querySelector('.rep-period-tabs-wrap');
    if(!tabsEl) return;
    var iss = repActiveIssuerId ? reportsDB[repActiveIssuerId] : null;
    if(!iss || !iss.periods) return;
    tabsEl.querySelectorAll('[data-pkey],[onclick*="repSelectPeriod"]').forEach(function(btn){
      var pkey = btn.dataset.pkey;
      if(!pkey){
        var oc = btn.getAttribute('onclick')||'';
        var m = oc.match(/repSelectPeriod\(['"]([^'"]+)['"]\)/);
        if(m) pkey = m[1];
      }
      if(!pkey) return;
      var pd = iss.periods[pkey];
      if(!pd) return;
      var fields = ['rev','ebitda','ebit','np','int','tax','assets','ca','cl','debt','cash','eq'];
      var filled = fields.filter(function(f){ return pd[f] != null; }).length;
      var dot = filled >= 10 ? '●' : filled >= 5 ? '◐' : '○';
      var dotColor = filled >= 10 ? 'var(--green)' : filled >= 5 ? 'var(--warn)' : 'var(--text3)';
      var old = btn.querySelector('.pkey-dot');
      if(old) old.remove();
      var dotEl = document.createElement('span');
      dotEl.className = 'pkey-dot';
      dotEl.style.cssText = 'font-size:.55rem;color:' + dotColor + ';margin-left:3px';
      dotEl.title = filled + '/12 полей заполнено';
      dotEl.textContent = dot;
      btn.appendChild(dotEl);
    });
  };
})();

// ── Генератор 4 зон динамики ──────────────────────────────────────────────
function _repBuildDynPanel(iss){
  var lp = (typeof _repLatestPeriod==='function') ? _repLatestPeriod(iss) : null;
  if(!lp) return '';
  var p = lp.period, pkey = lp.pkey;
  var periods = Object.keys(iss.periods||{}).sort(function(a,b){
    var pa=iss.periods[a],pb=iss.periods[b];
    return ((pa.year||0)*100+(pa.period==='Год'?12:pa.period==='9М'?9:pa.period==='Полугодие'?6:3))
          -((pb.year||0)*100+(pb.period==='Год'?12:pb.period==='9М'?9:pb.period==='Полугодие'?6:3));
  });
  var ci=periods.indexOf(pkey);
  var prev=ci>0?iss.periods[periods[ci-1]]:null;
  var fmt=function(v){if(v==null||!isFinite(v))return '—';return Math.abs(v)>=100?v.toFixed(0):Math.abs(v)>=10?v.toFixed(1):v.toFixed(2);};
  var fmtBn=function(v){if(v==null||!isFinite(v))return '—';return(Math.abs(v)>=1000?(v/1000).toFixed(0)+'T':Math.abs(v)>=100?v.toFixed(0):v.toFixed(1))+' млрд ₽';};

  function drow(lbl, key, bold, isDebtLike){
    var cur=p[key],prv=prev?prev[key]:null;
    if(cur==null||!isFinite(cur)) return '';
    var delta=(prv!=null&&isFinite(prv))?cur-prv:null;
    var deltaPct=(delta!=null&&prv&&prv!==0)?delta/Math.abs(prv)*100:null;
    var dir=delta==null?null:(isDebtLike?(delta>0?'neg':'pos'):(delta>0?'pos':'neg'));
    var dColor=dir==='pos'?'var(--pos)':dir==='neg'?'var(--neg)':'var(--t3)';
    var arrow=delta==null?'':delta>0?'▲ +':'▼ ';
    var deltaStr=delta!=null?'<span style="font-size:11px;font-family:var(--mono);font-weight:700;color:'+dColor+'">'+arrow+(deltaPct!=null?Math.abs(deltaPct).toFixed(1)+'%':fmtBn(Math.abs(delta)))+'</span>':'';
    var barW=deltaPct!=null?Math.min(45,Math.abs(deltaPct)/2):0;
    var barSide=delta!=null&&delta>0?'left:50%;background:rgba(82,242,201,0.55)':'right:50%;background:rgba(255,77,122,0.55)';
    if(dir==='neg'&&delta!=null) barSide=delta>0?'left:50%;background:rgba(255,77,122,0.65)':'right:50%;background:rgba(82,242,201,0.55)';
    var valClass=(cur<0||(isDebtLike&&delta!=null&&delta>0))?'red':'';
    return '<div class="drow'+(bold?' key':'')+'">'
      +'<div class="drow-top"><div class="d-lbl'+(bold?' bold':'')+'">'+_escHtml(lbl)+'</div>'
      +deltaStr
      +'<div class="d-vals">'+(prv!=null?'<span class="d-old">'+fmtBn(prv)+'</span><span class="d-arr">→</span>':'')+'<span class="d-new'+(valClass?' '+valClass:'')+'">'+fmtBn(cur)+'</span></div>'
      +'</div><div class="d-bar"><div class="d-bar-ax"></div>'
      +(barW>0?'<div class="d-bar-f" style="width:'+barW+'%;'+barSide+'"></div>':'')
      +'</div></div>';
  }

  function rrow(lbl,val,prevVal,scaleMin,scaleMax,normVal,normDir,unit,lowerBetter){
    if(val==null||!isFinite(val)) return '';
    var range=scaleMax-scaleMin; if(range<=0) return '';
    var normPct=Math.min(100,Math.max(0,(normVal-scaleMin)/range*100));
    var fillPct=Math.min(100,Math.max(0,(val-scaleMin)/range*100));
    var prevPct=(prevVal!=null&&isFinite(prevVal))?Math.min(100,Math.max(0,(prevVal-scaleMin)/range*100)):null;
    var good=lowerBetter?val<=normVal:val>=normVal;
    var fillColor=good?'rgba(82,242,201,0.55)':'rgba(255,77,122,0.55)';
    var delta=(prevVal!=null&&isFinite(prevVal))?val-prevVal:null;
    var dColor=(delta==null)?'':(lowerBetter?(delta<0?'var(--pos)':'var(--neg)'):(delta>0?'var(--pos)':'var(--neg)'));
    var arrow=delta==null?'':Math.abs(delta)<0.01?'':delta>0?'▲ +':'▼ ';
    var deltaStr=delta!=null&&Math.abs(delta)>0.001?'<span class="d-pct" style="font-size:10px;font-family:var(--mono);font-weight:700;color:'+dColor+'">'+arrow+fmt(Math.abs(delta))+unit+'</span>':'';
    var valCls=good?'':' red';
    var zGood=lowerBetter?'left:0;width:'+normPct+'%;background:rgba(82,242,201,0.06)':'left:'+normPct+'%;right:0;background:rgba(82,242,201,0.06)';
    var zBad=lowerBetter?'left:'+normPct+'%;right:0;background:rgba(255,77,122,0.06)':'left:0;width:'+normPct+'%;background:rgba(255,77,122,0.06)';
    return '<div class="rrow"><div class="rrow-top">'
      +'<div class="d-lbl bold">'+_escHtml(lbl)+'</div>'
      +deltaStr
      +'<div class="d-vals">'+(prevVal!=null&&isFinite(prevVal)?'<span class="d-old">'+fmt(prevVal)+unit+'</span><span class="d-arr">→</span>':'')+'<span class="d-new'+valCls+'">'+fmt(val)+unit+'</span></div>'
      +'<span class="r-norm">норма '+normDir+(normVal<10?normVal.toFixed(1):normVal.toFixed(0))+unit+'</span>'
      +'</div><div class="r-track">'
      +'<div class="r-zone" style="'+zGood+'"></div>'
      +'<div class="r-zone" style="'+zBad+'"></div>'
      +'<div class="r-fill" style="width:'+fillPct+'%;background:'+fillColor+'"></div>'
      +(prevPct!=null?'<div class="r-prev" style="left:'+prevPct+'%"></div>':'')
      +'<div class="r-nl" style="left:'+normPct+'%"></div>'
      +'</div><div class="r-ticks">'
      +'<span class="r-tick-start">'+scaleMin+unit+'</span>'
      +'<span class="r-tick" style="left:'+normPct+'%;color:'+(good?'var(--pos)':'var(--warn)')+'">'+normVal.toFixed(normVal<10?1:0)+unit+(good?' ✓':'')+'</span>'
      +'<span class="r-tick-end">'+scaleMax+unit+'</span>'
      +'</div></div>';
  }

  function zone(id,stripeColor,title,summItems,body){
    var summ=summItems.length?'<div class="zone-summ">'+summItems.map(function(s){
      return '<div class="zone-si"><span class="zone-sl">'+s.lbl+'</span><span style="color:'+s.c+'">'+s.v+'</span></div>';
    }).join('')+'</div>':'';
    return '<div class="zone" id="'+id+'">'
      +'<div class="zone-hdr" onclick="var z=document.getElementById(\\\''+id+'\\\');z.classList.toggle(\\\'collapsed\\\')">'
      +'<div class="zone-stripe" style="background:'+stripeColor+'"></div>'
      +'<div class="zone-inner"><div class="zone-name">'+title+'</div>'+summ+'</div>'
      +'<div class="zone-chev">▾</div></div>'
      +'<div class="zone-body">'+body+'</div></div>';
  }

  function pctStr(a,b){if(!a||!b||b===0)return null;var d=(a-b)/Math.abs(b)*100;return(d>0?'▲+':'▼')+Math.abs(d).toFixed(1)+'%';}
  function pctCol(v,inv){if(v==null)return'var(--t3)';var n=parseFloat(v);return inv?(n<0?'var(--pos)':'var(--neg)'):(n>0?'var(--pos)':'var(--neg)');}

  var plBody=drow('Выручка','rev',true,false)+drow('EBITDA','ebitda',true,false)+drow('EBIT','ebit',false,false)+drow('Проц. расходы','int',true,true)+drow('Чист. прибыль','np',true,false);
  var plSumm=[];
  if(p.rev&&prev&&prev.rev){var ps=pctStr(p.rev,prev.rev);if(ps)plSumm.push({lbl:'Выручка',v:ps,c:pctCol(ps,false)});}
  if(p.ebitda&&prev&&prev.ebitda){var es=pctStr(p.ebitda,prev.ebitda);if(es)plSumm.push({lbl:'EBITDA',v:es,c:pctCol(es,false)});}

  var bsBody=drow('Активы','assets',true,false)+drow('Собств. капитал','eq',false,false)+drow('Долг','debt',true,true)+drow('Ден. средства','cash',false,false);
  var bsSumm=[];
  if(p.debt&&prev&&prev.debt){var ds=pctStr(p.debt,prev.debt);if(ds)bsSumm.push({lbl:'Долг',v:ds,c:pctCol(ds,true)});}
  if(p.assets&&prev&&prev.assets){var as2=pctStr(p.assets,prev.assets);if(as2)bsSumm.push({lbl:'Активы',v:as2,c:pctCol(as2,false)});}

  var ndEb2=(p.debt!=null&&p.cash!=null&&p.ebitda&&p.ebitda>0)?(p.debt-p.cash)/p.ebitda:null;
  var ndEbPrev2=prev&&(prev.debt!=null&&prev.cash!=null&&prev.ebitda&&prev.ebitda>0)?(prev.debt-prev.cash)/prev.ebitda:null;
  var eM2=p.rev>0&&p.ebitda!=null?p.ebitda/p.rev*100:null;
  var eMPrev2=prev&&prev.rev>0&&prev.ebitda!=null?prev.ebitda/prev.rev*100:null;
  var eqR2=p.assets>0&&p.eq!=null?p.eq/p.assets*100:null;
  var eqRPrev2=prev&&prev.assets>0&&prev.eq!=null?prev.eq/prev.assets*100:null;
  var mult2=_repCalcMultipliers(iss);
  var ratBody=rrow('ND / EBITDA',ndEb2,ndEbPrev2,0,7,3,'<','x',true)
    +rrow('ICR (покр. %)',mult2.icr,null,0,5,1.5,'>','x',false)
    +rrow('EBITDA маржа',eM2,eMPrev2,0,50,15,'>','%',false)
    +rrow('D/E',mult2.dde,null,0,10,2,'<','x',true)
    +rrow('Equity Ratio',eqR2,eqRPrev2,0,100,30,'>','%',false);
  var ratSumm=[];
  if(ndEb2!=null)ratSumm.push({lbl:'ND/Е',v:ndEb2.toFixed(1)+'x',c:ndEb2<=3?'var(--pos)':ndEb2<=5?'var(--warn)':'var(--neg)'});
  if(mult2.icr!=null&&isFinite(mult2.icr))ratSumm.push({lbl:'ICR',v:mult2.icr.toFixed(2)+'x',c:mult2.icr>=3?'var(--pos)':mult2.icr>=1.5?'var(--warn)':'var(--neg)'});

  var roe2=p.eq&&p.eq>0&&p.np!=null?p.np/p.eq*100:null;
  var roa2=p.assets>0&&p.np!=null?p.np/p.assets*100:null;
  var npm2=p.rev>0&&p.np!=null?p.np/p.rev*100:null;
  var roePrev2=prev&&prev.eq&&prev.eq>0&&prev.np!=null?prev.np/prev.eq*100:null;
  var roaPrev2=prev&&prev.assets>0&&prev.np!=null?prev.np/prev.assets*100:null;
  function profRow(lbl,val,prevV,key2){
    if(val==null||!isFinite(val))return '';
    var d2=prevV!=null&&isFinite(prevV)?val-prevV:null;
    var dGood2=d2==null?null:d2>0;
    var dStr2=d2!=null?'<span style="font-size:10px;font-family:var(--mono);font-weight:700;color:'+(dGood2?'var(--pos)':'var(--neg)')+'">'+((d2>0?'▲ +':'▼ ')+Math.abs(d2).toFixed(1)+'%')+'</span>':'';
    var barW2=d2!=null?Math.min(45,Math.abs(d2)/2):0;
    var barSide2=d2!=null&&d2>0?'left:50%;background:rgba(82,242,201,0.45)':'right:50%;background:rgba(255,77,122,0.45)';
    return '<div class="drow'+(key2?' key':'')+'">'
      +'<div class="drow-top"><div class="d-lbl bold">'+lbl+'</div>'+dStr2
      +'<div class="d-vals">'+(prevV!=null?'<span class="d-old">'+prevV.toFixed(1)+'%</span><span class="d-arr">→</span>':'')+'<span class="d-new'+(val>=0?'':' red')+'">'+val.toFixed(1)+'%</span></div>'
      +'</div><div class="d-bar"><div class="d-bar-ax"></div>'+(barW2>0?'<div class="d-bar-f" style="width:'+barW2+'%;'+barSide2+'"></div>':'')+'</div></div>';
  }
  var rentBody=profRow('ROE',roe2,roePrev2,true)+profRow('ROA',roa2,roaPrev2,false);
  if(npm2!=null&&isFinite(npm2))rentBody+=profRow('Чист. маржа',npm2,null,false);
  var rentSumm=[];
  if(roe2!=null&&isFinite(roe2))rentSumm.push({lbl:'ROE',v:roe2.toFixed(1)+'%',c:roe2>=15?'var(--pos)':roe2>=0?'var(--warn)':'var(--neg)'});
  if(roa2!=null&&isFinite(roa2))rentSumm.push({lbl:'ROA',v:roa2.toFixed(1)+'%',c:roa2>=10?'var(--pos)':roa2>=3?'var(--warn)':'var(--neg)'});

  var yr2=mult2.year||'';
  var plHtml2=plBody?zone('rdz-pl','var(--pur)','П&L — '+(yr2||'период'),plSumm,plBody):'';
  var bsHtml2=bsBody?zone('rdz-bs','rgba(170,90,255,0.5)','Баланс',bsSumm,bsBody):'';
  var ratHtml2=ratBody?zone('rdz-rat','var(--acc)','Коэффициенты',ratSumm,ratBody):'';
  var rentHtml2=rentBody?zone('rdz-rent','rgba(82,242,201,0.55)','Рентабельность',rentSumm,rentBody):'';
  if(!plHtml2&&!bsHtml2&&!ratHtml2&&!rentHtml2) return '';
  return '<div id="rep-dyn-panel" style="padding:0 0 8px">'+plHtml2+bsHtml2+ratHtml2+rentHtml2+'</div>';
}

// ── Карточка эмитента ─────────────────────────────────────────────────────
function _repRenderIssuerCard(id, iss){
  var active=String(repActiveIssuerId)===String(id);
  var m=_repCalcMultipliers(iss);
  function multItem(lbl,val,fmt,lowGood,tGood,tWarn){
    var txt=(val==null||!isFinite(val))?'—':fmt==='pct'?(val*100).toFixed(1)+'%':val.toFixed(2)+'×';
    var cls='';
    if(val!=null&&isFinite(val)&&tGood!=null){var ok=lowGood?val<=tGood:val>=tGood,mid=lowGood?val<=tWarn:val>=tWarn;cls=ok?'c-pos':mid?'c-warn':'c-neg';}
    return '<div class="mult-item"><div class="mult-lbl">'+lbl+'</div><div class="mult-val'+(cls?' '+cls:'')+'">'+txt+'</div></div>';
  }
  var de=m.de;
  var stripe=(de==null||!isFinite(de))?'rgba(255,255,255,0.08)':de<=2.5?'rgba(82,242,201,0.7)':de<=4.5?'rgba(232,137,90,0.7)':'rgba(255,77,122,0.7)';
  var indKey=iss.ind||'other';
  var indLabel=(window._industryData&&window._industryData.industries&&window._industryData.industries[indKey]&&window._industryData.industries[indKey].label)||indKey;
  var ratingHtml='';
  if(Array.isArray(iss.ratings)&&iss.ratings.length){
    var best=iss.ratings.slice().sort(function(a,b){return((typeof _ratingRank==='function'&&_ratingRank(b.rating))||0)-((typeof _ratingRank==='function'&&_ratingRank(a.rating))||0);})[0];
    if(best&&best.rating){var rk=(typeof _ratingRank==='function'&&_ratingRank(best.rating))||0;var rc=rk>=12?'var(--pos)':rk>=6?'var(--warn)':'var(--neg)';ratingHtml=' <span class="rtg-badge" style="color:'+rc+';border-color:'+rc+'44">'+_escHtml(best.rating)+'</span>';}
  }
  var periods=Object.keys(iss.periods||{}).length;
  var lp2=(typeof _repLatestPeriod==='function')?_repLatestPeriod(iss):null;
  var p2=lp2?lp2.period:null;
  var ndEb3=p2&&p2.debt!=null&&p2.cash!=null&&p2.ebitda&&p2.ebitda>0?(p2.debt-p2.cash)/p2.ebitda:null;
  var eM3=p2&&p2.rev>0&&p2.ebitda!=null?p2.ebitda/p2.rev:null;
  return '<div class="rep-issuer-item iss-item" data-active="'+(active?'1':'0')+'" onclick="repSelectIssuerById(\\\''+id+'\\\')">'
    +'<div style="position:absolute;left:0;top:0;bottom:0;width:2px;background:'+stripe+'"></div>'
    +'<div class="iss-name" style="padding-left:7px">'+_escHtml(iss.name||'—')+ratingHtml+'</div>'
    +'<div class="iss-meta" style="padding-left:7px">'+(iss.inn?'<span>'+iss.inn+'</span>':'')+'<span class="ind-badge" style="color:var(--pur);border-color:rgba(170,90,255,0.25)">'+_escHtml(indLabel)+'</span>'+(m.year?'<span>'+m.year+'</span>':'')+(periods>0?'<span>'+periods+' пер.</span>':'<span style="opacity:.4">нет данных</span>')+'</div>'
    +'<div class="mult-row" style="padding-left:7px">'+multItem('Д/EBITDA',m.de,'x',true,2.5,4.5)+multItem('ICR',m.icr,'x',false,3.0,1.5)+(eM3!=null?multItem('EBITDA%',eM3,'pct',false,0.25,0.10):'')+(ndEb3!=null?multItem('ЧД/Е',ndEb3,'x',true,2.5,4.0):'')+'</div>'
    +'</div>';
}

// ── Override repSelectIssuerById — inject 4-zone dynamics panel ───────────
(function(){
  var _prevSel=window.repSelectIssuerById;
  window.repSelectIssuerById=function(id){
    _prevSel(id);
    document.querySelectorAll('.rep-issuer-item').forEach(function(el){
      var oc=el.getAttribute('onclick')||'';
      var mm=oc.match(/repSelectIssuerById\('([^']+)'\)/);
      el.dataset.active=(mm&&mm[1]===id)?'1':'0';
    });
    setTimeout(function(){
      var iss=(reportsDB||{})[id]; if(!iss) return;
      var old=document.getElementById('rep-dyn-panel'); if(old) old.remove();
      var html=_repBuildDynPanel(iss); if(!html) return;
      var div=document.createElement('div'); div.innerHTML=html;
      var target=document.getElementById('rep-np-ref-wrap');
      if(target&&target.parentNode) target.parentNode.insertBefore(div.firstElementChild,target);
    },150);
  };
})();

// ── Replace cards after each render ──────────────────────────────────────
(function(){
  var _origRIL2=window.repRenderIssuerList;
  window.repRenderIssuerList=function(){
    _origRIL2();
    var listEl=document.getElementById('rep-sidebar-list'); if(!listEl) return;
    listEl.querySelectorAll('.rep-issuer-item').forEach(function(el){
      var oc=el.getAttribute('onclick')||'';
      var mm=oc.match(/repSelectIssuerById\('([^']+)'\)/); if(!mm) return;
      var id=mm[1],iss=(reportsDB||{})[id]; if(!iss) return;
      var wasHidden=el.style.display==='none';
      var tmp=document.createElement('div'); tmp.innerHTML=_repRenderIssuerCard(id,iss);
      var card=tmp.firstElementChild; if(!card) return;
      if(wasHidden) card.style.display='none';
      el.parentNode.replaceChild(card,el);
    });
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

${extJs}

showPage = function(){
  var rp = document.getElementById('page-reports');
  if(rp) rp.style.display = '';
};

// Запуск — даём localStorage-прокси 200мс заполниться данными от shell
setTimeout(function(){
  try { loadState(); } catch(e){ console.warn('loadState:',e); }
  try { repInit(); } catch(e){ console.error('repInit:',e); }
  setTimeout(_repStructureSidebar, 80);
}, 200);

window.addEventListener('message',function(e){
  var d=e.data; if(!d) return;
  if(d.type==='SHELL_STATE'){
    if(d.token)  try{ localStorage.setItem('ba_apikey',d.token); }catch(ex){}
    if(d.apiUrl) try{ localStorage.setItem('bondan_girbo_proxy',d.apiUrl); _d1Base=d.apiUrl.replace(/\\/$/,''); }catch(ex){}
  }
});
<\/script>
</body>
</html>`;

fs.writeFileSync('/home/user/Ti/modules/reports-full.html', out);
console.log('Size:', Math.round(Buffer.byteLength(out)/1024)+'KB');
