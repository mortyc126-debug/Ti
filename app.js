'use strict';

// ══ ГЛОБАЛЬНЫЕ ОШИБКИ → тост ══
// Чтобы JS-вылеты не терялись в консоли (особенно на мобиле, где DevTools нет).
// Тап по тосту копирует сообщение в буфер — удобно прислать в чат.
function showToast(msg, kind){
  kind = kind || 'info';
  const colorMap = { info:'var(--acc)', warn:'var(--warn)', err:'var(--danger)', ok:'var(--green)' };
  const color = colorMap[kind] || colorMap.info;
  const t = document.createElement('div');
  t.style.cssText = `position:fixed;bottom:20px;right:20px;max-width:min(92vw,480px);
    background:var(--s2);border:1px solid ${color};color:${color};
    font-family:var(--mono);font-size:.66rem;padding:9px 14px;z-index:99999;
    box-shadow:0 4px 14px rgba(0,0,0,.35);cursor:pointer;word-break:break-word;
    line-height:1.45`;
  t.textContent = msg;
  t.title = 'Тап — скопировать';
  t.onclick = () => {
    (navigator.clipboard?.writeText(msg) || Promise.reject()).catch(()=>{}).finally(()=>{
      t.style.borderColor = 'var(--green)';
      t.style.color = 'var(--green)';
      t.textContent = '✓ скопировано';
      setTimeout(()=>t.remove(), 900);
    });
  };
  document.body.appendChild(t);
  setTimeout(()=>t.remove(), kind === 'err' ? 12000 : 5000);
  return t;
}

(function(){
  let last = '', lastAt = 0;
  function report(tag, msg){
    if(!msg) return;
    // Игнорируем мусор от сторонних расширений / ResizeObserver.
    if(/^(ResizeObserver loop|Script error\.?)\s*$/i.test(msg)) return;
    // Деду́пим одинаковые сообщения в течение 3 сек.
    const now = Date.now();
    if(msg === last && now - lastAt < 3000) return;
    last = msg; lastAt = now;
    console.error('[' + tag + ']', msg);
    showToast('⚠️ ' + tag + ': ' + msg.slice(0, 400), 'err');
  }
  window.addEventListener('error', e => {
    // Событие error также срабатывает на ошибки загрузки ресурсов (img/script) —
    // в таком случае e.error === null. Их пропускаем.
    if(!e.error && !e.message) return;
    const stack = e.error?.stack ? '\n' + e.error.stack.split('\n').slice(0,3).join('\n') : '';
    report('JS', (e.message || 'ошибка') + stack);
  });
  window.addEventListener('unhandledrejection', e => {
    const r = e.reason;
    const msg = r?.stack || r?.message || (typeof r === 'string' ? r : JSON.stringify(r));
    report('Promise', msg || 'unhandled rejection');
  });
})();

// ══ CONSTANTS ══
const RATE_NOW=15;
const IND_NAMES={energy:'Нефть и газ',metals:'Металлургия',retail:'Ритейл',telecom:'Телеком',finance:'Финансы/Банки',realty:'Недвижимость',transport:'Транспорт',agro:'АПК',other:'Другое'};
const IND_NORMS={
  energy:  {ndE:2.5,dscr:3.0,cur:1.2,ib:15,marg:15},
  metals:  {ndE:2.0,dscr:3.5,cur:1.3,ib:12,marg:12},
  retail:  {ndE:3.5,dscr:2.0,cur:1.0,ib:25,marg:4},
  telecom: {ndE:2.5,dscr:3.0,cur:0.9,ib:18,marg:20},
  finance: {ndE:5.0,dscr:1.5,cur:1.1,ib:40,marg:15},
  realty:  {ndE:5.0,dscr:1.8,cur:1.0,ib:30,marg:25},
  transport:{ndE:3.0,dscr:2.5,cur:1.1,ib:20,marg:10},
  agro:    {ndE:3.0,dscr:2.5,cur:1.2,ib:18,marg:8},
  other:   {ndE:3.0,dscr:2.5,cur:1.2,ib:20,marg:10},
};
const CT_LABELS={fix:'Фикс',float:'Флоатер',zero:'Нулевой'};
const CT_COLOR={fix:'var(--acc2)',float:'var(--warn)',zero:'var(--purple)'};
const BT_TAG={ОФЗ:'tag-ofz',Корп:'tag-corp',Муни:'tag-muni'};

// ══ STATE ══
let ytmRate=10, ytmBonds=[], portfolio=[], watchlists={}, activeWL=null, calEvents=[], reportsDB={};

function loadState(){
  try{const d=JSON.parse(localStorage.getItem('ba_v2')||'{}');
    ytmBonds=d.ytmBonds||[]; portfolio=d.portfolio||[]; watchlists=d.watchlists||{};
    calEvents=d.calEvents||[]; reportsDB=d.reportsDB||{};
  }catch(e){}
}
function save(){
  try{localStorage.setItem('ba_v2',JSON.stringify({ytmBonds,portfolio,watchlists,calEvents,reportsDB}))}catch(e){}
}

// ══ NAV ══
function showPage(n){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById('page-'+n).classList.add('active');
  const idx=['ytm','issuer','reports','portfolio','pnl','watchlist','calendar','industries','cross'].indexOf(n);
  if(idx>=0) document.querySelectorAll('.nav-btn')[idx].classList.add('active');
  if(n==='portfolio') renderPort();
  if(n==='watchlist') renderWL();
  if(n==='ytm') renderYtm();
  if(n==='calendar'){renderCalendar();updateCalStats();}
  if(n==='reports') repInit();
  if(n==='industries') indRender();
  if(n==='cross') crossInit();
  if(n==='moex') moexInit();
}
function sbAct(el){document.querySelectorAll('.sb-item').forEach(i=>i.classList.remove('active'));el.classList.add('active')}
function swIssTab(t,el){
  document.querySelectorAll('#page-issuer .ptab').forEach(p=>p.classList.remove('active'));
  el.classList.add('active');
  document.querySelectorAll('#page-issuer .ptab-c').forEach(p=>p.classList.remove('active'));
  const tab=document.getElementById('iss-tab-'+t);
  if(tab) tab.classList.add('active');
  if(t==='result') analyzeAuto();
}
function newListModal(){document.getElementById('modal-nl').classList.add('open');document.getElementById('nl-name').focus()}
function closeModal(id){document.getElementById(id).classList.remove('open')}
function createList(){
  const nm=document.getElementById('nl-name').value.trim(); if(!nm)return;
  const id='wl_'+Date.now(); watchlists[id]={name:nm,bonds:[]};
  save(); closeModal('modal-nl'); document.getElementById('nl-name').value='';
  renderWL(); renderSbLists(); setActiveWL(id);
}

// ══ MATH ══
function calcYTM(price,coupon,years){
  const n=Math.round(years*2),c=coupon/2; let y=coupon/price;
  for(let i=0;i<300;i++){
    const r=y/2; let pv=0,dp=0;
    for(let t=1;t<=n;t++){const d=Math.pow(1+r,t);pv+=c/d;dp-=t*c/(d*(1+r))}
    const dN=Math.pow(1+r,n); pv+=100/dN; dp-=n*100/(dN*(1+r));
    const df=pv-price; if(Math.abs(df)<1e-5)break; y-=df/dp;
  }
  return y*100;
}
function priceAtY(coupon,years,ytmPct){
  const n=Math.round(years*2),c=coupon/2,r=ytmPct/200;
  let pv=0; for(let t=1;t<=n;t++)pv+=c/Math.pow(1+r,t);
  return pv+100/Math.pow(1+r,n);
}
function ytmCls(v){return v>=14?'val-pos':v>=10?'val-neu':'val-neg'}
function rub(v,sign=false){return (sign&&v>0?'+':'')+v.toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2})+' ₽'}

// ══ YTM PAGE ══
function onYtmCType(){
  const t=document.getElementById('yf-ctype').value;
  document.getElementById('yf-fix-row').style.display=t==='fix'?'':'none';
  document.getElementById('yf-float-row').style.display=t==='float'?'':'none';
  document.getElementById('yf-zero-row').style.display=t==='zero'?'':'none';
}
function onYtmRate(){
  ytmRate=parseFloat(document.getElementById('ytm-rate').value);
  document.getElementById('ytm-rate-val').textContent=ytmRate+'%';
  document.getElementById('ytm-sc-col').textContent=`При КС ${ytmRate}%`;
  renderYtm();
}
function resetYtm(){if(!ytmBonds.length||confirm('Сбросить все выпуски?')){ytmBonds=[];save();renderYtm()}}
function removeYtmBond(id){ytmBonds=ytmBonds.filter(b=>b.id!==id);save();renderYtm()}

function addBond(){
  const name=document.getElementById('yf-name').value.trim();
  const btype=document.getElementById('yf-btype').value;
  const ctype=document.getElementById('yf-ctype').value;
  const price=parseFloat(document.getElementById('yf-price').value);
  const years=parseFloat(document.getElementById('yf-years').value);
  if(!name||isNaN(price)||isNaN(years)||price<=0||years<=0){alert('Введите название, цену и срок');return}
  const buyPriceRaw=parseFloat(document.getElementById('yf-buyprice').value);
  const b={name,btype,ctype,price,years,id:Date.now()+Math.random()};
  if(!isNaN(buyPriceRaw)&&buyPriceRaw>0&&buyPriceRaw!==price) b.buyPrice=buyPriceRaw;
  if(ctype==='fix'){
    const c=parseFloat(document.getElementById('yf-coupon').value);
    if(isNaN(c)||c<=0){alert('Введите купон');return}
    b.coupon=c; b.ytm=calcYTM(price,c,years);
  }else if(ctype==='float'){
    const spread=parseFloat(document.getElementById('yf-spread').value);
    if(isNaN(spread)){alert('Введите спред');return}
    b.base=document.getElementById('yf-base').value; b.spread=spread;
    b.ytm=RATE_NOW+spread-(price-100)/years;
  }else{
    b.coupon=0; b.ytm=((100/price)-1)/years*100;
  }
  ytmBonds.push(b); save(); renderYtm();
  ['yf-isin','yf-name','yf-price','yf-years','yf-coupon','yf-spread','yf-buyprice'].forEach(id=>{const el=document.getElementById(id);if(el)el.value=''});
  document.getElementById('yf-moex-status').textContent='';
}

function addBondToWL(b){
  const keys=Object.keys(watchlists);
  if(!keys.length){newListModal();return}
  watchlists[keys[0]].bonds.push({...b,note:'Из YTM',addedAt:Date.now()});
  save(); alert(`Добавлено в «${watchlists[keys[0]].name}»`);
}

function renderYtm(){
  const tbody=document.getElementById('ytm-tbody');
  const empty=document.getElementById('ytm-empty');
  const bestEl=document.getElementById('ytm-best');
  if(!ytmBonds.length){tbody.innerHTML='';empty.style.display='block';bestEl.innerHTML='';return}
  empty.style.display='none';

  const en=ytmBonds.map(b=>{
    let ytmS,dPct;
    if(b.ctype==='float'){
      const fb=b.base==='RUONIA'?ytmRate-.5:ytmRate;
      ytmS=fb+(b.spread||0); dPct=0;
    }else if(b.ctype==='zero'){
      const nY=b.ytm*(ytmRate/RATE_NOW);
      const nP=100/Math.pow(1+nY/100,b.years);
      dPct=(nP-b.price)/b.price*100; ytmS=b.ytm+dPct/b.years;
    }else{
      const nY=b.ytm*(ytmRate/RATE_NOW);
      const nP=priceAtY(b.coupon,b.years,nY);
      dPct=(nP-b.price)/b.price*100; ytmS=b.ytm+dPct/b.years;
    }
    return{...b,ytmS,dPct};
  }).sort((a,b)=>b.ytmS-a.ytmS);

  const maxS=en[0].ytmS, minS=en[en.length-1].ytmS;
  tbody.innerHTML=en.map((b,i)=>{
    const sc=maxS===minS?100:Math.round((b.ytmS-minS)/(maxS-minS)*100);
    const stars=sc>=80?'★★★':sc>=40?'★★☆':'★☆☆';
    const scol=sc>=80?'var(--green)':sc>=40?'var(--warn)':'var(--danger)';
    const scls=sc>=80?'score-hi':sc>=40?'score-md':'score-lo';
    const params=b.ctype==='float'?`${b.base}+${b.spread}%`:b.ctype==='zero'?'дисконт':`${(b.coupon||0).toFixed(2)}%`;
    const sCell=b.ctype==='float'
      ?`<span class="${ytmCls(b.ytmS)}">${b.ytmS.toFixed(2)}%</span><br><small style="color:var(--warn)">купон↓с КС</small>`
      :`<span class="${ytmCls(b.ytmS)}">${b.ytmS.toFixed(2)}%</span>`;
    const dCell=b.ctype==='float'?'<span style="color:var(--text3)">—</span>'
      :`<span class="${b.dPct>=0?'val-pos':'val-neg'}">${b.dPct>=0?'+':''}${b.dPct.toFixed(1)}%</span>`;

    // YTM покупки — если бумага добавлена из портфеля (есть buyPrice) или вручную задана цена покупки
    let ytmBuyCell = '<span style="color:var(--text3)">—</span>';
    if(b.buyPrice && b.buyPrice !== b.price && b.ctype !== 'float'){
      let ytmB;
      if(b.ctype==='zero') ytmB = ((100/b.buyPrice)-1)/b.years*100;
      else if(b.coupon>0)  ytmB = calcYTM(b.buyPrice, b.coupon, b.years);
      if(ytmB!=null && isFinite(ytmB)){
        const delta = b.ytm - ytmB;
        const dColor = Math.abs(delta)<0.05?'var(--text3)':delta>0?'var(--danger)':'var(--green)';
        ytmBuyCell = `<div>
          <span class="${ytmCls(ytmB)}" style="font-weight:600">${ytmB.toFixed(2)}%</span>
          <span style="font-size:.56rem;color:${dColor};display:block">${delta>=0?'+':''}${delta.toFixed(2)}% vs рынок</span>
        </div>`;
      }
    } else if(b.buyPrice && b.buyPrice !== b.price && b.ctype==='float'){
      const ytmB = RATE_NOW+(b.spread||0)-(b.buyPrice-100)/(b.years||2);
      if(isFinite(ytmB)){
        const delta = b.ytm - ytmB;
        const dColor = Math.abs(delta)<0.05?'var(--text3)':delta>0?'var(--danger)':'var(--green)';
        ytmBuyCell = `<div>
          <span class="${ytmCls(ytmB)}" style="font-weight:600">${ytmB.toFixed(2)}%</span>
          <span style="font-size:.56rem;color:${dColor};display:block">${delta>=0?'+':''}${delta.toFixed(2)}% vs рынок</span>
        </div>`;
      }
    }

    const bs=JSON.stringify(b).replace(/'/g,"&#39;");
    return`<tr class="${i===0?'tr-best':''}">
      <td style="color:var(--text3)">${i+1}</td>
      <td style="font-weight:600">${b.name}</td>
      <td><span class="tag ${BT_TAG[b.btype]||'tag-corp'}">${b.btype}</span></td>
      <td><span class="tag ct-${b.ctype}" style="font-size:.54rem">${CT_LABELS[b.ctype]}</span></td>
      <td style="color:var(--text2)">${params}</td>
      <td>${b.price.toFixed(2)}%</td><td>${b.years.toFixed(1)} л.</td>
      <td><span class="${ytmCls(b.ytm)} val-big">${b.ytm.toFixed(2)}%</span></td>
      <td>${ytmBuyCell}</td>
      <td>${sCell}</td><td>${dCell}</td>
      <td><div style="color:${scol};font-size:.78rem;margin-bottom:3px">${stars}</div>
          <div class="score-bar"><div class="score-fill ${scls}" style="width:${sc}%"></div></div></td>
      <td><div style="display:flex;gap:3px">
        <button class="btn btn-sm" onclick='addBondToWL(${bs})' title="В список">⭐</button>
        <button class="btn btn-sm" onclick="prefillIssuer('${b.name.replace(/'/g,"\\'")}');showPage('issuer')" title="Эмитент">🏢</button>
        <button class="btn btn-sm btn-d" onclick="removeYtmBond(${b.id})">✕</button>
      </div></td>
    </tr>`;
  }).join('');

  const top=en[0];
  const sl=top.ctype==='float'?`${top.base}+${top.spread}% · флоатер`:top.ctype==='zero'?'нулевой купон':`купон ${(top.coupon||0).toFixed(2)}%`;
  bestEl.innerHTML=`<div style="background:var(--green-dim);border:1px solid var(--green);padding:13px 19px;display:flex;align-items:center;gap:18px;flex-wrap:wrap;margin-top:4px">
    <div>
      <div style="font-size:.54rem;letter-spacing:.14em;text-transform:uppercase;color:var(--green);margin-bottom:2px">▶ Лучший при КС ${ytmRate}%</div>
      <div style="font-family:var(--serif);font-size:1.25rem;color:var(--green)">${top.name}</div>
      <div style="font-size:.63rem;color:var(--text2);margin-top:2px">${sl} · ${top.btype} · покупка по ${top.price.toFixed(2)}%</div>
    </div>
    <div style="display:flex;gap:18px;margin-left:auto;flex-wrap:wrap">
      <div class="stat-card" style="min-width:75px;padding:9px 13px"><div class="sc-lbl">YTM сейчас</div><div class="sc-val val-pos">${top.ytm.toFixed(2)}%</div></div>
      <div class="stat-card" style="min-width:75px;padding:9px 13px"><div class="sc-lbl">При КС ${ytmRate}%</div><div class="sc-val val-pos">${top.ytmS.toFixed(2)}%</div></div>
      ${top.ctype!=='float'?`<div class="stat-card" style="min-width:75px;padding:9px 13px"><div class="sc-lbl">Δ цены</div><div class="sc-val ${top.dPct>=0?'val-pos':'val-neg'}">${top.dPct>=0?'+':''}${top.dPct.toFixed(1)}%</div></div>`:''}
      <div class="stat-card" style="min-width:75px;padding:9px 13px"><div class="sc-lbl">До погаш.</div><div class="sc-val">${top.years.toFixed(1)} л.</div></div>
    </div>
  </div>`;
}

// ══ PORTFOLIO + MOEX ISIN LOOKUP ══

// ══ REFRESH ALL PRICES ══
async function refreshAllPrices() {
  const btn = document.getElementById('refresh-all-btn');
  const status = document.getElementById('refresh-status');
  status.style.display = 'block';
  status.style.color = 'var(--warn)';
  status.textContent = `Портфель: ${portfolio.length} позиций, с ISIN: ${portfolio.filter(p=>p.isin).length}`;

  // Collect unique ISINs from portfolio
  const positions = portfolio.filter(p => p.isin);
  if (!positions.length) {
    // Try to get ISINs from the hardcoded list
    const isinMap = {
      'ВИС ФИНАНС БО-П10':'RU000A10DA41','Кредитный поток 3.0':'RU000A10DBM5',
      'ОФЗ 29008':'RU000A0JV4P3','РЖД БО 001Р-26R':'RU000A106K43',
      'Село Зелёное Холдинг БО-П02':'RU000A10DQ68','ТГК-14 001Р-01':'RU000A1066J2',
      'ТрансКонтейнер П02-01':'RU000A109E71','АФК Система 002P-05':'RU000A10CU55',
      'Аэрофлот П02-БО-02':'RU000A10CS75','Биннофарм Групп 001P-05':'RU000A10B3Q2',
      'Газпром капитал БО-003Р-07':'RU000A10DLE1','ГТЛК 002Р-10':'RU000A10CR50',
      'Нижегородская обл. 34017':'RU000A10DJA3','Авто Финанс Банк БО-001Р-13':'RU000A109KY4',
      'Селигдар 001Р-09':'RU000A10DTA2','АБЗ-1 002P-04':'RU000A10DCK7',
      'Арктик Технолоджи БО-01':'RU000A10BV89','ВИС ФИНАНС БО-П11':'RU000A10EES4',
      'Группа Позитив 001P-03':'RU000A10BWC6','ГТЛК 002Р-04':'RU000A10A3Z4',
      'КАМАЗ ПАО БО-П20':'RU000A10EAC6','ПГК 003Р-02':'RU000A10DSL1',
      'Сэтл Групп 002Р-04':'RU000A10B8M0','Кредитный поток 3.0 (ИИС)':'RU000A10DBM5',
      'Село Зелёное Х (ИИС)':'RU000A10DQ68','Эконива 001Р-01':'RU000A10EJZ8',
    };
    portfolio.forEach(p => { if(!p.isin && isinMap[p.name]) p.isin = isinMap[p.name]; });
    save();
    status.textContent = `ISIN восстановлены, повторите обновление`;
    return;
  }

  btn.disabled = true;
  btn.textContent = '⏳ Обновляю...';
  status.style.display = 'block';
  status.style.color = 'var(--warn)';

  let updated = 0, failed = 0;
  const uniqueIsins = [...new Set(positions.map(p => p.isin))];

  for (let i = 0; i < uniqueIsins.length; i++) {
    const isin = uniqueIsins[i];
    status.textContent = `Обновляю ${i+1} из ${uniqueIsins.length}: ${isin}...`;
    try {
      // Step 1: get secid from isin
      const s = await moexFetch(`/iss/securities.json?q=${encodeURIComponent(isin)}&limit=3`);
      const scols = s?.securities?.columns || [];
      const srows = s?.securities?.data || [];
      const sidIdx = scols.indexOf('secid');
      if (!srows.length) { failed++; continue; }
      const secid = sidIdx >= 0 ? srows[0][sidIdx] : srows[0][0];

      // Step 2: get current price
      const mkt = await moexFetch(`/iss/engines/stock/markets/bonds/securities/${encodeURIComponent(secid)}.json`);
      const price = parseMoexPrice(mkt);

      // Step 3: also get coupon from description if missing
      let coupon = null;
      try {
        const desc = await moexFetch(`/iss/securities/${encodeURIComponent(secid)}.json`);
        const dMap = parseMoexDesc(desc);
        const c = parseFloat(dMap['COUPONPERCENT'] || '');
        if (!isNaN(c) && c > 0) coupon = c;
        // update maturity/years
        const maturity = dMap['MATDATE'] || dMap['OFFERDATE'] || '';
        if (maturity) {
          const ms = new Date(maturity) - new Date();
          if (ms > 0) {
            const years = parseFloat((ms/1000/60/60/24/365).toFixed(2));
            portfolio.forEach(p => {
              if (p.isin === isin) { p.years = years; }
            });
          }
        }
      } catch(e) {}

      if (price) {
        portfolio.forEach(p => {
          if (p.isin === isin) {
            p.cur = parseFloat(price.toFixed(2));
            if (coupon !== null && p.ctype === 'fix') p.coupon = coupon;
            // recalc ytm
            if (p.ctype === 'fix') {
              p.ytm = parseFloat(calcYTM(p.buy, p.coupon, p.years || 2).toFixed(2));
            }
          }
        });
        updated++;
      } else {
        failed++;
      }
    } catch(e) {
      failed++;
    }
    // Small delay to not hammer MOEX
    await new Promise(r => setTimeout(r, 300));
  }

  save();
  renderPort();

  btn.disabled = false;
  btn.textContent = '⟳ Обновить все цены';
  status.style.color = updated > 0 ? 'var(--green)' : 'var(--danger)';
  status.textContent = `✓ Обновлено ${updated} из ${uniqueIsins.length} бумаг${failed ? ` · ${failed} не найдено` : ''}`;
}

// ══ PDF PARSER ══
// Универсальная функция — определяет тип файла и парсит нужным способом
// ══════════════════════════════════════════════════════
// Общие хелперы парсинга отчётности (PDF/DOCX/XLSX).
// Используются и parseAnyReport (вкладка «Эмитент»), и
// repExtractPdf/repFillFromText (вкладка «Отчётность»).
// ══════════════════════════════════════════════════════

// Известные коды строк РСБУ (форма 1 — баланс, форма 2 — ОФР). Нужен
// ДО extractPdfTextLines (там же идёт классификация колонок).
const RSBU_CODE_SET = new Set([
  1110,1120,1130,1140,1150,1160,1170,1180,1190,1100,
  1210,1220,1230,1240,1250,1260,1200,1600,
  1310,1320,1340,1350,1360,1370,1300,
  1410,1420,1430,1450,1400,
  1510,1520,1530,1540,1550,1500,
  1700,
  2110,2120,2100,2210,2220,2200,2310,2320,2330,2340,2350,2300,
  2410,2421,2460,2400,2510,2520,2500,
]);

// ── Маркер синтетической строки заголовков таблицы. extractPdfTextLines
// эмитит её один раз на каждую страницу, чтобы findVal/findValTrace знали
// какому году/периоду соответствует каждая колонка значений.
const _HEADER_MARKER = '__HDR__';

// Извлекает год из произвольной строки заголовка («2024», «31.12.2024»,
// «На 31 декабря 2024 года», «За год, закончившийся 31 декабря 2024 г.»).
// Для безопасности ограничиваем диапазон 1950–2099 и используем границы
// слова, чтобы не подхватить год внутри большого числа.
function _parseYearLabel(s){
  if(!s) return null;
  const m = String(s).match(/(?:^|\D)(19[5-9]\d|20\d{2})(?:\D|$)/);
  return m ? parseInt(m[1], 10) : null;
}

// Парсит синтетическую строку __HDR__\t<year1>\t<year2>… из вывода
// extractPdfTextLines. Возвращает массив year/null по индексу
// колонки значений (соответствует cells[i+1] в data-строке) либо
// null если это не header-строка.
function _parseHeaderCells(line){
  if(!line || !line.startsWith(_HEADER_MARKER)) return null;
  const cells = line.split('\t').slice(1);
  return cells.map(c => _parseYearLabel(c));
}

// Выбирает «лучшую» ячейку из табличной строки.
//   cellNums — массив чисел/null по индексу value-колонки (после
//              padding до длины value-колонок).
//   colYears — массив year/null того же размера.
// Логика приоритетов:
//   1) исключаем ячейки, чьё значение совпадает с известным РСБУ-кодом,
//   2) если есть «крупные» (|n|≥100) — берём из них самую свежую (по году),
//   3) иначе — первое не-кодовое не-null,
//   4) иначе — первое вообще не-null.
// Возвращает {value, year, colIdx} либо null.
function _pickValueCell(cellNums, colYears){
  if(!cellNums || !cellNums.length) return null;
  const present = cellNums
    .map((v, i) => ({v, i, year: (colYears && colYears[i] != null) ? colYears[i] : null}))
    .filter(o => o.v != null);
  if(!present.length) return null;
  const nonCode = present.filter(o => !RSBU_CODE_SET.has(Math.abs(o.v)));
  const pool0 = nonCode.length ? nonCode : present;
  const big = pool0.filter(o => Math.abs(o.v) >= 100);
  const pool = big.length ? big : pool0;
  // Сортировка: сначала самый свежий год (известный), потом порядок слева→направо.
  pool.sort((a, b) => {
    const ya = a.year ?? -Infinity;
    const yb = b.year ?? -Infinity;
    if(yb !== ya) return yb - ya;
    return a.i - b.i;
  });
  const w = pool[0];
  return {value: w.v, year: w.year, colIdx: w.i};
}

// (Ранее тут жили _isSectionHeader/_looksLikeContinuation для попытки
// склеивать многострочные desc. На практике в плотных таблицах это
// давало неверные соединения соседних data-строк — логика убрана.
// Picker и findVal умеют look-ahead на уровне строк без склейки.)

// Универсальный построитель «структурного» вывода из array-of-arrays
// (rowsAoa = [[desc, val1, val2 …], …]). Заполняет те же глобалы,
// что и extractPdfTextLines, чтобы Picker (🎯 Ручной подбор,
// modal-picker-context, и т.п.) работал одинаково на DOCX/XLSX/CSV.
// Возвращает tab-разделённый текст (вход для findVal/findValTrace).
//
// Использование: repExtractDocx/repExtractXlsx формируют aoa из
// соответствующего формата и передают сюда. extractPdfTextLines
// остаётся отдельной реализацией с классификацией колонок по X —
// это сильнее подходит для плотных PDF-таблиц.
function _buildRowsFromAoa(aoa, {label=''} = {}){
  window._pickerPdfDoc = null;            // был PDF? уже нет
  window._pickerPdfTableRows = [];
  window._pickerPdfPageHeaders = {1: []};
  window._pickerPdfPageBoundaries = [0];
  const tableRows = window._pickerPdfTableRows;
  const pageHeaders = window._pickerPdfPageHeaders;
  const page = 1;
  let out = '';
  let curLineIdx = 0;
  // Сначала определяем «year» для каждой value-колонки, если в первых
  // 1–3 строках встречаются год/дата/период — эмитим __HDR__, чтобы
  // findVal/findValTrace выбирали самое свежее значение.
  let headerYears = null;
  const scanRows = aoa.slice(0, 5);
  for(const row of scanRows){
    if(!row || !row.length) continue;
    const cells = row.map(c => String(c == null ? '' : c));
    // Пропускаем пустой desc или саму строку, если первая ячейка — это
    // число (значит это data-строка, а не шапка).
    const hasNumFirstCell = /^\s*-?\d/.test(cells[0] || '');
    if(hasNumFirstCell) break;
    const yrs = cells.slice(1).map(c => _parseYearLabel(c));
    if(yrs.some(y => y != null)){
      headerYears = yrs;
      break;
    }
  }
  if(headerYears && headerYears.length){
    const hdrLine = _HEADER_MARKER + '\t' + headerYears.map(y => y != null ? String(y) : '').join('\t');
    out += hdrLine + '\n';
    tableRows.push({lineIdx: curLineIdx, page, desc: hdrLine, cols: []});
    curLineIdx++;
  }
  if(label){
    out += '— ' + label + ' —\n';
    tableRows.push({lineIdx: curLineIdx, page, desc: '— ' + label + ' —', cols: []});
    curLineIdx++;
  }
  for(const rowCells of aoa){
    if(!rowCells || !rowCells.length) continue;
    const cells = rowCells.map(c => {
      const s = c == null ? '' : String(c);
      return s.replace(/\s+/g, ' ').trim();
    });
    const desc = cells[0] || '';
    const cols = cells.slice(1);
    const hasValues = cols.some(c => c && /\d/.test(c));
    if(!desc && !hasValues) continue;
    tableRows.push({lineIdx: curLineIdx, page, desc, cols: cols.slice()});
    if(!hasValues && /(19|20)\d{2}|закончи|по состоянию|месяц|полугод|квартал/i.test(desc) && desc.length < 220){
      pageHeaders[page].push(desc);
    }
    out += [desc, ...cols].join('\t') + '\n';
    curLineIdx++;
  }
  window._pickerPdfPageBoundaries.push((out.match(/\n/g) || []).length);
  return out;
}

// Из плоского «mammoth extractRawText» вывода делаем хотя бы слабую
// структуру: каждая строка → одна запись с единственной ячейкой desc.
// Это даёт Picker'у возможность сопоставлять ключевые слова и искать
// числа в соседних строках (look-ahead), пусть и без колоночной
// разбивки.
function _aoaFromFlatText(txt){
  return String(txt||'').split(/\r?\n/).map(l => [l]);
}

// ═══════════════════════════════════════════════════════════════════
// РАСПОЗНАВАНИЕ РАЗДЕЛОВ ОТЧЁТА
// ═══════════════════════════════════════════════════════════════════
// Без ориентирования по разделам findVal регулярно путал:
//   • «Денежные средства» в балансе vs «ДС на конец периода» в ОДДС
//     (разные цифры!);
//   • «Чистая прибыль» в ОПиУ vs та же строка в ОДДС («Прибыль до
//     налогообложения» в operating activities);
//   • «Выручка» в основном ОПиУ vs сегментной разбивке (где итоги
//     другие — по географии/сегментам);
//   • «Итого активы» в балансе vs «Итого активы сегмента X»
//     в примечаниях.
//
// Идея: находим заголовки разделов («Отчёт о финансовом положении»,
// «Отчёт о прибылях и убытках», «Отчёт о движении денежных средств»
// и т.п.), размечаем по ним диапазоны строк, и в findVal добавляем
// +бонус/−штраф к score в зависимости от того, в каком разделе
// оказался кандидат для каждого конкретного показателя.

const _SECTION_RE_PNL = /отч[её]т\s+о\s+(?:прибыл[а-я]*\s+и\s+убытк[а-я]*|совокуп[а-я]+\s+(?:дох|финансов)|полном\s+совокуп|финансов[а-я]+\s+результат[а-я]*)|отч[её]т\s+о\s+прибыл[а-я]*|statement\s+of\s+(?:profit|comprehensive|income|operations|financial\s+performance)/i;
const _SECTION_RE_BAL = /отч[её]т\s+о\s+финансов[а-я]+\s+положен[а-я]+|бухгалтерск[а-я]+\s+баланс\b|\bbalance\s+sheet\b|statement\s+of\s+financial\s+position/i;
const _SECTION_RE_CF  = /отч[её]т\s+о\s+движен[а-я]+\s+денежн[а-я]+\s+средств|statement\s+of\s+cash\s+flows?/i;
const _SECTION_RE_EQ  = /отч[её]т\s+об\s+изменен[а-я]+\s+капитал[а-я]*|statement\s+of\s+changes\s+in\s+equity/i;
const _SECTION_RE_NOTE = /^\s*(?:примечание|note)\s+(\d+)[.\s:)\-—]/i;
const _SECTION_RE_SEGMENT = /\bинформация\s+по\s+(?:операционн[а-я]+\s+)?сегмент|отч[её]тн[а-я]+\s+сегмент|segment\s+(?:information|reporting)/i;

function _classifySectionTitle(desc){
  if(!desc) return null;
  const s = String(desc).replace(/\s+/g,' ').trim();
  if(!s || s.length > 200) return null;
  // Сегменты — ВАЖНО проверять раньше ОПиУ, т.к. подпись вроде
  // «Информация по операционным сегментам. Выручка сегмента» может
  // совпасть и с PnL (слово «выручк»).
  if(_SECTION_RE_SEGMENT.test(s)) return {kind: 'segments'};
  if(_SECTION_RE_PNL.test(s))     return {kind: 'pnl'};
  if(_SECTION_RE_BAL.test(s))     return {kind: 'balance'};
  if(_SECTION_RE_CF.test(s))      return {kind: 'cashflow'};
  if(_SECTION_RE_EQ.test(s))      return {kind: 'equity'};
  const mNote = s.match(_SECTION_RE_NOTE);
  if(mNote) return {kind: 'note', n: parseInt(mNote[1], 10)};
  return null;
}

// Сканируем строки и размечаем: [{kind, startLineIdx, endLineIdx, title}].
// Новый раздел закрывает предыдущий (endLineIdx = next.start − 1).
function _detectReportSections(textOrLines){
  const lines = Array.isArray(textOrLines) ? textOrLines : String(textOrLines||'').split('\n');
  const sections = [];
  for(let i = 0; i < lines.length; i++){
    const line = lines[i] || '';
    if(!line || line.startsWith(_HEADER_MARKER)) continue;
    const cells = line.split('\t');
    const desc = cells[0] || '';
    // Заголовки разделов почти всегда без чисел — data-строки пропускаем.
    const hasValues = cells.slice(1).some(c => /\d/.test(c));
    if(hasValues) continue;
    const cls = _classifySectionTitle(desc);
    if(!cls) continue;
    sections.push({
      kind: cls.kind,
      n: cls.n || null,
      startLineIdx: i,
      endLineIdx: lines.length - 1,
      title: desc
    });
  }
  for(let k = 0; k < sections.length - 1; k++){
    sections[k].endLineIdx = sections[k+1].startLineIdx - 1;
  }
  return sections;
}

function _sectionAt(sections, idx){
  if(!sections || !sections.length) return null;
  for(const s of sections){
    if(idx >= s.startLineIdx && idx <= s.endLineIdx) return s;
  }
  return null;
}

// Маппинг: ожидаемый раздел для каждого базового показателя.
// Ключ — базовое имя поля (без префиксов is-/rep-np-).
// 'note' означает «может встретиться и в примечаниях»; таким полям
// не штрафуем раздел note, но приоритет остаётся у основной таблицы.
const _FIELD_SECTION = {
  rev:    ['pnl'],
  ebitda: ['pnl','note'],
  ebit:   ['pnl'],
  np:     ['pnl'],
  int:    ['pnl','note'],
  tax:    ['pnl'],
  assets: ['balance'],
  ca:     ['balance'],
  cl:     ['balance'],
  debt:   ['balance','note'],
  cash:   ['balance'],   // КРИТИЧНО: не cashflow!
  ret:    ['balance'],
  eq:     ['balance'],
};
function _expectedSectionsForFieldId(fieldId){
  if(!fieldId) return null;
  const key = String(fieldId).replace(/^is-|^rep-np-/, '');
  return _FIELD_SECTION[key] || null;
}

// Премия/штраф к score для кандидата в разделе `got`, когда ожидались
// разделы из `expected`. Возвращает число (+бонус / −штраф).
// Шкала калибрована относительно «итог vs раздел» (±100): раздел даёт
// ±40..+60, а ОДДС для балансового поля — сильный штраф.
function _sectionScoreAdj(got, expected){
  if(!expected || !expected.length) return 0;
  if(!got) return -5;                                 // раздел неизвестен
  if(expected.includes(got)) return 60;               // точное попадание
  // Частые путаницы: cashflow ↔ balance для ДС/чистой прибыли.
  if(got === 'cashflow' && !expected.includes('cashflow')) return -40;
  if(got === 'segments' && !expected.includes('segments')) return -30;
  if(got === 'equity'   && !expected.includes('equity'))   return -20;
  if(got === 'note')    return -10;                   // возможно, но не основной источник
  return -15;
}

// ═══════════════════════════════════════════════════════════════════
// МЕТАДАННЫЕ ОТЧЁТА + СВЕРКА С ЭТАЛОНОМ
// ═══════════════════════════════════════════════════════════════════
// Пользовательский запрос: различать МСФО-группу (consolidated) и
// РСБУ-юрлицо (standalone). Если пользователь сверяет с ГИР БО, но
// загружен отчёт МСФО-группы — цифры несопоставимы, это надо явно
// отметить, а не показывать красные флаги как будто парсер промахнулся.

// detectReportMeta(txt) → {standard, scope, inn, orgName, confidence}
//   standard: 'МСФО' | 'РСБУ' | null
//   scope:    'group' (консолидированный) | 'standalone' (одно юрлицо) | null
//   inn:      10 или 12 цифр, распознанных рядом со словом «ИНН»
//   orgName:  «ПАО «…»», «ООО «…»», если удалось выудить в первых 3000 симв.
function detectReportMeta(txt){
  const s = String(txt||'');
  // 1. Стандарт.
  let standard = null;
  if(/IFRS\b|международн\w+\s+стандарт|\bIAS\s+\d|МСФО/i.test(s)) standard = 'МСФО';
  else if(/\bПБУ\s|\bРСБУ\b|российск\w+\s+стандарт|Приказ\s+Минфина|форма\s+(?:№\s*)?1\b|Бухгалтерский\s+баланс/i.test(s)) standard = 'РСБУ';
  else if(/\b(1110|1150|1600|2110|2400|1250)\b/.test(s)) standard = 'РСБУ';

  // 2. Область (группа / юрлицо). Считаем «голоса» за оба варианта.
  const groupVotes = [
    /консолидированн(?:ая|ой|ый|ого|ым|ую)/i,
    /\bconsolidated\b/i,
    /\bГруппа\s+(?:компани|«|»|\w)/,
    /\bgroup\b/i,
    /гудвил+/i,
    /goodwill/i,
    /неконтролирующ[а-я]+\s+дол/i,
    /non[-\s]?controlling\s+interest/i,
    /доля\s+в\s+прибыли\s+ассоциированн/i,
    /операции\s+со\s+связанн[а-я]+\s+сторон/i,
    /дочерн[а-я]+\s+(?:общест|компани|предприят)/i
  ].reduce((n, re) => n + (re.test(s) ? 1 : 0), 0);
  const standaloneVotes = [
    /форма\s+(?:№\s*)?1\b/i,
    /ОКУД\s+0710001/i,
    /Приказ\s+Минфина\s+(?:РФ\s+)?(?:от\s+)?(?:№\s*)?66н/i
  ].reduce((n, re) => n + (re.test(s) ? 1 : 0), 0);
  let scope = null;
  if(groupVotes >= 2) scope = 'group';
  else if(standaloneVotes >= 1 && groupVotes === 0) scope = 'standalone';
  else if(standard === 'МСФО') scope = 'group';      // МСФО публично — почти всегда консолидация
  else if(standard === 'РСБУ') scope = 'standalone'; // РСБУ публично — почти всегда standalone

  // 3. ИНН — 10 цифр (юрлицо) или 12 (ИП), рядом со словом «ИНН».
  let inn = null;
  const innMatch = s.match(/\bИНН\s*[:№]?\s*(\d{10}|\d{12})\b/i);
  if(innMatch) inn = innMatch[1];

  // 4. Название эмитента — в первых 3000 симв. ищем орг-форму + кавычки.
  let orgName = null;
  const head = s.slice(0, 3000);
  const orgMatch = head.match(/(?:ПАО|АО|ООО|ЗАО|ОАО|НАО)\s*[«"„]\s*([^»"\n“]{2,80})\s*[»"“]/);
  if(orgMatch) orgName = orgMatch[0].replace(/\s+/g,' ').trim();

  const confidence = (standard ? 0.4 : 0) + (scope ? 0.3 : 0) + (inn ? 0.2 : 0) + (orgName ? 0.1 : 0);
  return {standard, scope, inn, orgName, confidence};
}

// Маппинг строк РСБУ (коды из ГИР БО формата {current1110, current2110, …})
// на поля формы «Добавить период отчётности». ГИР БО отдаёт сырые данные
// в тысячах рублей — в normaliseReference делим на 1e6, чтобы получить
// млрд ₽ (в которых работает БондАналитик).
const _GIRBO_FIELD_MAP = {
  'rep-np-rev':    '2110',
  'rep-np-ebit':   '2200',
  'rep-np-np':     '2400',
  'rep-np-int':    '2330',
  'rep-np-assets': '1600',
  'rep-np-ca':     '1200',
  'rep-np-cl':     '1500',
  'rep-np-debt':   ['1410','1510'], // долгосрочные + краткосрочные займы
  'rep-np-cash':   '1250',
  'rep-np-ret':    '1370',
  'rep-np-eq':     '1300'
};

// Приводит произвольный JSON-эталон к единой структуре:
//   {values, standard, scope, company, inn, period, source, unit, format}
// Поддержанные форматы ввода:
//   A. Наш: {schema: 'bondan/ref/v1', values: {rep-np-…}, scope, standard, …}
//   B. ГИР БО: {current1110: …, current2110: …, organisationName, …}
// null — если формат не распознан.
function normaliseReference(raw){
  if(!raw || typeof raw !== 'object') return null;
  // Наш формат — поддерживает либо `values` (одноразовый), либо
  // `series` (мульти-период), либо оба.
  if(typeof raw.schema === 'string' && raw.schema.startsWith('bondan/ref') && (raw.values || raw.series)){
    let series = raw.series && typeof raw.series === 'object' ? {...raw.series} : null;
    if(raw.values && raw.period){
      const lbl = _periodLabel(raw.period.match?.(/(\d{4})/)?.[1] || raw.period, raw.period);
      series = series || {};
      if(!series[lbl]) series[lbl] = raw.values;
    }
    return {
      values: raw.values || (series ? series[Object.keys(series).sort((a,b)=>_periodSortKey(b)-_periodSortKey(a))[0]] : null),
      series,
      standard: raw.standard || null,
      scope: raw.scope || null,
      company: raw.company || null,
      inn: raw.inn || null,
      period: raw.period || null,
      source: raw.source || 'manual',
      unit: raw.unit || null,
      format: 'bondan'
    };
  }
  // ГИР БО.
  const hasGirbo = Object.keys(raw).some(k => /^current\d{4}$/.test(k));
  if(hasGirbo){
    const values = {};
    for(const [fid, code] of Object.entries(_GIRBO_FIELD_MAP)){
      const codes = Array.isArray(code) ? code : [code];
      let sum = 0, any = false;
      for(const c of codes){
        const v = raw['current' + c];
        if(typeof v === 'number'){ sum += v; any = true; }
      }
      if(any) values[fid] = sum / 1e6; // тыс ₽ → млрд ₽
    }
    const period = raw.period || raw.year || null;
    const series = period ? {[_periodLabel(period, 'FY')]: values} : null;
    return {
      values,
      series,
      standard: 'РСБУ',
      scope: 'standalone',
      company: raw.organisationName || raw.name || raw.shortName || null,
      inn: raw.inn || raw.organisationInn || null,
      period,
      source: 'ГИР БО',
      unit: 'млрд ₽',
      format: 'girbo'
    };
  }
  return null;
}

// Сравнивает значения в форме с эталоном. Для каждого поля статус:
//   ok      — расхождение ≤ 2%
//   warn    — расхождение 2%..10%
//   err     — расхождение > 10%
//   missing — поле в форме не заполнено
// Маппинг короткие_имена_reportsDB → ID полей формы (rep-np-*).
// reportsDB.periods[*] хранит данные с короткими ключами {rev, ebitda,
// np, ebit, ...}, а наши эталоны и сравнение — с длинными `rep-np-*`.
const _REPORTS_FIELD_MAP = {
  rev: 'rep-np-rev', ebitda: 'rep-np-ebitda', np: 'rep-np-np',
  ebit: 'rep-np-ebit', int: 'rep-np-int',
  assets: 'rep-np-assets', eq: 'rep-np-eq', debt: 'rep-np-debt',
  cash: 'rep-np-cash', ca: 'rep-np-ca', cl: 'rep-np-cl',
  ret: 'rep-np-ret'
};

// Нормализованный ярлык периода: «FY 2024», «H1 2025», «9M 2024».
function _periodLabel(year, period){
  if(!year) return String(period || '');
  const p = String(period || '').toUpperCase();
  if(!p || p === 'FY' || /год|year|annual/i.test(p)) return 'FY ' + year;
  if(/h1|полугод|6\s*мес|30\.06/i.test(p)) return 'H1 ' + year;
  if(/9м|9m|30\.09|9\s*мес/i.test(p)) return '9M ' + year;
  if(/q1|3\s*мес|31\.03/i.test(p)) return 'Q1 ' + year;
  if(/q3|30\.09/i.test(p)) return '9M ' + year;
  return p + ' ' + year;
}

// Парсит ярлык в число для сортировки (старше → меньше).
function _periodSortKey(label){
  const m = String(label || '').match(/(\d{4})/);
  const y = m ? parseInt(m[1], 10) : 0;
  let kind = 0;
  if(/^Q1\b/i.test(label))      kind = 0.25;
  else if(/^H1\b/i.test(label)) kind = 0.50;
  else if(/^9M\b/i.test(label)) kind = 0.75;
  else                          kind = 1.00; // FY
  return y + kind;
}

// Собирает многопериодную series из reportsDB по совпадению с
// распознанным эмитентом отчёта. Cравнение по orgName (включает),
// в обе стороны — потому что строка эмитента в отчёте часто длиннее
// (с орг-формой и кавычками), чем в reportsDB.
function _seriesFromReportsDB(meta){
  if(!meta || !meta.orgName || typeof reportsDB !== 'object') return null;
  const myName = String(meta.orgName).toLowerCase().replace(/[«»"„'()]/g,' ').replace(/\s+/g,' ').trim();
  const myCore = myName.replace(/^(пао|ао|ооо|зао|оао|нао)\s+/i,'').trim();
  const issuers = Object.values(reportsDB);
  const target = issuers.find(iss => {
    if(!iss || !iss.name) return false;
    const nm = String(iss.name).toLowerCase().replace(/[«»"„'()]/g,' ').replace(/\s+/g,' ').trim();
    if(!nm) return false;
    return nm.includes(myCore) || myCore.includes(nm)
        || nm.includes(myName) || myName.includes(nm);
  });
  if(!target || !target.periods) return null;
  const series = {};
  for(const data of Object.values(target.periods)){
    if(!data) continue;
    const label = _periodLabel(data.year, data.period);
    const v = {};
    for(const [src, dst] of Object.entries(_REPORTS_FIELD_MAP)){
      if(typeof data[src] === 'number') v[dst] = data[src];
    }
    if(Object.keys(v).length) series[label] = v;
  }
  return Object.keys(series).length ? series : null;
}

// Объединяет две series по полям; cur (более свежая запись)
// перезаписывает совпадающие периоды.
function _mergeSeries(base, cur){
  if(!base && !cur) return null;
  const out = {};
  for(const k of Object.keys(base || {})) out[k] = {...base[k]};
  for(const k of Object.keys(cur || {}))  out[k] = {...(out[k] || {}), ...cur[k]};
  return Object.keys(out).length ? out : null;
}

// Простой SVG-sparkline по массиву чисел/null. width × height в px.
function _sparkline(values, opts={}){
  const w = opts.w || 64, h = opts.h || 18;
  const valid = values.map((v,i) => typeof v === 'number' ? {v, i} : null).filter(Boolean);
  if(valid.length < 2) return '<span style="color:var(--text3);font-size:.55rem">—</span>';
  const min = Math.min(...valid.map(o => o.v));
  const max = Math.max(...valid.map(o => o.v));
  const range = max - min || Math.abs(max) || 1;
  const pad = 2;
  const innerW = w - pad*2, innerH = h - pad*2;
  const xOf = i => pad + (values.length === 1 ? innerW/2 : (i / (values.length - 1)) * innerW);
  const yOf = v => pad + (1 - (v - min) / range) * innerH;
  const path = valid.map((o, k) => (k===0?'M':'L') + xOf(o.i).toFixed(1) + ',' + yOf(o.v).toFixed(1)).join(' ');
  const last = valid[valid.length - 1];
  const lastUp = valid.length >= 2 && last.v >= valid[valid.length - 2].v;
  const colour = lastUp ? 'var(--green)' : 'var(--danger)';
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" style="vertical-align:middle;display:inline-block">
    <path d="${path}" fill="none" stroke="${colour}" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${xOf(last.i).toFixed(1)}" cy="${yOf(last.v).toFixed(1)}" r="1.6" fill="${colour}"/>
  </svg>`;
}

function repCompareReference(ref){
  if(!ref || !ref.values) return [];
  const res = [];
  for(const [fid, expected] of Object.entries(ref.values)){
    const el = document.getElementById(fid);
    if(!el) continue;
    const parsed = parseFloat(el.value);
    if(isNaN(parsed)){
      res.push({fid, parsed: null, expected, status: 'missing'});
      continue;
    }
    const rel = expected ? Math.abs(parsed - expected) / Math.abs(expected) : 0;
    const status = rel <= 0.02 ? 'ok' : (rel <= 0.1 ? 'warn' : 'err');
    res.push({fid, parsed, expected, rel, status});
  }
  return res;
}

function girboLinkForInn(inn){
  if(!inn) return null;
  return 'https://bo.nalog.gov.ru/advanced-search/organizations/search?query=' + encodeURIComponent(inn);
}

// ── Прокси к ГИР БО для автоматической подтяжки многолетней истории ──
// bo.nalog.gov.ru API доступен из РФ, но из браузера блокируется CORS
// (Access-Control-Allow-Origin не выставлен). Решение — прокси:
//   • по умолчанию используем публичный CORS-прокси corsproxy.io;
//   • пользователь может вписать свой URL (например, развёрнутый
//     Cloudflare Worker — см. cf-worker.js в репо), это надёжнее
//     и приватнее (через свой Worker не идёт через сторонний сервис).
// Домен в 2026 переехал с bo.nalog.ru → bo.nalog.gov.ru, и API стал
// дроблёным: раньше /nbo/bfo/{id} отдавал весь отчёт, теперь нужны
// отдельные /nbo/details/balance?id=… и /nbo/details/financial_result?id=…
function _girboProxyBase(){
  return localStorage.getItem('bondan_girbo_proxy') || 'https://corsproxy.io/?';
}
function _girboMakeUrl(path){
  const proxy = _girboProxyBase();
  // Cache-busting: добавляем в путь параметр _t=<timestamp>, чтобы
  // закешированные в браузере disk-cache ответы (включая 522!) не
  // перехватывались. В cf-worker.js (новая версия) ошибки уже не
  // кэшируются, но старый развёрнутый Worker мог закешировать —
  // этот параметр обходит обе проблемы одним махом. Ничего не ломает,
  // потому что bo.nalog.gov.ru лишние параметры игнорирует.
  const cb = (path.includes('?') ? '&' : '?') + '_t=' + Date.now();
  const target = 'https://bo.nalog.gov.ru' + path + cb;
  if(/[?=]$/.test(proxy)) return proxy + target;
  if(proxy.endsWith('/')) return proxy + 'https://bo.nalog.gov.ru' + path + cb;
  return proxy + path + cb;
}
async function _girboFetchJson(path, retries, timeoutMs){
  if(retries == null) retries = 2;
  if(timeoutMs == null) timeoutMs = 8000; // 8s — половина старого, меньше висеть
  const url = _girboMakeUrl(path);
  let lastErr = null;
  for(let attempt = 0; attempt <= retries; attempt++){
    const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const to = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const r = await fetch(url, {headers: {'Accept': 'application/json'}, signal: ctrl ? ctrl.signal : undefined});
      if(r.ok){
        const ct = r.headers.get('content-type') || '';
        if(!/json/i.test(ct)){
          const txt = await r.text();
          if(txt.startsWith('<')) throw new Error('Прокси вернул HTML вместо JSON — возможно, ГИР БО показал капчу. Попробуйте сменить прокси.');
        }
        return r.json();
      }
      // 522/524 — Cloudflare Worker не достучался до bo.nalog.gov.ru
      // (origin timeout / unreachable). Это transient: ФНС иногда
      // тормозит или периодически режет CF-трафик. Retry с задержкой
      // часто помогает — пробуем 2 раза с экспоненциальной паузой.
      if([502, 503, 504, 522, 524].includes(r.status) && attempt < retries){
        lastErr = new Error('HTTP ' + r.status + ' (CF→ФНС timeout, retry ' + (attempt+1) + '/' + retries + ')');
        await new Promise(res => setTimeout(res, 800 * Math.pow(2, attempt)));
        continue;
      }
      // 403/429 — почти всегда блок публичного прокси.
      if(r.status === 403 || r.status === 429){
        const proxy = _girboProxyBase();
        const isPublic = /corsproxy\.io|allorigins/i.test(proxy);
        const hint = isPublic
          ? ' (публичный corsproxy.io часто блокирует под нагрузкой). Подними свой Cloudflare Worker (см. cf-worker.js в репо, 2 минуты) и впиши URL в «⚡ Sync» → «📡 ГИР БО — прокси»'
          : ' — прокси ' + proxy + ' не отвечает';
        throw new Error('ГИР БО прокси: ' + r.status + hint);
      }
      // 522/524 после всех retry — отдельное человеческое сообщение.
      if([502, 503, 504, 522, 524].includes(r.status)){
        throw new Error('ФНС/CF недоступны (HTTP ' + r.status + ') — bo.nalog.gov.ru не отвечает через Cloudflare. Подожди 5-10 мин и повтори. Если упорно — возможно, ФНС временно режет CF-трафик.');
      }
      throw new Error('HTTP ' + r.status + ' ' + path);
    } catch(e){
      // AbortError от timeout — как сетевая ошибка.
      const isAbort = e.name === 'AbortError';
      if(attempt < retries && (isAbort || /NetworkError|Failed to fetch|timeout/i.test(e.message || ''))){
        lastErr = isAbort ? new Error('timeout ' + timeoutMs + ' мс — ГИР БО не отвечает') : e;
        await new Promise(res => setTimeout(res, 800 * Math.pow(2, attempt)));
        continue;
      }
      throw isAbort ? new Error('timeout — ГИР БО не отвечает') : e;
    } finally {
      if(to) clearTimeout(to);
    }
  }
  throw lastErr || new Error('ГИР БО: исчерпаны попытки');
}

// Подтягиваем последние N годовых отчётов РСБУ по ИНН, складываем в
// единую series (формат normaliseReference). Возвращает {series,
// company, inn, count, errors}.
// Универсальный поиск в ГИР БО — принимает ИНН или название.
// В 2026 API перерос: старый /nbo/organizations/?query= → новый
// /advanced-search/organizations/search?query=&page=0&size=20; старый
// /nbo/bfo/{id} (отчёт целиком) → два отдельных endpoint'а
// /nbo/details/balance?id={id} и /nbo/details/financial_result?id={id}.
// Возвращает {series, company, inn, count, errors} как раньше.
async function fetchGirboByInn(inn, maxYears = 5){
  if(!inn || !String(inn).trim()) throw new Error('query пустой');
  const query = String(inn).trim();
  const isInn = /^\d{10}(\d{2})?$/.test(query);

  // 1. Поиск организации — по ИНН или по имени.
  const search = await _girboFetchJson('/advanced-search/organizations/search?query=' + encodeURIComponent(query) + '&page=0&size=20');
  const orgs = Array.isArray(search) ? search : (search.content || search.organizations || []);
  if(!orgs.length) throw new Error('В ГИР БО нет «' + query + '»');
  // Если искали по ИНН — предпочитаем точное совпадение, иначе первый.
  const org = isInn
    ? (orgs.find(o => String(o.inn || o.organisationInn) === query) || orgs[0])
    : orgs[0];
  const orgId = org.id || org.organizationId;
  if(!orgId) throw new Error('У ответа ГИР БО нет orgId');
  const resolvedInn = String(org.inn || org.organisationInn || (isInn ? query : ''));

  // 2. Список отчётов организации (trailing slash обязателен на новом API).
  const bfoListResp = await _girboFetchJson('/nbo/organizations/' + orgId + '/bfo/');
  const bfoList = Array.isArray(bfoListResp) ? bfoListResp : (bfoListResp.content || bfoListResp.bfo || []);
  // Только годовые, отсортированы от новых к старым.
  const annual = bfoList
    .filter(b => /year|год/i.test(b.period || b.bfoPeriod || '') || b.periodType === 'YEAR' || (b.year && !b.quarter))
    .sort((a, b) => (b.year || 0) - (a.year || 0))
    .slice(0, maxYears);
  if(!annual.length) throw new Error('Нет годовых отчётов в ГИР БО');

  // 3. Детали каждого отчёта → values по нашим полям.
  // Новое API разбило отчёт на две формы: balance (коды 1xxx) и
  // financial_result (коды 2xxx). Тянем обе параллельно и мёржим в
  // один объект — _GIRBO_FIELD_MAP отработает как раньше.
  const series = {};
  const errors = [];
  for(const b of annual){
    try {
      const bfoId = b.id || b.bfoId;
      const [balance, pnl] = await Promise.all([
        _girboFetchJson('/nbo/details/balance?id=' + bfoId),
        _girboFetchJson('/nbo/details/financial_result?id=' + bfoId)
      ]);
      const det = Object.assign({}, balance, pnl);
      // Сам ответ содержит current{code} и previous{code} — есть две
      // соседние года в одном файле. Возьмём оба, чтобы получить больше
      // лет за меньшее число запросов.
      const yearMain = b.year || det.year;
      const yearPrev = yearMain ? yearMain - 1 : null;
      const buildVals = (kind) => {
        const v = {};
        for(const [fid, code] of Object.entries(_GIRBO_FIELD_MAP)){
          const codes = Array.isArray(code) ? code : [code];
          let sum = 0, any = false;
          for(const c of codes){
            const x = det[kind + c];
            if(typeof x === 'number'){ sum += x; any = true; }
          }
          if(any){
            // Строки 2330 (проценты к уплате) и 2410 (налог на прибыль)
            // в РСБУ-отчёте — это расходы; у нас они хранятся как
            // положительные магнитуды. В XML/JSON от ГИР БО значение
            // иногда приходит со знаком минус — нормализуем.
            const isExpense = fid === 'rep-np-int' || (Array.isArray(code) ? false : code === '2410');
            v[fid] = (isExpense ? Math.abs(sum) : sum) / 1e6; // тыс ₽ → млрд ₽
          }
        }
        return Object.keys(v).length ? v : null;
      };
      const cur = buildVals('current');
      if(cur && yearMain) series[_periodLabel(yearMain, 'FY')] = cur;
      const prev = buildVals('previous');
      if(prev && yearPrev) series[_periodLabel(yearPrev, 'FY')] = series[_periodLabel(yearPrev, 'FY')] || prev;
    } catch(e){
      errors.push({year: b.year, error: e.message});
    }
  }
  return {
    series,
    company: org.name || org.shortName || org.fullName || null,
    inn: resolvedInn,
    count: Object.keys(series).length,
    errors
  };
}

// ═══════════════════════════════════════════════════════════════════
// БАЗА ОТРАСЛЕЙ И МЕДИАНЫ (страница «🏭 Отрасли»)
// ═══════════════════════════════════════════════════════════════════
// Семантика:
//   • references/industry-peers.json (коммитится в репо) — стартовый
//     список отраслей и ИНН, которые я знаю точно (blue chips).
//   • localStorage['bondan_industry_peers'] — правки пользователя:
//     можно добавлять/удалять ИНН в любой отрасли, создавать новые
//     отрасли. При загрузке приложения мёрджим с seed'ом (по ключам
//     industry.key, peer.inn — локальные побеждают).
//   • localStorage['bondan_industry_medians'] — результат расчёта
//     (обновляется по нажатию «🧮 Построить медианы»). Храним в
//     синхронизируемом снапшоте (попадает в sync-код / Gist).
// Расчёт: для каждой отрасли обходим все ИНН через fetchGirboByInn,
// собираем series по всем peer'ам, потом по каждому (год, показатель)
// считаем p25 / p50 / p75.

const _IND_SEED_URL = 'references/industry-peers.json';
window._industryData = null;       // {industries: {key: {label, okved2, peers:[{inn,name}]}}}
window._industryMedians = null;    // {industryKey: {year: {fid: {p25,p50,p75,n}}}}
window._indActiveKey = null;

async function _indLoad(){
  if(window._industryData) return window._industryData;
  // 1) seed
  let seed = {industries:{}};
  try {
    const r = await fetch(_IND_SEED_URL, {cache:'no-store'});
    if(r.ok) seed = await r.json();
  } catch(e){}
  // 2) пользовательские правки
  let user = {industries:{}};
  try {
    const raw = localStorage.getItem('bondan_industry_peers');
    if(raw) user = JSON.parse(raw);
  } catch(e){}
  // 3) мёрдж: отрасль из user полностью побеждает seed; если в user
  // отрасли нет — берём seed-версию.
  const merged = {industries: {}};
  const allKeys = new Set([...Object.keys(seed.industries || {}), ...Object.keys(user.industries || {})]);
  for(const k of allKeys){
    merged.industries[k] = (user.industries && user.industries[k]) || seed.industries[k];
  }
  window._industryData = merged;
  // Медианы — из localStorage (будут пересчитаны по кнопке).
  try {
    const m = localStorage.getItem('bondan_industry_medians');
    if(m) window._industryMedians = JSON.parse(m);
  } catch(e){}
  return merged;
}

function _indSaveUser(){
  // Сохраняем только пользовательские правки (весь merged-state —
  // так его легко синхронизировать и откатить к seed).
  try {
    localStorage.setItem('bondan_industry_peers', JSON.stringify(window._industryData));
  } catch(e){}
}

async function indRender(){
  await _indLoad();
  const data = window._industryData;
  const listEl = document.getElementById('ind-list');
  const detEl  = document.getElementById('ind-detail');
  if(!listEl || !detEl) return;
  // Список отраслей слева.
  const keys = Object.keys(data.industries);
  if(!window._indActiveKey || !data.industries[window._indActiveKey]){
    window._indActiveKey = keys[0] || null;
  }
  listEl.innerHTML = keys.map(k => {
    const ind = data.industries[k];
    const n = (ind.peers || []).length;
    const hasMed = window._industryMedians?.[k] ? ' 📊' : '';
    const active = k === window._indActiveKey;
    const bg = active ? 'background:var(--acc);color:#000' : '';
    return `<div onclick="indSelect('${k}')" style="padding:6px 8px;cursor:pointer;border-bottom:1px solid var(--border);font-size:.65rem;${bg}">
      ${ind.label}${hasMed} <span style="color:${active?'#000':'var(--text3)'};float:right">${n}</span>
    </div>`;
  }).join('') + `<div style="padding:8px;border-top:1px solid var(--border)"><button class="btn btn-sm" onclick="indAddIndustry()" style="width:100%">+ новая отрасль</button></div>`;

  // Детализация выбранной отрасли справа.
  const key = window._indActiveKey;
  if(!key){ detEl.innerHTML = '<div style="color:var(--text3);padding:20px;text-align:center">Нет отраслей</div>'; return; }
  const ind = data.industries[key];
  const peers = ind.peers || [];
  const okvedLabel = (ind.okved2 && ind.okved2.length) ? ` · ОКВЭД2: ${ind.okved2.join(', ')}` : '';
  detEl.innerHTML = `
    <div style="display:flex;gap:6px;align-items:center;margin-bottom:8px">
      <strong style="font-size:.8rem">${ind.label}</strong>
      <span style="font-size:.55rem;color:var(--text3)">${okvedLabel}</span>
      <button class="btn btn-sm" onclick="indEditIndustry('${key}')" style="margin-left:auto;padding:2px 8px;font-size:.55rem">✎</button>
      <button class="btn btn-sm" onclick="indDeleteIndustry('${key}')" style="padding:2px 8px;font-size:.55rem" title="Удалить отрасль">✗</button>
    </div>
    <div style="display:flex;gap:6px;margin-bottom:8px">
      <input type="text" id="ind-add-inn" placeholder="ИНН (10 цифр)" style="width:130px;font-family:var(--mono);font-size:.7rem;padding:3px 6px">
      <input type="text" id="ind-add-name" placeholder="Название (опционально)" style="flex:1;font-size:.7rem;padding:3px 6px">
      <button class="btn btn-sm btn-p" onclick="indAddPeer('${key}')">+</button>
    </div>
    ${peers.length ? `
      <div style="max-height:340px;overflow:auto;border:1px solid var(--border);font-size:.65rem">
        ${peers.map((p, i) => `
          <div style="display:flex;gap:6px;padding:4px 6px;border-bottom:1px solid var(--border);align-items:center">
            <span style="font-family:var(--mono);color:var(--text3);min-width:92px">${p.inn || ''}</span>
            <span style="flex:1;color:var(--text2);overflow:hidden;text-overflow:ellipsis">${p.name || ''}</span>
            <button class="btn btn-sm" onclick="indRemovePeer('${key}',${i})" style="padding:1px 6px;font-size:.55rem">✗</button>
          </div>`).join('')}
      </div>
    ` : '<div style="color:var(--text3);padding:16px;text-align:center;font-size:.65rem">Список пуст. Добавьте хотя бы 5-10 ИНН, чтобы медианы были осмысленны.</div>'}
    ${_indMediansView(key)}
    ${_indRosstatView(key)}
  `;
  const cnt = keys.reduce((a,k) => a + (data.industries[k].peers||[]).length, 0);
  const bd = document.getElementById('sb-ind');
  if(bd) bd.textContent = cnt;
}

// Таблица ROS/ROA из XLSX ФНС по годам для выбранной отрасли.
// Если данных нет — краткая подсказка, как их загрузить.
function _indRosstatView(key){
  const db = _rosstatLoad();
  const years = Object.keys(db).map(y => +y).sort();
  if(!years.length){
    return `<div style="margin-top:14px;padding:8px;border:1px dashed var(--border);color:var(--text3);font-size:.58rem;line-height:1.5">
      🇷🇺 <strong>ROS/ROA (ФНС)</strong> — не загружено. Скачайте
      <code>ind2024.xls</code> и соседние годы с
      <a href="https://www.nalog.gov.ru/rn77/taxation/reference_work/conception_vnp/" target="_blank" style="color:var(--acc)">nalog.gov.ru/conception_vnp</a>
      и нажмите «🇷🇺 Импорт ФНС XLSX».
    </div>`;
  }
  const fmt = v => (v == null ? '—' : v.toFixed(1) + '%');
  const fnsNames = _ROSSTAT_INDUSTRY_MAP[key] || [];
  // Для каждого года пробуем найти первое совпадение из списка.
  const lookups = years.map(y => {
    const hit = rosstatLookup(key, y);
    return {y, hit};
  });
  const anyHit = lookups.some(x => x.hit);
  const mappingLine = fnsNames.length
    ? `<div style="font-size:.52rem;color:var(--text3);margin-top:4px">мэппинг: <code>${fnsNames.map(n => n.length > 40 ? n.slice(0, 40) + '…' : n).join('</code> → <code>')}</code></div>`
    : `<div style="font-size:.52rem;color:var(--warn);margin-top:4px">⚠ Для отрасли <code>${key}</code> нет мэппинга в словаре _ROSSTAT_INDUSTRY_MAP.</div>`;
  if(!anyHit){
    return `<div style="margin-top:14px;padding:8px;border:1px solid var(--border);background:var(--s2);font-size:.58rem">
      <div style="color:var(--text2)"><strong>🇷🇺 ROS/ROA (ФНС)</strong> · загружено лет: ${years.join(', ')}</div>
      <div style="color:var(--warn);margin-top:4px">Для этой отрасли ничего не нашлось по текущему мэппингу.</div>
      ${mappingLine}
    </div>`;
  }
  return `<div style="margin-top:14px">
    <div style="font-size:.58rem;color:var(--text3);letter-spacing:.08em;text-transform:uppercase;margin-bottom:4px">🇷🇺 среднеотраслевые ros / roa (фнс)</div>
    <div style="overflow:auto"><table style="font-size:.6rem;border-collapse:collapse;width:100%;min-width:${140 + years.length * 110}px">
      <tr style="color:var(--text3);background:var(--bg)">
        <th style="text-align:left;padding:4px 6px;border:1px solid var(--border)">Показатель</th>
        ${lookups.map(l => `<th style="text-align:right;padding:4px 6px;border:1px solid var(--border)">${l.y}</th>`).join('')}
      </tr>
      <tr>
        <td style="padding:3px 6px;border:1px solid var(--border);color:var(--text2)" title="Рентабельность проданных товаров (EBIT/Выручка)">ROS</td>
        ${lookups.map(l => {
          if(!l.hit) return `<td style="padding:3px 6px;border:1px solid var(--border);text-align:right;color:var(--text3)">—</td>`;
          const neg = l.hit.rosNeg && l.hit.ros == null;
          const val = neg ? '<span style="color:var(--danger)">&lt;0</span>' : fmt(l.hit.ros);
          return `<td style="padding:3px 6px;border:1px solid var(--border);text-align:right;font-variant-numeric:tabular-nums" title="«${l.hit.matchedName || l.hit.name}»">${val}</td>`;
        }).join('')}
      </tr>
      <tr>
        <td style="padding:3px 6px;border:1px solid var(--border);color:var(--text2)" title="Рентабельность активов (ЧП/Активы)">ROA</td>
        ${lookups.map(l => {
          if(!l.hit) return `<td style="padding:3px 6px;border:1px solid var(--border);text-align:right;color:var(--text3)">—</td>`;
          const neg = l.hit.roaNeg && l.hit.roa == null;
          const val = neg ? '<span style="color:var(--danger)">&lt;0</span>' : fmt(l.hit.roa);
          return `<td style="padding:3px 6px;border:1px solid var(--border);text-align:right;font-variant-numeric:tabular-nums" title="«${l.hit.matchedName || l.hit.name}»">${val}</td>`;
        }).join('')}
      </tr>
    </table></div>
    ${mappingLine}
  </div>`;
}

// Импорт одного или нескольких XLSX ФНС. Каждый файл парсится отдельно,
// год берётся из шапки. Все успешные результаты мёрджатся в общий стор.
async function rosstatImportFiles(input){
  const files = Array.from(input.files || []);
  if(!files.length) return;
  const statusEl = document.getElementById('ind-status');
  const setStatus = (msg, color) => {
    if(!statusEl) return;
    statusEl.style.display = 'block';
    statusEl.style.color = color || 'var(--text2)';
    statusEl.innerHTML = msg;
  };
  setStatus(`⏳ Парсю ${files.length} файл(ов)…`, 'var(--warn)');
  const ok = [], err = [];
  for(const f of files){
    try {
      const parsed = await rosstatParseFnsXlsx(f);
      rosstatStoreParsed(parsed);
      ok.push(`${f.name} → ${parsed.year} (${parsed.entries.length} строк)`);
    } catch(e){
      err.push(`${f.name}: ${e.message}`);
    }
  }
  input.value = '';
  const okLine  = ok.length  ? `<div style="color:var(--green)">✅ ${ok.join('<br>')}</div>` : '';
  const errLine = err.length ? `<div style="color:var(--danger)">❌ ${err.join('<br>')}</div>` : '';
  setStatus(okLine + errLine, ok.length ? 'var(--text2)' : 'var(--danger)');
  indRender();
}

// Полная очистка загруженных данных ФНС.
function rosstatClear(){
  if(!confirm('Удалить все загруженные данные ФНС?')) return;
  window._rosstatRatios = {};
  try { localStorage.removeItem('bondan_rosstat_ratios'); } catch(e){}
  indRender();
}

function _indMediansView(key){
  const med = window._industryMedians?.[key];
  if(!med) return '<div style="color:var(--text3);font-size:.6rem;margin-top:10px">Медианы не рассчитаны. Нажмите «🧮 Построить медианы».</div>';
  const years = Object.keys(med).sort((a,b) => _periodSortKey(a) - _periodSortKey(b));
  const rows = _REF_FIDS_ORDER.filter(fid => years.some(y => med[y][fid]));
  if(!rows.length) return '<div style="color:var(--warn);font-size:.6rem;margin-top:10px">Медианы пусты — либо ИНН не отвечают ГИР БО, либо прокси недоступен.</div>';
  const fmt = v => v == null ? '—' : (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1));
  return `
    <div style="margin-top:14px">
      <div style="font-size:.58rem;color:var(--text3);letter-spacing:.08em;text-transform:uppercase;margin-bottom:4px">медианы (p50) по годам</div>
      <div style="overflow:auto"><table style="font-size:.6rem;border-collapse:collapse;width:100%;min-width:${160+years.length*90}px">
        <tr style="color:var(--text3);background:var(--bg)"><th style="text-align:left;padding:4px 6px;border:1px solid var(--border)">Показатель</th>
          ${years.map(y => `<th style="text-align:right;padding:4px 6px;border:1px solid var(--border)">${y}</th>`).join('')}
        </tr>
        ${rows.map(fid => `
          <tr>
            <td style="padding:3px 6px;border:1px solid var(--border);color:var(--text2)">${_REF_LABELS[fid]||fid}</td>
            ${years.map(y => {
              const cell = med[y][fid];
              if(!cell) return `<td style="padding:3px 6px;border:1px solid var(--border);text-align:right;color:var(--text3)">—</td>`;
              return `<td style="padding:3px 6px;border:1px solid var(--border);text-align:right;font-variant-numeric:tabular-nums" title="p25=${fmt(cell.p25)} · p50=${fmt(cell.p50)} · p75=${fmt(cell.p75)} · n=${cell.n}">${fmt(cell.p50)}<span style="color:var(--text3);font-size:.55rem"> (n=${cell.n})</span></td>`;
            }).join('')}
          </tr>`).join('')}
      </table></div>
    </div>
  `;
}

function indSelect(key){ window._indActiveKey = key; indRender(); }

function indAddPeer(key){
  const inn = document.getElementById('ind-add-inn').value.trim();
  if(!/^\d{10}(\d{2})?$/.test(inn)){ alert('ИНН должен быть 10 или 12 цифр'); return; }
  const name = document.getElementById('ind-add-name').value.trim();
  const ind = window._industryData.industries[key];
  ind.peers = ind.peers || [];
  if(ind.peers.some(p => p.inn === inn)){ alert('Такой ИНН уже есть в отрасли'); return; }
  ind.peers.push({inn, name});
  _indSaveUser();
  indRender();
}

function indRemovePeer(key, idx){
  const ind = window._industryData.industries[key];
  if(!ind.peers || !ind.peers[idx]) return;
  if(!confirm(`Удалить «${ind.peers[idx].name || ind.peers[idx].inn}» из отрасли «${ind.label}»?`)) return;
  ind.peers.splice(idx, 1);
  _indSaveUser();
  indRender();
}

function indAddIndustry(){
  const label = prompt('Название новой отрасли:', '');
  if(!label) return;
  const key = 'custom_' + Date.now().toString(36);
  window._industryData.industries[key] = {label, okved2: [], peers: []};
  window._indActiveKey = key;
  _indSaveUser();
  indRender();
}

function indEditIndustry(key){
  const ind = window._industryData.industries[key];
  const label = prompt('Новое название отрасли:', ind.label);
  if(!label) return;
  const okved = prompt('Коды ОКВЭД2 через запятую (напр. 46, 47):', (ind.okved2||[]).join(', '));
  ind.label = label;
  ind.okved2 = (okved || '').split(',').map(s => s.trim()).filter(Boolean);
  _indSaveUser();
  indRender();
}

function indDeleteIndustry(key){
  const ind = window._industryData.industries[key];
  if(!confirm(`Удалить отрасль «${ind.label}» со всеми ИНН?`)) return;
  delete window._industryData.industries[key];
  if(window._industryMedians) delete window._industryMedians[key];
  _indSaveUser();
  try { localStorage.setItem('bondan_industry_medians', JSON.stringify(window._industryMedians||{})); } catch(e){}
  window._indActiveKey = Object.keys(window._industryData.industries)[0] || null;
  indRender();
}

function indExportPeers(){
  const data = {
    schema: 'bondan/industry-peers/v1',
    savedAt: new Date().toISOString(),
    industries: window._industryData?.industries || {}
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'bondan-industries-' + new Date().toISOString().slice(0,10) + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function indImportPeers(input){
  const f = input.files[0];
  if(!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const d = JSON.parse(r.result);
      if(!d.industries){ alert('Формат не распознан'); return; }
      if(!confirm('Импортировать отрасли и ИНН из файла? Текущие ваши правки будут замещены.')) return;
      window._industryData = {industries: d.industries};
      _indSaveUser();
      indRender();
    } catch(e){ alert('Ошибка: ' + e.message); }
  };
  r.readAsText(f);
  input.value = '';
}

async function indResetSeed(){
  if(!confirm('Удалить все ваши изменения в базе отраслей и вернуться к встроенному списку? Это также очистит рассчитанные медианы.')) return;
  try { localStorage.removeItem('bondan_industry_peers'); } catch(e){}
  try { localStorage.removeItem('bondan_industry_medians'); } catch(e){}
  window._industryData = null;
  window._industryMedians = null;
  window._indActiveKey = null;
  await indRender();
}

// Перцентиль по отсортированному по возрастанию массиву (линейная
// интерполяция между соседними значениями). q ∈ [0,1].
function _percentile(sortedArr, q){
  if(!sortedArr.length) return null;
  const idx = (sortedArr.length - 1) * q;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if(lo === hi) return sortedArr[lo];
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}

// Обход всех ИНН в базе отраслей через ГИР БО прокси, группировка по
// отраслям и (год × показатель), расчёт p25/p50/p75/n. Результат
// записывается в bondan_industry_medians и отображается в матрицах.
async function indBuildMedians(){
  await _indLoad();
  const data = window._industryData;
  if(!data || !data.industries){ alert('База отраслей пуста'); return; }
  const statusEl = document.getElementById('ind-status');
  const status = (msg, color) => {
    if(!statusEl) return;
    statusEl.style.display = 'block';
    statusEl.style.color = color || 'var(--text2)';
    statusEl.innerHTML = msg;
  };
  const totalInns = Object.values(data.industries).reduce((a, ind) => a + (ind.peers||[]).length, 0);
  if(!totalInns){ alert('Во всех отраслях пусто. Добавьте хотя бы несколько ИНН.'); return; }
  const estMin = Math.max(1, Math.round(totalInns * 8 / 60));
  if(!confirm(`🧮 Построить медианы по ${totalInns} компаниям?\n\nНа каждый ИНН — до 3 запросов к ГИР БО через прокси (${_girboProxyBase()}). Ориентировочно ${estMin}–${estMin*2} минут. По ходу будет показан прогресс; ошибочные ИНН пропустим.`)) return;

  // Накопитель: byIndustry[ind][period][fid] = [числа со всех peer'ов]
  const byIndustry = {};
  const errors = [];
  let done = 0;
  const t0 = Date.now();

  for(const [indKey, ind] of Object.entries(data.industries)){
    byIndustry[indKey] = {};
    for(const peer of (ind.peers || [])){
      done++;
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      status(`⏳ ${done}/${totalInns} · ${elapsed}с · <strong>${ind.label}</strong>: ${peer.name || peer.inn}…`, 'var(--warn)');
      try {
        const result = await fetchGirboByInn(peer.inn, 5);
        for(const [period, vals] of Object.entries(result.series || {})){
          byIndustry[indKey][period] = byIndustry[indKey][period] || {};
          for(const [fid, v] of Object.entries(vals)){
            if(typeof v === 'number' && isFinite(v)){
              byIndustry[indKey][period][fid] = byIndustry[indKey][period][fid] || [];
              byIndustry[indKey][period][fid].push(v);
            }
          }
        }
      } catch(e){
        errors.push({inn: peer.inn, name: peer.name || '?', err: e.message});
      }
    }
  }

  // Расчёт перцентилей. Пропускаем серии из <2 значений — они
  // некорректны как медиана.
  const medians = {};
  for(const [indKey, periods] of Object.entries(byIndustry)){
    medians[indKey] = {};
    for(const [period, fields] of Object.entries(periods)){
      medians[indKey][period] = {};
      for(const [fid, arr] of Object.entries(fields)){
        if(arr.length < 2) continue;
        const s = [...arr].sort((a,b) => a - b);
        medians[indKey][period][fid] = {
          p25: _percentile(s, 0.25),
          p50: _percentile(s, 0.50),
          p75: _percentile(s, 0.75),
          n: s.length,
          min: s[0], max: s[s.length - 1]
        };
      }
    }
  }
  window._industryMedians = medians;
  try { localStorage.setItem('bondan_industry_medians', JSON.stringify(medians)); } catch(e){}
  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  const errSummary = errors.length
    ? `<br><span style="color:var(--warn)">⚠ ${errors.length} ошибок, примеры: ${errors.slice(0,3).map(e => `${e.inn} (${e.err.slice(0,40)})`).join('; ')}${errors.length>3?'…':''}</span>`
    : '';
  const filled = Object.entries(medians).filter(([k,v]) => Object.keys(v).length).length;
  status(`✅ Готово за ${elapsed}с. Отраслей с данными: ${filled}/${Object.keys(medians).length}. ${errSummary}`, 'var(--green)');
  indRender();
}

// ═════════════════════════════════════════════════════════════════════
// РОССТАТ / ФНС — среднеотраслевые ROS / ROA
// Источник файлов: ФНС публикует ежегодно "Приложение № 4 к Приказу
// ФНС № ММ-3-06/333@" на https://www.nalog.gov.ru/rn77/taxation/
// reference_work/conception_vnp/  (файлы ind2017.xlsx … ind2024.xls).
// Данные рассчитаны по статистике Росстата. Это среднеотраслевые
// показатели по крупным и средним предприятиям.
//
// Структура XLSX (стабильна 2020–2024):
//   Лист «Рентабельность» (в 2020 — с пробелом на конце)
//   r1–r4: шапка, в одной из строк год формата «NNNN год»
//   r5+:   [название ОКВЭД-группы, ROS %, ROA %]
//   Значение "отр" = отрицательная, точная величина не публикуется.
//   Кодов ОКВЭД в файле нет — только текстовые названия групп.
//
// Хранение: localStorage['bondan_rosstat_ratios'] =
//   {year: {normName: {name, ros, roa, rosNeg, roaNeg}}}
// ═════════════════════════════════════════════════════════════════════

window._rosstatRatios = null;

function _rosstatLoad(){
  if(window._rosstatRatios) return window._rosstatRatios;
  try {
    const raw = localStorage.getItem('bondan_rosstat_ratios');
    if(raw) window._rosstatRatios = JSON.parse(raw);
  } catch(e){}
  if(!window._rosstatRatios) window._rosstatRatios = {};
  return window._rosstatRatios;
}

function _rosstatSave(){
  try {
    localStorage.setItem('bondan_rosstat_ratios', JSON.stringify(window._rosstatRatios || {}));
  } catch(e){}
}

// Нормализация названия отрасли для устойчивого мэппинга: lower-case,
// ё→е, срезаем переводы строк / кавычки / концевые точки, схлопываем пробелы.
function _rosstatNormName(s){
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"']/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[,.;:]+$/, '')
    .trim();
}

// Разбор одной ячейки: "отр" → отрицательная без значения, число или
// "12,3" → число. Возвращает {v, neg} или null если пустое.
function _rosstatParseCell(v){
  if(v == null || v === '') return null;
  if(typeof v === 'number') return {v, neg: v < 0};
  const s = String(v).trim().toLowerCase();
  if(!s) return null;
  if(s === 'отр' || s === 'отр.' || s === '-' || s === '–' || s === '—')
    return {v: null, neg: true};
  const num = parseFloat(s.replace(',', '.').replace(/[^\d.\-]/g, ''));
  return isNaN(num) ? null : {v: num, neg: num < 0};
}

// Парсер одного файла ФНС (XLSX или XLS). Возвращает
// {year, fileName, entries: [{name, key, ros, roa, rosNeg, roaNeg}]}.
async function rosstatParseFnsXlsx(file){
  await _ensureXlsx();
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, {type: 'array'});
  const sheetName = wb.SheetNames.find(n => /рентабельност/i.test(n.trim()));
  if(!sheetName) throw new Error(`В файле «${file.name}» нет листа «Рентабельность»`);
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, {header: 1, raw: false, defval: ''});

  // Год — ищем в первых 6 строках паттерн «2023 год» или «в 2023 году».
  let year = null;
  for(let i = 0; i < Math.min(6, rows.length); i++){
    const joined = (rows[i] || []).join(' ');
    const m = joined.match(/(19\d{2}|20\d{2})\s*год/i);
    if(m){ year = parseInt(m[1], 10); break; }
  }
  // Fallback — год из имени файла ind2024.xls.
  if(!year){
    const m = (file.name || '').match(/(19\d{2}|20\d{2})/);
    if(m) year = parseInt(m[1], 10);
  }
  if(!year) throw new Error(`Не удалось определить год в файле «${file.name}»`);

  const entries = [];
  for(let i = 0; i < rows.length; i++){
    const row = rows[i] || [];
    const a = String(row[0] || '').trim();
    if(!a) continue;
    // Пропуск шапки и сносок.
    if(/^\*/.test(a)) continue;
    if(/вид\s+экономическ/i.test(a)) continue;
    if(/^рентабельность\s+проданн/i.test(a)) continue;
    if(/приложение/i.test(a)) continue;
    const ros = _rosstatParseCell(row[1]);
    const roa = _rosstatParseCell(row[2]);
    if(ros == null && roa == null) continue;
    entries.push({
      name: a.replace(/\s+/g, ' '),
      key: _rosstatNormName(a),
      ros: ros ? ros.v : null,
      roa: roa ? roa.v : null,
      rosNeg: !!(ros && ros.neg),
      roaNeg: !!(roa && roa.neg)
    });
  }
  if(!entries.length)
    throw new Error(`В «${file.name}» не нашлось ни одной строки с данными рентабельности`);
  return {year, fileName: file.name, entries};
}

// Сохранить результат парсинга в общий локальный стор; год-ключ заменяется.
function rosstatStoreParsed(parsed){
  const db = _rosstatLoad();
  const y = String(parsed.year);
  db[y] = {};
  for(const e of parsed.entries){
    db[y][e.key] = {
      name: e.name,
      ros: e.ros,
      roa: e.roa,
      rosNeg: e.rosNeg,
      roaNeg: e.roaNeg
    };
  }
  window._rosstatRatios = db;
  _rosstatSave();
}

// Хардкод-мэппинг 15 отраслей (из references/industry-peers.json) на
// текстовые названия групп из ФНС-файлов. Порядок важен: берём первую
// строку, которая есть в данных конкретного года. При желании можно
// переопределить через localStorage['bondan_rosstat_map'] в будущем.
const _ROSSTAT_INDUSTRY_MAP = {
  oil_gas:       ['добыча сырой нефти и природного газа', 'производство кокса и нефтепродуктов', 'добыча полезных ископаемых'],
  metals_mining: ['производство металлургическое', 'добыча металлических руд', 'добыча полезных ископаемых'],
  telecom:       ['деятельность в области информации и связи'],
  banks:         ['деятельность финансовая и страховая'],
  retail:        ['торговля оптовая и розничная; ремонт автотранспортных средств и мотоциклов', 'торговля розничная, кроме торговли автотранспортными средствами и мотоциклами'],
  transport:     ['транспортировка и хранение'],
  it_software:   ['деятельность в области информации и связи'],
  utilities:     ['обеспечение электрической энергией, газом и паром; кондиционирование воздуха', 'водоснабжение; водоотведение, организация сбора и утилизации отходов, деятельно'],
  pharma:        ['производство лекарственных средств и материалов, применяемых в медицинских целях', 'деятельность в области здравоохранения и социальных услуг'],
  chemistry:     ['производство химических веществ и химических продуктов'],
  development:   ['строительство', 'деятельность по операциям с недвижимым имуществом'],
  leasing:       ['деятельность финансовая и страховая'],
  mfi:           ['деятельность финансовая и страховая'],
  agro_food:     ['сельское, лесное хозяйство, охота, рыболовство и рыбоводство', 'производство пищевых продуктов', 'растениеводство и животноводство, охота и предоставление соответствующих услуг в этих областях'],
  other:         ['всего']
};

// Поиск рентабельностей ФНС по industryKey за конкретный год. Пробуем
// все названия из мэппинга по очереди, возвращаем первое найденное.
function rosstatLookup(industryKey, year){
  const db = _rosstatLoad();
  if(!db[String(year)]) return null;
  const fnsNames = _ROSSTAT_INDUSTRY_MAP[industryKey];
  if(!fnsNames || !fnsNames.length) return null;
  const bucket = db[String(year)];
  for(const nm of fnsNames){
    const k = _rosstatNormName(nm);
    if(bucket[k]) return {...bucket[k], year: +year, matchedName: bucket[k].name};
  }
  return null;
}

// Список лет с загруженными данными ФНС.
function rosstatAvailableYears(){
  return Object.keys(_rosstatLoad()).map(y => +y).sort();
}

// Автоопределение отрасли для распознанного эмитента отчёта: ищем
// его ИНН среди peer'ов всех отраслей. Возвращает industryKey или null.
function _industryKeyForInn(inn){
  if(!inn || !window._industryData?.industries) return null;
  for(const [key, ind] of Object.entries(window._industryData.industries)){
    if((ind.peers || []).some(p => String(p.inn) === String(inn))) return key;
  }
  return null;
}

// ── Авто-подбор эталона по ИНН и периоду ─────────────────────────────
// Каталог эталонов хранится в двух местах:
//   • references/index.json рядом с index.html (общие, коммитятся в репо)
//   • localStorage['bondan_refs'] (личные, попадают туда через «💾
//     сохранить в кэш» и при ручном импорте)
// При каждом парсинге отчёта мы после detectReportMeta ищем эталон с
// совпадающим ИНН (и близким периодом) и автоматически применяем его.
// Если эталон не нашёлся — сверка тихо остаётся пустой; кнопки ручного
// импорта/экспорта по-прежнему доступны.
const _REF_CATALOGUE_URL = 'references/index.json';
window._refCatalogue = null;

async function _ensureRefCatalogue(){
  if(window._refCatalogue) return window._refCatalogue;
  // 1) Локальные — сохранённые пользователем.
  let localEntries = [];
  try {
    const raw = localStorage.getItem('bondan_refs');
    if(raw) localEntries = JSON.parse(raw) || [];
  } catch(e){}
  // 2) Общие — из JSON рядом с index.html.
  let repoEntries = [];
  try {
    const resp = await fetch(_REF_CATALOGUE_URL, {cache: 'no-store'});
    if(resp.ok){
      const data = await resp.json();
      repoEntries = Array.isArray(data.entries) ? data.entries : [];
    }
  } catch(e){}
  window._refCatalogue = {localEntries, repoEntries};
  return window._refCatalogue;
}

// Сопоставление периода: нормализуем разные формы (2024, «2024 год»,
// «H1 2024», «9M 2024», «31.12.2024») к строке-каноникалу.
function _normalisePeriod(p){
  if(!p) return '';
  const s = String(p).toLowerCase().replace(/ё/g,'е');
  // ищем «h1/h2/q1-q4/9m/12m/годовой» и год
  const yearM = s.match(/(19|20)\d{2}/);
  const year = yearM ? yearM[0] : '';
  let kind = '';
  if(/h1|полугод|\b6\s*мес|9м\s*2|12\s*мес|годов|year|31\.03|31\.12|30\.06|30\.09/.test(s)){
    if(/h1|полугод|\b6\s*мес|30\.06/.test(s)) kind = 'H1';
    else if(/9м|30\.09/.test(s)) kind = '9M';
    else if(/q1|3\s*мес|31\.03/.test(s)) kind = 'Q1';
    else if(/q3|30\.09/.test(s)) kind = '9M';
    else kind = 'FY'; // full year
  } else {
    kind = 'FY';
  }
  return kind + ' ' + year;
}

// Ищем в каталоге эталон для метаданных отчёта. Приоритет: полное
// совпадение ИНН+период > совпадение только по ИНН > null.
function _findRefFor(meta, period){
  if(!meta || !meta.inn) return null;
  const cat = window._refCatalogue;
  if(!cat) return null;
  const wantPeriod = _normalisePeriod(period || meta.period);
  const all = [...cat.localEntries, ...cat.repoEntries];
  const byInn = all.filter(e => String(e.inn) === String(meta.inn));
  if(!byInn.length) return null;
  // Точное совпадение по периоду.
  const exact = byInn.find(e => _normalisePeriod(e.period) === wantPeriod);
  if(exact) return exact;
  // Иначе — самый свежий по году.
  byInn.sort((a, b) => {
    const ya = (String(a.period||'').match(/(19|20)\d{2}/)||[''])[0];
    const yb = (String(b.period||'').match(/(19|20)\d{2}/)||[''])[0];
    return String(yb).localeCompare(String(ya));
  });
  return byInn[0];
}

// Сохранение эталона в локальный кэш (localStorage) — чтобы при
// следующей загрузке того же отчёта сверка применялась автоматом.
function _saveRefToLocal(ref){
  if(!ref || !ref.inn) return false;
  try {
    const raw = localStorage.getItem('bondan_refs');
    const arr = raw ? (JSON.parse(raw) || []) : [];
    // Заменяем предыдущую запись с тем же ИНН+периодом.
    const key = ref.inn + '|' + _normalisePeriod(ref.period);
    const filtered = arr.filter(e => (e.inn + '|' + _normalisePeriod(e.period)) !== key);
    filtered.push(ref);
    localStorage.setItem('bondan_refs', JSON.stringify(filtered));
    if(window._refCatalogue) window._refCatalogue.localEntries = filtered;
    return true;
  } catch(e){
    return false;
  }
}

// Извлекает текст PDF как таблицу с классификацией колонок.
// Алгоритм:
//   1) items группируются по Y → строки.
//   2) По всей странице строятся X-кластеры (колонки). Для каждой
//      колонки классифицируется тип:
//        'desc'   — в колонке много текста (не числа).
//        'note'   — 1-2-значные целые (номера примечаний).
//        'code'   — известные РСБУ-коды (1110-1700, 2110-2500).
//        'period' — колонка сплошь годов 1990–2099 (в «перевёрнутых»
//                   таблицах строки = годы, колонки = показатели).
//        'value'  — остальные числа ≥ 3 цифр или дробные.
//   3) Заголовки value-колонок (год/период) распознаются по верхним
//      строкам страницы и эмитятся синтетической строкой
//      `__HDR__\t<year_col1>\t<year_col2>…` — findVal/findValTrace
//      использует её, чтобы выбрать ячейку нужного года.
//   4) Многострочные подписи ячеек («Долгосрочные обязательства\nпо
//      займам банков 1234») склеиваются в одну строку при безопасных
//      условиях (нижняя строка — явное продолжение, не новый заголовок).
//   5) Колонки 'period' переносятся в desc как «… [2024]» — это
//      превращает «перевёрнутую» таблицу в обычный формат и сохраняет
//      связь значения с годом.
//   6) Колонки 'note' и 'code' игнорируются.
async function extractPdfTextLines(pdf, maxPages=80) {
  // Сохраняем для просмотрщика PDF (рендеринг страницы с подсветкой чисел).
  window._pickerPdfDoc = pdf;
  window._pickerPdfTableRows = [];           // структурные строки: {lineIdx, page, desc, cols}
  window._pickerPdfPageHeaders = {};         // страница → массив колоночных подписей
  window._pickerPdfPageLayout = {};          // страница → {colStarts, colKinds, items[{x,y,w,h,kind,str}]}
  const tableRows = window._pickerPdfTableRows;
  const pageHeaders = window._pickerPdfPageHeaders;
  const pageLayout = window._pickerPdfPageLayout;
  const pageBoundaries = [0]; // номер первой строки каждой страницы
  let out = '';
  let curLineIdx = 0;
  const pages = Math.min(pdf.numPages, maxPages);
  for(let i = 1; i <= pages; i++) {
    let page;
    try { page = await pdf.getPage(i); } catch(e){ continue; }
    let content;
    try { content = await page.getTextContent(); } catch(e){ continue; }
    const items = (content.items || []).filter(it => (it.str||'').length && it.transform);
    if(!items.length) { out += '\n'; continue; }

    const heights = items.map(it => it.height || Math.abs(it.transform[3]) || 12);
    const avgH = heights.reduce((a,b)=>a+b,0) / heights.length || 12;
    // Y-tolerance — **mode-based**. Предыдущие версии (avgH, потом
    // перцентиль-по-малым-дельтам) регулярно склеивали соседние data-
    // строки плотных таблиц: включали inter-line gap в расчёт, и yTol
    // оказывался близок к line-height, из-за чего items соседней
    // строки попадали в тот же Y-bucket.
    //
    // Теперь: сортируем ВСЕ items по Y, считаем гистограмму ненулевых
    // Y-дельт (round to 0.5pt) и берём самую частую — это и есть
    // настоящий line-height таблицы. yTol = 45% от неё — items одной
    // строки (sup/sub-script gap ≤ 1/3 line-h) остаются вместе, items
    // соседней (gap = line-h) гарантированно разделяются.
    const ysDesc = items.map(it => it.transform[5]).sort((a,b) => b - a);
    const gapHist = new Map();
    for(let k = 1; k < ysDesc.length; k++){
      const g = ysDesc[k-1] - ysDesc[k];
      if(g < 0.5) continue;              // тот же baseline
      if(g > avgH * 3)  continue;        // пропуск параграфа / страницы
      const bucket = Math.round(g * 2) / 2;
      gapHist.set(bucket, (gapHist.get(bucket) || 0) + 1);
    }
    let modeGap = avgH, modeCount = 0;
    for(const [g, c] of gapHist){
      if(c > modeCount){ modeCount = c; modeGap = g; }
    }
    const yTol = Math.max(1.0, Math.min(avgH * 0.8, modeGap * 0.45));

    // 1. Y-группировка
    const byLine = new Map();
    for(const it of items) {
      const y = it.transform[5];
      let key = null;
      for(const k of byLine.keys()) {
        if(Math.abs(k - y) <= yTol) { key = k; break; }
      }
      if(key == null) key = y;
      if(!byLine.has(key)) byLine.set(key, []);
      byLine.get(key).push(it);
    }

    // 1.5. Склейка соседних items ВНУТРИ строки.
    // PDF-экстрактор часто отдаёт один визуальный токен («2025»,
    // «30 июня 2025 года») как несколько items подряд с почти нулевым
    // горизонтальным зазором. Это рвёт даты («202 4 года») и делает
    // классификацию колонок неверной. Склеиваем, если между концом
    // предыдущего и началом следующего gap < 0.18 × avgH И по Y совпадают.
    for(const [k, arr] of byLine) {
      arr.sort((a,b) => a.transform[4] - b.transform[4]);
      const merged = [];
      for(const it of arr) {
        const last = merged[merged.length - 1];
        if(last) {
          const lastEnd = last.transform[4] + (last.width || 0);
          const gap = it.transform[4] - lastEnd;
          const h = last.height || it.height || avgH;
          // Не склеиваем если был явный пробел-разделитель (≥0.18×h).
          // Также не склеиваем «последнее — число, это — число» если
          // между ними любой видимый зазор: это может быть соседняя
          // колонка таблицы.
          const bothNumeric = /^\s*-?[\d\s\u00a0.,()]+$/.test(last.str||'')
                           && /^\s*-?[\d\s\u00a0.,()]+$/.test(it.str||'');
          const threshold = bothNumeric ? 0.05 : 0.18;
          if(gap < h * threshold){
            last.str = (last.str || '') + (it.str || '');
            last.width = (it.transform[4] + (it.width || 0)) - last.transform[4];
            continue;
          }
        }
        merged.push({
          str: it.str || '',
          transform: it.transform.slice(),
          width: it.width || 0,
          height: it.height || avgH,
        });
      }
      byLine.set(k, merged);
    }

    const linesOrdered = [...byLine.entries()].sort((a,b) => b[0] - a[0]);

    // После merge переcбираем плоский items2 для кластеризации/классификации,
    // чтобы они работали с уже склеенными токенами.
    const items2 = [];
    for(const [, arr] of byLine) for(const it of arr) items2.push(it);

    // 2. Кластеризация X всех items + классификация каждой колонки.
    // Плотные пороги: 1.3 × avgH между кластерами (раньше было 2×)
    // — так лучше отделяются узкие соседние числовые колонки.
    const allXs = items2.map(it => it.transform[4]).sort((a,b) => a-b);
    const COL_GAP = avgH * 1.3;
    const colStarts = [];
    if(allXs.length) {
      colStarts.push(allXs[0]);
      for(let k = 1; k < allXs.length; k++) {
        if(allXs[k] - allXs[k-1] >= COL_GAP) colStarts.push(allXs[k]);
      }
    }
    function colOf(x){
      let best = 0;
      for(let c = 0; c < colStarts.length; c++) {
        if(x >= colStarts[c] - avgH * 0.3) best = c;
        else break;
      }
      return best;
    }
    // Классифицируем каждую колонку по её содержимому по всей странице.
    // Используем жёсткие пороги: чтобы признать колонку «note» или «code»
    // — подавляющее большинство (80%+) её items должны быть такими.
    const NUM_PURE = /^\s*\(?-?[\d][\d \u00a0,.]{0,}\)?\s*$/;
    const colKinds = colStarts.map((_, ci) => {
      const bucket = items2.filter(it => colOf(it.transform[4]) === ci);
      if(!bucket.length) return 'desc';
      let numeric = 0, rsbu = 0, note = 0, big = 0, text = 0, yearLike = 0;
      for(const it of bucket) {
        const s = (it.str || '').trim();
        if(!s) continue;
        if(NUM_PURE.test(s)) {
          numeric++;
          const cleaned = s.replace(/[()\s,\u00a0]/g,'').replace(/^\-/,'');
          const n = parseInt(cleaned, 10);
          if(!isNaN(n)) {
            if(RSBU_CODE_SET && RSBU_CODE_SET.has(n)) rsbu++;
            else if(n >= 1990 && n <= 2099 && /^\d{4}$/.test(cleaned)) { yearLike++; big++; }
            else if(n >= 1 && n <= 99 && Number.isInteger(parseFloat(cleaned))) note++;
            else big++;
          } else big++;
        } else text++;
      }
      // Если в колонке больше текста чем чисел — это desc.
      if(numeric < text * 0.5) return 'desc';
      // Колонка «период» — почти все числа выглядят как годы (для
      // перевёрнутых таблиц, где год вынесен в боковую колонку).
      if(yearLike >= 2 && yearLike >= numeric * 0.6) return 'period';
      // Жёсткий порог для note/code: минимум 80% чистого содержимого
      // и мало «крупных» чисел (иначе реальный показатель 25 мог бы
      // ошибочно классифицировать колонку как note).
      if(rsbu >= numeric * 0.8 && big < numeric * 0.1) return 'code';
      if(note >= numeric * 0.8 && big < numeric * 0.1) return 'note';
      return 'value';
    });

    // 2.5. Заголовки value-колонок: ищем год среди items, попавших в эту
    // колонку из верхних строк страницы. Останавливаемся на первой
    // строке, в которой уже есть «крупное» (не-год) число — это
    // настоящая data-строка.
    const colHeaderText = colStarts.map(() => '');
    for(const [, lineItems] of linesOrdered){
      let bigDataHit = 0;
      for(const it of lineItems){
        const c = colOf(it.transform[4]);
        if(colKinds[c] !== 'value') continue;
        const s = (it.str||'').trim();
        if(!NUM_PURE.test(s)) continue;
        const cleaned = s.replace(/[()\s,\u00a0]/g,'').replace(/^\-/,'');
        const n = parseFloat(cleaned);
        if(!isNaN(n) && Math.abs(n) >= 1000 && !(n >= 1990 && n <= 2099)) bigDataHit++;
      }
      if(bigDataHit) break; // дошли до данных — заголовков выше уже нет
      for(const it of lineItems){
        const c = colOf(it.transform[4]);
        if(colKinds[c] !== 'value') continue;
        colHeaderText[c] = (colHeaderText[c] + ' ' + (it.str||'')).replace(/\s+/g,' ').trim();
      }
    }
    const colYears = colKinds.map((k, i) => k === 'value' ? _parseYearLabel(colHeaderText[i]) : null);

    // Индексы value-колонок слева направо — по ним выравниваются ячейки
    // в выводе и заголовок __HDR__.
    const valueColIdx = colKinds
      .map((k, i) => k === 'value' ? i : -1)
      .filter(i => i >= 0);

    // Эмитим синтетический header-row, если есть value-колонки. Даже если
    // ни один год не распознан — пустая строка-маркер не мешает, но даёт
    // findVal/findValTrace понять «здесь начинается новая таблица», а
    // ранжировщику — сопоставить ячейку с годом колонки.
    // IMPORTANT: curLineIdx синхронизирован с txt.split('\n') — picker
    // полагается на это; также пушим пустой tableRow, чтобы lineIdx
    // value-строк после шапки по-прежнему указывал в правильное место.
    if(valueColIdx.length){
      const headerCells = valueColIdx.map(ci => colYears[ci] != null ? String(colYears[ci]) : '');
      const hdrLine = _HEADER_MARKER + '\t' + headerCells.join('\t');
      out += hdrLine + '\n';
      tableRows.push({lineIdx: curLineIdx, page: i, desc: hdrLine, cols: []});
      curLineIdx++;
    }

    // 3. Сборка строк: items идут в нужные «ведра» согласно типу колонки.
    // Одна Y-строка PDF = одна строка вывода (без склейки с соседями —
    // это рушило плотные таблицы). Многострочные подписи остаются
    // разнесёнными по исходным строкам; Picker уже умеет look-ahead,
    // а findVal опирается на __HDR__ + колоночный padding.
    for(const [, lineItems] of linesOrdered) {
      lineItems.sort((a,b) => a.transform[4] - b.transform[4]);
      let desc = '';
      let prevDescEnd = null;
      let period = '';
      const valueCells = new Map(); // colIdx → текст ячейки
      for(const it of lineItems) {
        const x = it.transform[4], w = it.width || 0;
        const c = colOf(x);
        const kind = colKinds[c] || 'desc';
        const s = it.str || '';
        if(kind === 'desc') {
          if(prevDescEnd != null && x >= prevDescEnd && desc && !desc.endsWith(' ')) desc += ' ';
          desc += s;
          prevDescEnd = x + w;
        } else if(kind === 'value') {
          const prev = valueCells.get(c) || '';
          valueCells.set(c, prev ? (prev.endsWith(' ') ? prev + s : prev + ' ' + s) : s);
        } else if(kind === 'period') {
          const t = (s||'').trim();
          if(t) period = period ? period + ' ' + t : t;
        }
        // 'note' / 'code' — игнорируем полностью.
      }
      desc = desc.replace(/\s+/g,' ').trim();
      // Период (год сбоку) — переносим в desc, чтобы значение было
      // явно «привязано» к году. Это сохраняет связь в перевёрнутых
      // таблицах, где раньше год терялся как 'note'.
      const periodYear = _parseYearLabel(period);
      if(periodYear != null){
        const tag = '[' + periodYear + ']';
        desc = desc ? desc + ' ' + tag : tag;
      }
      // Выравниваем value-ячейки по value-колонкам страницы (с padding'ом).
      // Это критично, чтобы индекс ячейки соответствовал году в __HDR__;
      // pickerPdfTableRows также выиграет — colIdx в cols стабильно
      // указывает на позицию колонки, а пустые «''» picker пропустит
      // (parseNumsFrom('')=[]).
      const valCells = valueColIdx.map(ci => (valueCells.get(ci) || '').trim());
      const hasValues = valCells.some(v => v !== '');

      if(desc || hasValues){
        tableRows.push({lineIdx: curLineIdx, page: i, desc, cols: valCells.slice()});
        // Если строка без чисел и содержит год / дату-период — вероятно
        // это часть шапки колонок страницы. Сохраняем для Picker'а.
        if(!hasValues && /(19|20)\d{2}|закончи|по состоянию|месяц|полугод|квартал/i.test(desc) && desc.length < 220){
          if(!pageHeaders[i]) pageHeaders[i] = [];
          pageHeaders[i].push(desc);
        }
        out += [desc, ...valCells].join('\t') + '\n';
        curLineIdx++;
      }
    }
    out += '\n';
    curLineIdx++;
    // Запомнить, сколько строк уже в out — старт следующей страницы.
    pageBoundaries.push((out.match(/\n/g) || []).length);
    // Сохранить layout страницы для визуальной маски (поверх мини-PDF).
    // items — только те, что относятся к value/desc/note/code/period
    // колонкам (у них определён kind); координаты — в PDF-единицах,
    // перевод в canvas-coords делает viewport.convertToViewportPoint
    // при рендере маски.
    pageLayout[i] = {
      colStarts: colStarts.slice(),
      colKinds: colKinds.slice(),
      avgH,
      items: items2.map(it => ({
        x: it.transform[4],
        y: it.transform[5],
        w: it.width || 0,
        h: it.height || avgH,
        kind: colKinds[colOf(it.transform[4])] || 'desc',
        str: (it.str || '').slice(0, 40)
      }))
    };
  }
  window._pickerPdfPageBoundaries = pageBoundaries;
  return out;
}

// Выделяет все числа из строки, уважая русский разделитель тысяч (пробел
// между группами ровно 3 цифр) и НЕ склеивая соседние колонки таблицы.
// Отрицательные числа в скобках "(1 234)" конвертируются в "-1234".
// Определяет формат чисел в документе. Русский: '1 234 567,89'.
// Английский: '1,234,567.89'. По умолчанию русский — российские
// МСФО-отчёты чаще в нём.
function detectNumberFormat(txt){
  const enHits = ((txt||'').match(/\d{1,3}(?:,\d{3}){2,}(?:\.\d+)?/g) || []).length;
  const ruHits = ((txt||'').match(/\d{1,3}(?:[ \u00a0]\d{3}){2,}(?:,\d+)?/g) || []).length;
  if(enHits > ruHits * 1.5) return { lang:'en', thousands:',', decimal:'.' };
  return { lang:'ru', thousands:' ', decimal:',' };
}

// Держим текущий формат в глобале — фьюжн с detectNumberFormat проще
// чем прокидывать параметр через все findVal в РСБУ-блок.
let _numFormat = { lang:'ru', thousands:' ', decimal:',' };

function extractNumbersFromLine(line, fmt) {
  if(!line) return [];
  const f = fmt || _numFormat || { lang:'ru', thousands:' ', decimal:',' };
  // Отрицательные в скобках → префикс минус.
  line = line.replace(/\(\s*(-?[\d \u00a0,.]+)\s*\)/g, (m, n) => {
    return '-' + n.replace(/[\s\u00a0]/g,'');
  });
  const RE = f.lang === 'en'
    ? /-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g
    : /-?(?:\d{1,3}(?:[ \u00a0]\d{3})+|\d+)(?:[.,]\d+)?/g;
  const out = [];
  let m;
  while((m = RE.exec(line)) !== null) {
    let raw = m[0];
    if(f.lang === 'en') raw = raw.replace(/,/g,'');
    else raw = raw.replace(/[ \u00a0]/g,'').replace(',','.');
    const n = parseFloat(raw);
    if(!isNaN(n)) out.push(n);
  }
  return out;
}

// Фильтрует шум: годы (1000–2999 как 4-значные целые) и РСБУ-коды.
// Дополнительно: выбирает «значащее» число из строки. Первый элемент в
// табличной строке часто — номер примечания (1–2 цифры), его нужно
// пропустить если дальше в строке есть большие числа.
function filterMeaningfulNumbers(nums, {minAbs=0} = {}) {
  // Исторически тут отсекались 4-значные целые 1000-2999 как «годы/коды»,
  // но в МСФО отчётах настоящие значения (млн ₽) часто попадают в этот
  // диапазон (чистая прибыль 2 871, EBITDA 1 765 и т.п.) — фильтр давал
  // ложные срабатывания. Защиту от кодов РСБУ даёт уже extractByRsbuCodes
  // (он знает конкретный код и исключает ровно его), а защиту от
  // номеров примечаний (1-99 в начале строки) делает pickPrimaryNumber.
  return nums.filter(n => Math.abs(n) >= minAbs);
}

// Выбрать «первое значащее» число из строки: если в строке несколько
// чисел и первое выглядит как номер примечания (|n|<100), пропустить его
// и вернуть следующее большое. Одиночные числа возвращаем как есть.
function pickPrimaryNumber(nums) {
  if(!nums.length) return null;
  if(nums.length === 1) return nums[0];
  for(const n of nums) {
    if(Math.abs(n) >= 100) return n; // первое «взрослое» число
  }
  return nums[0];
}

async function parseAnyReport(input) {
  const file = input.files[0];
  if (!file) return;
  const status = document.getElementById('pdf-status');
  const found  = document.getElementById('pdf-found');
  status.style.color = 'var(--warn)';
  status.textContent = '⏳ Читаю ' + file.name + '...';
  found.style.display = 'none';

  const ext = file.name.split('.').pop().toLowerCase();
  try {
    let txt = '';

    if (ext === 'pdf') {
      // ── PDF ──
      await _ensurePdfjs();
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      const rawBuf = await file.arrayBuffer();
      const buf = rawBuf.slice(0);
      let pdf;
      try { pdf = await pdfjsLib.getDocument({ data: buf }).promise; }
      catch(e) { pdf = await pdfjsLib.getDocument({ data: rawBuf.slice(0), stopAtErrors: false }).promise; }
      txt = await extractPdfTextLines(pdf, 80);

    } else if (ext === 'docx' || ext === 'doc') {
      // ── DOCX ── делегируем на общий экстрактор (и Picker получит
      // структуру таблиц через _buildRowsFromAoa).
      txt = await repExtractDocx(file);

    } else if (ext === 'xlsx' || ext === 'xls') {
      // ── XLSX ── тот же экстрактор, aoa → tableRows для Picker'а.
      txt = await repExtractXlsx(file);

    } else if (typeof isImageExt === 'function' && isImageExt(ext)) {
      // ── Изображение (скан / фото таблицы) ──
      txt = await repOcrImage(file, (p, n, phase) => {
        status.style.color = 'var(--warn)';
        status.textContent = phase === 'init'
          ? '⏳ Загружаю OCR-модели (русский/английский)...'
          : '⏳ Распознаю изображение...';
      });

    } else {
      status.style.color = 'var(--danger)';
      status.textContent = '⚠️ Формат не поддерживается. Используйте PDF, DOCX, XLSX или фото (JPG/PNG).';
      return;
    }

    // ── Общий парсинг ──
    // Масштаб выбираем по наиболее частому упоминанию в документе.
    // В настоящем МСФО-отчёте «в миллионах рублей» стоит в шапке каждой
    // таблицы (баланс + ОФР + примечания = десятки вхождений), а «тыс.»
    // встречается изредка — в юр. блоке про уставный капитал, в разделе
    // про зарплаты и т.п. Если брать первое вхождение, случайное «тыс.»
    // на ранней странице ломает все цифры в 1000 раз.
    const SCALE_RES = [
      {re: /в\s+миллиардах\s+рубл/gi,                        s: 1},
      {re: /(?:^|[\s(])млрд\.?\s*руб/gi,                     s: 1},
      {re: /в\s+миллионах\s+рубл/gi,                         s: 0.001},
      {re: /(?:^|[\s(])млн\.?\s*руб/gi,                      s: 0.001},
      {re: /миллионах\s+росс/gi,                             s: 0.001},
      {re: /в\s+тысячах\s+рубл/gi,                           s: 0.000001},
      {re: /(?:^|[\s(])тыс\.?\s*руб/gi,                      s: 0.000001},
    ];
    const scaleCounts = {'1': 0, '0.001': 0, '0.000001': 0};
    for(const {re, s} of SCALE_RES) {
      const matches = txt.match(re);
      if(matches) scaleCounts[String(s)] += matches.length;
    }
    let scale = 1, best = 0;
    for(const [s, c] of Object.entries(scaleCounts)) {
      if(c > best) { best = c; scale = parseFloat(s); }
    }

    // Ищем число на строке с ключом. НЕ трогаем исходный текст глобально
    // — это сохраняет границы таблиц, где колонки разделены пробелами.
    // Каждая строка — TAB-разделённые ячейки [desc, val1, val2, …].
    // extractPdfTextLines также эмитит синтетическую строку
    // __HDR__\t<year1>\t<year2>… в начале каждой страницы — по ней мы
    // знаем, какому году соответствует каждая колонка, и умеем выбрать
    // самое свежее значение.
    //
    // Логика выбора среди нескольких совпавших строк:
    //   1) Строки без значений пропускаются (настоящие подписи разделов
    //      в табличном формате всегда отдельно от данных).
    //   2) Если паттерн содержит «Итог|ИТОГ|Total» — предпочитаем строки
    //      с этим словом в desc. Наоборот, если паттерн НЕ про итог —
    //      предпочитаем обычные строки (иначе «Чистая прибыль»
    //      мимоходом ловит «Итого чистая прибыль и прочий доход»).
    //   3) Из value-ячеек выбираем самую свежую по году (__HDR__),
    //      из них — самую «крупную» (|n|≥100) не-код.
    //   4) Fallback: если строка не TAB-формата (DOCX/XLSX), берём
    //      pickPrimaryNumber по всей строке.
    const _sections = _detectReportSections(txt);
    function findVal(patterns, fieldId) {
      const lines = txt.split('\n');
      const wantTotal = patterns.some(p => /итог|итого|total/i.test(p));
      const expSecs = _expectedSectionsForFieldId(fieldId);
      let curHeaders = null;
      const cands = [];
      for(let li = 0; li < lines.length; li++){
        const line = lines[li];
        const hdr = _parseHeaderCells(line);
        if(hdr){ curHeaders = hdr; continue; }
        if(!line) continue;
        const cells = line.split('\t');
        const desc = cells[0] || '';
        const isTabFormat = cells.length > 1;
        let patIdx = -1;
        for(let pi = 0; pi < patterns.length; pi++){
          const re = new RegExp(patterns[pi], 'i');
          if(isTabFormat ? re.test(desc) : re.test(line)){ patIdx = pi; break; }
        }
        if(patIdx < 0) continue;
        let value = null, year = null;
        if(isTabFormat){
          const cellNums = [];
          for(let i = 1; i < cells.length; i++){
            const nums = filterMeaningfulNumbers(extractNumbersFromLine(cells[i]), {minAbs:1});
            cellNums.push(nums.length ? nums[0] : null);
          }
          if(!cellNums.some(v => v != null)) continue;
          const colY = curHeaders ? cellNums.map((_, i) => curHeaders[i] ?? null) : cellNums.map(() => null);
          const picked = _pickValueCell(cellNums, colY);
          if(!picked) continue;
          value = picked.value; year = picked.year;
        } else {
          const nums = filterMeaningfulNumbers(extractNumbersFromLine(line), {minAbs:1})
            .filter(n => !RSBU_CODE_SET.has(Math.abs(n)));
          const v = pickPrimaryNumber(nums);
          if(v == null) continue;
          value = v;
        }
        const isTotalDesc = /итог|итого|total/i.test(desc);
        // Ранжирование: меньший patIdx лучше (паттерны отсортированы по
        // приоритету); совпадение wantTotal ↔ isTotalDesc даёт +100 очков;
        // попадание в ожидаемый раздел отчёта — +60/−40 (ОДДС для поля
        // «Денежные средства» промахивается на полном штрафе).
        let score = -patIdx * 10;
        if(wantTotal === isTotalDesc) score += 100;
        else if(wantTotal) score -= 50;
        else score -= 5;
        const sect = _sectionAt(_sections, li);
        score += _sectionScoreAdj(sect ? sect.kind : null, expSecs);
        cands.push({score, value, year, line, patIdx, sectionKind: sect ? sect.kind : null});
      }
      if(!cands.length) return null;
      cands.sort((a, b) => b.score - a.score || a.patIdx - b.patIdx);
      return cands[0].value;
    }

    // ── Сначала пробуем коды РСБУ (для XLSX/CSV) ──
    const codeResults = extractByRsbuCodes(txt);
    const fieldMap = {
      'is-rev':'is-rev','is-ebit':'is-ebit','is-np':'is-np','is-int':'is-int',
      'is-tax':'is-tax','is-assets':'is-assets','is-ca':'is-ca','is-cl':'is-cl',
      'is-debt':'is-debt','is-cash':'is-cash','is-ret':'is-ret','is-eq':'is-eq'
    };
    for (const [fid, val] of Object.entries(codeResults)) {
      if (val && document.getElementById(fid)) {
        const scaled = parseFloat((val * scale).toFixed(6));
        document.getElementById(fid).value = scaled;
      }
    }

    // ── Текстовый поиск для полей которые не нашли по кодам ──
    const sc = v => v !== null ? parseFloat((v * scale).toFixed(6)) : null;
    const alreadyFilled = new Set(Object.keys(codeResults).filter(k=>codeResults[k]!=null));
    const fields = {
      'is-rev':    alreadyFilled.has('is-rev')    ? null : sc(findVal(['Выручка по договорам','Выручка от реализации','Итого выручк[а-яё]*','^\\s*Выручка\\b','Доходы от реализации','Revenue'], 'is-rev')),
      'is-ebitda': sc(findVal(['EBITDA','Прибыль до вычета процентов','ЕБИТДА'], 'is-ebitda')),
      'is-ebit':   alreadyFilled.has('is-ebit')   ? null : sc(findVal(['Операционная прибыль','Прибыль от продаж','EBIT'], 'is-ebit')),
      'is-np':     alreadyFilled.has('is-np')     ? null : sc(findVal(['Чистая прибыль','Итого чистая прибыль','Прибыль за период','Прибыль за отчетн','Net profit','Profit for the period'], 'is-np')),
      'is-int':    alreadyFilled.has('is-int')    ? null : sc(findVal(['Проценты к уплате','Процентные расходы','Расходы по процентам','Финансовые расходы','Finance costs'], 'is-int')),
      'is-tax':    alreadyFilled.has('is-tax')    ? null : sc(findVal(['Налог на прибыль','Расход по налогу','Income tax'], 'is-tax')),
      'is-assets': alreadyFilled.has('is-assets') ? null : sc(findVal(['Итого активы','Итого активов','Совокупные активы','Всего активов','Total assets','ИТОГО АКТИВЫ','БАЛАНС'], 'is-assets')),
      'is-ca':     alreadyFilled.has('is-ca')     ? null : sc(findVal(['Итого оборотн[а-яё]*\\s+активов','Итого оборотных','Оборотные активы','Total current assets','Current assets'], 'is-ca')),
      'is-cl':     alreadyFilled.has('is-cl')     ? null : sc(findVal(['Итого краткосрочн[а-яё]*\\s+обязательств','Итого краткосрочных','Краткосрочные обязательства','Total current liabilities','Current liabilities'], 'is-cl')),
      'is-debt':   alreadyFilled.has('is-debt')   ? null : sc(findVal(['Заемные средства','Кредиты и займы','Total borrowings','Долгосрочные займы'], 'is-debt')),
      'is-cash':   alreadyFilled.has('is-cash')   ? null : sc(findVal(['Денежные средства и (их )?эквивалент','Cash and cash equivalents','ДС и их эквивалент'], 'is-cash')),
      'is-ret':    alreadyFilled.has('is-ret')    ? null : sc(findVal(['Нераспредел[её]нная прибыль','Retained earnings'], 'is-ret')),
      'is-eq':     alreadyFilled.has('is-eq')     ? null : sc(findVal(['Итого капитал','Итого собственн[а-яё]*\\s+капитал','Собственный капитал','Total equity','ИТОГО КАПИТАЛ'], 'is-eq')),
    };
    const labels = {
      'is-rev':'Выручка','is-ebitda':'EBITDA','is-ebit':'EBIT','is-np':'Чистая прибыль',
      'is-int':'Процентные расходы','is-tax':'Налог','is-assets':'Активы',
      'is-ca':'Оборотные активы','is-cl':'Краткосрочные обяз.','is-debt':'Долг',
      'is-cash':'Денежные средства','is-ret':'Нераспр. прибыль','is-eq':'Капитал'
    };
    const log = [];
    let filled = Object.keys(codeResults).filter(k=>codeResults[k]!=null).length;
    for (const [id, val] of Object.entries(fields)) {
      if (val !== null) {
        document.getElementById(id).value = val;
        log.push('<span style="color:var(--green)">✓</span> ' + labels[id] + ': <strong>' + val + '</strong>');
        filled++;
      }
    }
    if (filled === 0) {
      status.style.color = 'var(--warn)';
      status.textContent = '⚠️ Цифры не найдены. Если это PDF-скан — попробуйте DOCX или заполните вручную.';
    } else {
      status.style.color = 'var(--green)';
      // Автоопределение типа отчётности
      const detectedType = detectReportType(txt);
      const repTypeSel = document.getElementById('is-rep-type');
      if(detectedType && repTypeSel && !repTypeSel.value) {
        repTypeSel.value = detectedType;
      }
      status.textContent = '✓ Заполнено ' + filled + ' полей · ' + file.name + (detectedType?' · определён тип: '+detectedType:'');
      found.style.display = 'block';
      found.innerHTML = log.join('<br>');
    }
  } catch(e) {
    status.style.color = 'var(--danger)';
    status.textContent = '⚠️ Ошибка чтения файла: ' + e.message;
  }
}
// Оставляем алиас для совместимости
const parsePdfReport = parseAnyReport;

// MOEX ISS API — прямой запрос (работает на https://, GitHub Pages и localhost)
async function moexFetch(path){
  const url = 'https://iss.moex.com' + path + (path.includes('?')?'&':'?') + 'iss.meta=off';
  const resp = await fetch(url);
  if(!resp.ok) throw new Error('MOEX HTTP '+resp.status);
  return resp.json();
}
// Парсинг description-блока из ответа MOEX в плоский словарь
function parseMoexDesc(data){
  // Стандартный формат: {description:{columns:[...],data:[[name,title,value,...],...]}}
  const cols = data?.description?.columns || [];
  const rows = data?.description?.data || [];
  const nameIdx = cols.indexOf('name');
  const valIdx  = cols.indexOf('value');
  if(nameIdx<0||valIdx<0) return {};
  const m={};
  rows.forEach(r=>{ if(r[nameIdx]) m[r[nameIdx]]=r[valIdx]; });
  return m;
}
// Парсинг marketdata/securities блока
function parseMoexPrice(data){
  // marketdata
  const mc = data?.marketdata?.columns||[];
  const md = data?.marketdata?.data||[];
  const lastIdx = mc.indexOf('LAST');
  if(md.length && lastIdx>=0 && md[0][lastIdx]!=null) return parseFloat(md[0][lastIdx]);
  // securities PREVPRICE
  const sc = data?.securities?.columns||[];
  const sd = data?.securities?.data||[];
  const prevIdx = sc.indexOf('PREVPRICE');
  if(sd.length && prevIdx>=0 && sd[0][prevIdx]!=null) return parseFloat(sd[0][prevIdx]);
  return null;
}


let isinSearchTimer=null;
function onIsinInput(){
  clearTimeout(isinSearchTimer);
  const q=document.getElementById('pp-isin').value.trim();
  const sug=document.getElementById('pp-suggest');
  if(q.length<2){sug.style.display='none';return}
  isinSearchTimer=setTimeout(()=>fetchMoexSuggest(q),400);
}

async function fetchMoexSuggest(q){
  const sug=document.getElementById('pp-suggest');
  sug.innerHTML='<div style="padding:8px 12px;font-size:.67rem;color:var(--text3)">Поиск...</div>';
  sug.style.display='block';
  try{
    const data=await moexFetch(`/iss/securities.json?q=${encodeURIComponent(q)}&limit=8&group_by=name`);
    const rows=data?.securities?.data||[];
    if(!rows.length){sug.innerHTML='<div style="padding:8px 12px;font-size:.67rem;color:var(--text3)">Не найдено</div>';return}
    sug.innerHTML=rows.map(r=>{
      const secid=r[0],isin=r[2]||'',name=r[3]||secid,type=r[10]||'';
      return`<div style="padding:7px 12px;cursor:pointer;font-size:.68rem;border-bottom:1px solid var(--border);transition:background .1s"
        onmouseover="this.style.background='var(--s3)'" onmouseout="this.style.background=''"
        onclick="selectSuggest('${secid}','${isin}','${name.replace(/'/g,"\\'")}','${type}')">
        <strong style="color:var(--text)">${name}</strong>
        <span style="color:var(--text3);margin-left:8px">${secid}</span>
        <span style="color:var(--text3);margin-left:6px;font-size:.6rem">${isin}</span>
      </div>`;
    }).join('');
  }catch(e){sug.innerHTML=`<div style="padding:8px 12px;font-size:.67rem;color:var(--danger)">Ошибка: ${e.message}</div>`}
}

function selectSuggest(secid,isin,name,type){
  document.getElementById('pp-isin').value=isin||secid;
  document.getElementById('pp-suggest').style.display='none';
  lookupIsin(secid);
}

async function lookupIsin(secidOverride){
  const raw=document.getElementById('pp-isin').value.trim();
  if(!raw&&!secidOverride){alert('Введите ISIN или название');return}
  const q=secidOverride||raw;
  const btn=document.getElementById('pp-lookup-btn');
  const load=document.getElementById('pp-load');
  const status=document.getElementById('pp-moex-status');
  btn.style.display='none'; load.style.display='flex';
  status.textContent='Запрос к MOEX...';
  try{
    let secid=q;
    if(q.startsWith('RU')&&q.length>=12){
      const s=await moexFetch(`/iss/securities.json?q=${encodeURIComponent(q)}&limit=3`);
      const scols=s?.securities?.columns||[];
      const srows=s?.securities?.data||[];
      const sidIdx=scols.indexOf('secid');
      if(srows.length) secid=sidIdx>=0?srows[0][sidIdx]:srows[0][0];
    }
    const desc=await moexFetch(`/iss/securities/${encodeURIComponent(secid)}.json`);
    const dMap=parseMoexDesc(desc);
    let curPrice=null;
    try{
      const mkt=await moexFetch(`/iss/engines/stock/markets/bonds/securities/${encodeURIComponent(secid)}.json`);
      curPrice=parseMoexPrice(mkt);
    }catch(e){}
    const name=dMap['NAME']||dMap['SHORTNAME']||secid;
    const isin=dMap['ISIN']||q;
    const nomRaw=parseFloat(dMap['FACEVALUE']||'1000');
    const nom=isNaN(nomRaw)?1000:nomRaw;
    const couponRaw=parseFloat(dMap['COUPONPERCENT']||'');
    const maturity=dMap['MATDATE']||dMap['OFFERDATE']||'';
    let yearsLeft=null;
    if(maturity){const ms=new Date(maturity)-new Date();if(ms>0)yearsLeft=parseFloat((ms/1000/60/60/24/365).toFixed(2));}
    let btype='Корп';
    if(secid.startsWith('SU')||name.includes('ОФЗ')) btype='ОФЗ';
    const ctype=couponRaw===0?'zero':'fix';
    document.getElementById('pp-name').value=name;
    document.getElementById('pp-btype').value=btype;
    document.getElementById('pp-ctype').value=ctype;
    if(!isNaN(couponRaw)&&couponRaw>=0) document.getElementById('pp-coupon').value=couponRaw;
    document.getElementById('pp-nom').value=nom;
    if(yearsLeft) document.getElementById('pp-years').value=yearsLeft.toFixed(2);
    if(curPrice) document.getElementById('pp-cur').value=curPrice.toFixed(2);

    // Подтягиваем амортизацию и ближайшую оферту из bondization.json.
    // amortizations > 1 строки (или суммы < номинала на последней дате)
    // = есть амортизация. offers: ближайшая будущая put-call дата.
    let hasAmort = false, offerDate = '';
    try {
      const bz = await moexFetch(`/iss/securities/${encodeURIComponent(secid)}/bondization.json?iss.meta=off`);
      const amCols = bz?.amortizations?.columns || [];
      const amRows = bz?.amortizations?.data || [];
      if(amRows.length > 1) hasAmort = true;
      const ofCols = bz?.offers?.columns || [];
      const ofRows = bz?.offers?.data || [];
      const ofDateIdx = ofCols.indexOf('offerdate');
      const todayIso = new Date().toISOString().slice(0,10);
      const futureOffers = ofRows
        .map(r => ofDateIdx >= 0 ? r[ofDateIdx] : null)
        .filter(d => d && d >= todayIso)
        .sort();
      if(futureOffers.length) offerDate = futureOffers[0];
    } catch(_){}
    // Стэшим данные для addPortPos в data-атрибутах формы.
    const form = document.getElementById('pp-name');
    form.dataset.isin = isin;
    form.dataset.hasAmortization = hasAmort ? '1' : '';
    form.dataset.offerDate = offerDate || '';

    const extras = [];
    if(hasAmort) extras.push('амортизация');
    if(offerDate) extras.push('оферта ' + offerDate);
    status.innerHTML=`<span style="color:var(--green)">✓ ${name} · ${isin}${curPrice?` · цена ${curPrice.toFixed(2)}%`:''}${maturity?` · погаш. ${maturity}`:''}${extras.length?' · '+extras.join(' · '):''}</span>`;
  }catch(e){
    status.innerHTML=`<span style="color:var(--danger)">Ошибка: ${e.message}</span>`;
  }finally{
    btn.style.display=''; load.style.display='none';
  }
}

function clearPortForm(){
  ['pp-isin','pp-name','pp-buy','pp-cur','pp-coupon','pp-qty','pp-years'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('pp-nom').value='1000';
  document.getElementById('pp-suggest').style.display='none';
  document.getElementById('pp-moex-status').textContent='';
}

function addPortPos(){
  const name=document.getElementById('pp-name').value.trim();
  if(!name){alert('Введите название (используйте поиск по ISIN)');return}
  const btype=document.getElementById('pp-btype').value;
  const ctype=document.getElementById('pp-ctype').value;
  const buy=parseFloat(document.getElementById('pp-buy').value);
  const cur=parseFloat(document.getElementById('pp-cur').value);
  const coupon=parseFloat(document.getElementById('pp-coupon').value)||0;
  const qty=parseInt(document.getElementById('pp-qty').value)||1;
  const nom=parseFloat(document.getElementById('pp-nom').value)||1000;
  const years=parseFloat(document.getElementById('pp-years').value);
  if(isNaN(buy)||buy<=0){alert('Введите цену покупки');return}
  const curP=isNaN(cur)?buy:cur;
  const ytm=(!isNaN(years)&&years>0&&coupon>0)?calcYTM(buy,coupon,years):null;
  const isinVal=document.getElementById('pp-isin').value.trim();
  const form=document.getElementById('pp-name');
  const hasAmortization = form.dataset.hasAmortization === '1' ? true : undefined;
  const offerDate = form.dataset.offerDate || undefined;
  portfolio.push({
    name,btype,ctype,buy,cur:curP,coupon,qty,nom,years:isNaN(years)?0:years,
    ytm,isin:isinVal,id:Date.now()+Math.random(),
    hasAmortization, offerDate,
  });
  save(); renderPort(); clearPortForm();
  if(form){ delete form.dataset.hasAmortization; delete form.dataset.offerDate; delete form.dataset.isin; }
}

function removePortPos(id){portfolio=portfolio.filter(p=>p.id!==id);save();renderPort()}

function editPortPos(id){
  const p=portfolio.find(x=>x.id===id); if(!p)return;
  document.getElementById('ep-id').value=id;
  document.getElementById('ep-name').value=p.name;
  document.getElementById('ep-btype').value=p.btype;
  document.getElementById('ep-ctype').value=p.ctype;
  document.getElementById('ep-coupon').value=p.coupon;
  document.getElementById('ep-buy').value=p.buy;
  document.getElementById('ep-cur').value=p.cur;
  document.getElementById('ep-qty').value=p.qty;
  document.getElementById('ep-nom').value=p.nom;
  document.getElementById('ep-years').value=p.years;
  const rat=document.getElementById('ep-rating'); if(rat) rat.value=p.rating||'';
  const off=document.getElementById('ep-offer'); if(off) off.value=p.offerDate||'';
  const am=document.getElementById('ep-amort'); if(am) am.checked=!!p.hasAmortization;
  document.getElementById('modal-edit-pos').classList.add('open');
}
function saveEditPos(){
  const id=parseFloat(document.getElementById('ep-id').value);
  const idx=portfolio.findIndex(p=>p.id===id); if(idx<0)return;
  const buy=parseFloat(document.getElementById('ep-buy').value);
  const cur=parseFloat(document.getElementById('ep-cur').value);
  const coupon=parseFloat(document.getElementById('ep-coupon').value)||0;
  const years=parseFloat(document.getElementById('ep-years').value);
  const nom=parseFloat(document.getElementById('ep-nom').value)||1000;
  const rat=(document.getElementById('ep-rating')?.value||'').trim();
  const offerDate=document.getElementById('ep-offer')?.value||'';
  const hasAmort=!!document.getElementById('ep-amort')?.checked;
  portfolio[idx]={
    ...portfolio[idx],
    name:document.getElementById('ep-name').value.trim(),
    btype:document.getElementById('ep-btype').value,
    ctype:document.getElementById('ep-ctype').value,
    coupon,buy,cur:isNaN(cur)?buy:cur,
    qty:parseInt(document.getElementById('ep-qty').value)||1,
    nom,years:isNaN(years)?0:years,
    rating: rat || undefined,
    offerDate: offerDate || undefined,
    hasAmortization: hasAmort || undefined,
    ytm:(!isNaN(years)&&years>0&&coupon>0)?calcYTM(buy,coupon,years):null
  };
  save(); renderPort(); closeModal('modal-edit-pos');
}

// Copy portfolio position to YTM comparison
function copyToYtm(id){
  const p=portfolio.find(x=>x.id===id); if(!p)return;
  if(ytmBonds.find(b=>b.name===p.name)){alert('Такой выпуск уже есть в YTM');return}
  const b={name:p.name,btype:p.btype,ctype:p.ctype,price:p.cur,years:p.years,id:Date.now()+Math.random(),buyPrice:p.buy};
  if(p.ctype==='fix'){b.coupon=p.coupon;b.ytm=p.ytm||calcYTM(p.cur,p.coupon,p.years)}
  else if(p.ctype==='float'){b.spread=p.coupon;b.base='КС';b.ytm=RATE_NOW+p.coupon-(p.cur-100)/p.years}
  else{b.coupon=0;b.ytm=((100/p.cur)-1)/p.years*100}
  ytmBonds.push(b); save();
  alert(`${p.name} добавлен в YTM сравнение`);
}

// Copy portfolio position to watchlist
function copyToWL(id){
  const p=portfolio.find(x=>x.id===id); if(!p)return;
  const keys=Object.keys(watchlists);
  if(!keys.length){newListModal();return}
  const wlId=keys[0];
  watchlists[wlId].bonds.push({name:p.name,btype:p.btype,ctype:p.ctype,price:p.cur,coupon:p.coupon,years:p.years,
    ytm:p.ytm,note:'Из портфеля',addedAt:Date.now(),id:Date.now()+Math.random()});
  save(); alert(`${p.name} добавлен в «${watchlists[wlId].name}»`);
}

function renderPort(){
  const tbody=document.getElementById('port-tbody');
  const empty=document.getElementById('port-empty');
  document.getElementById('sb-pc').textContent=portfolio.length;
  if(!portfolio.length){
    tbody.innerHTML='';empty.style.display='block';
    ['ps-inv','ps-val','ps-pnl','ps-ytm','ps-ytmbuy','ps-coup'].forEach(id=>{const el=document.getElementById(id);if(el)el.textContent='—'});
    return;
  }
  empty.style.display='none';
  let tInv=0,tVal=0,tCoup=0,ySum=0,yW=0,yBuySum=0,yBuyW=0;
  tbody.innerHTML=portfolio.map(p=>{
    const inv=p.buy/100*p.nom*p.qty;
    const val=p.cur/100*p.nom*p.qty;
    const pnl=val-inv; const pPct=pnl/inv*100;
    const effCoupon = p.ctype==='float' ? (RATE_NOW + (p.spread||0)) : (p.coupon||0);
    const coup=effCoupon/100*p.nom*p.qty;
    tInv+=inv;tVal+=val;tCoup+=coup;

    // YTM текущий (от текущей цены)
    let ytmCur;
    if(p.ctype==='float')      ytmCur = RATE_NOW+(p.spread||0)-(p.cur-100)/(p.years||2);
    else if(p.coupon>0&&p.years>0) ytmCur = calcYTM(p.cur,p.coupon,p.years);
    else ytmCur = null;

    // YTM покупки (от цены входа) — ваша фактическая доходность
    let ytmBuy;
    if(p.ctype==='float')      ytmBuy = RATE_NOW+(p.spread||0)-(p.buy-100)/(p.years||2);
    else if(p.coupon>0&&p.years>0) ytmBuy = calcYTM(p.buy,p.coupon,p.years);
    else ytmBuy = null;

    if(ytmBuy&&isFinite(ytmBuy)){yBuySum+=ytmBuy*inv;yBuyW+=inv}
    if(ytmCur&&isFinite(ytmCur)){ySum+=ytmCur*inv;yW+=inv}

    // Дельта: текущий YTM vs YTM покупки
    const delta = (ytmCur!=null&&ytmBuy!=null) ? ytmCur-ytmBuy : null;
    const deltaStr = delta!=null
      ? `<span style="font-size:.56rem;color:${Math.abs(delta)<0.1?'var(--text3)':delta>0?'var(--green)':'var(--danger)'}">${delta>=0?'+':''}${delta.toFixed(2)}%</span>`
      : '';

    const ytmBuyCell = ytmBuy!=null&&isFinite(ytmBuy)
      ? `<span class="${ytmCls(ytmBuy)}" style="font-weight:600">${ytmBuy.toFixed(2)}%</span>`
      : '—';
    const ytmCurCell = ytmCur!=null&&isFinite(ytmCur)
      ? `<div><span class="${ytmCls(ytmCur)}">${ytmCur.toFixed(2)}%</span> ${deltaStr}</div>`
      : '—';

    // Бэйджи особенностей выпуска: амортизация / оферта / рейтинг
    const badges = [];
    if(p.rating) badges.push(`<span title="Рейтинг" style="font-size:.52rem;color:var(--text2);border:1px solid var(--border2);padding:1px 4px;margin-left:5px">${p.rating}</span>`);
    if(p.hasAmortization) badges.push(`<span title="Амортизация номинала" style="font-size:.52rem;color:var(--warn);border:1px solid var(--warn);padding:1px 4px;margin-left:5px">АМОРТ</span>`);
    if(p.offerDate) badges.push(`<span title="Оферта ${p.offerDate}" style="font-size:.52rem;color:var(--purple);border:1px solid var(--purple);padding:1px 4px;margin-left:5px">ОФ ${fmtOfferDate(p.offerDate)}</span>`);
    const badgesHtml = badges.join('');

    return`<tr>
      <td style="font-weight:600">${p.name}${badgesHtml}</td>
      <td><span class="tag ${BT_TAG[p.btype]||'tag-corp'}">${p.btype}</span></td>
      <td><span class="tag ct-${p.ctype}" style="font-size:.54rem">${CT_LABELS[p.ctype]}</span></td>
      <td>${p.buy.toFixed(2)}%</td><td>${p.cur.toFixed(2)}%</td><td>${p.qty}</td>
      <td>${rub(inv)}</td><td>${rub(val)}</td>
      <td class="${pnl>=0?'val-pos':'val-neg'}">${rub(pnl,true)}</td>
      <td class="${pPct>=0?'val-pos':'val-neg'}">${pPct>=0?'+':''}${pPct.toFixed(2)}%</td>
      <td>${ytmBuyCell}</td>
      <td>${ytmCurCell}</td>
      <td>${rub(coup)}</td>
      <td><div style="display:flex;gap:3px">
        <button class="btn btn-sm" onclick="editPortPos(${p.id})" title="Редактировать">✏️</button>
        <button class="btn btn-sm" onclick="copyToYtm(${p.id})" title="Скопировать в YTM">⧉</button>
        <button class="btn btn-sm" onclick="copyToWL(${p.id})" title="Добавить в список">⭐</button>
        <button class="btn btn-sm btn-d" onclick="removePortPos(${p.id})">✕</button>
      </div></td>
    </tr>`;
  }).join('');
  const tPnl=tVal-tInv;
  const avgYtmCur=yW>0?ySum/yW:0;
  const avgYtmBuy=yBuyW>0?yBuySum/yBuyW:0;
  document.getElementById('ps-inv').textContent=rub(tInv);
  document.getElementById('ps-val').textContent=rub(tVal);
  document.getElementById('ps-pnl').textContent=rub(tPnl,true);
  document.getElementById('ps-pnl').className='sc-val '+(tPnl>=0?'val-pos':'val-neg');
  document.getElementById('ps-ytm').textContent=avgYtmCur?avgYtmCur.toFixed(2)+'%':'—';
  const buyEl=document.getElementById('ps-ytmbuy');
  if(buyEl) buyEl.textContent=avgYtmBuy?avgYtmBuy.toFixed(2)+'%':'—';
  document.getElementById('ps-coup').textContent=rub(tCoup);
  // Круговые диаграммы — рисуем всегда, когда в портфеле что-то есть.
  renderPortCharts();
}

// Форматирует дату оферты как «DD.MM.YY» — экономит место в таблице.
function fmtOfferDate(iso){
  if(!iso) return '';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1].slice(2)}` : iso;
}

// Класс рейтинга для группировки. Нормализуем «ruAA+», «AA-», «A+» → «AA»/«A».
// Возвращает ключ из {AAA, AA, A, BBB, BB, B, CCC и ниже, нет}.
function ratingClass(r){
  if(!r) return 'нет';
  const s = String(r).toUpperCase().replace(/^RU/, '').replace(/[+\-−–]/g,'').trim();
  if(s.startsWith('AAA')) return 'AAA';
  if(s.startsWith('AA'))  return 'AA';
  if(s.startsWith('A'))   return 'A';
  if(s.startsWith('BBB')) return 'BBB';
  if(s.startsWith('BB'))  return 'BB';
  if(s.startsWith('B'))   return 'B';
  if(s.startsWith('C') || s.startsWith('D')) return 'CCC и ниже';
  return 'нет';
}

// Рисует 4 SVG-круговых диаграммы: по рейтингу / сроку / YTM / риску.
// Вес слайсов — доля по текущей стоимости позиции (cur*nom*qty).
function renderPortCharts(){
  const card = document.getElementById('port-charts-card');
  const wrap = document.getElementById('port-charts');
  if(!wrap || !card) return;
  if(!portfolio.length){ card.style.display='none'; wrap.innerHTML=''; return; }

  const weight = p => (p.cur/100)*p.nom*p.qty;

  // Палитры — подогнаны под тему (акцент, зелёный, варн, даунгер, пурпл, бирюза).
  const PALETTE = ['#00d4ff','#22d3a0','#f5a623','#ff4d6d','#a78bfa','#60a5fa','#7aa0b8','#3a6080'];
  const RATING_ORDER = ['AAA','AA','A','BBB','BB','B','CCC и ниже','нет'];
  const RATING_COLORS = {
    'AAA':'#22d3a0','AA':'#60a5fa','A':'#00d4ff','BBB':'#a78bfa',
    'BB':'#f5a623','B':'#ff4d6d','CCC и ниже':'#ff4d6d','нет':'#7aa0b8',
  };
  const RISK_COLORS = {'Низкий':'#22d3a0','Средний':'#f5a623','Высокий':'#ff4d6d','Не оценено':'#7aa0b8'};

  // Эффективный рейтинг позиции: сначала из позиции, потом из совпавшего
  // по имени эмитента в «Базе отчётности» — чтобы не пришлось дублировать.
  const effectiveRating = p => {
    if(p.rating) return p.rating;
    if(typeof findReportsIssuerByName !== 'function') return '';
    const issId = findReportsIssuerByName(p.name);
    const iss = issId ? reportsDB[issId] : null;
    return (iss && iss.rating) ? iss.rating : '';
  };

  // Собираем «жалобы»: позиции, у которых не хватает данных для разбивок.
  const missingRating = [];       // для диаграммы рейтинга/риска
  const missingYears  = [];       // для диаграммы срока
  const missingYtm    = [];       // для диаграммы YTM

  // 1) По рейтингу
  const byRating = {};
  portfolio.forEach(p => {
    const cls = ratingClass(effectiveRating(p));
    if(cls === 'нет') missingRating.push(p.name);
    byRating[cls] = (byRating[cls] || 0) + weight(p);
  });
  const ratingSlices = RATING_ORDER.filter(k => byRating[k] > 0)
    .map(k => ({label:k, value:byRating[k], color:RATING_COLORS[k]}));

  // 2) По сроку до погашения (учитываем оферту — если ближе, берём её)
  const now = new Date();
  const yearsLeft = p => {
    if(p.offerDate){
      const o = new Date(p.offerDate);
      if(!isNaN(o)) {
        const d = (o - now)/(365.25*24*3600*1000);
        if(d > 0 && (p.years == null || d < p.years)) return d;
      }
    }
    return p.years || 0;
  };
  const termBuckets = [
    {k:'до 1 года', test:y => y < 1,            color:'#22d3a0'},
    {k:'1–3 года',  test:y => y >= 1 && y < 3,  color:'#00d4ff'},
    {k:'3–5 лет',   test:y => y >= 3 && y < 5,  color:'#a78bfa'},
    {k:'5+ лет',    test:y => y >= 5,           color:'#f5a623'},
  ];
  const byTerm = {};
  portfolio.forEach(p => {
    const y = yearsLeft(p);
    if(!y || !isFinite(y) || y <= 0){ missingYears.push(p.name); return; }
    const b = termBuckets.find(b => b.test(y));
    if(b) byTerm[b.k] = (byTerm[b.k] || 0) + weight(p);
  });
  const termSlices = termBuckets.filter(b => byTerm[b.k] > 0)
    .map(b => ({label:b.k, value:byTerm[b.k], color:b.color}));

  // 3) По YTM (текущей)
  const ytmOf = p => {
    if(p.ctype==='float')          return RATE_NOW+(p.spread||0)-(p.cur-100)/(p.years||2);
    if(p.coupon>0 && p.years>0)    return calcYTM(p.cur, p.coupon, p.years);
    return null;
  };
  const ytmBuckets = [
    {k:'до 10%',  test:y => y < 10,              color:'#7aa0b8'},
    {k:'10–15%',  test:y => y >= 10 && y < 15,   color:'#60a5fa'},
    {k:'15–20%',  test:y => y >= 15 && y < 20,   color:'#22d3a0'},
    {k:'20–25%',  test:y => y >= 20 && y < 25,   color:'#f5a623'},
    {k:'25%+',    test:y => y >= 25,             color:'#ff4d6d'},
  ];
  const byYtm = {};
  portfolio.forEach(p => {
    const y = ytmOf(p);
    if(y == null || !isFinite(y)){ missingYtm.push(p.name); return; }
    const b = ytmBuckets.find(b => b.test(y));
    if(b) byYtm[b.k] = (byYtm[b.k] || 0) + weight(p);
  });
  const ytmSlices = ytmBuckets.filter(b => byYtm[b.k] > 0)
    .map(b => ({label:b.k, value:byYtm[b.k], color:b.color}));

  // 4) По риску: ОФЗ/муни + рейтинг → Низкий / Средний / Высокий.
  const riskOf = p => {
    if(p.btype === 'ОФЗ' || p.btype === 'Муни') return 'Низкий';
    const r = ratingClass(effectiveRating(p));
    if(r === 'AAA' || r === 'AA') return 'Низкий';
    if(r === 'A' || r === 'BBB') return 'Средний';
    if(r === 'BB' || r === 'B' || r === 'CCC и ниже') return 'Высокий';
    return 'Не оценено';
  };
  const byRisk = {};
  portfolio.forEach(p => {
    const r = riskOf(p);
    byRisk[r] = (byRisk[r] || 0) + weight(p);
  });
  const RISK_ORDER = ['Низкий','Средний','Высокий','Не оценено'];
  const riskSlices = RISK_ORDER.filter(k => byRisk[k] > 0)
    .map(k => ({label:k, value:byRisk[k], color:RISK_COLORS[k]}));

  // Подсказки о недостающих данных — отображаются под диаграммой, если
  // соответствующее поле пусто у ≥1 позиций.
  const ratingHint = missingRating.length
    ? `У ${missingRating.length} поз. нет рейтинга: ${missingRating.slice(0,3).join(', ')}${missingRating.length>3?' и ещё '+(missingRating.length-3):''}. Добавьте через ✏️ у позиции или в «Базе отчётности» (он подтянется по имени).`
    : '';
  const termHint = missingYears.length
    ? `У ${missingYears.length} поз. не указан срок до погашения: ${missingYears.slice(0,3).join(', ')}${missingYears.length>3?'...':''}`
    : '';
  const ytmHint = missingYtm.length
    ? `У ${missingYtm.length} поз. не посчитался YTM (нужны купон + срок): ${missingYtm.slice(0,3).join(', ')}${missingYtm.length>3?'...':''}`
    : '';
  const riskHint = missingRating.length
    ? `Для корп. бумаг без рейтинга риск = «Не оценено». Задайте рейтинг, чтобы он попал в нужную категорию.`
    : '';

  card.style.display = '';
  wrap.innerHTML = [
    pieChartBlock('По рейтингу', ratingSlices, ratingHint),
    pieChartBlock('По сроку', termSlices, termHint),
    pieChartBlock('По доходности', ytmSlices, ytmHint),
    pieChartBlock('По риску', riskSlices, riskHint),
  ].join('');
}

// Рендерит один блок: заголовок + SVG-пирог + легенда справа.
// Использует inline SVG без зависимостей — держит стиль моно-терминала.
// hint (опц.) — пояснение под диаграммой о неполных данных.
function pieChartBlock(title, slices, hint){
  const hintHtml = hint ? `<div style="font-size:.55rem;color:var(--warn);margin-top:6px;line-height:1.4">⚠ ${hint}</div>` : '';
  const total = slices.reduce((s, x) => s + (x.value || 0), 0);
  if(!total){
    return `<div style="border:1px solid var(--border);padding:10px;background:var(--bg)">
      <div style="font-size:.58rem;letter-spacing:.1em;text-transform:uppercase;color:var(--text3);margin-bottom:6px">${title}</div>
      <div style="font-size:.6rem;color:var(--text3)">нет данных</div>
      ${hintHtml}
    </div>`;
  }
  const R = 42, CX = 52, CY = 52;
  let a0 = -Math.PI / 2;
  const paths = slices.map(s => {
    const frac = s.value / total;
    const a1 = a0 + frac * Math.PI * 2;
    // Отдельный полный круг, если единственный слайс — SVG arc с 360° не рисуется.
    if(frac >= 0.9999){
      a0 = a1;
      return `<circle cx="${CX}" cy="${CY}" r="${R}" fill="${s.color}"/>`;
    }
    const x0 = CX + R * Math.cos(a0), y0 = CY + R * Math.sin(a0);
    const x1 = CX + R * Math.cos(a1), y1 = CY + R * Math.sin(a1);
    const large = frac > 0.5 ? 1 : 0;
    a0 = a1;
    return `<path d="M${CX},${CY} L${x0.toFixed(2)},${y0.toFixed(2)} A${R},${R} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)} Z" fill="${s.color}"/>`;
  }).join('');
  const legend = slices.map(s => {
    const pct = (s.value / total * 100).toFixed(1);
    return `<div style="display:flex;align-items:center;gap:6px;font-size:.6rem;color:var(--text2)">
      <span style="width:9px;height:9px;background:${s.color};flex-shrink:0"></span>
      <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${s.label}</span>
      <span style="color:var(--text);font-variant-numeric:tabular-nums">${pct}%</span>
    </div>`;
  }).join('');
  return `<div style="border:1px solid var(--border);padding:10px;background:var(--bg)">
    <div style="font-size:.58rem;letter-spacing:.1em;text-transform:uppercase;color:var(--text3);margin-bottom:6px">${title}</div>
    <div style="display:flex;align-items:center;gap:12px">
      <svg viewBox="0 0 104 104" style="width:88px;height:88px;flex-shrink:0">
        <circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="var(--border)" stroke-width="1"/>
        ${paths}
        <circle cx="${CX}" cy="${CY}" r="18" fill="var(--s1)"/>
      </svg>
      <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:3px">${legend}</div>
    </div>
    ${hintHtml}
  </div>`;
}

// Close suggest on outside click
document.addEventListener('click',e=>{
  const sug=document.getElementById('pp-suggest');
  if(sug&&!sug.contains(e.target)&&e.target.id!=='pp-isin') sug.style.display='none';
});

// Allow pressing Enter in ISIN field to trigger lookup
document.getElementById('pp-isin').addEventListener('keydown',e=>{
  if(e.key==='Enter'){e.preventDefault();document.getElementById('pp-suggest').style.display='none';lookupIsin()}
});

// ══ WATCHLISTS ══
function setActiveWL(id){
  activeWL=id;
  document.getElementById('wl-add-form').style.display='block';
  document.getElementById('wl-cur-name').textContent=watchlists[id]?.name||'';
  renderWL();
}
function addToWL(){
  if(!activeWL||!watchlists[activeWL])return;
  const name=document.getElementById('wl-bname').value.trim();
  if(!name){alert('Введите название');return}
  const price=parseFloat(document.getElementById('wl-price').value);
  const coupon=parseFloat(document.getElementById('wl-coupon').value);
  const years=parseFloat(document.getElementById('wl-years').value);
  const ytm=(!isNaN(price)&&!isNaN(coupon)&&!isNaN(years)&&coupon>0)?calcYTM(price,coupon,years):null;
  watchlists[activeWL].bonds.push({
    name,btype:document.getElementById('wl-btype').value,ctype:document.getElementById('wl-ctype').value,
    price:isNaN(price)?null:price,coupon:isNaN(coupon)?null:coupon,years:isNaN(years)?null:years,
    ytm,note:document.getElementById('wl-note').value.trim(),addedAt:Date.now(),id:Date.now()+Math.random()
  });
  save();renderWL();
  ['wl-bname','wl-price','wl-coupon','wl-years','wl-note'].forEach(id=>document.getElementById(id).value='');
}
function removeFromWL(wlId,bId){
  if(!watchlists[wlId])return;
  watchlists[wlId].bonds=watchlists[wlId].bonds.filter(b=>b.id!==bId);
  save();renderWL();
}
function delWL(id){
  if(!confirm(`Удалить «${watchlists[id]?.name}»?`))return;
  delete watchlists[id];
  if(activeWL===id){activeWL=null;document.getElementById('wl-add-form').style.display='none'}
  save();renderWL();renderSbLists();
}
function renderWL(){
  const keys=Object.keys(watchlists);
  document.getElementById('wl-tabs').innerHTML=keys.map(id=>
    `<button class="btn btn-sm ${activeWL===id?'btn-p':''}" onclick="setActiveWL('${id}')">${watchlists[id].name} (${watchlists[id].bonds.length})</button>`
  ).join('');
  const cont=document.getElementById('wl-content');
  if(!keys.length){cont.innerHTML='<div class="empty"><div class="ei">⭐</div><p>Создайте список</p></div>';return}
  if(!activeWL||!watchlists[activeWL]){cont.innerHTML='<div class="empty"><div class="ei">👆</div><p>Выберите список выше</p></div>';return}
  const wl=watchlists[activeWL];
  cont.innerHTML=`<div style="display:flex;align-items:center;gap:9px;margin-bottom:10px">
    <span style="font-family:var(--serif);font-size:1.1rem;color:var(--acc)">${wl.name}</span>
    <span style="font-size:.61rem;color:var(--text3)">${wl.bonds.length} выпусков</span>
    <button class="btn btn-sm btn-d" onclick="delWL('${activeWL}')" style="margin-left:auto">Удалить список</button>
  </div>
  <div class="card"><div class="tbl-wrap"><table>
    <thead><tr><th>Название</th><th>Бумага</th><th>Купон</th><th>Цена</th><th>Купон/%</th><th>Лет</th><th>YTM</th><th>Заметка</th><th>Дата</th><th></th></tr></thead>
    <tbody>${wl.bonds.length?wl.bonds.map(b=>`<tr>
      <td style="font-weight:600">${b.name}</td>
      <td><span class="tag ${BT_TAG[b.btype]||'tag-corp'}">${b.btype||'—'}</span></td>
      <td><span class="tag ct-${b.ctype}" style="font-size:.54rem">${CT_LABELS[b.ctype]||'—'}</span></td>
      <td>${b.price!=null?b.price.toFixed(2)+'%':'—'}</td>
      <td>${b.coupon!=null?b.coupon.toFixed(2)+'%':'—'}</td>
      <td>${b.years!=null?b.years.toFixed(1)+' л.':'—'}</td>
      <td>${b.ytm!=null?`<span class="${ytmCls(b.ytm)}">${b.ytm.toFixed(2)}%</span>`:'—'}</td>
      <td style="color:var(--text2);font-size:.67rem;max-width:130px">${b.note||'—'}</td>
      <td style="color:var(--text3);font-size:.61rem">${new Date(b.addedAt).toLocaleDateString('ru')}</td>
      <td><button class="btn btn-sm btn-d" onclick="removeFromWL('${activeWL}',${b.id})">✕</button></td>
    </tr>`).join(''):'<tr><td colspan="10" style="text-align:center;color:var(--text3);padding:22px">Список пуст</td></tr>'}
    </tbody>
  </table></div></div>`;
}
function renderSbLists(){
  document.getElementById('sb-lists').innerHTML=Object.entries(watchlists).map(([id,wl])=>
    `<div class="sb-item" onclick="showPage('watchlist');setActiveWL('${id}')"><span class="sb-icon">⭐</span><span class="sb-list-name">${wl.name}</span><span class="sb-badge">${wl.bonds.length}</span></div>`
  ).join('');
}

// ══ P&L ══
function onPlCtype(){
  const t=document.getElementById('pl-ctype').value;
  const isF=t==='float';
  document.getElementById('pl-float-base-f').style.display=isF?'block':'none';
  document.getElementById('pl-float-spread-row').style.display=isF?'grid':'none';
  document.getElementById('pnl-float-strip').style.display=isF?'flex':'none';
  if(!isF)document.getElementById('pnl-step-ctrl').style.display='none';
  calcPnl();
}
function onPnlMode(){
  const step=document.querySelector('input[name="pnl-mode"]:checked')?.value==='step';
  document.getElementById('pnl-step-ctrl').style.display=step?'flex':'none';
  calcPnl();
}
function onTariff(){
  document.getElementById('pl-fee').disabled=document.getElementById('pl-tariff').value!=='custom';
  calcPnl();
}

function buildRateSched(from,to,months){
  const n=Math.max(1,Math.round(months/1.5));
  const drop=(from-to)/n;
  let r=from,m=0; const s=[];
  for(let i=0;i<n;i++){m+=1.5;r=Math.max(to,r-drop);s.push({month:m,rate:Math.round(r*2)/2})}
  return s;
}
function floaterCashStep(spread,base,nom,qty,days,from,to,months){
  const sched=buildRateSched(from,to,months);
  let total=0,prevM=0;
  sched.forEach(s=>{
    if(prevM*30>=days)return;
    const pd=(s.month-prevM)*30;
    const ad=Math.min(pd,days-prevM*30);
    const br=base==='RUONIA'?s.rate-.5:s.rate;
    total+=nom*qty*(br+spread)/100*(ad/365);
    prevM=s.month;
  });
  return total;
}

function calcPnl(){
  const buy=parseFloat(document.getElementById('pl-buy').value);
  const sell=parseFloat(document.getElementById('pl-sell').value);
  const ctype=document.getElementById('pl-ctype').value;
  const coupon=parseFloat(document.getElementById('pl-coupon').value)||0;
  const nom=parseFloat(document.getElementById('pl-nom').value)||1000;
  const qty=parseInt(document.getElementById('pl-qty').value)||1;
  const days=parseFloat(document.getElementById('pl-days').value);
  const nkdB=parseFloat(document.getElementById('pl-nkdb').value)||0;
  const nkdS=parseFloat(document.getElementById('pl-nkds').value)||0;
  const coupsRec=parseFloat(document.getElementById('pl-crec').value)||0;
  const acct=document.getElementById('pl-acct').value;
  const tariff=document.getElementById('pl-tariff').value;
  const feePct=(tariff==='custom'?parseFloat(document.getElementById('pl-fee').value)||0:parseFloat(tariff))/100;

  if(isNaN(buy)||buy<=0){
    document.getElementById('pnl-result').style.display='none';
    document.getElementById('pnl-ph').style.display='block';return;
  }
  const hasSell=!isNaN(sell)&&sell>0;
  const sellP=hasSell?sell:buy;
  const bA=buy/100*nom, sA=sellP/100*nom;
  const tB=(bA+nkdB)*qty, tS=(sA+nkdS)*qty;
  const fB=tB*feePct, fS=tS*feePct;
  const pGain=(sA-bA)*qty;
  const nkdD=(nkdS-nkdB)*qty;

  let effCoup=coupsRec;
  let stepNote='';
  const mode=document.querySelector('input[name="pnl-mode"]:checked')?.value||'simple';
  if(ctype==='float'&&mode==='step'&&!isNaN(days)&&days>0){
    const tgt=parseFloat(document.getElementById('pnl-rate-tgt').value)||10;
    const mo=parseFloat(document.getElementById('pnl-rate-mo').value)||18;
    const spread=parseFloat(document.getElementById('pl-fspread').value)||0;
    const base=document.getElementById('pl-fbase').value;
    effCoup=floaterCashStep(spread,base,nom,qty,days,RATE_NOW,tgt,mo);
    const sched=buildRateSched(RATE_NOW,tgt,mo);
    const finalR=sched[sched.length-1]?.rate||tgt;
    stepNote=`<div style="font-size:.64rem;color:var(--warn);margin:6px 0;padding:5px 9px;border:1px solid rgba(245,166,35,.2);background:rgba(245,166,35,.04)">
      📉 КС ${RATE_NOW}% → ${finalR}% за ${mo} мес. (${sched.length} заседаний) · Расч. купон: <strong>${rub(effCoup)}</strong></div>`;
  }

  let taxC=0,taxP=0;
  if(acct==='br'){taxC=effCoup*0.13;if(pGain+nkdD>0)taxP=(pGain+nkdD)*0.13}
  else if(acct==='ldb'){taxC=effCoup*0.13}
  const net=pGain+nkdD+effCoup-fB-fS-taxC-taxP;
  const inv=tB+fB;
  const proc=tS+effCoup-fS-taxC-taxP;
  const ann=!isNaN(days)&&days>0?(net/inv)*365/days*100:null;

  // Breakeven
  let bePct=buy;
  for(let i=0;i<800;i++){
    const sp=bePct/100*nom;
    const fsE=(sp+nkdS)*qty*feePct;
    const g=(sp-bA)*qty+nkdD;
    const tPE=acct==='br'&&g>0?g*0.13:0;
    const np=g+effCoup-fB-fsE-taxC-tPE;
    if(Math.abs(np)<0.05)break;
    bePct+=np>0?-0.05:0.05;
  }

  document.getElementById('pnl-result').style.display='block';
  document.getElementById('pnl-ph').style.display='none';
  const isP=net>0.5,isM=net<-0.5;
  document.getElementById('pnl-vbadge').textContent=isP?'▲ В плюсе':isM?'▼ В минусе':'≈ Безубыток';
  document.getElementById('pnl-vbadge').className='v-badge '+(isP?'vb-s':isM?'vb-d':'vb-w');
  document.getElementById('pnl-net').textContent=rub(net,true);
  document.getElementById('pnl-net').style.color=isP?'var(--green)':isM?'var(--danger)':'var(--warn)';
  document.getElementById('pnl-inv').textContent=rub(inv);
  document.getElementById('pnl-proc').textContent=rub(proc);
  const annEl=document.getElementById('pnl-ann');
  annEl.textContent=ann!=null?`${ann>=0?'+':''}${ann.toFixed(1)}% г.`:'—';
  annEl.className='val-big '+(ann==null?'val-neu':ann>=0?'val-pos':'val-neg');

  const bkRow=(l,v,c='')=>`<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid rgba(30,48,72,.4);font-size:.7rem"><span style="color:var(--text2)">${l}</span><span class="${c}">${v}</span></div>`;
  document.getElementById('pnl-bkdn').innerHTML=
    bkRow('Прибыль от цены',rub(pGain,true),pGain>=0?'val-pos':'val-neg')+
    bkRow('НКД дельта',rub(nkdD,true),nkdD>=0?'val-pos':'val-neg')+
    bkRow('Купоны / расч. доход',rub(effCoup,true),'val-pos')+
    bkRow('Комиссия (покупка)',rub(-fB),'val-neg')+
    bkRow('Комиссия (продажа)',rub(-fS),'val-neg')+
    bkRow('НДФЛ с купонов',taxC>0?rub(-taxC):acct!=='br'?'<span class="val-pos">Льгота ✓</span>':'—',taxC>0?'val-neg':'')+
    bkRow('НДФЛ с прибыли',taxP>0?rub(-taxP):acct!=='br'?'<span class="val-pos">Льгота ✓</span>':'—',taxP>0?'val-neg':'')+
    stepNote+
    `<div style="display:flex;justify-content:space-between;padding:8px 0;font-size:.77rem;font-weight:600"><span>Итого</span><span style="color:${isP?'var(--green)':isM?'var(--danger)':'var(--warn)'}">${rub(net,true)}</span></div>`;

  const lo=Math.min(buy,bePct)*.93, hi=Math.max(hasSell?sellP:buy,bePct)*1.07;
  const rng=hi-lo; const pos=p=>Math.min(100,Math.max(0,(p-lo)/rng*100))+'%';
  const beP=pos(bePct);
  document.getElementById('be-dz').style.cssText=`left:0;width:${beP}`;
  document.getElementById('be-sz').style.cssText=`left:${beP};width:${100-parseFloat(beP)}%`;
  document.getElementById('be-lb').style.left=pos(buy);
  document.getElementById('be-lbe').style.left=beP;
  if(hasSell){document.getElementById('be-ls').style.display='block';document.getElementById('be-ls').style.left=pos(sellP)}
  else document.getElementById('be-ls').style.display='none';
  document.getElementById('be-lo').textContent=lo.toFixed(1)+'%';
  document.getElementById('be-hi').textContent=hi.toFixed(1)+'%';
  document.getElementById('be-be-lbl').textContent=`БУ: ${bePct.toFixed(2)}%`;
  const diff=hasSell?sellP-bePct:0;
  document.getElementById('be-text').innerHTML=hasSell
    ?`БУ: <strong style="color:var(--warn)">${bePct.toFixed(2)}%</strong>. Продаёте по ${sellP.toFixed(2)}% — `+(diff>0?`<strong class="val-pos">+${diff.toFixed(2)}% выше ✓</strong>`:`<strong class="val-neg">${diff.toFixed(2)}% ниже ✗</strong>`)
    :`Точка БУ: <strong style="color:var(--warn)">${bePct.toFixed(2)}%</strong>. Продавайте выше этой цены.`;
}

// ══ ISSUER — 3 MODELS ══
function prefillIssuer(name){document.getElementById('is-bond').value=name}
function clearIssuer(){
  ['is-co','is-bond','is-purpose','is-ctx','is-rev','is-ebitda','is-ebit','is-np','is-int','is-tax',
   'is-assets','is-ca','is-cl','is-debt','is-cash','is-ret','is-eq','is-mkt','is-sz','is-peak','is-coup','is-yrs','is-rating']
  .forEach(id=>{const el=document.getElementById(id);if(el)el.value=''});
}

function normalCDF(x){
  const t=1/(1+.2316419*Math.abs(x));
  const p=t*(.319381530+t*(-.356563782+t*(1.781477937+t*(-1.821255978+t*1.330274429))));
  const phi=Math.exp(-x*x/2)/Math.sqrt(2*Math.PI);
  const c=1-phi*p; return x>=0?c:1-c;
}

// Model 1: Merton Distance-to-Default
function modelMerton(assets,debt,equity,mktcap){
  if(!assets||!debt||!equity)return null;
  const Va=mktcap||equity;
  if(Va<=0||debt<=0)return null;
  const sigA=.25, r=.10, T=1;
  const dd=(Math.log(Va/debt)+(r-.5*sigA*sigA)*T)/(sigA*Math.sqrt(T));
  const pd1=normalCDF(-dd)*100;
  const pd3=Math.min(1-(1-pd1/100)**3,0.99)*100;
  return{dd:dd.toFixed(2),pd1:pd1.toFixed(1),pd3:pd3.toFixed(1),
    note:'Proxy: балансовый капитал вместо рыночной стоимости активов. Точность выше при наличии рыночной кап-и.'};
}

// Model 2: Logit (калибровка по РФ рынку 2015-2024)
function modelLogit(dscr,ndE,cur,netMarg,industry){
  if(dscr==null&&ndE==null)return null;
  const b0=-2.5;
  const b1=dscr!=null?-0.8*dscr:0;
  const b2=ndE!=null?0.35*ndE:0;
  const b3=cur!=null?-0.4*cur:0;
  const b4=netMarg!=null?-3.0*netMarg:0;
  const adj={energy:-.4,metals:-.2,retail:.5,telecom:.1,finance:.3,realty:.6,transport:.3,agro:.2,other:.1}[industry]||0;
  const L=b0+b1+b2+b3+b4+adj;
  const pd1=1/(1+Math.exp(-L))*100;
  const pd3=Math.min(1-(1-pd1/100)**3,0.99)*100;
  return{L:L.toFixed(2),pd1:pd1.toFixed(1),pd3:pd3.toFixed(1),
    note:'Логистическая регрессия: DSCR, ND/EBITDA, ликвидность, рентабельность + отраслевая поправка по РФ.'};
}

// Model 3: Heuristic Scorecard
function modelHeuristic(dscr,ndE,cur,ib,peakLoad,netMarg,equity,assets,rating,industry){
  const nm=IND_NORMS[industry]||IND_NORMS.other;
  const items=[];
  const add=(name,val,gt,bt,inv,fmt)=>{
    if(val==null){items.push({name,val:null,s:null,fmt,norm:gt});return}
    const s=inv?(val<=gt?2:val<=bt?1:0):(val>=gt?2:val>=bt?1:0);
    items.push({name,val,s,fmt,norm:gt});
  };
  const f2=v=>v.toFixed(2)+'x', fp=v=>v.toFixed(1)+'%';
  add('DSCR',dscr,nm.dscr,1.2,false,f2);
  add('Чист. долг/EBITDA',ndE,nm.ndE,nm.ndE*1.6,true,f2);
  add('Тек. ликвидность',cur,nm.cur,0.8,false,f2);
  add('Обслуживание долга % EBITDA',ib,nm.ib,nm.ib*1.8,true,fp);
  add('Пиковая нагрузка % EBITDA',peakLoad,nm.ib*3,100,true,fp);
  add('Чистая маржа',netMarg,nm.marg,0,false,fp);
  if(equity&&assets)add('Капитал/Активы',equity/assets*100,30,10,false,fp);
  const RTMAP={'ruAAA':2,'ruAA':2,'ruA+':2,'ruA':1,'ruA-':1,'ruBBB+':1,'ruBBB':1,'ruBBB-':0,'ruBB':0,'ruB':-1,'ruCCC':-2};
  const rk=Object.keys(RTMAP).find(k=>rating&&rating.toUpperCase().includes(k.toUpperCase()));
  if(rk)items.push({name:'Кредитный рейтинг',val:rating,s:Math.max(0,RTMAP[rk]+1),fmt:v=>v,norm:'ruBBB'});
  const valid=items.filter(i=>i.s!=null);
  const tot=valid.reduce((a,b)=>a+b.s,0);
  const pct=valid.length?tot/(valid.length*2):0;
  const pd1=pct>=.75?2:pct>=.5?5:pct>=.3?12:25;
  const pd3=pct>=.75?6:pct>=.5?14:pct>=.3?30:55;
  return{items,pct,pd1,pd3,note:'8 метрик, нормы по отраслям РФ. Рейтинг учитывается как сигнал.'};
}

async function analyzeIssuer(){
  const g=id=>document.getElementById(id)?.value.trim()||'';
  const n=id=>{const v=parseFloat(document.getElementById(id)?.value);return isNaN(v)?null:v};

  const co=g('is-co')||'Не указано';
  const ind=g('is-ind');
  const rating=g('is-rating');
  const bond=g('is-bond')||'—';
  const purpose=g('is-purpose')||'не указано';
  const ctx=g('is-ctx');

  const rev=n('is-rev'),ebitda=n('is-ebitda'),ebit=n('is-ebit'),np=n('is-np'),intE=n('is-int');
  const assets=n('is-assets'),ca=n('is-ca'),cl=n('is-cl'),debt=n('is-debt');
  const cash=n('is-cash'),eq=n('is-eq'),mkt=n('is-mkt');
  const sz=n('is-sz'),peak=n('is-peak'),coup=n('is-coup'),yrs=n('is-yrs');

  const dscr=ebitda&&intE?ebitda/intE:null;
  const ndE=debt!=null&&cash!=null&&ebitda?(debt-cash)/ebitda:null;
  const cur=ca&&cl?ca/cl:null;
  const ib=intE&&ebitda?intE/ebitda*100:null;
  const peakLoad=peak&&ebitda?peak/ebitda*100:null;
  const netMarg=np&&rev?np/rev*100:null;

  const merton=modelMerton(assets,debt,eq,mkt);
  const logit=modelLogit(dscr,ndE,cur,netMarg!=null?netMarg/100:null,ind);
  const heur=modelHeuristic(dscr,ndE,cur,ib,peakLoad,netMarg,eq,assets,rating,ind);

  const pds1=[heur.pd1]; const pds3=[heur.pd3];
  if(merton){pds1.push(parseFloat(merton.pd1));pds3.push(parseFloat(merton.pd3))}
  if(logit){pds1.push(parseFloat(logit.pd1));pds3.push(parseFloat(logit.pd3))}
  const avg1=pds1.reduce((a,b)=>a+b,0)/pds1.length;
  const avg3=pds3.reduce((a,b)=>a+b,0)/pds3.length;
  const riskLbl=avg1<3?'Низкий риск':avg1<10?'Умеренный риск':'Высокий риск';
  const riskCls=avg1<3?'val-pos':avg1<10?'val-neu':'val-neg';
  const riskBdr=avg1<3?'var(--green)':avg1<10?'var(--warn)':'var(--danger)';

  const scHTML=heur.items.map(item=>{
    if(item.val==null)return`<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(30,48,72,.25);font-size:.68rem"><span style="color:var(--text2)">${item.name}</span><span style="color:var(--text3)">нет данных</span></div>`;
    const c=item.s>=2?'var(--green)':item.s>=1?'var(--warn)':'var(--danger)';
    const icon=['✗','◑','✓'][Math.min(item.s,2)];
    return`<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(30,48,72,.25);font-size:.68rem">
      <span style="color:var(--text2)">${item.name}</span>
      <span style="color:${c}">${icon} ${typeof item.val==='number'?item.fmt(item.val):item.val} <span style="color:var(--text3);font-size:.58rem">(норма: ${typeof item.norm==='number'?item.fmt(item.norm):item.norm})</span></span>
    </div>`;
  }).join('');

  document.getElementById('iss-res-tab').style.display='';
  swIssTab('result',document.getElementById('iss-res-tab'));
  document.getElementById('iss-res-content').innerHTML=`
  <div style="margin-top:14px">
    <div style="background:${avg1<3?'var(--green-dim)':avg1<10?'rgba(245,166,35,.07)':'var(--danger-dim)'};border:1px solid ${riskBdr};padding:14px 18px;margin-bottom:14px;display:flex;align-items:center;gap:20px;flex-wrap:wrap">
      <div>
        <div style="font-size:.54rem;letter-spacing:.14em;text-transform:uppercase;color:var(--text2);margin-bottom:3px">Консенсус ${pds1.length} моделей</div>
        <div style="font-family:var(--serif);font-size:1.35rem" class="${riskCls}">${riskLbl}</div>
        <div style="font-size:.63rem;color:var(--text2);margin-top:2px">${co} · ${IND_NAMES[ind]||ind}</div>
      </div>
      <div style="display:flex;gap:16px;margin-left:auto;flex-wrap:wrap">
        <div class="stat-card" style="padding:9px 14px;min-width:80px"><div class="sc-lbl">PD 1 год</div><div class="sc-val ${riskCls}">${avg1.toFixed(1)}%</div><div class="sc-sub">среднее моделей</div></div>
        <div class="stat-card" style="padding:9px 14px;min-width:80px"><div class="sc-lbl">PD 3 года</div><div class="sc-val ${avg3<8?'val-pos':avg3<20?'val-neu':'val-neg'}">${avg3.toFixed(1)}%</div></div>
        ${dscr!=null?`<div class="stat-card" style="padding:9px 14px;min-width:80px"><div class="sc-lbl">DSCR</div><div class="sc-val ${dscr>2?'val-pos':dscr>1.2?'val-neu':'val-neg'}">${dscr.toFixed(2)}x</div></div>`:''}
        ${ndE!=null?`<div class="stat-card" style="padding:9px 14px;min-width:80px"><div class="sc-lbl">ND/EBITDA</div><div class="sc-val ${ndE<2?'val-pos':ndE<4?'val-neu':'val-neg'}">${ndE.toFixed(2)}x</div></div>`:''}
        ${ib!=null?`<div class="stat-card" style="padding:9px 14px;min-width:80px"><div class="sc-lbl">Долг % EBITDA</div><div class="sc-val ${ib<20?'val-pos':ib<40?'val-neu':'val-neg'}">${ib.toFixed(1)}%</div></div>`:''}
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:11px;margin-bottom:14px">
      <div class="card" style="margin:0">
        <div class="card-hdr">📐 Merton / KMV</div>
        <div class="card-body" style="font-size:.71rem">
          ${merton?`<div style="display:flex;gap:14px;margin-bottom:8px">
            <div><div style="font-size:.54rem;color:var(--text3)">Distance-to-Default</div><div style="font-size:1.05rem;font-weight:600;color:${parseFloat(merton.dd)>1?'var(--green)':parseFloat(merton.dd)>0?'var(--warn)':'var(--danger)'}">${merton.dd}σ</div></div>
            <div><div style="font-size:.54rem;color:var(--text3)">PD 1г.</div><div style="font-size:1.05rem;font-weight:600" class="${parseFloat(merton.pd1)<3?'val-pos':parseFloat(merton.pd1)<10?'val-neu':'val-neg'}">${merton.pd1}%</div></div>
            <div><div style="font-size:.54rem;color:var(--text3)">PD 3г.</div><div style="font-size:1.05rem;font-weight:600" class="${parseFloat(merton.pd3)<8?'val-pos':parseFloat(merton.pd3)<20?'val-neu':'val-neg'}">${merton.pd3}%</div></div>
          </div><div style="color:var(--text3);font-size:.62rem;line-height:1.4">${merton.note}</div>`
          :`<div style="color:var(--text3)">Нужны: активы, долг, капитал</div>`}
        </div>
      </div>
      <div class="card" style="margin:0">
        <div class="card-hdr">📊 Logit РФ 2015–2024</div>
        <div class="card-body" style="font-size:.71rem">
          ${logit?`<div style="display:flex;gap:14px;margin-bottom:8px">
            <div><div style="font-size:.54rem;color:var(--text3)">Логит L</div><div style="font-size:1.05rem;font-weight:600;color:var(--text)">${logit.L}</div></div>
            <div><div style="font-size:.54rem;color:var(--text3)">PD 1г.</div><div style="font-size:1.05rem;font-weight:600" class="${parseFloat(logit.pd1)<3?'val-pos':parseFloat(logit.pd1)<10?'val-neu':'val-neg'}">${logit.pd1}%</div></div>
            <div><div style="font-size:.54rem;color:var(--text3)">PD 3г.</div><div style="font-size:1.05rem;font-weight:600" class="${parseFloat(logit.pd3)<8?'val-pos':parseFloat(logit.pd3)<20?'val-neu':'val-neg'}">${logit.pd3}%</div></div>
          </div><div style="color:var(--text3);font-size:.62rem;line-height:1.4">${logit.note}</div>`
          :`<div style="color:var(--text3)">Нужны: DSCR или ND/EBITDA</div>`}
        </div>
      </div>
      <div class="card" style="margin:0">
        <div class="card-hdr">🎯 Heuristic Scorecard</div>
        <div class="card-body" style="font-size:.71rem">
          <div style="display:flex;gap:14px;margin-bottom:8px">
            <div><div style="font-size:.54rem;color:var(--text3)">Балл</div><div style="font-size:1.05rem;font-weight:600;color:${heur.pct>=.65?'var(--green)':heur.pct>=.4?'var(--warn)':'var(--danger)'}">${Math.round(heur.pct*100)}%</div></div>
            <div><div style="font-size:.54rem;color:var(--text3)">PD 1г.</div><div style="font-size:1.05rem;font-weight:600" class="${heur.pd1<3?'val-pos':heur.pd1<10?'val-neu':'val-neg'}">${heur.pd1}%</div></div>
            <div><div style="font-size:.54rem;color:var(--text3)">PD 3г.</div><div style="font-size:1.05rem;font-weight:600" class="${heur.pd3<8?'val-pos':heur.pd3<20?'val-neu':'val-neg'}">${heur.pd3}%</div></div>
          </div>
          ${scHTML}
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-hdr">🤖 AI-анализ: интерпретация · отрасль · вердикт
        <span style="margin-left:auto;font-size:.57rem;color:var(--text3)" id="ai-key-hint"></span>
      </div>
      <div class="card-body">
        <div class="ai-panel" id="ai-panel-wrap">
          <div class="ai-loading" id="ai-load"><div class="ai-spin"></div>Интерпретирую результаты моделей...</div>
          <div class="ai-text" id="ai-out" style="display:none"></div>
        </div>
      </div>
    </div>
  </div>`;

  // ── Сначала показываем автономный развёрнутый вердикт ──
  const vData = buildDetailedVerdict({
    co, ind, rating, bond, purpose, ctx,
    rev, ebitda, ebit, np, intE, assets, ca, cl, debt, cash, eq, mkt,
    sz, peak, coup, yrs,
    dscr, ndE, cur, ib, peakLoad, netMarg,
    heur, avg1, avg3
  });

  // Строим HTML развёрнутого вердикта
  const secHTML = vData.sections.map(s=>{
    const sc = s.score;
    const bc = sc>=2?'var(--green)':sc>=1?'var(--warn)':'var(--danger)';
    const bg = sc>=2?'var(--green-dim)':sc>=1?'rgba(245,166,35,.06)':'var(--danger-dim)';
    return `<div style="padding:9px 12px;border-left:3px solid ${bc};background:${bg};margin-bottom:7px">
      <div style="font-size:.58rem;letter-spacing:.09em;text-transform:uppercase;color:${bc};margin-bottom:4px">${s.title}</div>
      <div style="font-size:.71rem;line-height:1.7;color:var(--text2)">${s.text}</div>
    </div>`;
  }).join('');

  const comboHTML = vData.combos.length ? `
    <div style="margin-bottom:12px">
      <div style="font-size:.57rem;letter-spacing:.1em;text-transform:uppercase;color:var(--text3);margin-bottom:7px">Комбинированные сигналы</div>
      ${vData.combos.map(c=>{
        const col = c.type==='good'?'var(--green)':c.type==='warn'?'var(--warn)':'var(--danger)';
        const ic  = c.type==='good'?'✓':c.type==='warn'?'⚠':'✗';
        return `<div style="font-size:.69rem;color:${col};padding:3px 0;border-bottom:1px solid rgba(30,48,72,.3)">${ic} ${c.text}</div>`;
      }).join('')}
    </div>` : '';

  const flagsHTML = vData.flags.length ? `
    <div style="padding:9px 12px;background:var(--danger-dim);border:1px solid var(--danger);margin-bottom:8px">
      <div style="font-size:.57rem;letter-spacing:.1em;text-transform:uppercase;color:var(--danger);margin-bottom:5px">🚨 Красные флаги</div>
      ${vData.flags.map(f=>`<div style="font-size:.69rem;color:var(--danger);padding:2px 0">✗ ${f}</div>`).join('')}
    </div>` : '';

  const plusHTML = vData.plus.length ? `
    <div style="padding:9px 12px;background:var(--green-dim);border:1px solid var(--green);margin-bottom:8px">
      <div style="font-size:.57rem;letter-spacing:.1em;text-transform:uppercase;color:var(--green);margin-bottom:5px">✓ Позитивные факторы</div>
      ${vData.plus.map(f=>`<div style="font-size:.69rem;color:var(--green);padding:2px 0">✓ ${f}</div>`).join('')}
    </div>` : '';

  const watchHTML = vData.watch.length ? `
    <div style="padding:9px 12px;background:rgba(245,166,35,.07);border:1px solid var(--warn);margin-bottom:8px">
      <div style="font-size:.57rem;letter-spacing:.1em;text-transform:uppercase;color:var(--warn);margin-bottom:5px">👁 На мониторинге</div>
      ${vData.watch.map(f=>`<div style="font-size:.69rem;color:var(--warn);padding:2px 0">⟳ ${f}</div>`).join('')}
    </div>` : '';

  const incompleteHTML = vData.incomplete ? `
    <div style="padding:7px 11px;background:var(--s2);border-left:2px solid var(--text3);font-size:.63rem;color:var(--text3);margin-bottom:8px;line-height:1.5">
      ⚠ Неполные данные (${vData.missingCritical.join(', ')} отсутствуют) — анализ частичный. Загрузите PDF отчётности для полного расчёта.
    </div>` : '';

  const verdictColor = vData.vClass==='val-pos'?'var(--green)':vData.vClass==='val-neu'?'var(--warn)':'var(--danger)';
  const verdictBg    = vData.vClass==='val-pos'?'var(--green-dim)':vData.vClass==='val-neu'?'rgba(245,166,35,.08)':'var(--danger-dim)';

  const autonomousHTML = `
    <div style="padding:13px 16px;background:${verdictBg};border:2px solid ${verdictColor};margin-bottom:12px;display:flex;align-items:center;gap:16px;flex-wrap:wrap">
      <div>
        <div style="font-size:.54rem;letter-spacing:.14em;text-transform:uppercase;color:var(--text3);margin-bottom:3px">Автономный вердикт · ${vData.sections.length} факторов</div>
        <div style="font-family:var(--serif);font-size:1.4rem;color:${verdictColor}">${vData.vIcon} ${vData.verdict}</div>
        <div style="font-size:.63rem;color:var(--text2);margin-top:2px">${vData.flags.length} красных флагов · ${vData.plus.length} позитивных факторов</div>
      </div>
      ${vData.ratingSection ? `<div style="font-size:.68rem;color:var(--text2);max-width:280px;line-height:1.5">${vData.ratingSection}</div>` : ''}
    </div>
    ${incompleteHTML}
    ${flagsHTML}${plusHTML}${watchHTML}
    <div style="font-size:.57rem;letter-spacing:.1em;text-transform:uppercase;color:var(--text3);margin:10px 0 7px">Детальный разбор показателей</div>
    ${secHTML}
    ${comboHTML}`;

  document.getElementById('ai-out').style.display = 'block';
  document.getElementById('ai-out').innerHTML = autonomousHTML;
  document.getElementById('ai-load').style.display = 'none';

  // ── Если есть API ключ — дополнительно запускаем AI ──
  const apiKey = localStorage.getItem('ba_apikey') || '';
  if(apiKey){
    document.getElementById('ai-key-hint').textContent = '+ AI углублённый анализ';
    document.getElementById('ai-load').style.display = 'flex';

    const mRes=[`Heuristic: балл=${Math.round(heur.pct*100)}%, PD_1y=${heur.pd1}%, PD_3y=${heur.pd3}%`];
    if(merton)mRes.push(`Merton/KMV: DD=${merton.dd}σ, PD_1y=${merton.pd1}%, PD_3y=${merton.pd3}%`);
    if(logit)mRes.push(`Logit (РФ): L=${logit.L}, PD_1y=${logit.pd1}%, PD_3y=${logit.pd3}%`);
    const mets=[];
    if(dscr!=null)mets.push(`DSCR: ${dscr.toFixed(2)}x`);
    if(ndE!=null)mets.push(`ND/EBITDA: ${ndE.toFixed(2)}x`);
    if(netMarg!=null)mets.push(`Маржа: ${netMarg.toFixed(1)}%`);
    if(rev)mets.push(`Выручка: ${rev} млрд`);
    if(ebitda)mets.push(`EBITDA: ${ebitda} млрд`);
    if(sz)mets.push(`Выпуск: ${sz} млрд`);

    const prompt=`Кредитный аналитик РФ. Кратко (3-4 абзаца): отраслевой контекст ${IND_NAMES[ind]||ind} при КС ${RATE_NOW}%, специфические риски, оценка цели выпуска («${purpose}»), итоговый вывод.
Компания: ${co} | Рейтинг: ${rating||'нет'} | Выпуск: ${bond}
${ctx?'Контекст: '+ctx:''}
Модели: ${mRes.join(', ')}
Метрики: ${mets.join(', ')}
Вердикт скоркарда: ${vData.verdict}. Красных флагов: ${vData.flags.length}.
Дополни анализ — не повторяй то что уже посчитано скоркардом.`;

    try{
      const resp=await fetch('https://api.anthropic.com/v1/messages',{
        method:'POST', headers:apiHeaders(),
        body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:900,messages:[{role:'user',content:prompt}]})
      });
      const data=await resp.json();
      const txt=data.content?.find(c=>c.type==='text')?.text||'';
      document.getElementById('ai-load').style.display='none';
      if(txt){
        const aiExtra = `<div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
          <div style="font-size:.57rem;letter-spacing:.1em;text-transform:uppercase;color:var(--acc);margin-bottom:8px">🤖 AI · Отраслевой контекст</div>
          <div style="font-size:.72rem;line-height:1.75;color:var(--text2)">`+
          txt.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/\n\n/g,'<br><br>').replace(/\n/g,'<br>')
          +`</div></div>`;
        document.getElementById('ai-out').innerHTML += aiExtra;
      }
    }catch(e){
      document.getElementById('ai-load').style.display='none';
    }
  } else {
    document.getElementById('ai-load').style.display='none';
    document.getElementById('ai-key-hint').innerHTML='<span style="color:var(--text3)">+ AI-контекст: введите ключ в поле выше</span>';
  }
}

// ══ ISSUER DATA SEARCH ══

// Синхронизировать поле поиска с названием компании
document.getElementById('is-co').addEventListener('input', function(){
  const sp = document.getElementById('sp-query');
  if(!sp.value || sp.value === sp.dataset.synced) {
    sp.value = this.value;
    sp.dataset.synced = this.value;
  }
});

function getSearchCompany(){
  return document.getElementById('sp-query').value.trim() ||
         document.getElementById('is-co').value.trim() || '';
}

// Разбор ответа AI: ищем числа по полям
function parseAiFieldValues(text, fieldHints){
  const results = {};
  for(const [fieldId, hints] of Object.entries(fieldHints)){
    for(const hint of hints){
      // Ищем паттерн: "Выручка: 1234.5" или "Выручка — 1 234,5 млрд"
      const re = new RegExp(hint + '[^\\d\\n]{0,40}([\\d][\\d\\s]{0,8}[\\d,\\.]+)', 'i');
      const m = text.match(re);
      if(m){
        const raw = m[1].replace(/\s/g,'').replace(',','.');
        const num = parseFloat(raw);
        if(!isNaN(num) && num > 0){ results[fieldId] = num; break; }
      }
    }
  }
  return results;
}

// Построчный поиск одного поля
async function searchSingleField(fieldId, fieldLabel){
  const co = getSearchCompany();
  if(!co){ alert('Введите название компании'); document.getElementById('is-co').focus(); return; }

  const btn = document.getElementById('spb-' + fieldId);
  if(btn){ btn.textContent = '⏳'; btn.classList.add('loading'); btn.disabled = true; }

  const statusEl = document.getElementById('sp-status');
  statusEl.style.display = 'block';
  statusEl.innerHTML += `<div class="sp-miss">⏳ Ищу: <strong>${fieldLabel}</strong> для «${co}»...</div>`;

  const bond = document.getElementById('is-bond').value.trim();
  const prompt = `Найди актуальное значение показателя "${fieldLabel}" для компании "${co}"${bond?' (выпуск: '+bond+')':''}.

Ищи в финансовой отчётности МСФО/РСБУ, раскрытие.рф, e-disclosure.ru, smart-lab.ru, cbonds.ru, rusbonds.ru, moex.com.

Верни ТОЛЬКО числовое значение в млрд рублей и источник в формате:
ЗНАЧЕНИЕ: [число в млрд руб]
ИСТОЧНИК: [откуда]
ПЕРИОД: [год/квартал]
ПРИМЕЧАНИЕ: [если данные неточные или косвенные]

Если данных нет — напиши: ЗНАЧЕНИЕ: нет данных`;

  try{
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST', headers:apiHeaders(),
      body: JSON.stringify({
        model:'claude-sonnet-4-20250514', max_tokens:400,
        tools:[{type:'web_search_20250305',name:'web_search'}],
        messages:[{role:'user',content:prompt}]
      })
    });
    const data = await resp.json();
    const fullText = (data.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');

    const valMatch = fullText.match(/ЗНАЧЕНИЕ:\s*([\d\.,]+)/i);
    const srcMatch = fullText.match(/ИСТОЧНИК:\s*(.+)/i);
    const perMatch = fullText.match(/ПЕРИОД:\s*(.+)/i);
    const noteMatch = fullText.match(/ПРИМЕЧАНИЕ:\s*(.+)/i);

    if(valMatch){
      const num = parseFloat(valMatch[1].replace(',','.'));
      if(!isNaN(num) && num > 0){
        document.getElementById(fieldId).value = num;
        const src = srcMatch?srcMatch[1].trim():'';
        const per = perMatch?perMatch[1].trim():'';
        const note = noteMatch?noteMatch[1].trim():'';
        statusEl.innerHTML += `<div class="sp-found">✓ <strong>${fieldLabel}</strong>: ${num} млрд ₽${per?' ('+per+')':''}${src?' · '+src:''}${note?' ⚠ '+note:''}</div>`;
        if(btn){btn.textContent='✓';btn.classList.remove('loading');btn.classList.add('found');}
      } else {
        statusEl.innerHTML += `<div class="sp-miss">✗ <strong>${fieldLabel}</strong>: данные не найдены</div>`;
        if(btn){btn.textContent='🔍';btn.classList.remove('loading');}
      }
    } else {
      statusEl.innerHTML += `<div class="sp-miss">✗ <strong>${fieldLabel}</strong>: данные не найдены</div>`;
      if(btn){btn.textContent='🔍';btn.classList.remove('loading');}
    }
  } catch(e){
    statusEl.innerHTML += `<div style="color:var(--danger)">⚠ Ошибка поиска: ${e.message}</div>`;
    if(btn){btn.textContent='🔍';btn.classList.remove('loading');}
  } finally {
    if(btn) btn.disabled = false;
  }
  statusEl.scrollTop = statusEl.scrollHeight;
}

// Полный поиск — ищет все пустые поля одним запросом
async function searchAllFields(){
  const co = getSearchCompany();
  if(!co){ alert('Введите название компании'); document.getElementById('is-co').focus(); return; }

  const btn = document.getElementById('sp-full-btn');
  btn.disabled = true; btn.textContent = '⏳ Ищу...';

  const statusEl = document.getElementById('sp-status');
  statusEl.style.display = 'block';
  statusEl.innerHTML = `<div style="color:var(--purple);margin-bottom:6px;font-size:.62rem;letter-spacing:.06em">▶ ПОЛНЫЙ ПОИСК · ${co}</div>`;

  // Собираем пустые поля
  const allFields = {
    'is-rev':    {label:'Выручка',          unit:'млрд ₽'},
    'is-ebitda': {label:'EBITDA',            unit:'млрд ₽'},
    'is-ebit':   {label:'EBIT',              unit:'млрд ₽'},
    'is-np':     {label:'Чистая прибыль',    unit:'млрд ₽'},
    'is-int':    {label:'Процентные расходы',unit:'млрд ₽'},
    'is-tax':    {label:'Налог на прибыль',  unit:'млрд ₽'},
    'is-assets': {label:'Совокупные активы', unit:'млрд ₽'},
    'is-ca':     {label:'Оборотные активы',  unit:'млрд ₽'},
    'is-cl':     {label:'Краткосрочные обязательства', unit:'млрд ₽'},
    'is-debt':   {label:'Совокупный долг',   unit:'млрд ₽'},
    'is-cash':   {label:'Денежные средства', unit:'млрд ₽'},
    'is-ret':    {label:'Нераспред. прибыль',unit:'млрд ₽'},
    'is-eq':     {label:'Собственный капитал',unit:'млрд ₽'},
    'is-mkt':    {label:'Рыночная капитализация',unit:'млрд ₽'},
    'is-sz':     {label:'Объём выпуска облигаций',unit:'млрд ₽'},
    'is-peak':   {label:'Пиковые долговые выплаты / год',unit:'млрд ₽'},
  };

  const emptyFields = Object.entries(allFields)
    .filter(([id])=>!document.getElementById(id)?.value)
    .map(([id,{label}])=>id+'='+label);

  const filledFields = Object.entries(allFields)
    .filter(([id])=>!!document.getElementById(id)?.value)
    .map(([id,{label}])=>`${label}: ${document.getElementById(id).value}`);

  if(!emptyFields.length){
    statusEl.innerHTML += `<div class="sp-found">✓ Все поля уже заполнены</div>`;
    btn.disabled = false; btn.textContent = '🔍 Полный поиск';
    return;
  }

  const bond = document.getElementById('is-bond').value.trim();
  const ind = document.getElementById('is-ind').value;
  const indName = document.querySelector('#is-ind option:checked')?.textContent || ind;
  const rating = document.getElementById('is-rating').value.trim();

  const prompt = `Ты — финансовый аналитик. Найди финансовые данные компании "${co}" для анализа облигаций.
${bond ? 'Выпуск: '+bond : ''}
Отрасль: ${indName}${rating?' · Рейтинг: '+rating:''}

${filledFields.length ? 'УЖЕ ИЗВЕСТНО:\n'+filledFields.join('\n')+'\n\n':''}НУЖНО НАЙТИ (все суммы в млрд рублей):
${emptyFields.map(f=>f.split('=')[1]).join(', ')}

Источники: МСФО/РСБУ отчётность, e-disclosure.ru, раскрытие.рф, cbonds.ru, smart-lab.ru, rusbonds.ru, официальный сайт компании.

Верни результат СТРОГО в формате (одна строка на показатель):
[ID_ПОЛЯ] | [ЗНАЧЕНИЕ число] | [ИСТОЧНИК] | [ПЕРИОД] | [УВЕРЕННОСТЬ: высокая/средняя/низкая]

ID полей: is-rev=Выручка, is-ebitda=EBITDA, is-ebit=EBIT, is-np=Чистая прибыль, is-int=Процентные расходы, is-tax=Налог, is-assets=Активы, is-ca=Оборотные активы, is-cl=Краткосрочные обяз., is-debt=Долг, is-cash=Денежные средства, is-ret=Нераспр. прибыль, is-eq=Капитал, is-mkt=Рыночная кап., is-sz=Объём выпуска, is-peak=Пиковые выплаты

Если данных нет — пропусти строку. После таблицы — краткая сноска о качестве найденных данных.`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST', headers:apiHeaders(),
      body: JSON.stringify({
        model:'claude-sonnet-4-20250514', max_tokens:1200,
        tools:[{type:'web_search_20250305',name:'web_search'}],
        messages:[{role:'user',content:prompt}]
      })
    });
    const data = await resp.json();
    const fullText = (data.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');

    let filled = 0, notFound = 0;
    const lines = fullText.split('\n');

    for(const line of lines){
      const parts = line.split('|').map(s=>s.trim());
      if(parts.length < 2) continue;
      const fieldId = parts[0].trim();
      if(!document.getElementById(fieldId)) continue;
      const numRaw = parts[1].replace(/[^\d\.,\-]/g,'').replace(',','.');
      const num = parseFloat(numRaw);
      if(isNaN(num) || num === 0) continue;
      if(document.getElementById(fieldId).value) continue; // не перезаписываем заполненные

      document.getElementById(fieldId).value = num;
      const src = parts[2]||'';
      const per = parts[3]||'';
      const conf = parts[4]||'';
      const label = allFields[fieldId]?.label || fieldId;
      const confColor = conf.includes('высок')?'var(--green)':conf.includes('средн')?'var(--warn)':'var(--text3)';
      statusEl.innerHTML += `<div><span class="sp-found">✓ <strong>${label}</strong>: ${num} млрд ₽</span>${per?' <span style="color:var(--text3)">'+per+'</span>':''} ${src?'<span style="color:var(--text3);font-size:.58rem">'+src+'</span>':''} ${conf?'<span style="color:'+confColor+';font-size:.56rem">'+conf+'</span>':''}</div>`;
      filled++;
    }

    // Вычленяем сноску (текст после последней строки с "|")
    const noteLines = lines.filter(l=>!l.includes('|') && l.trim().length > 20);
    if(noteLines.length){
      statusEl.innerHTML += `<div style="margin-top:8px;padding:7px 9px;background:var(--s2);border-left:2px solid var(--border2);font-size:.62rem;color:var(--text2);line-height:1.5">${noteLines.slice(0,3).join('<br>')}</div>`;
    }

    if(filled===0){
      statusEl.innerHTML += `<div class="sp-miss">Данные не найдены. Попробуйте уточнить название компании или поискать отдельные поля.</div>`;
    } else {
      statusEl.innerHTML += `<div style="margin-top:6px;font-size:.61rem;color:var(--text2)">Заполнено полей: <strong style="color:var(--green)">${filled}</strong> из ${emptyFields.length}</div>`;
    }
  } catch(e){
    statusEl.innerHTML += `<div style="color:var(--danger)">⚠ Ошибка API: ${e.message}</div>`;
  } finally {
    btn.disabled = false; btn.textContent = '🔍 Полный поиск';
  }
  statusEl.scrollTop = statusEl.scrollHeight;
}

// Поиск объёма выпуска с MOEX по ISIN облигации
async function searchVolumeFromMoex(){
  const bond = document.getElementById('is-bond').value.trim();
  const co = getSearchCompany();
  if(!bond && !co){ alert('Введите название выпуска или компании'); return; }

  const statusEl = document.getElementById('sp-status');
  statusEl.style.display = 'block';
  statusEl.innerHTML += `<div class="sp-miss">⏳ Ищу объём выпуска на MOEX...</div>`;

  try {
    const query = bond || co;
    const data = await moexFetch(`/iss/securities.json?q=${encodeURIComponent(query)}&limit=10&group_by=name`);
    const rows = data?.securities?.data || [];
    const cols = data?.securities?.columns || [];
    // Фильтруем облигации
    const typeIdx = cols.indexOf('TYPE') >= 0 ? cols.indexOf('TYPE') : cols.indexOf('group');
    const bonds = rows.filter(r => {
      const t = (r[typeIdx]||'').toLowerCase();
      return t.includes('bond') || t.includes('обл') || t === 'bond_corporate' || t === 'bond_govt';
    });
    const targets = bonds.length ? bonds : rows.slice(0,5);

    if(!targets.length){
      statusEl.innerHTML += `<div class="sp-miss">✗ Выпуск не найден на MOEX</div>`;
      return;
    }

    const secidIdx = cols.indexOf('secid');
    const nameIdx = cols.indexOf('name') >= 0 ? cols.indexOf('name') : 3;
    const isinIdx = cols.indexOf('isin') >= 0 ? cols.indexOf('isin') : 2;

    for(const row of targets.slice(0,3)){
      const secid = secidIdx >= 0 ? row[secidIdx] : row[0];
      const name = row[nameIdx] || secid;
      try {
        const desc = await moexFetch(`/iss/securities/${encodeURIComponent(secid)}.json`);
        const dMap = parseMoexDesc(desc);
        const faceVal = parseFloat(dMap['FACEVALUE']||'1000');
        const issueSz = parseFloat(dMap['ISSUESIZE']||'0');
        if(issueSz > 0 && faceVal > 0){
          const volBln = (issueSz * faceVal / 1e9);
          document.getElementById('is-sz').value = parseFloat(volBln.toFixed(3));
          const isin = dMap['ISIN'] || row[isinIdx] || '';
          const maturity = dMap['MATDATE'] || '';
          statusEl.innerHTML += `<div class="sp-found">✓ <strong>Объём выпуска</strong>: ${volBln.toFixed(2)} млрд ₽ · ${name}${isin?' · '+isin:''}${maturity?' · погаш. '+maturity:''} · MOEX</div>`;
          // Если есть купон — тоже заполним
          const couponPct = parseFloat(dMap['COUPONPERCENT']||'');
          if(!isNaN(couponPct) && couponPct > 0 && !document.getElementById('is-coup').value){
            document.getElementById('is-coup').value = couponPct;
            statusEl.innerHTML += `<div class="sp-found">✓ <strong>Купон</strong>: ${couponPct}% · MOEX</div>`;
          }
          const matDate = dMap['MATDATE'];
          if(matDate && !document.getElementById('is-yrs').value){
            const ms = new Date(matDate) - new Date();
            if(ms > 0){
              const yrs = parseFloat((ms/1000/60/60/24/365).toFixed(2));
              document.getElementById('is-yrs').value = yrs;
              statusEl.innerHTML += `<div class="sp-found">✓ <strong>Лет до погашения</strong>: ${yrs} · MOEX</div>`;
            }
          }
          break;
        }
      } catch(e){}
    }
  } catch(e){
    statusEl.innerHTML += `<div style="color:var(--danger)">⚠ MOEX ошибка: ${e.message}</div>`;
  }
  statusEl.scrollTop = statusEl.scrollHeight;
}

// ══ AUTONOMOUS DATA SEARCH (MOEX + CBR, no API key) ══

// Синхронизация поля ISIN с полем выпуска
document.getElementById('is-bond').addEventListener('input', function(){
  const sp = document.getElementById('sp-isin');
  if(!sp.value) sp.value = this.value;
});

// Автосаджест для поля поиска
let spIsinTimer = null;
function onSpIsinInput(){
  clearTimeout(spIsinTimer);
  const q = document.getElementById('sp-isin').value.trim();
  const sug = document.getElementById('sp-suggest');
  if(q.length < 2){ sug.style.display='none'; return; }
  spIsinTimer = setTimeout(async ()=>{
    sug.innerHTML='<div style="padding:6px 12px;font-size:.65rem;color:var(--text3)">Поиск...</div>';
    sug.style.display='block';
    try{
      const data = await moexFetch(`/iss/securities.json?q=${encodeURIComponent(q)}&limit=8&group_by=name`);
      const rows = data?.securities?.data||[];
      if(!rows.length){ sug.innerHTML='<div style="padding:6px 12px;font-size:.65rem;color:var(--text3)">Не найдено</div>'; return; }
      sug.innerHTML = rows.map(r=>{
        const secid=r[0], isin=r[2]||'', name=r[3]||secid;
        return `<div style="padding:6px 12px;cursor:pointer;font-size:.67rem;border-bottom:1px solid var(--border)"
          onmouseover="this.style.background='var(--s3)'" onmouseout="this.style.background=''"
          onclick="document.getElementById('sp-isin').value='${isin||secid}';document.getElementById('sp-suggest').style.display='none';fetchFromMoexFull('${secid}')">
          <strong style="color:var(--text)">${name}</strong>
          <span style="color:var(--text3);margin-left:7px;font-size:.6rem">${secid} ${isin}</span>
        </div>`;
      }).join('');
    }catch(e){ sug.style.display='none'; }
  }, 350);
}
document.addEventListener('click', e=>{
  const sug=document.getElementById('sp-suggest');
  if(sug && !sug.contains(e.target) && e.target.id!=='sp-isin') sug.style.display='none';
});

// ── Главная функция: загрузить всё с MOEX по ISIN ──
async function fetchFromMoexFull(secidOverride){
  const raw = document.getElementById('sp-isin').value.trim();
  const q = secidOverride || raw;
  if(!q){ alert('Введите ISIN или название выпуска'); return; }

  const btn = document.getElementById('sp-moex-btn');
  btn.disabled = true; btn.textContent = '⏳ Загружаю...';
  const statusEl = document.getElementById('sp-status');
  statusEl.style.display = 'block';
  statusEl.innerHTML = `<div style="color:var(--acc);font-size:.62rem;margin-bottom:5px">▶ MOEX ISS · ${q}</div>`;

  try {
    // 1. Resolve secid
    let secid = q;
    if(q.startsWith('RU') && q.length >= 12){
      const s = await moexFetch(`/iss/securities.json?q=${encodeURIComponent(q)}&limit=3`);
      const srows = s?.securities?.data||[];
      const scols = s?.securities?.columns||[];
      const sidIdx = scols.indexOf('secid');
      if(srows.length) secid = sidIdx>=0 ? srows[0][sidIdx] : srows[0][0];
    }

    // 2. Description (основные параметры выпуска)
    const desc = await moexFetch(`/iss/securities/${encodeURIComponent(secid)}.json`);
    const dMap = parseMoexDesc(desc);

    const name     = dMap['NAME'] || dMap['SHORTNAME'] || secid;
    const isin     = dMap['ISIN'] || q;
    const faceVal  = parseFloat(dMap['FACEVALUE']||'1000') || 1000;
    const issueSz  = parseFloat(dMap['ISSUESIZE']||'0');
    const couponPct= parseFloat(dMap['COUPONPERCENT']||'');
    const maturity = dMap['MATDATE'] || dMap['OFFERDATE'] || '';
    const listDate = dMap['LISTINGDATE'] || '';
    const emitCode = dMap['EMITENTID'] || '';
    const regNum   = dMap['REGNUMBER'] || '';

    // Заполняем поля выпуска
    const filled = [];
    if(!document.getElementById('is-bond').value && name){
      document.getElementById('is-bond').value = name;
      filled.push('Выпуск: ' + name);
    }
    if(issueSz > 0){
      const volBln = parseFloat((issueSz * faceVal / 1e9).toFixed(3));
      document.getElementById('is-sz').value = volBln;
      filled.push(`Объём выпуска: ${volBln} млрд ₽`);
    }
    if(!isNaN(couponPct) && couponPct >= 0 && !document.getElementById('is-coup').value){
      document.getElementById('is-coup').value = couponPct;
      filled.push(`Купон: ${couponPct}%`);
    }
    if(maturity && !document.getElementById('is-yrs').value){
      const ms = new Date(maturity) - new Date();
      if(ms > 0){
        const yrs = parseFloat((ms/1000/60/60/24/365).toFixed(2));
        document.getElementById('is-yrs').value = yrs;
        filled.push(`Лет до погашения: ${yrs} (погашение ${maturity})`);
      }
    }

    // 3. Текущая цена и YTM от MOEX
    try{
      const mkt = await moexFetch(`/iss/engines/stock/markets/bonds/securities/${encodeURIComponent(secid)}.json`);
      const price = parseMoexPrice(mkt);
      // YTM из MOEX
      const ycols = mkt?.yields?.columns||[];
      const ydata = mkt?.yields?.data||[];
      const ytmIdx = ycols.indexOf('yield');
      const moexYtm = (ydata.length && ytmIdx>=0) ? ydata[0][ytmIdx] : null;
      if(price) filled.push(`Текущая цена: ${price.toFixed(2)}%`);
      if(moexYtm) filled.push(`YTM (MOEX): ${parseFloat(moexYtm).toFixed(2)}%`);
    }catch(e){}

    // 4. График купонов и амортизации (bondization)
    try{
      const bz = await moexFetch(`/iss/securities/${encodeURIComponent(secid)}/bondization.json`);
      const cpCols = bz?.coupons?.columns||[];
      const cpData = bz?.coupons?.data||[];
      const amCols = bz?.amortizations?.columns||[];
      const amData = bz?.amortizations?.data||[];

      if(cpData.length){
        const cpDateIdx = cpCols.indexOf('coupondate');
        const cpValIdx  = cpCols.indexOf('value');
        const cpRateIdx = cpCols.indexOf('valueprc');
        const now = new Date();
        const futureCoupons = cpData.filter(r => r[cpDateIdx] && new Date(r[cpDateIdx]) > now);
        const annualCoupon  = futureCoupons.slice(0,2).reduce((s,r)=>s+(parseFloat(r[cpValIdx])||0),0);
        if(annualCoupon > 0 && issueSz > 0){
          const totalAnnual = annualCoupon * issueSz / 1e9;
          if(!document.getElementById('is-peak').value){
            document.getElementById('is-peak').value = parseFloat(totalAnnual.toFixed(3));
            filled.push(`Купонные выплаты/год (расчёт): ${totalAnnual.toFixed(2)} млрд ₽`);
          }
        }
        filled.push(`Купонных выплат впереди: ${futureCoupons.length}`);
      }

      if(amData.length){
        const amDateIdx = amCols.indexOf('amortdate');
        const amValIdx  = amCols.indexOf('value');
        const now = new Date();
        const futureAm = amData.filter(r => r[amDateIdx] && new Date(r[amDateIdx]) > now);
        if(futureAm.length) filled.push(`Платежей амортизации впереди: ${futureAm.length}`);
      }
    }catch(e){}

    // 5. Все выпуски эмитента (через emitCode или поиск по имени)
    let allBonds = [];
    if(emitCode){
      try{
        const issBonds = await moexFetch(`/iss/issuers/${encodeURIComponent(emitCode)}/securities.json?iss.meta=off&limit=50`);
        const ibCols = issBonds?.securities?.columns||[];
        const ibData = issBonds?.securities?.data||[];
        const ibFVIdx  = ibCols.indexOf('facevalue');
        const ibSZIdx  = ibCols.indexOf('issuesize');
        const ibNmIdx  = ibCols.indexOf('shortname') >= 0 ? ibCols.indexOf('shortname') : ibCols.indexOf('name');
        const ibMtIdx  = ibCols.indexOf('matdate');
        const ibCpIdx  = ibCols.indexOf('couponpercent');
        allBonds = ibData.map(r=>({
          name: r[ibNmIdx]||'',
          fv: parseFloat(r[ibFVIdx]||'1000')||1000,
          sz: parseFloat(r[ibSZIdx]||'0'),
          mat: r[ibMtIdx]||'',
          cp: parseFloat(r[ibCpIdx]||'0')
        })).filter(b=>b.sz>0);

        if(allBonds.length > 0){
          // Считаем суммарный долг по рыночным выпускам
          const totalDebtBln = allBonds.reduce((s,b)=>s + b.sz*b.fv/1e9, 0);
          filled.push(`Выпусков облигаций эмитента: ${allBonds.length} · суммарно ~${totalDebtBln.toFixed(1)} млрд ₽`);

          // Пик погашений: ближайший год
          const now = new Date();
          const nextYear = new Date(now); nextYear.setFullYear(nextYear.getFullYear()+1);
          const peakNext = allBonds.filter(b=>b.mat && new Date(b.mat)>now && new Date(b.mat)<=nextYear)
                                   .reduce((s,b)=>s + b.sz*b.fv/1e9, 0);
          if(peakNext > 0 && !document.getElementById('is-peak').value){
            document.getElementById('is-peak').value = parseFloat(peakNext.toFixed(2));
            filled.push(`Погашений в ближайший год: ${peakNext.toFixed(2)} млрд ₽ (из реестра MOEX)`);
          }
        }
      }catch(e){}
    }

    // 6. Рейтинг из MOEX (если есть)
    if(!document.getElementById('is-rating').value){
      try{
        const rt = await moexFetch(`/iss/statistics/engines/stock/markets/bonds/ratings.json?iss.meta=off&q=${encodeURIComponent(name.split(' ')[0])}&limit=5`);
        const rtCols = rt?.ratings?.columns||[];
        const rtData = rt?.ratings?.data||[];
        const rtNmIdx  = rtCols.indexOf('rating_agency');
        const rtValIdx = rtCols.indexOf('rating');
        const rtSecIdx = rtCols.indexOf('issuer_name') >= 0 ? rtCols.indexOf('issuer_name') : rtCols.indexOf('short_name');
        if(rtData.length && rtValIdx>=0){
          const ratingVal = rtData[0][rtValIdx];
          const agency    = rtNmIdx>=0 ? rtData[0][rtNmIdx] : '';
          if(ratingVal){
            document.getElementById('is-rating').value = ratingVal;
            filled.push(`Рейтинг: ${ratingVal}${agency?' ('+agency+')':''} · MOEX`);
          }
        }
      }catch(e){}
    }

    // Вывод результата
    statusEl.innerHTML = `<div style="color:var(--acc);font-size:.62rem;margin-bottom:6px">▶ MOEX · ${name} · ${isin}</div>`;
    if(filled.length){
      filled.forEach(f => {
        statusEl.innerHTML += `<div class="sp-found">✓ ${f}</div>`;
      });
    } else {
      statusEl.innerHTML += `<div class="sp-miss">Данных не найдено — проверьте ISIN</div>`;
    }

    // Подсказка что ещё нужно
    const stillEmpty = ['is-rev','is-ebitda','is-ebit','is-np','is-int','is-assets','is-eq','is-debt','is-cash']
      .filter(id => !document.getElementById(id).value);
    if(stillEmpty.length){
      statusEl.innerHTML += `<div style="margin-top:7px;padding:6px 9px;background:var(--s2);border-left:2px solid var(--warn);font-size:.61rem;color:var(--text2);line-height:1.6">
        ⚠ Финансовые показатели (выручка, EBITDA, долг и др.) MOEX не раскрывает — загрузите PDF отчётности эмитента выше.<br>
        Источники: <strong>e-disclosure.ru</strong> → поиск по названию → последняя МСФО/РСБУ
      </div>`;
    }

  } catch(e){
    statusEl.innerHTML += `<div style="color:var(--danger)">⚠ Ошибка MOEX: ${e.message}</div>`;
  } finally {
    btn.disabled = false; btn.textContent = '📊 Загрузить с MOEX';
  }
  statusEl.scrollTop = statusEl.scrollHeight;
}

// ── Получить ключевую ставку из ЦБ РФ ──
async function fetchCbrRate(){
  const statusEl = document.getElementById('sp-status');
  statusEl.style.display = 'block';
  statusEl.innerHTML += `<div class="sp-miss">⏳ Запрос к ЦБ РФ...</div>`;
  try{
    // ЦБ XML API - открыт для CORS
    const today = new Date();
    const from  = new Date(today); from.setMonth(from.getMonth()-2);
    const fmt   = d => `${d.getDate().toString().padStart(2,'0')}/${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getFullYear()}`;
    const url   = `https://www.cbr.ru/DailyInfoWebServ/DailyInfo.asmx/KeyRate?fromDate=${from.toISOString().split('T')[0]}&ToDate=${today.toISOString().split('T')[0]}`;
    const resp  = await fetch(url);
    if(!resp.ok) throw new Error('HTTP '+resp.status);
    const txt   = await resp.text();
    // Парсим XML
    const parser = new DOMParser();
    const xml    = parser.parseFromString(txt, 'text/xml');
    const rows   = xml.querySelectorAll('KR');
    if(rows.length){
      const last  = rows[rows.length-1];
      const rate  = last.querySelector('Rate')?.textContent;
      const dt    = last.querySelector('DT')?.textContent?.split('T')[0];
      if(rate){
        const rateNum = parseFloat(rate);
        // Обновляем глобальную КС в приложении
        document.querySelector('.ks-badge').textContent = `КС: ${rateNum.toFixed(2)}%`;
        statusEl.innerHTML += `<div class="sp-found">✓ Ключевая ставка ЦБ РФ: <strong>${rateNum}%</strong>${dt?' · с '+dt:''}</div>`;
      }
    }
  }catch(e){
    // Если CORS всё же блокирует — объясняем
    statusEl.innerHTML += `<div class="sp-miss">⚠ ЦБ РФ недоступен из браузера (CORS). КС обновляйте вручную.</div>`;
  }
}

// Кнопки построчного поиска — теперь показывают подсказку про PDF
async function searchSingleField(fieldId, fieldLabel){
  const statusEl = document.getElementById('sp-status');
  statusEl.style.display = 'block';
  statusEl.innerHTML += `<div style="padding:6px 9px;background:var(--s2);border-left:2px solid var(--acc2);font-size:.62rem;color:var(--text2);margin-top:4px;line-height:1.6">
    <strong style="color:var(--acc2)">📋 ${fieldLabel}</strong><br>
    Этот показатель не доступен через MOEX.<br>
    Источники для ручного поиска:<br>
    · <strong>e-disclosure.ru</strong> → компания → МСФО/РСБУ → последний отчёт → загрузить PDF выше<br>
    · <strong>Годовой отчёт</strong> на сайте эмитента<br>
    · <strong>smart-lab.ru/q/shares/</strong> → мультипликаторы (для публичных)
  </div>`;
  statusEl.scrollTop = statusEl.scrollHeight;
}

// Убираем старые AI-зависимые функции
async function searchAllFields(){ /* deprecated - replaced by fetchFromMoexFull */ }
async function searchVolumeFromMoex(){ fetchFromMoexFull(); }

// ══ РАСШИРЕННЫЙ АВТОНОМНЫЙ SCORECARD ══
// Генерирует детальные текстовые выводы без AI

function buildDetailedVerdict(data){
  const {co, ind, rating, bond, purpose, ctx,
         rev, ebitda, ebit, np, intE, assets, ca, cl, debt, cash, eq, mkt,
         sz, peak, coup, yrs,
         dscr, ndE, cur, ib, peakLoad, netMarg,
         heur, avg1, avg3} = data;

  const nm = IND_NORMS[ind] || IND_NORMS.other;
  const indName = IND_NAMES[ind] || ind;
  const flags = [];   // красные флаги
  const plus  = [];   // позитивные факторы
  const watch = [];   // на мониторинг

  // ── Анализ каждого показателя с контекстом ──
  const sections = [];

  // 1. DSCR
  if(dscr !== null){
    let txt = `<strong>DSCR ${dscr.toFixed(2)}x</strong> (норма для ${indName}: >${nm.dscr}x). `;
    if(dscr >= nm.dscr){ txt += `Компания генерирует достаточно операционной прибыли для обслуживания долга. `; plus.push('DSCR выше нормы') }
    else if(dscr >= 1.5){ txt += `Запас прочности умеренный — повышение ставок или падение EBITDA на ${((dscr-1)/dscr*100).toFixed(0)}% приведёт к проблемам. `; watch.push('DSCR приближается к 1.5x') }
    else if(dscr >= 1.0){ txt += `<span style="color:var(--warn)">Низкий запас: прибыль лишь на ${((dscr-1)*100).toFixed(0)}% превышает процентные выплаты.</span> `; flags.push('DSCR < 1.5x') }
    else { txt += `<span style="color:var(--danger)">КРИТИЧНО: прибыль не покрывает проценты (DSCR < 1x). Высокий риск дефолта.</span> `; flags.push('DSCR < 1x — не покрывает проценты') }
    sections.push({title:'Покрытие долга (DSCR)', text:txt, score:dscr>=nm.dscr?2:dscr>=1.5?1:0});
  }

  // 2. ND/EBITDA
  if(ndE !== null){
    let txt = `<strong>ND/EBITDA ${ndE.toFixed(2)}x</strong> (норма для ${indName}: <${nm.ndE}x). `;
    if(ndE < 0){ txt += `Чистый долг отрицательный — денежная позиция превышает долг. Исключительно низкий финансовый риск. `; plus.push('Отрицательный чистый долг') }
    else if(ndE <= nm.ndE){ txt += `Умеренная долговая нагрузка. При текущей EBITDA долг будет погашен за ${ndE.toFixed(1)} лет. `; plus.push('Долговая нагрузка в норме') }
    else if(ndE <= nm.ndE * 1.5){ txt += `Нагрузка выше нормы. Следите за динамикой — рост означает ухудшение. `; watch.push('ND/EBITDA выше нормы') }
    else { txt += `<span style="color:var(--danger)">Высокая нагрузка. При ND/EBITDA >${nm.ndE*1.5}x рейтинговые агентства переходят в спекулятивную зону.</span> `; flags.push(`ND/EBITDA = ${ndE.toFixed(1)}x — критично`) }
    sections.push({title:'Долговая нагрузка (ND/EBITDA)', text:txt, score:ndE<=nm.ndE?2:ndE<=nm.ndE*1.5?1:0});
  }

  // 3. Ликвидность
  if(cur !== null){
    let txt = `<strong>Current Ratio ${cur.toFixed(2)}x</strong> (норма: >${nm.cur}x). `;
    if(cur >= nm.cur){ txt += `Оборотных активов достаточно для покрытия краткосрочных обязательств. `; plus.push('Ликвидность в норме') }
    else if(cur >= 1.0){ txt += `Ликвидность минимально допустимая — небольшой кассовый разрыв создаст проблему. `; watch.push('Current ratio ниже отраслевой нормы') }
    else { txt += `<span style="color:var(--danger)">Краткосрочных обязательств больше чем ликвидных активов. Риск технического дефолта.</span> `; flags.push('Current Ratio < 1x') }
    sections.push({title:'Текущая ликвидность', text:txt, score:cur>=nm.cur?2:cur>=1?1:0});
  }

  // 4. Маржинальность
  if(netMarg !== null){
    let txt = `<strong>Чистая маржа ${netMarg.toFixed(1)}%</strong> (норма для ${indName}: >${nm.marg}%). `;
    if(netMarg >= nm.marg){ txt += `Рентабельность выше отраслевой нормы. `; plus.push('Рентабельность выше нормы') }
    else if(netMarg >= 0){ txt += `Компания прибыльна, но маржа ниже нормы. Высокое КС (${RATE_NOW}%) создаёт давление. `; watch.push('Маржа ниже нормы') }
    else { txt += `<span style="color:var(--danger)">Убыточность. Компания сжигает капитал.</span> `; flags.push('Отрицательная чистая маржа') }
    sections.push({title:'Рентабельность', text:txt, score:netMarg>=nm.marg?2:netMarg>=0?1:0});
  }

  // 5. Объём выпуска vs EBITDA
  if(sz && ebitda){
    const ratio = sz / ebitda;
    let txt = `<strong>Объём выпуска / EBITDA = ${ratio.toFixed(2)}x</strong>. `;
    if(ratio <= 0.5){ txt += `Размер выпуска небольшой относительно прибыли — низкий риск рефинансирования. `; plus.push('Небольшой размер выпуска') }
    else if(ratio <= 1.0){ txt += `Умеренно. Компания может погасить выпуск из ~${ratio.toFixed(1)} лет EBITDA. `; }
    else if(ratio <= 2.0){ txt += `Выпуск крупный — потребует рефинансирования или нескольких лет EBITDA. `; watch.push('Крупный выпуск — рефинансирование под вопросом') }
    else { txt += `<span style="color:var(--danger)">Выпуск превышает 2x EBITDA — высокий риск рефинансирования при росте ставок.</span> `; flags.push('Выпуск > 2x EBITDA') }
    sections.push({title:'Размер выпуска', text:txt, score:ratio<=0.5?2:ratio<=1?1:0});
  }

  // 6. Капитальная структура
  if(eq && assets){
    const eqRatio = eq / assets * 100;
    let txt = `<strong>Equity Ratio ${eqRatio.toFixed(1)}%</strong>. `;
    if(ind === 'finance'){ txt += `Для финансовых компаний норма — 5–15%. `; }
    else if(eqRatio >= 40){ txt += `Высокая финансовая независимость — кредиторы в безопасности. `; plus.push('Высокая доля собственного капитала') }
    else if(eqRatio >= 20){ txt += `Умеренный леверидж — приемлемо. `; }
    else if(eqRatio >= 10){ txt += `Низкая доля капитала — почти весь бизнес на заёмные деньги. `; watch.push('Низкий Equity Ratio') }
    else { txt += `<span style="color:var(--danger)">Критически низкий капитал. Любое обесценение активов обнулит его.</span> `; flags.push('Equity Ratio < 10%') }
    sections.push({title:'Структура капитала', text:txt, score:eqRatio>=40?2:eqRatio>=20?1:0});
  }

  // 7. Процентная нагрузка
  if(ib !== null){
    let txt = `<strong>Процентные расходы / EBITDA = ${ib.toFixed(1)}%</strong> (норма: <${nm.ib}%). `;
    if(ib <= nm.ib){ txt += `При КС ${RATE_NOW}% нагрузка приемлема. `; plus.push('Процентная нагрузка в норме') }
    else if(ib <= nm.ib * 1.8){ txt += `Нагрузка выше нормы. Повышение ставок ещё на 2–3% будет болезненным. `; watch.push('Процентная нагрузка выше нормы') }
    else { txt += `<span style="color:var(--danger)">Процентные расходы съедают критическую долю EBITDA.</span> `; flags.push(`Процентная нагрузка ${ib.toFixed(0)}% EBITDA`) }
    sections.push({title:'Процентная нагрузка', text:txt, score:ib<=nm.ib?2:ib<=nm.ib*1.8?1:0});
  }

  // 8. Пиковые выплаты
  if(peakLoad !== null && ebitda){
    let txt = `<strong>Пиковые выплаты / EBITDA = ${peakLoad.toFixed(1)}%</strong>. `;
    if(peakLoad <= 30){ txt += `Пиковые погашения посильны из текущей прибыли. `; plus.push('Пиковые выплаты управляемы') }
    else if(peakLoad <= 60){ txt += `В год пиковых выплат потребуется существенная часть EBITDA или рефинансирование. `; watch.push('Значительные пиковые выплаты') }
    else { txt += `<span style="color:var(--danger)">Пиковые выплаты превышают половину EBITDA — высокий риск рефинансирования.</span> `; flags.push(`Пиковые выплаты ${peakLoad.toFixed(0)}% EBITDA`) }
    sections.push({title:'Пиковые погашения', text:txt, score:peakLoad<=30?2:peakLoad<=60?1:0});
  }

  // 9. Анализ комбинаций (сигналы)
  const combos = [];
  if(dscr !== null && ndE !== null){
    if(dscr < 1.5 && ndE > nm.ndE) combos.push({type:'danger', text:'DSCR низкий + высокий ND/EBITDA → двойной сигнал долговой перегрузки'});
    if(dscr > nm.dscr && ndE < nm.ndE) combos.push({type:'good', text:'DSCR в норме + ND/EBITDA в норме → сбалансированная долговая позиция'});
  }
  if(cur !== null && cl && debt){
    if(cur < 1.0 && debt > 0) combos.push({type:'danger', text:'Current Ratio < 1x при наличии долга → риск кассового разрыва в ближайшие 12 мес.'});
  }
  if(netMarg !== null && ndE !== null){
    if(netMarg < 0 && ndE > 3) combos.push({type:'danger', text:'Убыточность + высокий долг → нарастающая спираль'});
    if(netMarg > nm.marg && ndE < nm.ndE) combos.push({type:'good', text:'Высокая маржа + низкий долг → сильная кредитная позиция'});
  }
  if(sz && ebitda && dscr !== null){
    if(sz / ebitda > 1.5 && dscr < 2) combos.push({type:'warn', text:'Крупный выпуск + невысокий DSCR → рефинансирование потребует благоприятной рыночной конъюнктуры'});
  }

  // 10. Рейтинговая оценка
  let ratingSection = '';
  if(rating){
    const RTMAP = {'AAA':0.5,'AA':1,'A+':1.5,'A':2,'A-':2.5,'BBB+':3,'BBB':4,'BBB-':5,'BB+':7,'BB':9,'BB-':12,'B+':15,'B':20,'B-':25,'CCC':40};
    const rKey = Object.keys(RTMAP).find(k => rating.toUpperCase().replace('RU','').includes(k));
    const rPD = rKey ? RTMAP[rKey] : null;
    if(rPD !== null){
      ratingSection = `Рейтинг <strong>${rating}</strong> соответствует историческому PD ~${rPD}% годовых по российским данным. `;
      if(rPD < 3) plus.push('Инвестиционный рейтинг');
      else if(rPD >= 15) flags.push('Спекулятивный рейтинг B и ниже');
    }
  }

  // 11. Итоговый вердикт
  const pct = heur?.pct || 0;
  let verdict, vClass, vIcon;
  if(flags.length === 0 && avg1 < 5){ verdict='ПОКУПАТЬ'; vClass='val-pos'; vIcon='✓'; }
  else if(flags.length <= 1 && avg1 < 12){ verdict='ДЕРЖАТЬ'; vClass='val-neu'; vIcon='⟳'; }
  else { verdict='ИЗБЕГАТЬ'; vClass='val-neg'; vIcon='✗'; }

  // Неполные данные
  const missingCritical = [];
  if(!ebitda) missingCritical.push('EBITDA');
  if(!debt) missingCritical.push('Долг');
  if(!rev) missingCritical.push('Выручка');
  const incomplete = missingCritical.length > 0;

  return {sections, combos, flags, plus, watch, verdict, vClass, vIcon, ratingSection, incomplete, missingCritical};
}

// ══ MOEX lookup for YTM form ══
let ytmIsinTimer=null;
function onYtmIsinInput(){
  clearTimeout(ytmIsinTimer);
  const q=document.getElementById('yf-isin').value.trim();
  const sug=document.getElementById('yf-suggest');
  if(q.length<2){sug.style.display='none';return}
  ytmIsinTimer=setTimeout(async()=>{
    sug.innerHTML='<div style="padding:8px 12px;font-size:.67rem;color:var(--text3)">Поиск...</div>';
    sug.style.display='block';
    try{
      const data=await moexFetch(`/iss/securities.json?q=${encodeURIComponent(q)}&limit=7`);
      const rows=data?.securities?.data||[];
      if(!rows.length){sug.innerHTML='<div style="padding:8px 12px;font-size:.67rem;color:var(--text3)">Не найдено</div>';return}
      sug.innerHTML=rows.map(r=>{
        const secid=r[0],isin=r[2]||'',name=r[3]||secid;
        return`<div style="padding:7px 12px;cursor:pointer;font-size:.68rem;border-bottom:1px solid var(--border)"
          onmouseover="this.style.background='var(--s3)'" onmouseout="this.style.background=''"
          onclick="selectYtmSuggest('${secid}','${isin}','${name.replace(/'/g,"\\'")}')">
          <strong style="color:var(--text)">${name}</strong>
          <span style="color:var(--text3);margin-left:8px">${secid}</span>
          <span style="color:var(--text3);margin-left:6px;font-size:.6rem">${isin}</span>
        </div>`;
      }).join('');
    }catch(e){sug.style.display='none'}
  },400);
}
function selectYtmSuggest(secid,isin,name){
  document.getElementById('yf-isin').value=isin||secid;
  document.getElementById('yf-suggest').style.display='none';
  lookupYtmIsin(secid);
}
async function lookupYtmIsin(secidOverride){
  const raw=document.getElementById('yf-isin').value.trim();
  if(!raw&&!secidOverride)return;
  const q=secidOverride||raw;
  document.getElementById('yf-lookup-btn').style.display='none';
  document.getElementById('yf-load').style.display='flex';
  document.getElementById('yf-moex-status').textContent='Запрос к MOEX...';
  try{
    let secid=q;
    if(q.startsWith('RU')&&q.length>=12){
      const s=await moexFetch(`/iss/securities.json?q=${encodeURIComponent(q)}&limit=3`);
      const scols=s?.securities?.columns||[];
      const srows=s?.securities?.data||[];
      const sidIdx=scols.indexOf('secid');
      if(srows.length) secid=sidIdx>=0?srows[0][sidIdx]:srows[0][0];
    }
    const desc=await moexFetch(`/iss/securities/${encodeURIComponent(secid)}.json`);
    const dMap=parseMoexDesc(desc);
    let curPrice=null;
    try{
      const mkt=await moexFetch(`/iss/engines/stock/markets/bonds/securities/${encodeURIComponent(secid)}.json`);
      curPrice=parseMoexPrice(mkt);
    }catch(e){}
    const name=dMap['NAME']||dMap['SHORTNAME']||secid;
    const couponRaw=parseFloat(dMap['COUPONPERCENT']||'');
    const maturity=dMap['MATDATE']||dMap['OFFERDATE']||'';
    let yearsLeft=null;
    if(maturity){const ms=new Date(maturity)-new Date();if(ms>0)yearsLeft=parseFloat((ms/1000/60/60/24/365).toFixed(2))}
    const btype=secid.startsWith('SU')||name.includes('ОФЗ')?'ОФЗ':'Корп';
    const ctype=couponRaw===0?'zero':'fix';
    document.getElementById('yf-name').value=name;
    document.getElementById('yf-btype').value=btype;
    document.getElementById('yf-ctype').value=ctype; onYtmCType();
    if(!isNaN(couponRaw)&&couponRaw>=0)document.getElementById('yf-coupon').value=couponRaw;
    if(curPrice)document.getElementById('yf-price').value=curPrice.toFixed(2);
    if(yearsLeft)document.getElementById('yf-years').value=yearsLeft.toFixed(2);
    document.getElementById('yf-moex-status').innerHTML=`<span style="color:var(--green)">✓ ${name}${curPrice?` · ${curPrice.toFixed(2)}%`:''}${maturity?` · погаш. ${maturity}`:''}</span>`;
  }catch(e){
    document.getElementById('yf-moex-status').innerHTML=`<span style="color:var(--danger)">Ошибка: ${e.message}</span>`;
  }finally{
    document.getElementById('yf-lookup-btn').style.display='';
    document.getElementById('yf-load').style.display='none';
  }
}
document.addEventListener('click',e=>{
  const sug=document.getElementById('yf-suggest');
  if(sug&&!sug.contains(e.target)&&e.target.id!=='yf-isin')sug.style.display='none';
});
document.getElementById('yf-isin')?.addEventListener('keydown',e=>{
  if(e.key==='Enter'){e.preventDefault();document.getElementById('yf-suggest').style.display='none';lookupYtmIsin()}
});

// ══ API KEY HELPER ══
function apiHeaders(){
  const key = document.getElementById('api-key-input')?.value.trim() ||
              localStorage.getItem('ba_apikey') || '';
  if(!key) throw new Error('Введите Anthropic API Key в поле выше');
  return {
    'Content-Type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true'
  };
}

// ══ INIT ══
loadState();
// Restore API key
(()=>{const k=localStorage.getItem('ba_apikey');if(k&&document.getElementById('api-key-input'))document.getElementById('api-key-input').value=k;})();

// Pre-load portfolio — принудительная загрузка позиций (версия 6)
const PORTFOLIO_VERSION = 10;
const savedVersion = parseInt(localStorage.getItem('ba_portfolio_ver')||'0');
// Версия 9: сбрасываем счётчик чтобы загрузить правильные позиции один раз
// После этого данные живут в localStorage и больше не перезаписываются
if(savedVersion < PORTFOLIO_VERSION){
  localStorage.setItem('ba_portfolio_ver', PORTFOLIO_VERSION);
  portfolio = []; // очищаем перед загрузкой
  const pos = [
    // Брокерский счёт (основной)
    {name:'ВИС ФИНАНС БО-П10',         isin:'RU000A10DA41', btype:'Корп', ctype:'fix',   buy:96.07,  cur:96.07,  coupon:17.0,  qty:11, nom:1000, years:2.53},
    {name:'Кредитный поток 3.0',        isin:'RU000A10DBM5', btype:'Корп', ctype:'fix',   buy:101.68, cur:101.68, coupon:17.3,  qty:18, nom:1000, years:3.23},
    {name:'ОФЗ 29008',                  isin:'RU000A0JV4P3', btype:'ОФЗ',  ctype:'float', buy:104.25, cur:104.25, coupon:0,     qty:21, nom:1000, years:1.8,  base:'КС', spread:1.2},
    {name:'РЖД БО 001Р-26R',            isin:'RU000A106K43', btype:'Корп', ctype:'float', buy:98.19,  cur:98.19,  coupon:0,     qty:7,  nom:1000, years:3.42, base:'RUONIA', spread:1.3},
    {name:'Село Зелёное Холдинг БО-П02',isin:'RU000A10DQ68', btype:'Корп', ctype:'fix',   buy:102.18, cur:102.18, coupon:17.25, qty:11, nom:1000, years:1.92},
    {name:'ТГК-14 001Р-01',             isin:'RU000A1066J2', btype:'Корп', ctype:'fix',   buy:95.32,  cur:95.32,  coupon:14.0,  qty:100,nom:1000, years:2.5},
    {name:'ТрансКонтейнер П02-01',      isin:'RU000A109E71', btype:'Корп', ctype:'float', buy:98.43,  cur:98.43,  coupon:0,     qty:28, nom:1000, years:3.1,  base:'КС', spread:1.75},
    // Брокерский счёт 1
    {name:'АФК Система 002P-05',        isin:'RU000A10CU55', btype:'Корп', ctype:'float', buy:98.39,  cur:98.39,  coupon:0,     qty:20, nom:1000, years:2.75, base:'КС', spread:3.5},
    {name:'Аэрофлот П02-БО-02',         isin:'RU000A10CS75', btype:'Корп', ctype:'float', buy:99.39,  cur:99.39,  coupon:0,     qty:15, nom:1000, years:2.0,  base:'КС', spread:1.6},
    {name:'Биннофарм Групп 001P-05',    isin:'RU000A10B3Q2', btype:'Корп', ctype:'fix',   buy:102.41, cur:102.41, coupon:23.5,  qty:12, nom:1000, years:2.42},
    {name:'Газпром капитал БО-003Р-07', isin:'RU000A10DLE1', btype:'Корп', ctype:'float', buy:99.6,   cur:99.6,   coupon:0,     qty:36, nom:1000, years:2.92, base:'КС', spread:1.5},
    {name:'ГТЛК 002Р-10',               isin:'RU000A10CR50', btype:'Корп', ctype:'float', buy:97.56,  cur:97.56,  coupon:0,     qty:22, nom:1000, years:2.0,  base:'КС', spread:2.5},
    {name:'Нижегородская обл. 34017',   isin:'RU000A10DJA3', btype:'Муни', ctype:'float', buy:101.49, cur:101.49, coupon:0,     qty:39, nom:1000, years:3.75, base:'КС', spread:2.15},
    // Брокерский счёт 2
    {name:'Авто Финанс Банк БО-001Р-13',isin:'RU000A109KY4', btype:'Корп', ctype:'float', buy:99.8,   cur:99.8,   coupon:0,     qty:20, nom:1000, years:1.5,  base:'КС', spread:2.3},
    {name:'Селигдар 001Р-09',           isin:'RU000A10DTA2', btype:'Корп', ctype:'float', buy:100.0,  cur:100.0,  coupon:0,     qty:40, nom:1000, years:2.17, base:'КС', spread:4.5},
    // ИИС
    {name:'АБЗ-1 002P-04',              isin:'RU000A10DCK7', btype:'Корп', ctype:'fix',   buy:104.29, cur:104.29, coupon:23.5,  qty:13, nom:1000, years:2.0},
    {name:'Арктик Технолоджи БО-01',    isin:'RU000A10BV89', btype:'Корп', ctype:'fix',   buy:115.45, cur:115.45, coupon:26.0,  qty:1,  nom:1000, years:1.5},
    {name:'ВИС ФИНАНС БО-П11',          isin:'RU000A10EES4', btype:'Корп', ctype:'fix',   buy:101.81, cur:101.81, coupon:17.0,  qty:11, nom:1000, years:2.88},
    {name:'Группа Позитив 001P-03',     isin:'RU000A10BWC6', btype:'Корп', ctype:'fix',   buy:106.54, cur:106.54, coupon:18.0,  qty:5,  nom:1000, years:2.25},
    {name:'ГТЛК 002Р-04',               isin:'RU000A10A3Z4', btype:'Корп', ctype:'fix',   buy:112.95, cur:112.95, coupon:25.0,  qty:30, nom:1000, years:1.58},
    {name:'КАМАЗ ПАО БО-П20',           isin:'RU000A10EAC6', btype:'Корп', ctype:'fix',   buy:100.07, cur:100.07, coupon:21.0,  qty:16, nom:1000, years:2.5},
    {name:'ПГК 003Р-02',                isin:'RU000A10DSL1', btype:'Корп', ctype:'fix',   buy:102.0,  cur:102.0,  coupon:15.95, qty:15, nom:1000, years:2.67},
    {name:'Сэтл Групп 002Р-04',         isin:'RU000A10B8M0', btype:'Корп', ctype:'fix',   buy:103.99, cur:103.99, coupon:23.9,  qty:36, nom:1000, years:2.83},
    {name:'Кредитный поток 3.0 (ИИС)',  isin:'RU000A10DBM5', btype:'Корп', ctype:'fix',   buy:103.05, cur:103.05, coupon:17.3,  qty:30, nom:1000, years:3.23},
    {name:'Село Зелёное Х (ИИС)',       isin:'RU000A10DQ68', btype:'Корп', ctype:'fix',   buy:102.19, cur:102.19, coupon:17.25, qty:10, nom:1000, years:1.92},
    {name:'Эконива 001Р-01',            isin:'RU000A10EJZ8', btype:'Корп', ctype:'fix',   buy:101.4,  cur:101.4,  coupon:16.75, qty:3,  nom:1000, years:2.5},
  ];
  pos.forEach(p => {
    const years = p.years || 2;
    let ytm;
    if(p.ctype === 'float') {
      ytm = RATE_NOW + (p.spread||0) - (p.buy - 100) / years;
    } else if(p.coupon > 0) {
      ytm = calcYTM(p.buy, p.coupon, years);
    } else {
      ytm = null;
    }
    portfolio.push({
      name: p.name, btype: p.btype, ctype: p.ctype,
      buy: p.buy, cur: p.cur, coupon: p.coupon||0,
      qty: p.qty, nom: p.nom||1000, years: years,
      ytm: ytm != null ? parseFloat(ytm.toFixed(2)) : null,
      base: p.base||'', spread: p.spread||0,
      isin: p.isin||'',
      id: Date.now() + Math.random()
    });
  });
  save();
}

// ══════════════════════════════════════════════════════
// Pre-load reportsDB — seed отчётности эмитентов из портфеля.
// Цифры взяты из реальных публичных отчётов МСФО (smart-lab.ru агрегирует
// консолидированную отчётность эмитентов MOEX; ГТЛК и АБЗ-1 — из PDF
// МСФО с сайтов эмитентов). Все значения в млрд ₽.
// Эмитенты без цифр — в базу добавлены только как карточки (загрузите
// официальный PDF-отчёт через «📂 PDF/DOCX/XLSX» на вкладке «Эмитент»).
// ══════════════════════════════════════════════════════
const REPORTS_SEED_VERSION = 1;
const savedRepVersion = parseInt(localStorage.getItem('ba_reports_seed_ver')||'0');
if(savedRepVersion < REPORTS_SEED_VERSION){
  localStorage.setItem('ba_reports_seed_ver', REPORTS_SEED_VERSION);
  const SRC_SL = name => `Источник: smart-lab.ru/q/${name}/f/y/MSFO/ (консолид. МСФО эмитента MOEX).`;
  const SRC_GTLK = 'Источник: gtlk.ru/investors (Консолидир. МСФО за 2024 г., PDF).';
  const SRC_ABZ  = 'Источник: abz-1.ru (Консолидир. МСФО за 2024 г., PDF, апр. 2025).';
  const NO_DATA_NOTE = 'Цифры не подтянуты автоматически (403/503 на корп. сайте и e-disclosure.ru). Загрузите PDF отчёта через кнопку «📂 PDF/DOCX/XLSX» на вкладке «Эмитент».';
  const REPORTS_SEED = [
    // ═══ С данными (10 эмитентов) ═══
    {name:'Аэрофлот', ind:'transport', note:SRC_SL('AFLT'), periods:[
      {year:'2023', period:'Год', type:'МСФО', rev:612.2, ebitda:318.4, ebit:182.3, np:-1.03, int:29.2, assets:1114,  eq:-85.5, debt:747.3, cash:117.0, ca:null, cl:null, ret:null},
      {year:'2024', period:'Год', type:'МСФО', rev:856.8, ebitda:214.1, ebit:99.5,  np:64.2,  int:23.1, assets:1157,  eq:-55.7, debt:703.0, cash:105.4, ca:null, cl:null, ret:null},
    ]},
    {name:'Газпром', ind:'energy', note:SRC_SL('GAZP'), periods:[
      {year:'2023', period:'Год', type:'МСФО', rev:8542,  ebitda:1765,  ebit:-364,  np:726,   int:396.8,assets:28714, eq:15650, debt:6657,  cash:1602,  ca:null, cl:null, ret:null},
      {year:'2024', period:'Год', type:'МСФО', rev:10715, ebitda:3108,  ebit:1456,  np:1461,  int:715.4,assets:30698, eq:16711, debt:6715,  cash:992,   ca:null, cl:null, ret:null},
    ]},
    {name:'АФК Система', ind:'other', note:SRC_SL('AFKS'), periods:[
      {year:'2023', period:'Год', type:'МСФО', rev:1046,  ebitda:263.5, ebit:115.5, np:-31.5, int:130.3,assets:2349,  eq:66.3,  debt:1199,  cash:137.5, ca:null, cl:null, ret:null},
      {year:'2024', period:'Год', type:'МСФО', rev:1232,  ebitda:317.7, ebit:167.0, np:-25.6, int:252.9,assets:2761,  eq:13.5,  debt:1485,  cash:157.9, ca:null, cl:null, ret:null},
    ]},
    {name:'КАМАЗ', ind:'other', note:SRC_SL('KMAZ'), periods:[
      {year:'2023', period:'Год', type:'МСФО', rev:370.3, ebitda:34.4,  ebit:28.9,  np:19.7,  int:8.84, assets:468.3, eq:114.8, debt:144.0, cash:91.6,  ca:null, cl:null, ret:null},
      {year:'2024', period:'Год', type:'МСФО', rev:393.7, ebitda:33.1,  ebit:22.8,  np:-0.2,  int:20.7, assets:556.5, eq:118.6, debt:225.6, cash:65.4,  ca:null, cl:null, ret:null},
    ]},
    {name:'Селигдар', ind:'metals', note:SRC_SL('SELG'), periods:[
      {year:'2023', period:'Год', type:'МСФО', rev:56.0,  ebitda:18.6,  ebit:4.93,  np:2.84,  int:4.92, assets:134.9, eq:24.4,  debt:58.8,  cash:10.3,  ca:null, cl:null, ret:null},
      {year:'2024', period:'Год', type:'МСФО', rev:59.3,  ebitda:23.6,  ebit:12.9,  np:5.50,  int:7.74, assets:179.2, eq:19.4,  debt:89.9,  cash:8.43,  ca:null, cl:null, ret:null},
    ]},
    {name:'Группа Позитив', ind:'telecom', note:SRC_SL('POSI'), periods:[
      {year:'2023', period:'Год', type:'МСФО', rev:22.2,  ebitda:10.8,  ebit:9.82,  np:9.70,  int:0.131,assets:28.4,  eq:13.2,  debt:5.68,  cash:1.68,  ca:null, cl:null, ret:null},
      {year:'2024', period:'Год', type:'МСФО', rev:24.5,  ebitda:6.46,  ebit:4.62,  np:3.66,  int:0.969,assets:52.7,  eq:17.1,  debt:26.4,  cash:6.23,  ca:null, cl:null, ret:null},
    ]},
    {name:'ТГК-14', ind:'energy', note:SRC_SL('TGKN'), periods:[
      {year:'2023', period:'Год', type:'МСФО', rev:17.8,  ebitda:3.00,  ebit:2.19,  np:1.65,  int:0.560,assets:21.6,  eq:7.66,  debt:8.28,  cash:5.00,  ca:null, cl:null, ret:null},
      {year:'2024', period:'Год', type:'МСФО', rev:19.3,  ebitda:3.78,  ebit:2.74,  np:1.76,  int:1.12, assets:23.8,  eq:7.10,  debt:9.62,  cash:3.76,  ca:null, cl:null, ret:null},
    ]},
    {name:'ТрансКонтейнер', ind:'transport', note:SRC_SL('TRCN'), periods:[
      {year:'2023', period:'Год', type:'МСФО', rev:199.2, ebitda:42.1,  ebit:null,  np:19.8,  int:11.3, assets:160.7, eq:24.9,  debt:98.4,  cash:7.80,  ca:null, cl:null, ret:null},
      {year:'2024', period:'Год', type:'МСФО', rev:185.1, ebitda:46.3,  ebit:null,  np:14.2,  int:16.4, assets:168.5, eq:26.3,  debt:98.5,  cash:4.73,  ca:null, cl:null, ret:null},
    ]},
    {name:'ГТЛК', ind:'finance', note:SRC_GTLK, periods:[
      {year:'2023', period:'Год', type:'МСФО', rev:97.4,  ebitda:null,  ebit:14.3,  np:0.7,   int:66.7, assets:1144.7,eq:173.1, debt:840.8, cash:32.2,  ca:null, cl:null, ret:-55.0},
      {year:'2024', period:'Год', type:'МСФО', rev:133.4, ebitda:null,  ebit:7.5,   np:1.8,   int:110.0,assets:1355.7,eq:205.3, debt:989.7, cash:64.5,  ca:null, cl:null, ret:-53.3},
    ]},
    {name:'АБЗ-1', ind:'realty', note:SRC_ABZ, periods:[
      {year:'2023', period:'Год', type:'МСФО', rev:6.4,   ebitda:1.1,   ebit:0.8,   np:0.6,   int:1.0,  assets:11.7,  eq:2.7,   debt:7.0,   cash:0.9,   ca:10.1, cl:3.6,  ret:2.7},
      {year:'2024', period:'Год', type:'МСФО', rev:8.2,   ebitda:1.3,   ebit:1.1,   np:0.7,   int:1.2,  assets:12.2,  eq:3.5,   debt:6.2,   cash:1.8,   ca:11.1, cl:5.5,  ret:3.5},
    ]},
    // ═══ Без цифр (WebFetch блокируется корп. сайтами / e-disclosure.ru) ═══
    {name:'РЖД',                         ind:'transport', note:NO_DATA_NOTE, periods:[]},
    {name:'ПГК',                         ind:'transport', note:NO_DATA_NOTE, periods:[]},
    {name:'ВИС Финанс',                  ind:'realty',    note:NO_DATA_NOTE, periods:[]},
    {name:'Авто Финанс Банк',            ind:'finance',   note:NO_DATA_NOTE, periods:[]},
    {name:'Сэтл Групп',                  ind:'realty',    note:NO_DATA_NOTE, periods:[]},
    {name:'МФК Кредитный поток',         ind:'finance',   note:NO_DATA_NOTE, periods:[]},
    {name:'Холдинг СЗ (Село Зелёное)',   ind:'agro',      note:NO_DATA_NOTE, periods:[]},
    {name:'Биннофарм Групп',             ind:'other',     note:NO_DATA_NOTE, periods:[]},
    {name:'Арктик Технолоджи',           ind:'energy',    note:NO_DATA_NOTE, periods:[]},
    {name:'Эконива',                     ind:'agro',      note:NO_DATA_NOTE, periods:[]},
  ];
  REPORTS_SEED.forEach(ent => {
    let issId = Object.keys(reportsDB).find(k => reportsDB[k].name === ent.name);
    if(!issId){
      issId = 'iss_seed_' + Math.floor(Math.random()*1e9).toString(36) + '_' + Date.now().toString(36);
      reportsDB[issId] = {name: ent.name, ind: ent.ind, periods:{}};
    }
    ent.periods.forEach(p => {
      const key = `${p.year}_${p.period||'FY'}_${p.type||'?'}`;
      if(reportsDB[issId].periods[key]) return; // не перезаписываем то, что ввёл пользователь
      reportsDB[issId].periods[key] = {
        year:p.year, period:p.period||'FY', type:p.type||'?',
        note: ent.note||'',
        rev:p.rev??null, ebitda:p.ebitda??null, ebit:p.ebit??null, np:p.np??null,
        int:p.int??null, tax:p.tax??null, assets:p.assets??null, ca:p.ca??null,
        cl:p.cl??null, debt:p.debt??null, cash:p.cash??null, ret:p.ret??null,
        eq:p.eq??null,
        analysisHTML:'',
      };
    });
  });
  save();
  const _sbRep = document.getElementById('sb-rep');
  if(_sbRep) _sbRep.textContent = Object.keys(reportsDB).length;
}

// Demo YTM bonds if empty
if(!ytmBonds.length){
  [{name:'ОФЗ 26238',btype:'ОФЗ',ctype:'fix',price:60.5,coupon:7.1,years:15.5},
   {name:'ОФЗ 26226',btype:'ОФЗ',ctype:'fix',price:88.2,coupon:7.95,years:4.2},
   {name:'РЖД 1Р-20R',btype:'Корп',ctype:'fix',price:94.1,coupon:13.5,years:2.8},
   {name:'Газпром Б27',btype:'Корп',ctype:'fix',price:91.8,coupon:11.5,years:3.1},
   {name:'ВТБ КС+1.8',btype:'Корп',ctype:'float',base:'КС',spread:1.8,price:100.2,years:3.0},
   {name:'ОФЗ 52005 (ИПЦ)',btype:'ОФЗ',ctype:'float',base:'ИПЦ',spread:2.5,price:97.5,years:8.2},
  ].forEach(d=>{
    const ytm=d.ctype==='fix'?calcYTM(d.price,d.coupon,d.years):RATE_NOW+d.spread-(d.price-100)/d.years;
    ytmBonds.push({...d,ytm,id:Date.now()+Math.random()});
  });
}

renderYtm(); renderSbLists();
document.getElementById('sb-pc').textContent=portfolio.length;

// Метка «инициализация завершена». Видно пользователю в сайдбаре.
if(window._perfMarks){
  window._perfMarks.ready = performance.now();
  if(typeof _perfUpdate === 'function') _perfUpdate();
}

// Demo P&L prefill
['pl-buy','pl-sell','pl-coupon'].forEach((id,i)=>{document.getElementById(id).value=['60.5','72.0','7.1'][i]});
document.getElementById('pl-qty').value='20';
document.getElementById('pl-days').value='365';
document.getElementById('pl-nkdb').value='12.50';
document.getElementById('pl-nkds').value='18.20';
document.getElementById('pl-crec').value='1420';

// Modal close on overlay click
document.querySelectorAll('.modal-overlay').forEach(m=>m.addEventListener('click',e=>{if(e.target===m)m.classList.remove('open')}));

// ══════════════════════════════════════════════════════
// ══ CALENDAR EVENTS MODULE ══
// ══════════════════════════════════════════════════════

const CAL_TYPE_META = {
  report:   { icon:'📋', label:'Отчётность', color:'var(--purple)',  bg:'rgba(167,139,250,.12)' },
  coupon:   { icon:'💵', label:'Купон',       color:'var(--green)',   bg:'var(--green-dim)' },
  offer:    { icon:'🔔', label:'Оферта',      color:'var(--warn)',    bg:'rgba(245,166,35,.1)' },
  maturity: { icon:'🏁', label:'Погашение',   color:'var(--acc)',     bg:'var(--acc-dim)' },
  cbr:      { icon:'🏦', label:'ЦБ РФ',       color:'#60a5fa',       bg:'rgba(96,165,250,.1)' },
  rating:   { icon:'⭐', label:'Рейтинг',     color:'var(--danger)',  bg:'var(--danger-dim)' },
  other:    { icon:'📌', label:'Прочее',      color:'var(--text2)',   bg:'var(--s2)' },
};

const CAL_STATUS_META = {
  expected:  { icon:'⏳', color:'var(--warn)' },
  confirmed: { icon:'✅', color:'var(--acc)' },
  done:      { icon:'✔',  color:'var(--green)' },
  missed:    { icon:'❌', color:'var(--danger)' },
};

let calViewMode = 'list';
let calFilterType = 'all';
let calMonthOffset = 0; // months from current

// Seed ЦБ РФ meetings & generate portfolio events on first load
function seedDefaultEvents() {
  // CBR scheduled meetings 2025-2026 (approximate)
  const cbrDates = [
    '2025-03-21','2025-04-25','2025-06-06','2025-07-25',
    '2025-09-12','2025-10-24','2025-12-19',
    '2026-02-06','2026-03-20','2026-04-24','2026-06-05',
    '2026-07-24','2026-09-11','2026-10-23','2026-12-18',
  ];
  const existing = calEvents.map(e=>e.date+'_'+e.type);
  cbrDates.forEach(d=>{
    const key = d+'_cbr';
    if(!existing.includes(key)){
      calEvents.push({
        id: 'cbr_'+d, date: d, type:'cbr',
        issuer:'ЦБ РФ', title:'Заседание Совета директоров ЦБ',
        amount:'КС: ?', status:'expected', note:'Решение по ключевой ставке', auto:true
      });
    }
  });
  // Generate approx reporting dates for portfolio issuers
  const now = new Date();
  const seen = new Set(calEvents.filter(e=>e.auto&&e.type==='report').map(e=>e.issuer+'_'+e.date));
  const unique = [...new Map(portfolio.map(p=>[p.name,p])).values()];
  unique.forEach(p => {
    // Quarterly: approx Mar 31, May 15, Aug 15, Nov 15 (РСБУ); May 31 / Aug 31 / Nov 30 (МСФО)
    const quarters = [
      {date: year(now)+ '-03-31', label:'РСБУ Q4 '+(year(now)-1)},
      {date: year(now)+ '-05-15', label:'РСБУ Q1 '+year(now)},
      {date: year(now)+ '-05-31', label:'МСФО Q1 '+year(now)},
      {date: year(now)+ '-08-15', label:'РСБУ Q2 '+year(now)},
      {date: year(now)+ '-08-31', label:'МСФО Q2 '+year(now)},
      {date: year(now)+ '-11-14', label:'РСБУ Q3 '+year(now)},
      {date: year(now)+ '-11-28', label:'МСФО Q3 '+year(now)},
      {date: (year(now)+1)+'-03-31', label:'РСБУ Q4 '+year(now)},
      {date: (year(now)+1)+'-04-30', label:'МСФО FY '+year(now)},
    ];
    quarters.forEach(q=>{
      const dObj = new Date(q.date);
      if(dObj < now) return; // skip past
      const key = p.name+'_'+q.date;
      if(!seen.has(key)){
        seen.add(key);
        calEvents.push({
          id: 'rep_'+p.name+'_'+q.date.replace(/-/g,''),
          date: q.date, type:'report',
          issuer: p.name,
          issuerShort: p.name.split(' ').slice(0,2).join(' '),
          isin: p.isin||'',
          title: q.label,
          amount:'', status:'expected',
          note:'Ожидаемая дата публикации (по закону о раскрытии). Точная дата — на e-disclosure.ru',
          auto:true
        });
      }
    });
    // Maturity
    if(p.years){
      const matDate = addYears(now, p.years);
      const matStr = fmtDateISO(matDate);
      const mkey = p.name+'_mat';
      if(!calEvents.find(e=>e.id==='mat_'+p.isin)){
        calEvents.push({
          id: 'mat_'+p.isin, date: matStr, type:'maturity',
          issuer: p.name, title:'Погашение / Дата оферты',
          amount: p.nom ? p.nom.toLocaleString('ru-RU')+'₽' : '1 000₽',
          status:'expected', note:'Расчётная дата из портфеля', auto:true
        });
      }
    }
  });
  save();
}

function year(d){ return d.getFullYear(); }
function addYears(d, y){ const n=new Date(d); n.setFullYear(n.getFullYear()+Math.floor(y)); n.setMonth(n.getMonth()+Math.round((y%1)*12)); return n; }
function fmtDateISO(d){ return d.toISOString().split('T')[0]; }
function fmtDateRu(s){
  if(!s) return '—';
  const [y,m,d] = s.split('-');
  const months=['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];
  return d+' '+months[parseInt(m)-1]+' '+y;
}
function daysUntil(dateStr){
  const now = new Date(); now.setHours(0,0,0,0);
  const d = new Date(dateStr); d.setHours(0,0,0,0);
  return Math.round((d-now)/(1000*60*60*24));
}

function calFilter(type, btn){
  calFilterType = type;
  document.querySelectorAll('.cal-flt').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  renderCalendar();
}

function calSetView(mode, btn){
  calViewMode = mode;
  document.getElementById('cal-list-view').style.display = mode==='list'?'block':'none';
  document.getElementById('cal-month-view').style.display = mode==='month'?'block':'none';
  document.querySelectorAll('#cal-view-list,#cal-view-month').forEach(b=>{
    b.style.background='';b.style.borderColor='';b.style.color='var(--text2)';
  });
  btn.style.borderColor='var(--acc)'; btn.style.color='var(--acc)'; btn.style.background='var(--acc-dim)';
  if(mode==='month') renderCalendarMonth();
  else renderCalendar();
}

function getFilteredEvents(){
  const horizon = parseInt(document.getElementById('cal-horizon')?.value||'90');
  const now = new Date(); now.setHours(0,0,0,0);
  const future = new Date(now); future.setDate(future.getDate()+horizon);
  return calEvents
    .filter(e=>{
      const d=new Date(e.date); d.setHours(0,0,0,0);
      if(d < new Date(now.getTime()-7*24*3600*1000)) return false; // show 7 days past too
      if(d > future) return false;
      if(calFilterType!=='all' && e.type!==calFilterType) return false;
      return true;
    })
    .sort((a,b)=>a.date.localeCompare(b.date));
}

function updateCalStats(){
  const now = new Date(); now.setHours(0,0,0,0);
  const horizon30 = new Date(now); horizon30.setDate(horizon30.getDate()+30);
  const all = calEvents.filter(e=>{ const d=new Date(e.date); return d>=now&&d<=horizon30; });
  const counts={report:0,coupon:0,offer:0,maturity:0,cbr:0,rating:0,other:0};
  all.forEach(e=>{ if(counts[e.type]!==undefined) counts[e.type]++; });
  const el = document.getElementById('cal-stats');
  if(!el) return;
  el.innerHTML = [
    {k:'report',l:'Отчётов'},
    {k:'coupon',l:'Купонов'},
    {k:'offer',l:'Оферт'},
    {k:'cbr',l:'Заседаний ЦБ'},
  ].map(({k,l})=>`
    <div class="stat-card" style="border-color:${CAL_TYPE_META[k].color}20;min-width:90px">
      <div class="sc-lbl">${CAL_TYPE_META[k].icon} ${l}</div>
      <div class="sc-val" style="color:${CAL_TYPE_META[k].color}">${counts[k]}</div>
      <div class="sc-sub">ближ. 30 дней</div>
    </div>`).join('');
  document.getElementById('sb-ev').textContent = calEvents.filter(e=>{ const d=new Date(e.date); return d>=now; }).length;
}

function renderCalendar(){
  if(calViewMode==='month'){renderCalendarMonth();return;}
  const evs = getFilteredEvents();
  const container = document.getElementById('cal-groups');
  const empty = document.getElementById('cal-empty');
  if(!evs.length){ container.innerHTML=''; empty.style.display='block'; return; }
  empty.style.display='none';

  // Group by week
  const groups = {};
  const now = new Date(); now.setHours(0,0,0,0);
  evs.forEach(e=>{
    const d = new Date(e.date); d.setHours(0,0,0,0);
    const diff = Math.round((d-now)/(7*24*3600*1000));
    let gkey, glabel;
    const days = daysUntil(e.date);
    if(days<0){ gkey='past'; glabel='Прошедшие'; }
    else if(days===0){ gkey='today'; glabel='Сегодня'; }
    else if(days<=7){ gkey='week1'; glabel='Эта неделя'; }
    else if(days<=14){ gkey='week2'; glabel='Следующая неделя'; }
    else if(days<=31){ gkey='month1'; glabel='В этом месяце'; }
    else if(days<=90){ gkey='q1'; glabel='Ближайший квартал'; }
    else { gkey='far'; glabel='Далее'; }
    if(!groups[gkey]) groups[gkey]={label:glabel,events:[]};
    groups[gkey].events.push(e);
  });

  const order=['past','today','week1','week2','month1','q1','far'];
  container.innerHTML = order.filter(k=>groups[k]).map(k=>{
    const g = groups[k];
    const isToday = k==='today';
    return `<div style="margin-bottom:20px">
      <div style="font-size:.6rem;letter-spacing:.14em;text-transform:uppercase;color:${isToday?'var(--acc)':'var(--text3)'};margin-bottom:8px;padding-bottom:5px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px">
        ${isToday?'● ':''}<span>${g.label}</span>
        <span style="margin-left:auto;background:var(--border);padding:1px 7px;font-size:.55rem">${g.events.length}</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px">
        ${g.events.map(e=>renderEventCard(e)).join('')}
      </div>
    </div>`;
  }).join('');
}

function urgencyBadge(days){
  if(days<0) return `<span style="font-size:.55rem;color:var(--text3);background:var(--border);padding:1px 6px">прошло</span>`;
  if(days===0) return `<span style="font-size:.55rem;color:var(--bg);background:var(--acc);padding:1px 7px;font-weight:600">СЕГОДНЯ</span>`;
  if(days<=3) return `<span style="font-size:.55rem;color:var(--danger);border:1px solid var(--danger);padding:1px 6px">через ${days}д</span>`;
  if(days<=7) return `<span style="font-size:.55rem;color:var(--warn);border:1px solid var(--warn);padding:1px 6px">через ${days}д</span>`;
  if(days<=30) return `<span style="font-size:.55rem;color:var(--text2);border:1px solid var(--border2);padding:1px 6px">через ${days}д</span>`;
  return `<span style="font-size:.55rem;color:var(--text3);padding:1px 6px">через ${days}д</span>`;
}

// Нормализация имени эмитента для fuzzy-сравнения:
// убираем кавычки, тире, «ПАО/АО/ООО», пробелы, приводим к lowercase.
function normalizeIssuerName(name){
  if(!name) return '';
  return String(name)
    .toLowerCase()
    .replace(/[«»"'`"„“()\[\]]/g, '')
    .replace(/\b(пао|оао|ао|ооо|зао|группа|групп|gk|pjsc|jsc|llc|ltd|public|joint[\s-]?stock|company)\b/g, '')
    .replace(/[\-–—_.,;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Ищет в reportsDB эмитента по имени (exact → substring → пересечение слов).
// Возвращает id или null. Используется из календаря, чтобы дать прямую
// ссылку в локальную «Базу отчётности» вместо общего e-disclosure-поиска.
function findReportsIssuerByName(name){
  if(!name || !reportsDB) return null;
  const target = normalizeIssuerName(name);
  if(!target) return null;
  const entries = Object.entries(reportsDB);
  // 1) Точное совпадение нормализованных имён
  for(const [id, iss] of entries){
    if(normalizeIssuerName(iss && iss.name) === target) return id;
  }
  // 2) Подстрока в любую сторону
  for(const [id, iss] of entries){
    const n = normalizeIssuerName(iss && iss.name);
    if(n && (n.includes(target) || target.includes(n))) return id;
  }
  // 3) Пересечение значимых (≥3 символа) слов: ищем лучший матч.
  const targetWords = target.split(' ').filter(w => w.length >= 3);
  if(!targetWords.length) return null;
  let bestId = null, bestHits = 0;
  for(const [id, iss] of entries){
    const nWords = normalizeIssuerName(iss && iss.name).split(' ').filter(w => w.length >= 3);
    const hits = targetWords.filter(w => nWords.includes(w)).length;
    if(hits > bestHits){ bestHits = hits; bestId = id; }
  }
  // Требуем минимум 1 совпадение + совпадение хотя бы половины целевых слов.
  return (bestHits > 0 && bestHits >= Math.ceil(targetWords.length / 2)) ? bestId : null;
}

// Переключается на вкладку «Отчётность» и выбирает заданного эмитента.
function calOpenIssuerInReports(issuerId){
  if(!reportsDB[issuerId]){ alert('Эмитент не найден в базе — возможно, удалён.'); return; }
  if(typeof showPage === 'function') showPage('reports');
  // Обновляем select и триггерим его обработчик вручную — часть логики
  // репа завязана на change-событие / чтение value.
  const sel = document.getElementById('rep-issuer-sel');
  if(sel){
    sel.value = issuerId;
    if(typeof repSelectIssuer === 'function') repSelectIssuer();
  }
  // Подсветим активный пункт в сайдбаре
  const sbItems = document.querySelectorAll('.sb-item');
  sbItems.forEach(i => i.classList.remove('active'));
  const target = [...sbItems].find(i => (i.textContent||'').includes('База отчётности'));
  if(target) target.classList.add('active');
}

function renderEventCard(e){
  const m = CAL_TYPE_META[e.type]||CAL_TYPE_META.other;
  const sm = CAL_STATUS_META[e.status]||CAL_STATUS_META.expected;
  const days = daysUntil(e.date);
  const isPortfolio = portfolio.some(p=>p.name===e.issuer||p.name.startsWith(e.issuer)||e.issuer.includes(p.name));

  // Статус "уже вышло" для отчётности — если дата прошла и статус ещё "expected"
  const isPast = days < 0;
  const isReport = e.type === 'report';
  const maybePublished = isReport && isPast && e.status === 'expected';

  // Ссылки на источники.
  // Приоритет для e-disclosure:
  //   1) URL, прописанный у эмитента вручную (самая точная);
  //   2) поиск по ОГРН (уникален);
  //   3) поиск по ИНН (обычно уникален);
  //   4) поиск по имени (fallback).
  const localIssuerId = findReportsIssuerByName(e.issuer);
  const localIss = localIssuerId ? reportsDB[localIssuerId] : null;
  const issuerQuery = encodeURIComponent(e.issuerShort || e.issuer.split(' ').slice(0,2).join(' '));
  const edisclosureLink =
      (localIss && localIss.disclosureUrl) ? localIss.disclosureUrl
    : (localIss && localIss.ogrn) ? `https://www.e-disclosure.ru/poisk-po-ogrn?ogrn=${encodeURIComponent(localIss.ogrn)}`
    : (localIss && localIss.inn)  ? `https://www.e-disclosure.ru/poisk-po-inn?inn=${encodeURIComponent(localIss.inn)}`
    : `https://www.e-disclosure.ru/poisk-po-kompaniyam?query=${issuerQuery}`;
  const edisclosureHint =
      (localIss && localIss.disclosureUrl) ? 'прямая ссылка'
    : (localIss && localIss.ogrn) ? 'по ОГРН'
    : (localIss && localIss.inn)  ? 'по ИНН'
    : 'поиск по имени';
  const moexIssuerLink  = e.isin ? `https://www.moex.com/ru/issue.aspx?code=${e.isin}` : null;
  const moexEventsLink  = e.isin ? `https://iss.moex.com/iss/securities/${e.isin}/events.json` : null;

  const localIssuerLink = localIssuerId
    ? `<button type="button"
        style="font-size:.58rem;color:var(--acc);border:1px solid var(--acc);background:transparent;padding:2px 7px;cursor:pointer;transition:background .12s"
        onmouseover="this.style.background='var(--acc-dim)'" onmouseout="this.style.background='transparent'"
        onclick="event.stopPropagation();calOpenIssuerInReports('${localIssuerId}')">🏢 В базе отчётности</button>`
    : '';

  const linksHTML = isReport ? `
    <div style="display:flex;gap:8px;margin-top:5px;flex-wrap:wrap">
      ${localIssuerLink}
      <a href="${edisclosureLink}" target="_blank" rel="noopener"
        title="${edisclosureHint}"
        style="font-size:.58rem;color:var(--acc2);border:1px solid var(--acc2);padding:2px 7px;text-decoration:none;transition:background .12s"
        onmouseover="this.style.background='var(--acc-dim)'" onmouseout="this.style.background=''"
        onclick="event.stopPropagation()">↗ e-disclosure · ${edisclosureHint}</a>
      ${moexIssuerLink?`<a href="${moexIssuerLink}" target="_blank" rel="noopener"
        style="font-size:.58rem;color:var(--acc2);border:1px solid var(--acc2);padding:2px 7px;text-decoration:none;transition:background .12s"
        onmouseover="this.style.background='var(--acc-dim)'" onmouseout="this.style.background=''"
        onclick="event.stopPropagation()">↗ MOEX</a>`:''}
    </div>` : (e.isin && ['coupon','offer','maturity'].includes(e.type)) ? `
    <div style="display:flex;gap:8px;margin-top:4px;flex-wrap:wrap">
      ${localIssuerLink}
      <a href="https://www.moex.com/ru/issue.aspx?code=${e.isin}" target="_blank" rel="noopener"
        style="font-size:.58rem;color:var(--text3);border:1px solid var(--border);padding:2px 7px;text-decoration:none"
        onclick="event.stopPropagation()">↗ MOEX · ${e.isin}</a>
    </div>` : (localIssuerLink ? `<div style="margin-top:4px">${localIssuerLink}</div>` : '');

  const publishedWarning = maybePublished ? `
    <div style="font-size:.6rem;color:var(--warn);margin-top:3px">
      ⚠ Дедлайн прошёл — отчёт мог выйти. Проверьте на e-disclosure.
    </div>` : '';

  return `<div style="background:var(--s1);border:1px solid var(--border);border-left:3px solid ${m.color};padding:10px 14px;display:flex;align-items:flex-start;gap:12px;transition:background .15s;${maybePublished?'border-top:1px solid var(--warn)':''}" 
    onmouseover="this.style.background='var(--s2)'" onmouseout="this.style.background='var(--s1)'">
    <div style="font-size:1.3rem;line-height:1;margin-top:2px;cursor:pointer" onclick="editCalEvent('${e.id}')">${m.icon}</div>
    <div style="flex:1;min-width:0">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:3px">
        <span style="font-weight:600;font-size:.76rem;color:var(--text);cursor:pointer" onclick="editCalEvent('${e.id}')">${e.title}</span>
        ${e.amount?`<span style="font-size:.64rem;color:${m.color};background:${m.bg};padding:1px 6px">${e.amount}</span>`:''}
        <span style="font-size:.57rem;color:${maybePublished?'var(--warn)':sm.color}">${maybePublished?'⚠ возможно вышло':sm.icon+' '+(e.status==='expected'?'ожидается':e.status==='confirmed'?'подтверждено':e.status==='done'?'выполнено':'пропущено')}</span>
        ${isPortfolio?`<span style="font-size:.53rem;color:var(--green);border:1px solid var(--green);padding:1px 5px">В портфеле</span>`:''}
        ${e.source==='moex'?`<span style="font-size:.5rem;color:var(--acc);border:1px solid var(--border);padding:1px 4px">MOEX</span>`:e.auto?`<span style="font-size:.5rem;color:var(--text3);border:1px solid var(--border);padding:1px 4px">расч.</span>`:''}
      </div>
      <div style="font-size:.67rem;color:var(--text2)">${e.issuer}</div>
      ${e.note?`<div style="font-size:.62rem;color:var(--text3);margin-top:3px">${e.note}</div>`:''}
      ${publishedWarning}
      ${linksHTML}
    </div>
    <div style="text-align:right;flex-shrink:0;cursor:pointer" onclick="editCalEvent('${e.id}')">
      <div style="font-size:.71rem;color:var(--text2);margin-bottom:4px">${fmtDateRu(e.date)}</div>
      ${urgencyBadge(days)}
    </div>
  </div>`;
}

// ── Загрузка реальных событий с MOEX по ISIN портфеля ──
async function fetchCalendarFromMoex(){
  const btn = document.getElementById('cal-moex-btn');
  btn.disabled = true; btn.textContent = '⏳ Загружаю...';

  // Собираем уникальные ISIN из портфеля
  const isins = [...new Set(portfolio.filter(p=>p.isin).map(p=>({isin:p.isin,name:p.name})))];
  if(!isins.length){
    alert('В портфеле нет позиций с ISIN. Добавьте через поиск MOEX.');
    btn.disabled=false; btn.textContent='📡 Обновить с MOEX'; return;
  }

  let added = 0, failed = 0;
  // Убираем старые авто-события из MOEX чтобы не дублировать
  calEvents = calEvents.filter(e => e.source !== 'moex');

  for(const {isin, name} of isins){
    try{
      // Resolve secid
      const s = await moexFetch(`/iss/securities.json?q=${encodeURIComponent(isin)}&limit=3&iss.meta=off`);
      const srows = s?.securities?.data||[];
      const scols = s?.securities?.columns||[];
      const sidIdx = scols.indexOf('secid');
      if(!srows.length){ failed++; continue; }
      const secid = sidIdx>=0 ? srows[0][sidIdx] : srows[0][0];

      // Реальные события: купоны, оферты, погашения
      const bz = await moexFetch(`/iss/securities/${encodeURIComponent(secid)}/bondization.json?iss.meta=off`);

      // Купоны
      const cpCols = bz?.coupons?.columns||[];
      const cpData = bz?.coupons?.data||[];
      const cpDateIdx = cpCols.indexOf('coupondate');
      const cpValIdx  = cpCols.indexOf('value');
      const cpRateIdx = cpCols.indexOf('valueprc');
      const now = new Date(); now.setHours(0,0,0,0);
      const horizon = new Date(now); horizon.setFullYear(horizon.getFullYear()+2);

      cpData.forEach(r=>{
        const dt = r[cpDateIdx];
        if(!dt) return;
        const d = new Date(dt);
        if(d < now || d > horizon) return;
        const val  = parseFloat(r[cpValIdx]||'0');
        const rate = parseFloat(r[cpRateIdx]||'0');
        const evId = `moex_cp_${isin}_${dt}`;
        if(calEvents.find(e=>e.id===evId)) return;
        calEvents.push({
          id: evId, date: dt, type:'coupon',
          issuer: name, isin: isin,
          title: `Купон · ${name}`,
          amount: (val>0?val.toFixed(2)+'₽':'') + (rate>0?' · '+rate.toFixed(2)+'%':''),
          status:'confirmed', source:'moex', auto:false,
          note:`Источник: MOEX ISS · ${secid}`
        });
        added++;
      });

      // Оферты
      const ofCols = bz?.offers?.columns||[];
      const ofData = bz?.offers?.data||[];
      const ofDateIdx = ofCols.indexOf('offerdate');
      const ofTypeIdx = ofCols.indexOf('offertype');
      ofData.forEach(r=>{
        const dt = r[ofDateIdx];
        if(!dt) return;
        const d = new Date(dt);
        if(d < now) return;
        const evId = `moex_of_${isin}_${dt}`;
        if(calEvents.find(e=>e.id===evId)) return;
        const ofType = r[ofTypeIdx]||'';
        calEvents.push({
          id: evId, date: dt, type:'offer',
          issuer: name, isin: isin,
          title: `Оферта · ${name}`,
          amount: ofType,
          status:'confirmed', source:'moex', auto:false,
          note:`Тип: ${ofType||'—'} · MOEX ISS · ${secid}`
        });
        added++;
      });

      // Амортизации / погашения
      const amCols = bz?.amortizations?.columns||[];
      const amData = bz?.amortizations?.data||[];
      const amDateIdx = amCols.indexOf('amortdate');
      const amValIdx  = amCols.indexOf('value');
      amData.forEach(r=>{
        const dt = r[amDateIdx];
        if(!dt) return;
        const d = new Date(dt);
        if(d < now) return;
        const evId = `moex_am_${isin}_${dt}`;
        if(calEvents.find(e=>e.id===evId)) return;
        const val = parseFloat(r[amValIdx]||'0');
        calEvents.push({
          id: evId, date: dt, type:'maturity',
          issuer: name, isin: isin,
          title: `Погашение/амортизация · ${name}`,
          amount: val>0 ? val.toFixed(0)+'₽' : '',
          status:'confirmed', source:'moex', auto:false,
          note:`MOEX ISS · ${secid}`
        });
        added++;
      });

      // Небольшая пауза чтобы не перегружать MOEX
      await new Promise(r=>setTimeout(r,250));

    } catch(e){ failed++; }
  }

  // Обновляем расчётные даты отчётности — добавляем ссылки и isin
  calEvents.forEach(e=>{
    if(e.type==='report' && e.auto){
      const pos = portfolio.find(p=>p.name===e.issuer);
      if(pos?.isin && !e.isin) e.isin = pos.isin;
    }
  });

  save();
  renderCalendar();
  updateCalStats();
  btn.disabled=false; btn.textContent='📡 Обновить с MOEX';

  // Короткий тост
  const toast = document.createElement('div');
  toast.style.cssText=`position:fixed;bottom:20px;right:20px;background:var(--s2);border:1px solid var(--green);color:var(--green);font-family:var(--mono);font-size:.67rem;padding:9px 16px;z-index:9998;animation:fadeIn .2s`;
  toast.textContent = `✓ MOEX: добавлено ${added} событий по ${isins.length} выпускам${failed?' · '+failed+' ошибок':''}`;
  document.body.appendChild(toast);
  setTimeout(()=>toast.remove(), 4000);
}

// ── Month grid ──
function calMonthNav(dir){ calMonthOffset+=dir; renderCalendarMonth(); }

function renderCalendarMonth(){
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth()+calMonthOffset, 1);
  const year = target.getFullYear();
  const month = target.getMonth();
  const months = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
  document.getElementById('cal-month-label').textContent = months[month]+' '+year;

  const firstDay = new Date(year, month, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(year, month+1, 0).getDate();
  const startOffset = (firstDay+6)%7; // Mon-based

  // Build event map for this month
  const evMap = {};
  calEvents.forEach(e=>{
    const d=new Date(e.date);
    if(d.getFullYear()===year&&d.getMonth()===month){
      const day=d.getDate();
      if(!evMap[day]) evMap[day]=[];
      evMap[day].push(e);
    }
  });

  const today = new Date(); today.setHours(0,0,0,0);
  const wdays = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
  let html = `<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:3px;margin-bottom:3px">
    ${wdays.map(d=>`<div style="text-align:center;font-size:.56rem;color:var(--text3);padding:4px">${d}</div>`).join('')}
  </div>
  <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:3px">`;

  for(let i=0;i<startOffset;i++) html+=`<div></div>`;
  for(let day=1;day<=daysInMonth;day++){
    const cellDate = new Date(year,month,day);
    const isToday = cellDate.getTime()===today.getTime();
    const evs = evMap[day]||[];
    const hasCrit = evs.some(e=>['offer','maturity','cbr'].includes(e.type));
    html+=`<div style="background:${isToday?'var(--acc-dim)':hasCrit?'rgba(255,77,109,.05)':'var(--s1)'};border:1px solid ${isToday?'var(--acc)':hasCrit?'var(--danger)':'var(--border)'};min-height:68px;padding:5px;cursor:${evs.length?'pointer':'default'}"
      ${evs.length?`onclick="calShowDayEvs('${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}')"`:''}>
      <div style="font-size:.67rem;font-weight:600;color:${isToday?'var(--acc)':'var(--text2)'};margin-bottom:3px">${day}</div>
      ${evs.slice(0,3).map(e=>{const m2=CAL_TYPE_META[e.type]||CAL_TYPE_META.other;
        return `<div style="font-size:.52rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:${m2.color};margin-bottom:1px">${m2.icon} ${e.title}</div>`;
      }).join('')}
      ${evs.length>3?`<div style="font-size:.5rem;color:var(--text3)">+${evs.length-3} ещё</div>`:''}
    </div>`;
  }
  html += '</div>';
  document.getElementById('cal-month-grid').innerHTML = html;
}

function calShowDayEvs(dateStr){
  const evs = calEvents.filter(e=>e.date===dateStr);
  if(!evs.length) return;
  if(evs.length===1){ editCalEvent(evs[0].id); return; }
  // Show quick summary
  alert(fmtDateRu(dateStr)+'\n\n'+evs.map(e=>`${CAL_TYPE_META[e.type]?.icon} ${e.title} — ${e.issuer}`).join('\n'));
}

// ── Modal ──
function openAddEventModal(){
  document.getElementById('cal-ev-id').value='';
  document.getElementById('cal-modal-title').innerHTML='Добавить событие <button class="modal-x" onclick="closeModal(\'modal-cal-event\')">✕</button>';
  document.getElementById('cal-ev-del').style.display='none';
  document.getElementById('cal-ev-date').value = fmtDateISO(new Date());
  document.getElementById('cal-ev-type').value='report';
  document.getElementById('cal-ev-issuer').value='';
  document.getElementById('cal-ev-title').value='';
  document.getElementById('cal-ev-amount').value='';
  document.getElementById('cal-ev-status').value='expected';
  document.getElementById('cal-ev-note').value='';
  document.getElementById('modal-cal-event').classList.add('open');
}

function editCalEvent(id){
  const e = calEvents.find(e=>e.id===id); if(!e) return;
  document.getElementById('cal-ev-id').value=id;
  document.getElementById('cal-modal-title').innerHTML='Редактировать событие <button class="modal-x" onclick="closeModal(\'modal-cal-event\')">✕</button>';
  document.getElementById('cal-ev-del').style.display='';
  document.getElementById('cal-ev-date').value=e.date||'';
  document.getElementById('cal-ev-type').value=e.type||'report';
  document.getElementById('cal-ev-issuer').value=e.issuer||'';
  document.getElementById('cal-ev-title').value=e.title||'';
  document.getElementById('cal-ev-amount').value=e.amount||'';
  document.getElementById('cal-ev-status').value=e.status||'expected';
  document.getElementById('cal-ev-note').value=e.note||'';
  document.getElementById('modal-cal-event').classList.add('open');
}

function saveCalEvent(){
  const id = document.getElementById('cal-ev-id').value;
  const ev = {
    id: id||'ev_'+Date.now(),
    date: document.getElementById('cal-ev-date').value,
    type: document.getElementById('cal-ev-type').value,
    issuer: document.getElementById('cal-ev-issuer').value.trim(),
    title: document.getElementById('cal-ev-title').value.trim(),
    amount: document.getElementById('cal-ev-amount').value.trim(),
    status: document.getElementById('cal-ev-status').value,
    note: document.getElementById('cal-ev-note').value.trim(),
    auto: false
  };
  if(!ev.date||!ev.title){alert('Укажите дату и заголовок');return;}
  if(id){ const idx=calEvents.findIndex(e=>e.id===id); if(idx>=0) calEvents[idx]=ev; else calEvents.push(ev); }
  else calEvents.push(ev);
  save();
  closeModal('modal-cal-event');
  renderCalendar(); updateCalStats();
  if(calViewMode==='month') renderCalendarMonth();
}

function deleteCalEvent(){
  const id = document.getElementById('cal-ev-id').value;
  if(!id||!confirm('Удалить это событие?')) return;
  calEvents = calEvents.filter(e=>e.id!==id);
  save(); closeModal('modal-cal-event');
  renderCalendar(); updateCalStats();
  if(calViewMode==='month') renderCalendarMonth();
}

// ── Init calendar ──
seedDefaultEvents();
updateCalStats();

// ══════════════════════════════════════════════════════
// ══ REPORTS MODULE ══
// ══════════════════════════════════════════════════════

const REP_FIELDS = [
  {id:'rev',   label:'Выручка',           icon:'📈', unit:'млрд ₽', good:'up'},
  {id:'ebitda',label:'EBITDA',            icon:'💹', unit:'млрд ₽', good:'up'},
  {id:'ebit',  label:'EBIT',              icon:'⚙️', unit:'млрд ₽', good:'up'},
  {id:'np',    label:'Чистая прибыль',    icon:'💰', unit:'млрд ₽', good:'up'},
  {id:'assets',label:'Активы',            icon:'🏛', unit:'млрд ₽', good:'up'},
  {id:'eq',    label:'Собств. капитал',   icon:'🔷', unit:'млрд ₽', good:'up'},
  {id:'debt',  label:'Долг',              icon:'⚠️', unit:'млрд ₽', good:'down'},
  {id:'cash',  label:'Ден. средства',     icon:'💵', unit:'млрд ₽', good:'up'},
  {id:'ca',    label:'Оборотные активы',  icon:'🔄', unit:'млрд ₽', good:'up'},
  {id:'cl',    label:'Краткосрочн. обяз.',icon:'🔴', unit:'млрд ₽', good:'down'},
  {id:'int',   label:'Процентные расх.',  icon:'📉', unit:'млрд ₽', good:'down'},
  {id:'ret',   label:'Нераспр. прибыль',  icon:'🏦', unit:'млрд ₽', good:'up'},
];

// Derived ratios
function repCalcRatios(d){
  const r={};
  if(d.ebitda&&d.debt!=null&&d.cash!=null) r.ndE = ((d.debt-d.cash)/d.ebitda).toFixed(2);
  if(d.ebitda&&d.int) r.icr = (d.ebitda/d.int).toFixed(2);
  if(d.ca&&d.cl) r.cur = (d.ca/d.cl).toFixed(2);
  if(d.np&&d.rev) r.npm = (d.np/d.rev*100).toFixed(1);
  if(d.ebitda&&d.rev) r.ebitdam = (d.ebitda/d.rev*100).toFixed(1);
  if(d.eq&&d.assets) r.eqr = (d.eq/d.assets*100).toFixed(1);
  return r;
}

// ═════════════════════════════════════════════════════════════════════
// СТРАНИЦА «📊 Сравнение компаний»
// Ранжирует всех эмитентов из reportsDB по выбранному показателю в
// выбранном периоде. Сравниваем только тех, у кого в данном периоде
// есть поля, нужные для расчёта — остальные тихо пропускаем.
//
// Ключ периода — `${year}_${period}` (без scope/type), так как один
// и тот же квартал может быть и в РСБУ и в МСФО: агрегируем их в
// один «слот», а из дубликатов берём запись с максимальным количеством
// заполненных числовых полей.
// ═════════════════════════════════════════════════════════════════════

const _CROSS_METRICS = [
  {k:'ebitdam', l:'EBITDA-маржа, %',           unit:'%',    higher:true,  calc:d => (d.ebitda && d.rev) ? d.ebitda/d.rev*100 : null},
  {k:'npm',     l:'Чистая маржа, %',           unit:'%',    higher:true,  calc:d => (d.np != null && d.rev) ? d.np/d.rev*100 : null},
  {k:'ndE',     l:'ND / EBITDA',               unit:'x',    higher:false, calc:d => (d.ebitda && d.debt != null && d.cash != null) ? (d.debt - d.cash)/d.ebitda : null},
  {k:'icr',     l:'ICR (EBITDA / %проц.)',     unit:'x',    higher:true,  calc:d => (d.ebitda && d.int) ? d.ebitda/d.int : null},
  {k:'cur',     l:'Current Ratio (CA / CL)',   unit:'x',    higher:true,  calc:d => (d.ca && d.cl) ? d.ca/d.cl : null},
  {k:'eqr',     l:'Equity Ratio, %',           unit:'%',    higher:true,  calc:d => (d.eq && d.assets) ? d.eq/d.assets*100 : null},
  {k:'roa',     l:'ROA (ЧП / Активы), %',      unit:'%',    higher:true,  calc:d => (d.np != null && d.assets) ? d.np/d.assets*100 : null},
  {k:'roe',     l:'ROE (ЧП / Капитал), %',     unit:'%',    higher:true,  calc:d => (d.np != null && d.eq) ? d.np/d.eq*100 : null},
  {k:'rev',     l:'Выручка, млрд ₽',           unit:'млрд', higher:true,  calc:d => (typeof d.rev === 'number') ? d.rev : null},
  {k:'ebitda',  l:'EBITDA, млрд ₽',            unit:'млрд', higher:true,  calc:d => (typeof d.ebitda === 'number') ? d.ebitda : null},
  {k:'ebit',    l:'EBIT, млрд ₽',              unit:'млрд', higher:true,  calc:d => (typeof d.ebit === 'number') ? d.ebit : null},
  {k:'np',      l:'Чистая прибыль, млрд ₽',    unit:'млрд', higher:true,  calc:d => (typeof d.np === 'number') ? d.np : null},
  {k:'assets',  l:'Активы, млрд ₽',            unit:'млрд', higher:true,  calc:d => (typeof d.assets === 'number') ? d.assets : null},
  {k:'eq',      l:'Капитал, млрд ₽',           unit:'млрд', higher:true,  calc:d => (typeof d.eq === 'number') ? d.eq : null},
  {k:'debt',    l:'Долг, млрд ₽',              unit:'млрд', higher:false, calc:d => (typeof d.debt === 'number') ? d.debt : null}
];

// Сортировочный вес периода: FY > 9M > H1 > Q1 в пределах одного года.
function _crossPeriodWeight(period){
  if(period === 'FY') return 1.00;
  if(period === '9M') return 0.75;
  if(period === 'H1') return 0.50;
  if(period === 'Q1') return 0.25;
  return 0.40;
}

function _crossEnumeratePeriods(){
  const bucket = {};
  for(const iss of Object.values(reportsDB || {})){
    for(const p of Object.values(iss.periods || {})){
      if(!p || !p.year) continue;
      const period = p.period || 'FY';
      const key = p.year + '_' + period;
      if(!bucket[key]){
        bucket[key] = {
          key,
          label: p.year + ' ' + period,
          count: 0,
          sortKey: p.year * 10 + _crossPeriodWeight(period) * 10
        };
      }
      bucket[key].count++;
    }
  }
  return Object.values(bucket).sort((a, b) => b.sortKey - a.sortKey);
}

// Восемь «профильных» метрик для радара — независимые от абсолютного
// размера компании (все коэффициенты). Порядок = порядок осей вокруг
// круга, начиная с 12 часов по часовой.
const _CROSS_RADAR_AXES = ['ebitdam','npm','roa','roe','icr','ndE','cur','eqr'];

// Палитра для полигонов компаний в радаре. 30 цветов в HSL с шагом
// hue ≈ 12° и чередованием насыщенности/яркости — соседи по индексу
// контрастны, и при ≤30 эмитентов точно нет повторов.
const _CROSS_PALETTE = (() => {
  const out = [];
  // Перестановка hue: 0,180,90,270,45,225,135,315,22,202,… — даёт
  // максимальный угловой разнос между соседними индексами.
  const hueOrder = [0, 180, 90, 270, 45, 225, 135, 315,
                    22, 202, 112, 292, 67, 247, 157, 337,
                    11, 191, 101, 281, 56, 236, 146, 326,
                    34, 214, 124, 304, 78, 258];
  hueOrder.forEach((h, i) => {
    const layer = i % 3; // 3 «слоя» насыщенности/яркости
    const sat = layer === 0 ? 78 : layer === 1 ? 62 : 88;
    const lig = layer === 0 ? 60 : layer === 1 ? 52 : 68;
    out.push(`hsl(${h}, ${sat}%, ${lig}%)`);
  });
  return out;
})();

let _crossViewMode = 'radar'; // radar | heatmap | bar
let _crossHiddenIds = new Set(); // чекбокс-скрытые эмитенты

function crossBuildPeriodSelector(){
  const sel = document.getElementById('cross-period');
  if(!sel) return;
  const cur = sel.value;
  const periods = _crossEnumeratePeriods();
  if(!periods.length){
    sel.innerHTML = '<option value="">—</option>';
    return;
  }
  sel.innerHTML = periods.map(p =>
    `<option value="${p.key}">${p.label} · ${p.count} ком.</option>`
  ).join('');
  if(cur && periods.find(p => p.key === cur)) sel.value = cur;
}

function crossBuildMetricSelector(){
  const sel = document.getElementById('cross-metric');
  if(!sel || sel.options.length) return;
  sel.innerHTML = _CROSS_METRICS.map(m =>
    `<option value="${m.k}">${m.l}${m.higher === false ? ' (меньше = лучше)' : ''}</option>`
  ).join('');
  sel.value = 'ebitdam';
}

function crossSetView(mode, btn){
  _crossViewMode = mode;
  document.querySelectorAll('.cross-view-btn').forEach(b => b.classList.remove('btn-p'));
  if(btn) btn.classList.add('btn-p');
  const mw = document.getElementById('cross-metric-wrap');
  if(mw) mw.style.display = mode === 'bar' ? '' : 'none';
  crossRender();
}

function crossInit(){
  crossBuildPeriodSelector();
  crossBuildMetricSelector();
  // Подсвечиваем активную кнопку вида.
  document.querySelectorAll('.cross-view-btn').forEach(b => {
    b.classList.toggle('btn-p', b.dataset.view === _crossViewMode);
  });
  const mw = document.getElementById('cross-metric-wrap');
  if(mw) mw.style.display = _crossViewMode === 'bar' ? '' : 'none';
  crossRender();
}

// Выбираем одну запись на эмитента в указанном периоде — тот scope, где
// заполнено больше числовых полей. Возвращает {id, name, type, year,
// period, data (сырой объект периода)}.
function _crossPickRow(iss, issId, year, period, scopeFilter){
  if(!iss || !iss.periods) return null;
  let cand = Object.values(iss.periods).filter(p =>
    p && +p.year === year && (p.period || 'FY') === period
  );
  if(scopeFilter) cand = cand.filter(p => (p.type || '?') === scopeFilter);
  if(!cand.length) return null;
  cand.sort((a, b) =>
    Object.values(b).filter(v => typeof v === 'number').length -
    Object.values(a).filter(v => typeof v === 'number').length
  );
  const p = cand[0];
  return {
    id: issId,
    name: iss.name || issId,
    type: p.type || '?',
    year: p.year,
    period: p.period || 'FY',
    data: p
  };
}

// Все эмитенты периода, с сырыми значениями по всем метрикам.
function _crossCollectAll(periodKey, opts){
  const filter = (opts.filter || '').trim().toLowerCase();
  const scopeFilter = opts.scopeFilter || null;
  const [yearStr, period] = periodKey.split('_');
  const year = +yearStr;
  const out = [];
  for(const [issId, iss] of Object.entries(reportsDB || {})){
    if(filter && !String(iss?.name || '').toLowerCase().includes(filter)) continue;
    const row = _crossPickRow(iss, issId, year, period, scopeFilter);
    if(!row) continue;
    row.values = {};
    for(const m of _CROSS_METRICS){
      const v = m.calc(row.data);
      row.values[m.k] = (v == null || !isFinite(v)) ? null : v;
    }
    out.push(row);
  }
  return out;
}

// Перцентиль-rank каждой компании по каждой метрике: 0 = худший,
// 100 = лучший. Для higher=false метрик сравнение инвертировано, т.е.
// меньше ND/EBITDA → выше percentile. Компании с null-значением
// получают null (на радаре точка тянется к центру).
function _crossRanks(rows){
  const ranks = {};
  for(const m of _CROSS_METRICS){
    const pairs = rows
      .map((r, i) => ({i, v: r.values[m.k]}))
      .filter(p => p.v != null);
    if(pairs.length < 2){
      rows.forEach(r => { (ranks[m.k] ||= {})[r.id] = null; });
      continue;
    }
    pairs.sort((a, b) => m.higher === false ? (a.v - b.v) : (b.v - a.v));
    // Лучший (первый) → 100, худший → 0. Tied values → усреднённый rank.
    const n = pairs.length;
    pairs.forEach((p, idx) => {
      // percentile по «сколько компаний я обошёл»: (n-1-idx)/(n-1) * 100.
      (ranks[m.k] ||= {})[rows[p.i].id] = n === 1 ? 100 : Math.round((n - 1 - idx) / (n - 1) * 100);
    });
    rows.forEach(r => {
      if(r.values[m.k] == null) (ranks[m.k])[r.id] = null;
    });
  }
  return ranks;
}

function _crossFmt(v, unit){
  if(v == null) return '—';
  if(unit === 'млрд'){
    const abs = Math.abs(v);
    return v.toLocaleString('ru-RU', {maximumFractionDigits: abs >= 100 ? 0 : abs >= 10 ? 1 : 2}) + ' млрд';
  }
  if(unit === 'x') return v.toFixed(2) + 'x';
  if(unit === '%') return v.toFixed(1) + '%';
  return v.toFixed(2);
}

function _crossColor(i){ return _CROSS_PALETTE[i % _CROSS_PALETTE.length]; }

// Сайдбар со списком компаний (чекбоксы + цветовой маркер = легенда
// радара). В режиме heatmap/bar маркер не нужен, но список остаётся —
// позволяет фильтровать «вручную».
function _crossRenderCompanies(rows){
  const box = document.getElementById('cross-companies');
  if(!box) return;
  if(!rows.length){
    box.innerHTML = '<div style="padding:10px;color:var(--text3)">—</div>';
    return;
  }
  const showLegend = _crossViewMode === 'radar';
  const visible = rows.filter(r => !_crossHiddenIds.has(r.id));
  const head = `<div style="padding:6px 8px;border-bottom:1px solid var(--border);background:var(--bg);display:flex;gap:6px;align-items:center">
      <strong style="font-size:.62rem;color:var(--text2)">${rows.length} эмит.</strong>
      <span style="color:var(--text3);font-size:.55rem">(${visible.length} видимых)</span>
      <button class="btn btn-sm" onclick="crossToggleAll(true)" style="padding:1px 6px;margin-left:auto;font-size:.52rem">все</button>
      <button class="btn btn-sm" onclick="crossToggleAll(false)" style="padding:1px 6px;font-size:.52rem">ничего</button>
    </div>`;
  const list = rows.map((r, i) => {
    const checked = !_crossHiddenIds.has(r.id);
    const dot = showLegend
      ? `<span style="width:10px;height:10px;display:inline-block;background:${checked ? _crossColor(i) : 'transparent'};border:1px solid ${_crossColor(i)};flex:0 0 auto"></span>`
      : '';
    return `<label style="display:flex;gap:6px;padding:4px 8px;border-bottom:1px solid rgba(30,48,72,.3);align-items:center;cursor:pointer;font-size:.58rem;${checked ? '' : 'opacity:.45'}" title="${r.name} · ${r.type}">
      <input type="checkbox" ${checked ? 'checked' : ''} onchange="crossToggleId('${r.id}', this.checked)" style="margin:0">
      ${dot}
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text2)">${r.name}</span>
    </label>`;
  }).join('');
  box.innerHTML = head + list;
}

function crossToggleId(id, checked){
  if(checked) _crossHiddenIds.delete(id); else _crossHiddenIds.add(id);
  crossRender();
}

function crossToggleAll(on){
  if(on){
    _crossHiddenIds.clear();
  } else {
    const rows = window._crossLast?.rows || [];
    rows.forEach(r => _crossHiddenIds.add(r.id));
  }
  crossRender();
}

function crossRender(){
  crossBuildPeriodSelector();
  crossBuildMetricSelector();
  const periodKey = document.getElementById('cross-period')?.value || '';
  const filter    = document.getElementById('cross-filter')?.value || '';
  const sameScopeChk = document.getElementById('cross-same-scope')?.checked;
  const chart  = document.getElementById('cross-chart');
  const status = document.getElementById('cross-status');
  if(!chart) return;
  if(!periodKey){
    chart.innerHTML = '<div class="empty"><div class="ei">📊</div><p>Нет распознанных отчётов. Добавьте хотя бы 2 периода от разных эмитентов в 📂 Отчётность.</p></div>';
    _crossRenderCompanies([]);
    if(status) status.textContent = '';
    window._crossLast = null;
    return;
  }
  // scopeFilter — если чекбокс включен, берём самый частый type в периоде.
  let scopeFilter = null;
  if(sameScopeChk){
    const [yearStr, period] = periodKey.split('_');
    const freq = {};
    for(const iss of Object.values(reportsDB || {})){
      for(const p of Object.values(iss.periods || {})){
        if(p && +p.year === +yearStr && (p.period || 'FY') === period){
          const t = p.type || '?';
          freq[t] = (freq[t] || 0) + 1;
        }
      }
    }
    scopeFilter = Object.entries(freq).sort((a,b) => b[1] - a[1])[0]?.[0] || null;
  }
  const rows = _crossCollectAll(periodKey, {filter, scopeFilter});
  const ranks = _crossRanks(rows);
  window._crossLast = {rows, ranks, periodKey, scopeFilter};
  _crossRenderCompanies(rows);
  if(!rows.length){
    chart.innerHTML = '<div class="empty"><div class="ei">∅</div><p>В этом периоде нет эмитентов (с учётом фильтра).</p></div>';
    if(status) status.textContent = '';
    return;
  }
  if(status){
    const scopeTag = scopeFilter ? ` · scope=${scopeFilter}` : '';
    const viewLabel = {radar:'радар (профиль)', heatmap:'тепловая карта', bar:'бар-чарт'}[_crossViewMode];
    status.innerHTML = `${rows.length} эмитент(ов)${scopeTag} · вид: <strong>${viewLabel}</strong>${_crossViewMode!=='bar' ? ' · значения нормированы в перцентили (0…100)' : ''}`;
  }
  if(_crossViewMode === 'radar')        _crossRenderRadar(rows, ranks);
  else if(_crossViewMode === 'heatmap') _crossRenderHeatmap(rows, ranks);
  else                                  _crossRenderBar(rows);
}

// ── Радар (паутинка) ─────────────────────────────────────────────────
// Оси = _CROSS_RADAR_AXES, radius = percentile (0..1). Каждая видимая
// компания — полигон своего цвета. Наведение на точку — tooltip с
// исходным значением метрики.
function _crossRenderRadar(rows, ranks){
  const chart = document.getElementById('cross-chart');
  const axes = _CROSS_RADAR_AXES.map(k => _CROSS_METRICS.find(m => m.k === k)).filter(Boolean);
  const N = axes.length;
  const W = 640, H = 560;
  const cx = W / 2, cy = H / 2 - 8;
  const R = Math.min(W, H) / 2 - 96;
  const angleOf = i => -Math.PI / 2 + (i / N) * Math.PI * 2; // 12 часов → по часовой
  const point = (i, r) => [cx + Math.cos(angleOf(i)) * R * r, cy + Math.sin(angleOf(i)) * R * r];
  // Сетка: 4 концентрических десятиугольника (25/50/75/100%).
  const gridPoly = f => axes.map((_, i) => {
    const [x, y] = point(i, f);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const grid = [0.25, 0.5, 0.75, 1].map(f =>
    `<polygon points="${gridPoly(f)}" fill="none" stroke="var(--border)" stroke-width="${f===1?1.2:.7}" opacity="${f===1?0.9:0.5}"/>`
  ).join('');
  const spokes = axes.map((m, i) => {
    const [x, y] = point(i, 1);
    return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--border)" stroke-width=".6" opacity=".55"/>`;
  }).join('');
  // Подписи осей.
  const labels = axes.map((m, i) => {
    const [x, y] = point(i, 1.14);
    const anchor = Math.abs(x - cx) < 2 ? 'middle' : (x > cx ? 'start' : 'end');
    const tag = m.higher === false ? ' ↓' : '';
    const short = m.l.split(',')[0].split('(')[0].trim();
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}" dominant-baseline="middle" fill="var(--text2)" font-size="11" font-family="var(--mono, monospace)">${short}${tag}</text>`;
  }).join('');
  // Метки перцентиля 50/100.
  const ringLabels = [0.5, 1].map(f => {
    const [x, y] = point(0, f);
    return `<text x="${(x+6).toFixed(1)}" y="${(y-4).toFixed(1)}" fill="var(--text3)" font-size="9">${Math.round(f*100)}</text>`;
  }).join('');
  // Полигоны компаний (только видимые).
  const polys = [];
  const markers = [];
  rows.forEach((r, idx) => {
    if(_crossHiddenIds.has(r.id)) return;
    const color = _crossColor(idx);
    const pts = [];
    axes.forEach((m, i) => {
      const pr = ranks[m.k]?.[r.id];
      const f = pr == null ? 0 : pr / 100;
      const [x, y] = point(i, f);
      pts.push([x, y, m, pr, r.values[m.k]]);
    });
    const polyStr = pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    polys.push(`<polygon points="${polyStr}" fill="${color}" fill-opacity=".12" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"/>`);
    pts.forEach(p => {
      const [x, y, m, pr, raw] = p;
      const title = `${r.name} · ${m.l}: ${_crossFmt(raw, m.unit)} (перцентиль ${pr == null ? '—' : pr})`;
      markers.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.5" fill="${color}" stroke="var(--bg)" stroke-width=".8"><title>${title.replace(/"/g,'&quot;')}</title></circle>`);
    });
  });
  const visibleCount = rows.filter(r => !_crossHiddenIds.has(r.id)).length;
  chart.innerHTML = `
    <div style="font-size:.56rem;color:var(--text3);margin-bottom:4px">
      ↓ = «меньше — лучше» (для ND/EBITDA шкала инвертирована, чтобы «дальше от центра = лучше» работало всегда). Наведите мышь на точку — увидите сырое значение.
    </div>
    <div style="overflow:auto"><svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;display:block;margin:0 auto">
      ${grid}${spokes}${ringLabels}${labels}${polys.join('')}${markers.join('')}
    </svg></div>
    <div style="margin-top:4px;font-size:.55rem;color:var(--text3)">Показано полигонов: ${visibleCount} / ${rows.length}. Отключайте лишние в списке слева.</div>
  `;
}

// ── Тепловая карта ───────────────────────────────────────────────────
// Строки = компании (отсортированы по среднему перцентилю по всем
// метрикам — лучшие сверху). Колонки = метрики. Цвет ячейки ∝
// перцентилю: красный (0) → жёлтый (50) → зелёный (100).
function _percentileColor(p){
  if(p == null) return 'var(--s1)';
  // 0 → #ff4d6d, 50 → #f5a623, 100 → #22d3a0
  const hex = h => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];
  const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  const [r, g, bl] = p <= 50
    ? mix(hex('#ff4d6d'), hex('#f5a623'), p / 50)
    : mix(hex('#f5a623'), hex('#22d3a0'), (p - 50) / 50);
  return `rgba(${r},${g},${bl},.78)`;
}

function _crossRenderHeatmap(rows, ranks){
  const chart = document.getElementById('cross-chart');
  const metrics = _CROSS_METRICS;
  // Сортировка строк: сначала считаем средний перцентиль по всем метрикам у каждой компании.
  const withAvg = rows.map(r => {
    const vals = metrics.map(m => ranks[m.k]?.[r.id]).filter(v => v != null);
    const avg = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : -1;
    return {row: r, avg};
  });
  withAvg.sort((a, b) => b.avg - a.avg);
  const visible = withAvg.filter(x => !_crossHiddenIds.has(x.row.id));
  if(!visible.length){
    chart.innerHTML = '<div class="empty"><div class="ei">👻</div><p>Все компании скрыты — отметьте их в списке слева.</p></div>';
    return;
  }
  const headCols = metrics.map(m => {
    const lbl = m.l.split(',')[0].split('(')[0].trim();
    const arr = m.higher === false ? ' ↓' : '';
    return `<th style="font-size:.5rem;padding:6px 3px;border:1px solid var(--border);color:var(--text3);writing-mode:vertical-rl;transform:rotate(180deg);white-space:nowrap;min-width:26px" title="${m.l}">${lbl}${arr}</th>`;
  }).join('');
  const body = visible.map(({row, avg}) => {
    const cells = metrics.map(m => {
      const p = ranks[m.k]?.[row.id];
      const raw = row.values[m.k];
      const color = _percentileColor(p);
      const label = p == null ? '—' : String(p);
      const tt = `${m.l}: ${_crossFmt(raw, m.unit)} · перцентиль ${p == null ? '—' : p}`;
      return `<td style="padding:0;border:1px solid var(--border);text-align:center;font-size:.54rem;font-variant-numeric:tabular-nums;background:${color};color:${p!=null&&p<40?'#fff':'var(--bg)'};min-width:36px;height:22px" title="${tt.replace(/"/g,'&quot;')}">${label}</td>`;
    }).join('');
    const avgCell = `<td style="padding:3px 6px;border:1px solid var(--border);text-align:right;font-variant-numeric:tabular-nums;background:${_percentileColor(avg<0?null:avg)};color:${avg<50?'#fff':'var(--bg)'};font-weight:600">${avg<0?'—':avg.toFixed(0)}</td>`;
    return `<tr>
      <td style="padding:3px 6px;border:1px solid var(--border);background:var(--s1);white-space:nowrap;font-size:.58rem;color:var(--text2);max-width:220px;overflow:hidden;text-overflow:ellipsis">
        <span style="cursor:pointer;text-decoration:underline dotted var(--text3) 1px" onclick="crossOpenIssuer('${row.id}')" title="${row.name} · ${row.type}">${row.name}</span>
        <span style="color:var(--text3);font-size:.5rem"> · ${row.type}</span>
      </td>
      ${avgCell}
      ${cells}
    </tr>`;
  }).join('');
  chart.innerHTML = `
    <div style="font-size:.56rem;color:var(--text3);margin-bottom:4px">
      Строки отсортированы по среднему перцентилю (лучшие сверху). Зелёный = лидер, красный = аутсайдер. ↓ = метрика «меньше — лучше» (шкала уже инвертирована).
    </div>
    <div style="overflow:auto;max-height:640px"><table style="border-collapse:collapse;font-family:var(--mono,monospace)">
      <thead><tr>
        <th style="padding:6px 8px;border:1px solid var(--border);background:var(--bg);text-align:left;font-size:.58rem;color:var(--text3);position:sticky;left:0;z-index:2">Компания</th>
        <th style="padding:6px 8px;border:1px solid var(--border);background:var(--bg);font-size:.58rem;color:var(--text3)" title="Средний перцентиль по всем метрикам">ср.</th>
        ${headCols}
      </tr></thead>
      <tbody>${body}</tbody>
    </table></div>
  `;
}

// ── Бар-чарт по одной метрике (старый вид) ───────────────────────────
function _crossRenderBar(rows){
  const chart = document.getElementById('cross-chart');
  const metricKey = document.getElementById('cross-metric')?.value || 'ebitdam';
  const metric = _CROSS_METRICS.find(m => m.k === metricKey) || _CROSS_METRICS[0];
  const filtered = rows
    .filter(r => !_crossHiddenIds.has(r.id) && r.values[metric.k] != null)
    .map(r => ({...r, value: r.values[metric.k]}));
  filtered.sort((a, b) => metric.higher === false ? (a.value - b.value) : (b.value - a.value));
  if(!filtered.length){
    chart.innerHTML = `<div class="empty"><div class="ei">∅</div><p>Ни у одного эмитента нет полей для показателя «${metric.l}».</p></div>`;
    return;
  }
  const maxV = Math.max(...filtered.map(r => Math.abs(r.value))) || 1;
  const hasNeg = filtered.some(r => r.value < 0);
  const best = filtered[0].value;
  const worst = filtered[filtered.length - 1].value;
  const avg = filtered.reduce((s, r) => s + r.value, 0) / filtered.length;
  const median = filtered.slice().sort((a, b) => a.value - b.value)[Math.floor(filtered.length / 2)].value;
  const barRows = filtered.map((r, i) => {
    const absW = Math.abs(r.value) / maxV * (hasNeg ? 50 : 100);
    const barPos = hasNeg
      ? (r.value >= 0
          ? `left:50%;width:${absW}%;background:${metric.higher === false ? 'var(--danger)' : 'var(--green)'};opacity:.75`
          : `right:50%;width:${absW}%;background:${metric.higher === false ? 'var(--green)' : 'var(--danger)'};opacity:.75`)
      : `left:0;width:${absW}%;background:var(--acc);opacity:.72`;
    const clr = r.value === best ? 'var(--green)' : (r.value === worst && filtered.length > 1 ? 'var(--danger)' : 'var(--text2)');
    return `<div style="display:grid;grid-template-columns:30px minmax(180px,1.4fr) 1fr 100px;gap:8px;padding:4px 4px;border-bottom:1px solid rgba(30,48,72,.3);align-items:center;font-size:.64rem">
      <div style="color:var(--text3);text-align:right;font-variant-numeric:tabular-nums">${i + 1}.</div>
      <div style="color:${clr};overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.name} · ${r.type}"><span style="cursor:pointer;text-decoration:underline dotted var(--text3) 1px" onclick="crossOpenIssuer('${r.id}')">${r.name}</span><span style="color:var(--text3);font-size:.52rem"> · ${r.type}</span></div>
      <div style="position:relative;height:14px;background:var(--s1);border:1px solid var(--border)">
        ${hasNeg ? '<div style="position:absolute;left:50%;top:0;bottom:0;width:1px;background:var(--text3);opacity:.45"></div>' : ''}
        <div style="position:absolute;top:0;bottom:0;${barPos}"></div>
      </div>
      <div style="text-align:right;font-variant-numeric:tabular-nums;color:${clr};font-weight:600">${_crossFmt(r.value, metric.unit)}</div>
    </div>`;
  }).join('');
  chart.innerHTML = `
    <div style="margin-bottom:6px;font-size:.58rem;color:var(--text3);display:flex;gap:12px;flex-wrap:wrap">
      <span><strong style="color:var(--text2)">Показатель:</strong> ${metric.l}</span>
      <span><strong style="color:var(--text2)">Лидер:</strong> ${filtered[0].name} = ${_crossFmt(best, metric.unit)}</span>
      <span><strong style="color:var(--text2)">Среднее:</strong> ${_crossFmt(avg, metric.unit)}</span>
      <span><strong style="color:var(--text2)">Медиана:</strong> ${_crossFmt(median, metric.unit)}</span>
    </div>
    ${barRows}
  `;
}

// Клик по имени эмитента — переходим на страницу «📂 Отчётность»
// с выбранным эмитентом.
function crossOpenIssuer(issId){
  if(!reportsDB[issId]) return;
  repActiveIssuerId = issId;
  repActivePeriodKey = null;
  showPage('reports');
  const sel = document.getElementById('rep-issuer-sel');
  if(sel){
    sel.value = issId;
    if(typeof repSelectIssuer === 'function') repSelectIssuer();
  }
}

function crossExportCsv(){
  if(!window._crossLast || !window._crossLast.rows?.length){
    alert('Нет данных для экспорта — выберите период с доступными эмитентами.');
    return;
  }
  const {rows, ranks, periodKey} = window._crossLast;
  const metrics = _CROSS_METRICS;
  // Сводная матрица: по каждой компании — сырое значение и перцентиль
  // по всем метрикам плюс средний перцентиль.
  const header = ['name','type','year','period', ...metrics.map(m => m.k), ...metrics.map(m => m.k + '_pct'), 'avg_pct'].join(';');
  const body = rows.map(r => {
    const raw = metrics.map(m => {
      const v = r.values[m.k];
      return v == null ? '' : v.toFixed(4).replace('.', ',');
    });
    const pct = metrics.map(m => {
      const p = ranks[m.k]?.[r.id];
      return p == null ? '' : p;
    });
    const valid = pct.filter(p => p !== '');
    const avg = valid.length ? (valid.reduce((s, v) => s + (+v), 0) / valid.length).toFixed(1).replace('.', ',') : '';
    return [
      '"' + (r.name || '').replace(/"/g, '""') + '"',
      r.type, r.year, r.period,
      ...raw, ...pct, avg
    ].join(';');
  }).join('\n');
  const blob = new Blob(['\ufeff' + header + '\n' + body + '\n'], {type: 'text/csv;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `cross_${periodKey}_matrix.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

let repActiveIssuerId = null;
let repActivePeriodKey = null;
let repViewMode = 'cards';

// Приоритет типов отчётности в смешанных списках. МСФО детальнее
// и аудируются → первые. РСБУ — оперативные. ГИРБО — те же цифры РСБУ
// из госреестра ФНС, поэтому замыкает при прочих равных.
const REP_TYPE_PRIORITY = {'МСФО': 1, 'РСБУ': 2, 'ГИРБО': 3};
function repTypeRank(t){ return REP_TYPE_PRIORITY[t] ?? 4; }

// Фильтр по типу: 'all' (по умолчанию), 'no-girbo', 'only-girbo'.
// Храним в localStorage, чтобы переключение сохранялось между сессиями.
let repTypeFilter = (() => {
  try { return localStorage.getItem('repTypeFilter') || 'all'; }
  catch(_) { return 'all'; }
})();

// Возвращает отфильтрованные и отсортированные entries([key, period]):
// сначала год (asc/desc в зависимости от order), затем period, затем
// приоритет типа (МСФО → РСБУ → ГИРБО).
function repFilteredPeriods(iss, order){
  if(!iss || !iss.periods) return [];
  order = order || 'desc';
  const entries = Object.entries(iss.periods).filter(([,p]) => {
    if(!p) return false;
    if(repTypeFilter === 'no-girbo')   return p.type !== 'ГИРБО';
    if(repTypeFilter === 'only-girbo') return p.type === 'ГИРБО';
    return true;
  });
  entries.sort(([,a],[,b]) => {
    const ay = String(a.year || ''), by = String(b.year || '');
    if(ay !== by) return order === 'asc' ? ay.localeCompare(by) : by.localeCompare(ay);
    const ap = String(a.period || ''), bp = String(b.period || '');
    if(ap !== bp) return order === 'asc' ? ap.localeCompare(bp) : bp.localeCompare(ap);
    return repTypeRank(a.type) - repTypeRank(b.type);
  });
  return entries;
}

function repSetTypeFilter(mode){
  if(!['all','no-girbo','only-girbo'].includes(mode)) return;
  repTypeFilter = mode;
  try { localStorage.setItem('repTypeFilter', mode); } catch(_){}
  document.querySelectorAll('.rep-tf-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tf === mode));
  // Если активный период отфильтрован — сбросим, дальше repBuildPeriodTabs
  // выберет первый доступный.
  const iss = reportsDB[repActiveIssuerId];
  if(iss && repActivePeriodKey){
    const per = iss.periods && iss.periods[repActivePeriodKey];
    const stillVisible = per && (
      repTypeFilter === 'all' ||
      (repTypeFilter === 'no-girbo' && per.type !== 'ГИРБО') ||
      (repTypeFilter === 'only-girbo' && per.type === 'ГИРБО')
    );
    if(!stillVisible) repActivePeriodKey = null;
  }
  repBuildPeriodTabs();
  const cmpView = document.getElementById('rep-compare-view');
  if(cmpView && cmpView.style.display === 'block') repShowCompare();
}

function repInit(){
  repRebuildSelect();
  const ids = Object.keys(reportsDB);
  document.getElementById('sb-rep').textContent = ids.length;
  if(ids.length===0){
    document.getElementById('rep-empty').style.display='block';
    document.getElementById('rep-issuer-view').style.display='none';
    document.getElementById('rep-compare-view').style.display='none';
  }
  // Fill year selector in modal
  const ySel = document.getElementById('rep-np-year');
  if(ySel&&!ySel.options.length){
    const y = new Date().getFullYear();
    for(let i=y;i>=y-10;i--) ySel.add(new Option(i,i));
  }
  // Подсветим сохранённый фильтр по типу отчётности.
  document.querySelectorAll('.rep-tf-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tf === repTypeFilter));
}

function repRebuildSelect(){
  const sel = document.getElementById('rep-issuer-sel');
  const cur = sel.value;
  sel.innerHTML = '<option value="">— выберите эмитента —</option>';
  Object.entries(reportsDB).forEach(([id,iss])=>{
    const cnt = Object.keys(iss.periods||{}).length;
    sel.add(new Option(`${iss.name} (${cnt} периодов)`, id));
  });
  if(cur && reportsDB[cur]) sel.value = cur;
}

function repSelectIssuer(){
  const id = document.getElementById('rep-issuer-sel').value;
  const editBtn = document.getElementById('rep-edit-period-btn');
  const delPBtn = document.getElementById('rep-del-period-btn');
  if(!id){
    document.getElementById('rep-empty').style.display='block';
    document.getElementById('rep-issuer-view').style.display='none';
    document.getElementById('rep-compare-btn').style.display='none';
    document.getElementById('rep-add-period-btn').style.display='none';
    document.getElementById('rep-pdf-btn').style.display='none';
    document.getElementById('rep-del-issuer-btn').style.display='none';
    const ex = document.getElementById('rep-export-issuer-btn'); if(ex) ex.style.display='none';
    const ed = document.getElementById('rep-edit-issuer-btn'); if(ed) ed.style.display='none';
    const dos = document.getElementById('rep-dossier-btn'); if(dos) dos.style.display='none';
    if(editBtn) editBtn.style.display='none';
    if(delPBtn) delPBtn.style.display='none';
    return;
  }
  repActiveIssuerId = id;
  // При смене эмитента активный период сбрасываем — пусть выберется
  // самый свежий внутри repBuildPeriodTabs.
  repActivePeriodKey = null;
  document.getElementById('rep-empty').style.display='none';
  document.getElementById('rep-issuer-view').style.display='block';
  document.getElementById('rep-compare-view').style.display='none';
  document.getElementById('rep-add-period-btn').style.display='';
  document.getElementById('rep-pdf-btn').style.display='';
  document.getElementById('rep-del-issuer-btn').style.display='';
  const exBtn = document.getElementById('rep-export-issuer-btn'); if(exBtn) exBtn.style.display='';
  const edBtn = document.getElementById('rep-edit-issuer-btn'); if(edBtn) edBtn.style.display='';
  const dosBtn = document.getElementById('rep-dossier-btn'); if(dosBtn) dosBtn.style.display='';
  repBuildPeriodTabs();
  _repSyncPeriodToolbar();
}

// Видимость кнопок «✎ Редактировать / 🗑 Удалить период» — ON, если у
// активного эмитента есть выбранный период. Вызывается отовсюду, где
// меняется repActivePeriodKey.
function _repSyncPeriodToolbar(){
  const editBtn = document.getElementById('rep-edit-period-btn');
  const delPBtn = document.getElementById('rep-del-period-btn');
  const have = !!(repActiveIssuerId && repActivePeriodKey && reportsDB[repActiveIssuerId]?.periods?.[repActivePeriodKey]);
  if(editBtn) editBtn.style.display = have ? '' : 'none';
  if(delPBtn) delPBtn.style.display = have ? '' : 'none';
}

function repBuildPeriodTabs(){
  const iss = reportsDB[repActiveIssuerId]; if(!iss) return;
  const periods = repFilteredPeriods(iss, 'desc');
  const tabsEl = document.getElementById('rep-period-tabs');

  if(!periods.length){
    const msg = repTypeFilter === 'only-girbo'
      ? 'Нет ГИРБО-периодов у этого эмитента. Переключитесь на «Все» или импортируйте ГИРБО.'
      : repTypeFilter === 'no-girbo'
      ? 'Нет МСФО/РСБУ-периодов. Снимите фильтр «Без ГИРБО», чтобы увидеть ГИРБО.'
      : 'Нет периодов — добавьте первый';
    tabsEl.innerHTML = `<div style="font-size:.67rem;color:var(--text3);padding:8px 0">${msg}</div>`;
    document.getElementById('rep-cards-grid').innerHTML='';
    document.getElementById('rep-compare-btn').style.display='none';
    return;
  }

  // Если активный период не попал в фильтр — выбираем первый доступный.
  if(!repActivePeriodKey || !periods.some(([k]) => k === repActivePeriodKey)){
    repActivePeriodKey = periods[0][0];
  }

  document.getElementById('rep-compare-btn').style.display = periods.length>=2 ? '' : 'none';

  tabsEl.innerHTML = periods.map(([key,p])=>{
    const active = repActivePeriodKey===key;
    return `<button class="ptab${active?' active':''}" onclick="repSelectPeriod('${key}',this)">${p.year} ${p.period} <span style="font-size:.55rem;opacity:.7">${p.type}</span></button>`;
  }).join('');

  repRenderPeriod();
  _repSyncPeriodToolbar();
}

function repSelectPeriod(key, btn){
  repActivePeriodKey = key;
  document.querySelectorAll('#rep-period-tabs .ptab').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  repRenderPeriod();
  _repSyncPeriodToolbar();
}

function repRenderPeriod(){
  const iss = reportsDB[repActiveIssuerId]; if(!iss) return;
  const p = iss.periods[repActivePeriodKey]; if(!p) return;
  document.getElementById('rep-period-meta').textContent = `${iss.name} · ${p.year} ${p.period} ${p.type}${p.note?' · '+p.note:''}`;
  if(repViewMode==='cards') repRenderCards(p);
  else if(repViewMode==='text') repRenderText(p, iss);
  else if(repViewMode==='analysis') repRenderAnalysis(p, iss);
  else repRenderCharts(iss);
}

function repSetView(mode, btn){
  repViewMode = mode;
  ['cards','text','chart','analysis'].forEach(m=>{
    document.getElementById('rep-view-'+m).style.display = m===mode?'block':'none';
  });
  document.querySelectorAll('.rep-view-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  repRenderPeriod();
}

function repRenderCards(p){
  const ratios = repCalcRatios(p);
  const grid = document.getElementById('rep-cards-grid');

  // Значение хранится в млрд ₽. Для малых значений переключаем единицу,
  // иначе 0,03 млрд округляется до «0» и показатели выглядят пустыми.
  //   |v| >= 1        — млрд, 1 знак;
  //   0.1  <= |v| < 1 — млрд, 2 знака;
  //   0.01 <= |v| < 0.1 — млн ₽, 0 знаков;
  //   |v|  < 0.01      — млн ₽, 1 знак;
  //   чистый 0 — оставляем «0».
  const fmtRep = v => {
    if(v == null) return { text: '—', unit: '' };
    if(v === 0)   return { text: '0',  unit: 'млрд ₽' };
    const abs = Math.abs(v);
    if(abs >= 1)   return { text: v.toLocaleString('ru-RU',{maximumFractionDigits:1}), unit: 'млрд ₽' };
    if(abs >= 0.1) return { text: v.toLocaleString('ru-RU',{maximumFractionDigits:2}), unit: 'млрд ₽' };
    const inMln = v * 1000;
    if(abs >= 0.01) return { text: inMln.toLocaleString('ru-RU',{maximumFractionDigits:0}), unit: 'млн ₽' };
    return { text: inMln.toLocaleString('ru-RU',{maximumFractionDigits:1}), unit: 'млн ₽' };
  };

  // Main metrics
  const cards = REP_FIELDS.filter(f=>p[f.id]!=null).map(f=>{
    const v = p[f.id];
    const fmt = fmtRep(v);
    return `<div style="background:var(--s1);border:1px solid var(--border);padding:12px 14px">
      <div style="font-size:.58rem;letter-spacing:.08em;text-transform:uppercase;color:var(--text3);margin-bottom:4px">${f.icon} ${f.label}</div>
      <div style="font-size:1.05rem;font-weight:600;color:var(--text)">${fmt.text}</div>
      <div style="font-size:.57rem;color:var(--text3)">${fmt.unit || f.unit}</div>
    </div>`;
  }).join('');

  // Derived ratios
  const ratioCards = [
    ratios.ndE!=null ? repRatioCard('ND/EBITDA', ratios.ndE+'x', parseFloat(ratios.ndE)<2?'var(--green)':parseFloat(ratios.ndE)<4?'var(--warn)':'var(--danger)', 'Долговая нагрузка') : '',
    ratios.icr!=null ? repRatioCard('ICR (покр. %)', ratios.icr+'x', parseFloat(ratios.icr)>3?'var(--green)':parseFloat(ratios.icr)>1.5?'var(--warn)':'var(--danger)', 'EBITDA / проценты') : '',
    ratios.cur!=null ? repRatioCard('Current Ratio', ratios.cur+'x', parseFloat(ratios.cur)>1.2?'var(--green)':parseFloat(ratios.cur)>0.8?'var(--warn)':'var(--danger)', 'Ликвидность') : '',
    ratios.npm!=null ? repRatioCard('Чист. маржа', ratios.npm+'%', parseFloat(ratios.npm)>10?'var(--green)':parseFloat(ratios.npm)>0?'var(--warn)':'var(--danger)', 'Чист. прибыль / Выручка') : '',
    ratios.ebitdam!=null ? repRatioCard('EBITDA маржа', ratios.ebitdam+'%', parseFloat(ratios.ebitdam)>20?'var(--green)':parseFloat(ratios.ebitdam)>10?'var(--warn)':'var(--danger)', 'EBITDA / Выручка') : '',
    ratios.eqr!=null ? repRatioCard('Equity Ratio', ratios.eqr+'%', parseFloat(ratios.eqr)>40?'var(--green)':parseFloat(ratios.eqr)>20?'var(--warn)':'var(--danger)', 'Капитал / Активы') : '',
  ].filter(Boolean).join('');

  grid.innerHTML = `
    <div style="font-size:.57rem;letter-spacing:.12em;text-transform:uppercase;color:var(--text3);margin-bottom:8px">Исходные показатели</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;margin-bottom:16px">${cards||'<div style="color:var(--text3);font-size:.7rem">Нет данных</div>'}</div>
    ${ratioCards?`<div style="font-size:.57rem;letter-spacing:.12em;text-transform:uppercase;color:var(--text3);margin-bottom:8px">Расчётные коэффициенты</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px">${ratioCards}</div>`:''}`;
}

function repRatioCard(label, value, color, sub){
  return `<div style="background:var(--s1);border:1px solid var(--border);border-left:3px solid ${color};padding:11px 13px">
    <div style="font-size:.57rem;color:var(--text3);margin-bottom:3px">${label}</div>
    <div style="font-size:1rem;font-weight:600;color:${color}">${value}</div>
    <div style="font-size:.56rem;color:var(--text3)">${sub}</div>
  </div>`;
}

function repRenderText(p, iss){
  const r = repCalcRatios(p);
  const fmtn = v => v!=null ? v.toLocaleString('ru-RU',{maximumFractionDigits:1}) : '—';
  const pct = (a,b) => (a&&b) ? ((a-b)/Math.abs(b)*100).toFixed(1)+'%' : null;

  let lines = [];
  lines.push(`<div style="font-size:.62rem;letter-spacing:.12em;text-transform:uppercase;color:var(--acc);margin-bottom:10px">📋 ${iss.name} · ${p.year} ${p.period} ${p.type}</div>`);

  if(p.rev) lines.push(`📈 <strong>Выручка</strong>: ${fmtn(p.rev)} млрд ₽`);
  if(p.ebitda) lines.push(`💹 <strong>EBITDA</strong>: ${fmtn(p.ebitda)} млрд ₽${r.ebitdam?' (маржа '+r.ebitdam+'%)':''}`);
  if(p.np!=null) lines.push(`💰 <strong>Чистая прибыль</strong>: ${p.np>=0?'':'<span style="color:var(--danger)">'}${fmtn(p.np)} млрд ₽${p.np>=0?'':'</span>'}`);
  if(p.debt!=null) lines.push(`⚠️ <strong>Долг</strong>: ${fmtn(p.debt)} млрд ₽${p.cash?' · Кэш: '+fmtn(p.cash)+' млрд ₽':''}`);
  if(r.ndE) lines.push(`📊 <strong>ND/EBITDA</strong>: <span style="color:${parseFloat(r.ndE)<2?'var(--green)':parseFloat(r.ndE)<4?'var(--warn)':'var(--danger)'}">${r.ndE}x</span>${parseFloat(r.ndE)<2?' — низкая нагрузка ✓':parseFloat(r.ndE)<4?' — умеренно':' — высокая нагрузка ⚠️'}`);
  if(r.icr) lines.push(`🔐 <strong>Покрытие процентов</strong>: <span style="color:${parseFloat(r.icr)>3?'var(--green)':parseFloat(r.icr)>1.5?'var(--warn)':'var(--danger)'}">${r.icr}x</span>${parseFloat(r.icr)>3?' — комфортно ✓':parseFloat(r.icr)>1?'':' — риск ⚠️'}`);
  if(r.cur) lines.push(`💧 <strong>Ликвидность</strong>: ${r.cur}x${parseFloat(r.cur)>1.2?' — достаточная ✓':parseFloat(r.cur)>0.8?' — умеренная':' — низкая ⚠️'}`);
  if(r.eqr) lines.push(`🔷 <strong>Доля капитала</strong>: ${r.eqr}%${parseFloat(r.eqr)>40?' — высокая независимость ✓':parseFloat(r.eqr)>20?' — умеренный леверидж':' — высокий леверидж ⚠️'}`);
  if(p.note) lines.push(`<br>📝 <em style="color:var(--text2)">${p.note}</em>`);

  document.getElementById('rep-text-block').querySelector('.card-body').innerHTML = lines.join('<br>');
}

function repRenderCharts(iss){
  const area = document.getElementById('rep-chart-area');
  const periods = repFilteredPeriods(iss, 'asc');
  if(periods.length<2){
    const hint = repTypeFilter !== 'all'
      ? '<br><span style="font-size:.6rem;color:var(--text3)">Сейчас активен фильтр «'+(repTypeFilter==='only-girbo'?'Только ГИРБО':'Без ГИРБО')+'» — попробуйте «Все».</span>'
      : '';
    area.innerHTML=`<div class="empty"><div class="ei">📈</div><p>Нужно минимум 2 периода для сравнения динамики${hint}</p></div>`;
    return;
  }

  // Метрики: higher=true — рост хорошо (зелёный), higher=false — рост плохо (красный).
  const metrics = [
    {key:'rev',    label:'Выручка',              higher:true},
    {key:'ebitda', label:'EBITDA',               higher:true},
    {key:'ebit',   label:'EBIT',                 higher:true},
    {key:'np',     label:'Чистая прибыль',       higher:true},
    {key:'assets', label:'Активы',               higher:true},
    {key:'eq',     label:'Собственный капитал',  higher:true},
    {key:'cash',   label:'Денежные средства',    higher:true},
    {key:'ret',    label:'Нераспр. прибыль',     higher:true},
    {key:'debt',   label:'Долг',                 higher:false},
    {key:'int',    label:'Процентные расходы',   higher:false},
    {key:'cl',     label:'Краткосрочные обяз.',  higher:false},
    {key:'ca',     label:'Оборотные активы',     higher:true},
  ];

  const fmtV = v => v==null ? '—' : v.toLocaleString('ru-RU',{maximumFractionDigits:2}) + ' млрд';
  const sign = n => n>0 ? '+' : '';

  // Строим карточку-пару для двух соседних периодов
  function pairCard(prev, curr){
    const [ka,pa] = prev;
    const [kb,pb] = curr;
    const headerL = `${pa.year} ${pa.period} ${pa.type}`;
    const headerR = `${pb.year} ${pb.period} ${pb.type}`;

    const rows = metrics.map(m=>{
      const a = pa[m.key], b = pb[m.key];
      if(a==null || b==null) return '';
      // Знак изменения в процентах. Если база ≈ 0, отдаём n/a.
      let pct = null, dir = 'flat';
      if(Math.abs(a) > 1e-9){
        pct = (b - a) / Math.abs(a) * 100;
        if(pct >  0.5) dir = 'up';
        else if(pct < -0.5) dir = 'down';
      } else if(b !== 0){
        dir = b > 0 ? 'up' : 'down'; // с нуля — только направление
      }

      // Цвет: учитываем что для debt/int/cl рост = плохо.
      const good = dir==='up' ? m.higher : (dir==='down' ? !m.higher : null);
      const color = good===null ? 'var(--text2)' : good ? 'var(--green)' : 'var(--danger)';
      const arrow = dir==='up' ? '▲' : dir==='down' ? '▼' : '—';

      // Полоса: ширина ∝ min(|Δ%|, 100%), со знаком слева/справа от центра.
      const pctClamped = pct==null ? 0 : Math.max(-100, Math.min(100, pct));
      const w = Math.abs(pctClamped); // 0..100
      const barHtml = pct==null ? '' : `
        <div style="position:relative;height:6px;background:var(--border);margin-top:5px">
          <div style="position:absolute;left:50%;top:0;bottom:0;width:1px;background:var(--text3);opacity:.5"></div>
          ${pctClamped>=0
            ? `<div style="position:absolute;left:50%;top:0;bottom:0;width:${w/2}%;background:${color};opacity:.65"></div>`
            : `<div style="position:absolute;right:50%;top:0;bottom:0;width:${w/2}%;background:${color};opacity:.65"></div>`}
        </div>`;

      const pctText = pct==null ? 'н/д' : `${sign(pct)}${pct.toFixed(1)}%`;

      return `<div style="padding:10px 0;border-bottom:1px solid rgba(30,48,72,.4)">
        <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:3px">
          <span style="font-size:.72rem;font-weight:600;color:var(--text);min-width:160px">${m.label}</span>
          <span style="font-size:.64rem;color:var(--text3);margin-left:auto;font-variant-numeric:tabular-nums">${fmtV(a)} → ${fmtV(b)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:.78rem;font-weight:700;color:${color};min-width:80px">${arrow} ${pctText}</span>
          <div style="flex:1;min-width:40px">${barHtml}</div>
        </div>
      </div>`;
    }).filter(Boolean).join('');

    // Сводка по производным коэффициентам (ND/EBITDA, ICR, Equity Ratio, маржа)
    const ra = repCalcRatios(pa), rb = repCalcRatios(pb);
    const ratioRow = (label, va, vb, unit, betterHigher) => {
      if(va==null || vb==null) return '';
      const a = parseFloat(va), b = parseFloat(vb);
      const diff = b - a;
      const abs = Math.abs(a) > 1e-9 ? (diff/Math.abs(a)*100) : null;
      const dir = Math.abs(diff) < 0.005 ? 'flat' : diff > 0 ? 'up' : 'down';
      const good = dir==='up' ? betterHigher : (dir==='down' ? !betterHigher : null);
      const color = good===null ? 'var(--text2)' : good ? 'var(--green)' : 'var(--danger)';
      const arrow = dir==='up' ? '▲' : dir==='down' ? '▼' : '—';
      return `<div style="display:flex;align-items:baseline;gap:10px;padding:6px 0;border-bottom:1px dashed rgba(30,48,72,.4);font-size:.68rem">
        <span style="color:var(--text2);min-width:140px">${label}</span>
        <span style="color:var(--text);font-variant-numeric:tabular-nums">${a.toFixed(2)}${unit} → ${b.toFixed(2)}${unit}</span>
        <span style="color:${color};margin-left:auto;font-weight:600">${arrow} ${diff>0?'+':''}${diff.toFixed(2)}${unit}${abs!=null?` (${abs>0?'+':''}${abs.toFixed(1)}%)`:''}</span>
      </div>`;
    };

    const ratios = [
      ratioRow('ND/EBITDA',      ra.ndE,    rb.ndE,    'x', false),
      ratioRow('ICR (покрытие)', ra.icr,    rb.icr,    'x', true),
      ratioRow('Current Ratio',  ra.cur,    rb.cur,    'x', true),
      ratioRow('EBITDA маржа',   ra.ebitdam,rb.ebitdam,'%', true),
      ratioRow('Чист. маржа',    ra.npm,    rb.npm,    '%', true),
      ratioRow('Equity Ratio',   ra.eqr,    rb.eqr,    '%', true),
    ].filter(Boolean).join('');

    return `<div class="card" style="margin-bottom:14px">
      <div class="card-hdr">
        <span style="color:var(--text2);font-size:.67rem">${headerL}</span>
        <span style="color:var(--text3);margin:0 6px">→</span>
        <span style="color:var(--acc);font-size:.67rem">${headerR}</span>
      </div>
      <div class="card-body">
        ${rows || '<div style="color:var(--text3);font-size:.7rem;padding:6px 0">Нет перекрывающихся числовых полей для расчёта динамики.</div>'}
        ${ratios ? `
          <div style="font-size:.57rem;letter-spacing:.12em;text-transform:uppercase;color:var(--text3);margin:14px 0 6px">Производные коэффициенты</div>
          ${ratios}` : ''}
      </div>
    </div>`;
  }

  const cards = [];
  for(let i=0; i<periods.length-1; i++){
    cards.push(pairCard(periods[i], periods[i+1]));
  }

  area.innerHTML = `
    <div style="font-size:.6rem;color:var(--text3);margin-bottom:10px">
      Сравнение между соседними периодами. ${periods.length>2?'Несколько пар — сверху старые, снизу свежие.':''} Цвет учитывает знак: рост долга — красный, рост выручки — зелёный.
    </div>
    ${cards.join('')}
  `;
}

function repRenderAnalysis(p, iss){
  const area = document.getElementById('rep-analysis-area');
  // 1) Если у периода сохранён снэпшот анализа — показываем его (старое поведение).
  if(p.analysisHTML){
    area.innerHTML = p.analysisHTML;
    return;
  }
  // 2) Иначе строим шкалы на лету из числовых полей периода.
  const d = {
    co:     iss?.name || 'Эмитент',
    ind:    iss?.ind || 'other',
    bond:   '', rating: '',
    repType:p.type   || '',
    period: [p.year,p.period].filter(Boolean).join(' '),
    rev:    p.rev,
    ebitda: p.ebitda,
    ebit:   p.ebit,
    np:     p.np,
    intExp: p.int,
    tax:    p.tax,
    dep:    null,
    assets: p.assets,
    ca:     p.ca,
    cl:     p.cl,
    debt:   p.debt,
    cash:   p.cash,
    eq:     p.eq,
    sz:     null,
    peak:   null,
  };
  window._lastAnalysis = { d, opts:{mode:'archive'}, containerId:'rep-analysis-area' };
  area.innerHTML = buildAnalysisHTML(d, {mode:'archive'});
}

// ── Compare ──
function repShowCompare(){
  const iss = reportsDB[repActiveIssuerId]; if(!iss) return;
  const periods = repFilteredPeriods(iss, 'desc');
  if(periods.length < 2){
    alert('Для сравнения нужно ≥2 периода после фильтра. Сейчас доступно: '+periods.length+'.');
    return;
  }
  ['rep-cmp-a','rep-cmp-b'].forEach((selId,si)=>{
    const sel = document.getElementById(selId);
    sel.innerHTML = periods.map(([k,p],i)=>`<option value="${k}" ${i===si?'selected':''}>${p.year} ${p.period} ${p.type}</option>`).join('');
  });
  document.getElementById('rep-issuer-view').style.display='none';
  document.getElementById('rep-compare-view').style.display='block';
  repRenderCompare();
}
function repHideCompare(){
  document.getElementById('rep-compare-view').style.display='none';
  document.getElementById('rep-issuer-view').style.display='block';
}
function repRenderCompare(){
  const iss = reportsDB[repActiveIssuerId]; if(!iss) return;
  const ka = document.getElementById('rep-cmp-a').value;
  const kb = document.getElementById('rep-cmp-b').value;
  const pa = iss.periods[ka], pb = iss.periods[kb];
  if(!pa||!pb) return;

  const ra = repCalcRatios(pa), rb = repCalcRatios(pb);

  const row = (label, icon, va, vb, goodDir) => {
    if(va==null&&vb==null) return '';
    const fmtV = v => v!=null ? v.toLocaleString('ru-RU',{maximumFractionDigits:2}) : '—';
    let delta='', deltaColor='var(--text3)';
    if(va!=null&&vb!=null){
      const d = ((vb-va)/Math.abs(va)*100);
      const isGood = goodDir==='up'?d>=0:d<=0;
      deltaColor = Math.abs(d)<1?'var(--text3)':isGood?'var(--green)':'var(--danger)';
      delta = `<span style="color:${deltaColor}">${d>=0?'▲+':'▼'}${Math.abs(d).toFixed(1)}%</span>`;
    }
    return `<tr>
      <td style="color:var(--text2)">${icon} ${label}</td>
      <td style="text-align:right">${fmtV(va)}</td>
      <td style="text-align:right">${fmtV(vb)}</td>
      <td style="text-align:right">${delta}</td>
    </tr>`;
  };

  const rows = [
    ...REP_FIELDS.map(f=>row(f.label,f.icon,pa[f.id],pb[f.id],f.good)),
    `<tr><td colspan="4" style="padding:8px 11px 4px;font-size:.56rem;letter-spacing:.12em;text-transform:uppercase;color:var(--text3)">Коэффициенты</td></tr>`,
    row('ND/EBITDA','📊',ra.ndE!=null?parseFloat(ra.ndE):null,rb.ndE!=null?parseFloat(rb.ndE):null,'down'),
    row('ICR (покр. %)','🔐',ra.icr!=null?parseFloat(ra.icr):null,rb.icr!=null?parseFloat(rb.icr):null,'up'),
    row('Current Ratio','💧',ra.cur!=null?parseFloat(ra.cur):null,rb.cur!=null?parseFloat(rb.cur):null,'up'),
    row('EBITDA маржа %','💹',ra.ebitdam!=null?parseFloat(ra.ebitdam):null,rb.ebitdam!=null?parseFloat(rb.ebitdam):null,'up'),
    row('Чист. маржа %','💰',ra.npm!=null?parseFloat(ra.npm):null,rb.npm!=null?parseFloat(rb.npm):null,'up'),
    row('Equity Ratio %','🔷',ra.eqr!=null?parseFloat(ra.eqr):null,rb.eqr!=null?parseFloat(rb.eqr):null,'up'),
  ].filter(Boolean).join('');

  document.getElementById('rep-compare-table').innerHTML = `
    <div class="tbl-wrap"><table>
      <thead><tr>
        <th>Показатель</th>
        <th style="text-align:right">${pa.year} ${pa.period} ${pa.type}</th>
        <th style="text-align:right">${pb.year} ${pb.period} ${pb.type}</th>
        <th style="text-align:right">Δ изм.</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

// ── CRUD ──
function repNiClearForm(){
  document.getElementById('rep-ni-id').value = '';
  document.getElementById('rep-ni-name').value = '';
  document.getElementById('rep-ni-ind').value = 'other';
  document.getElementById('rep-ni-isin').value = '';
  document.getElementById('rep-ni-inn').value = '';
  document.getElementById('rep-ni-ogrn').value = '';
  document.getElementById('rep-ni-disclosure').value = '';
  const r = document.getElementById('rep-ni-rating'); if(r) r.value = '';
  const st = document.getElementById('rep-ni-moex-status'); if(st) st.textContent = '';
}
function repNewIssuerModal(){
  repNiClearForm();
  document.getElementById('rep-ni-title').innerHTML = 'Новый эмитент <button class="modal-x" onclick="closeModal(\'modal-rep-issuer\')">✕</button>';
  document.getElementById('rep-ni-save').textContent = 'Создать';
  document.getElementById('modal-rep-issuer').classList.add('open');
}
function repEditIssuerModal(){
  if(!repActiveIssuerId) return;
  const iss = reportsDB[repActiveIssuerId];
  if(!iss) return;
  repNiClearForm();
  document.getElementById('rep-ni-id').value = repActiveIssuerId;
  document.getElementById('rep-ni-name').value = iss.name || '';
  document.getElementById('rep-ni-ind').value = iss.ind || 'other';
  document.getElementById('rep-ni-isin').value = iss.isin || '';
  document.getElementById('rep-ni-inn').value = iss.inn || '';
  document.getElementById('rep-ni-ogrn').value = iss.ogrn || '';
  document.getElementById('rep-ni-disclosure').value = iss.disclosureUrl || '';
  const r = document.getElementById('rep-ni-rating'); if(r) r.value = iss.rating || '';
  document.getElementById('rep-ni-title').innerHTML = 'Редактировать эмитента <button class="modal-x" onclick="closeModal(\'modal-rep-issuer\')">✕</button>';
  document.getElementById('rep-ni-save').textContent = '💾 Сохранить';
  document.getElementById('modal-rep-issuer').classList.add('open');
}
function repSaveIssuerFromModal(){
  const editId = document.getElementById('rep-ni-id').value.trim();
  const name = document.getElementById('rep-ni-name').value.trim();
  if(!name){ alert('Укажите название компании.'); return; }
  const ind = document.getElementById('rep-ni-ind').value;
  const isin = document.getElementById('rep-ni-isin').value.trim().toUpperCase();
  const inn  = document.getElementById('rep-ni-inn').value.trim();
  const ogrn = document.getElementById('rep-ni-ogrn').value.trim();
  const disclosureUrl = document.getElementById('rep-ni-disclosure').value.trim();
  const rating = (document.getElementById('rep-ni-rating')?.value || '').trim();
  if(editId && reportsDB[editId]){
    // Редактирование: сохраняем periods/note и прочие поля
    const cur = reportsDB[editId];
    cur.name = name; cur.ind = ind;
    cur.isin = isin || undefined;
    cur.inn = inn || undefined;
    cur.ogrn = ogrn || undefined;
    cur.disclosureUrl = disclosureUrl || undefined;
    cur.rating = rating || undefined;
    save(); closeModal('modal-rep-issuer');
    repRebuildSelect();
    document.getElementById('rep-issuer-sel').value = editId;
    repSelectIssuer();
    return;
  }
  // Новый эмитент
  const id = 'iss_' + Date.now();
  reportsDB[id] = {
    name, ind, periods:{},
    isin: isin || undefined,
    inn: inn || undefined,
    ogrn: ogrn || undefined,
    disclosureUrl: disclosureUrl || undefined,
    rating: rating || undefined,
  };
  save(); closeModal('modal-rep-issuer');
  repRebuildSelect();
  document.getElementById('rep-issuer-sel').value = id;
  repSelectIssuer();
  document.getElementById('sb-rep').textContent = Object.keys(reportsDB).length;
}

// Бэкап-алиас: в коде мог остаться старый вызов.
function repCreateIssuer(){ return repSaveIssuerFromModal(); }

// Автоподтягивание ИНН/ОГРН/имени с MOEX ISS по ISIN.
// MOEX отдаёт описание бумаги в блоке description; имена полей плавают
// между выпусками (INN / ISSUERINN / EMITTER_INN и т.п.) — пробуем все.
async function repNiFetchMoex(){
  const isinInput = document.getElementById('rep-ni-isin');
  const isin = (isinInput.value || '').trim().toUpperCase();
  const st = document.getElementById('rep-ni-moex-status');
  if(!isin){ st.style.color='var(--danger)'; st.textContent='Впишите ISIN, чтобы подтянуть данные с MOEX.'; return; }
  if(typeof moexFetch !== 'function'){ st.style.color='var(--danger)'; st.textContent='MOEX-клиент недоступен.'; return; }
  st.style.color = 'var(--warn)';
  st.textContent = '⏳ Запрашиваю MOEX по ' + isin + '...';
  try {
    // 1) Находим SECID (ISIN может и сам быть secid'ом — пробуем прямой запрос)
    let secid = isin;
    let desc = null;
    try { desc = await moexFetch(`/iss/securities/${encodeURIComponent(secid)}.json`); }
    catch(_){ desc = null; }
    const hasRows = desc && desc.description && Array.isArray(desc.description.data) && desc.description.data.length;
    if(!hasRows){
      const s = await moexFetch(`/iss/securities.json?q=${encodeURIComponent(isin)}&limit=3`);
      const cols = s?.securities?.columns || [];
      const rows = s?.securities?.data || [];
      const secidIdx = cols.indexOf('secid');
      if(rows.length && secidIdx >= 0){
        secid = rows[0][secidIdx];
        desc = await moexFetch(`/iss/securities/${encodeURIComponent(secid)}.json`);
      }
    }
    const map = (typeof parseMoexDesc === 'function' ? parseMoexDesc(desc||{}) : {});
    // Имена полей ИНН/ОГРН в MOEX плавают — тянем первое непустое
    const pick = keys => { for(const k of keys){ if(map[k]) return String(map[k]).trim(); } return ''; };
    const inn  = pick(['INN','ISSUERINN','EMITTER_INN','EMITENT_INN']);
    const ogrn = pick(['OGRN','ISSUEROGRN','EMITTER_OGRN','EMITENT_OGRN']);
    const issuerName = pick(['ISSUERNAME','EMITTER_NAME','EMITENT_NAME']);
    let filled = 0;
    if(inn){ document.getElementById('rep-ni-inn').value = inn; filled++; }
    if(ogrn){ document.getElementById('rep-ni-ogrn').value = ogrn; filled++; }
    // Если название пустое — подставим то, что прислал MOEX (пользователь увидит и сможет перебить)
    const nameEl = document.getElementById('rep-ni-name');
    if(issuerName && !nameEl.value.trim()){ nameEl.value = issuerName; filled++; }
    if(filled){
      st.style.color = 'var(--green)';
      st.textContent = `✓ С MOEX: ${[inn&&'ИНН',ogrn&&'ОГРН',issuerName&&'имя'].filter(Boolean).join(' · ')} (${secid})`;
    } else {
      st.style.color = 'var(--warn)';
      st.textContent = 'MOEX вернул описание, но без ИНН/ОГРН. Впишите вручную.';
    }
  } catch(e){
    st.style.color = 'var(--danger)';
    st.textContent = 'MOEX не ответил: ' + (e.message || e);
  }
}
function repDeleteIssuer(){
  if(!repActiveIssuerId||!confirm('Удалить эмитента и все его отчёты?')) return;
  delete reportsDB[repActiveIssuerId];
  repActiveIssuerId=null; repActivePeriodKey=null;
  save(); repInit();
  document.getElementById('rep-issuer-view').style.display='none';
  document.getElementById('rep-empty').style.display='block';
}

// Экспорт одного эмитента: удобно перетаскивать между устройствами
// одну компанию, не таская весь портфель. Формат совместим с общим
// импортом — просто reportsDB с единственным ключом.
function repExportIssuer(){
  if(!repActiveIssuerId) return;
  const iss = reportsDB[repActiveIssuerId];
  if(!iss){ alert('Эмитент не найден'); return; }
  // Экспортируем в схеме bondan/issuer/v1 — плоский файл одного эмитента.
  // Импорт это распознаёт и оборачивает обратно в reportsDB.
  const payload = {
    schema: 'bondan/issuer/v1',
    name: iss.name,
    ind: iss.ind || 'other',
    note: iss.note || '',
    isin: iss.isin || undefined,
    inn: iss.inn || undefined,
    ogrn: iss.ogrn || undefined,
    disclosureUrl: iss.disclosureUrl || undefined,
    rating: iss.rating || undefined,
    periods: iss.periods || {},
  };
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], {type:'application/json'});
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  const safe = (iss.name||'issuer').replace(/[^\wа-яА-ЯёЁ0-9\-]+/g,'_').slice(0,60);
  a.href = url;
  a.download = `bondanalytics_${safe}_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// Прямой shortcut для загрузки PDF: открывает ту же модалку создания
// периода, но сразу триггерит файловый диалог — пользователю не нужно
// искать кнопку внутри формы. После парсинга он только выбирает
// год/период/тип и жмёт «Сохранить».
function repUploadFileShortcut(){
  if(!repActiveIssuerId){ alert('Сначала выберите эмитента'); return; }
  repNewPeriodModal();
  setTimeout(()=>{
    const f = document.getElementById('rep-np-file');
    if(f) f.click();
  }, 120);
}

function repToggleRawText(){
  const ta = document.getElementById('rep-np-raw-text');
  const btn = document.getElementById('rep-np-raw-btn');
  if(!ta) return;
  if(ta.style.display === 'none'){
    ta.style.display = 'block';
    if(btn) btn.textContent = '📄 Скрыть текст';
  } else {
    ta.style.display = 'none';
    if(btn) btn.textContent = '📄 Показать распознанный текст';
  }
}

// ── Мета + сверка с эталоном ─────────────────────────────────────
// Показываем распознанный тип отчёта (МСФО/РСБУ, группа/юрлицо,
// ИНН, название) над логом парсинга. Это само по себе полезно (видно,
// что поняло приложение) и служит контекстом для кнопки сверки.
function repRenderMeta(meta){
  const box = document.getElementById('rep-np-meta-wrap');
  const refWrap = document.getElementById('rep-np-ref-wrap');
  if(!box) return;
  if(!meta || (!meta.standard && !meta.scope && !meta.inn && !meta.orgName)){
    box.style.display = 'none';
    if(refWrap) refWrap.style.display = 'block'; // кнопку импорта всё равно показываем
    return;
  }
  const parts = [];
  if(meta.standard){
    parts.push(`<strong style="color:var(--acc)">${meta.standard}</strong>`);
  }
  if(meta.scope){
    parts.push(meta.scope === 'group'
      ? '<span style="color:var(--warn)">группа (consolidated)</span>'
      : '<span style="color:var(--green)">юрлицо (standalone)</span>');
  }
  if(meta.orgName) parts.push(`<span style="color:var(--text)">${meta.orgName.replace(/</g,'&lt;')}</span>`);
  if(meta.inn) parts.push(`<span style="color:var(--text3)">ИНН ${meta.inn}</span>`);
  box.innerHTML = '📄 ' + parts.join(' · ');
  box.style.display = 'block';
  if(refWrap) refWrap.style.display = 'block';
}

function repOnRefFile(input){
  const f = input.files[0];
  if(!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const raw = JSON.parse(reader.result);
      const ref = normaliseReference(raw);
      if(!ref){
        alert('Формат JSON не распознан. Поддерживаются:\n• наш формат (schema: "bondan/ref/v1")\n• сырой JSON из bo.nalog.gov.ru (поля current1110, current2110 и т.п.)');
        return;
      }
      window._reportReference = ref;
      // Сохраняем в локальный кэш, чтобы при следующей загрузке того же
      // отчёта (тот же ИНН+период) сверка применилась автоматически.
      if(ref.inn) _saveRefToLocal(ref);
      repRenderRefResult();
    } catch(e){
      alert('Не удалось прочитать JSON: ' + e.message);
    }
  };
  reader.readAsText(f);
  input.value = '';
}

function repOpenGirboForInn(){
  const meta = window._reportMeta;
  const inn = meta?.inn;
  if(!inn){
    const manual = prompt('ИНН не распознан в отчёте. Введите вручную (10 или 12 цифр):', '');
    if(!manual) return;
    if(!/^\d{10}(\d{2})?$/.test(manual.trim())){
      alert('ИНН должен быть 10 цифр (юрлицо) или 12 (ИП).');
      return;
    }
    window.open('https://bo.nalog.gov.ru/advanced-search/organizations/search?query=' + encodeURIComponent(manual.trim()), '_blank', 'noopener');
  } else {
    window.open(girboLinkForInn(inn), '_blank', 'noopener');
  }
  alert('1. На странице ГИР БО откройте карточку компании.\n2. Найдите нужный отчётный год → «Скачать» или «Открыть JSON».\n3. Сохраните файл на диск.\n4. Вернитесь и нажмите «📋 Импорт JSON».\n\nПодробнее: ГИР БО отдаёт только РСБУ-отчётность юрлица. Если ваш загруженный отчёт — МСФО-группа, приложение покажет это как справочную информацию, а не прямую сверку.');
}

function repExportCurrentAsRef(){
  const values = {};
  ['rep-np-rev','rep-np-ebitda','rep-np-ebit','rep-np-np','rep-np-int',
   'rep-np-assets','rep-np-ca','rep-np-cl','rep-np-debt','rep-np-cash',
   'rep-np-ret','rep-np-eq'].forEach(id => {
    const v = parseFloat(document.getElementById(id)?.value);
    if(!isNaN(v)) values[id] = v;
  });
  if(!Object.keys(values).length){
    alert('В форме нет значений для экспорта. Сначала заполните хотя бы одно поле.');
    return;
  }
  const meta = window._reportMeta || {};
  const periodRaw = document.getElementById('rep-np-year')?.value || '';
  const periodLabel = _periodLabel(periodRaw.match?.(/(\d{4})/)?.[1] || periodRaw, periodRaw);
  // Если в текущем эталоне (или подтянутой истории) уже есть series —
  // мёрджим её и добавляем/перезаписываем текущий период.
  const existing = window._reportReference?.series || null;
  const series = _mergeSeries(existing, {[periodLabel]: values}) || {[periodLabel]: values};
  const ref = {
    schema: 'bondan/ref/v1',
    company: meta.orgName || '',
    inn: meta.inn || '',
    standard: meta.standard || '',
    scope: meta.scope || '',
    period: periodRaw,
    unit: 'млрд ₽',
    source: 'manual export',
    note: 'Экспортировано из БондАналитик. Содержит весь накопленный ряд периодов.',
    values,
    series
  };
  const blob = new Blob([JSON.stringify(ref, null, 2)], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'reference-' + (meta.inn || meta.orgName?.replace(/[^a-zа-я0-9]+/gi,'-').slice(0,30) || 'manual') + '-' + (ref.period||'') + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function repClearReference(){
  window._reportReference = null;
  const box = document.getElementById('rep-np-ref-result');
  if(box) box.innerHTML = '';
}

// Кнопка «📡 5 лет» — подтянуть многолетнюю историю РСБУ из ГИР БО
// по распознанному ИНН. Работает только для standalone-юрлиц
// (это всё, что у ФНС в открытом доступе). Если загруженный отчёт —
// МСФО-группа, цифры будут существенно меньше консолидированных,
// и блок сверки явно это подсветит как «не прямое сравнение».
async function repFetchGirboSeries(){
  const meta = window._reportMeta || {};
  let inn = meta.inn;
  if(!inn){
    inn = prompt('ИНН не распознан в отчёте. Введите вручную (10 или 12 цифр):', '');
    if(!inn) return;
    inn = inn.trim();
    if(!/^\d{10}(\d{2})?$/.test(inn)){ alert('ИНН должен быть 10 (юрлицо) или 12 (ИП) цифр.'); return; }
  }
  const box = document.getElementById('rep-np-ref-result');
  const wrap = document.getElementById('rep-np-ref-wrap');
  if(wrap) wrap.style.display = 'block';
  if(box) box.innerHTML = `<div style="color:var(--warn);font-size:.6rem">⏳ Запрос ГИР БО по ИНН ${inn} через прокси <code>${_girboProxyBase()}</code>…</div>`;
  try {
    const data = await fetchGirboByInn(inn, 5);
    if(!data.count){
      if(box) box.innerHTML = `<div style="color:var(--danger);font-size:.6rem">❌ ГИР БО ничего не вернул (компания исключена из публикации? нет годовых отчётов?). Ошибки: ${data.errors.length}.</div>`;
      return;
    }
    // Соберём ref в нашем формате и применим как обычный.
    const baseSeries = window._reportReference?.series || null;
    const merged = _mergeSeries(baseSeries, data.series);
    const newest = Object.keys(merged).sort((a,b) => _periodSortKey(b) - _periodSortKey(a))[0];
    const ref = {
      values: merged[newest],
      series: merged,
      standard: 'РСБУ',
      scope: 'standalone',
      company: data.company || meta.orgName,
      inn: data.inn,
      period: newest,
      source: 'ГИР БО (прокси)',
      unit: 'млрд ₽',
      format: 'girbo-multi',
      _autoSource: 'ГИР БО'
    };
    window._reportReference = ref;
    // Сохраняем в локальный кэш — при следующем открытии того же
    // отчёта подтянется автоматически без запроса.
    _saveRefToLocal({...ref, schema: 'bondan/ref/v1'});
    repRenderRefResult();
  } catch(e){
    if(box) box.innerHTML = `<div style="color:var(--danger);font-size:.6rem">❌ ${e.message}<br><span style="color:var(--text3)">Если прокси не работает — поменяйте его в «⚡ Sync» → «📡 ГИР БО — прокси». Альтернативы: corsproxy.io, ваш CF Worker.</span></div>`;
  }
}

// Массовый экспорт: скачать ВСЕ сохранённые на устройстве эталоны
// одним JSON-файлом. Нужен как оффлайн-бэкап / для переноса между
// устройствами без GitHub Gist (флешка, e-mail, облачный диск).
function repExportAllRefs(){
  let arr = [];
  try { arr = JSON.parse(localStorage.getItem('bondan_refs') || '[]'); } catch(e){}
  if(!arr.length){
    alert('В локальной коллекции эталонов пока пусто. Сначала импортируйте/сохраните хотя бы один.');
    return;
  }
  const bundle = {
    schema: 'bondan/ref-bundle/v1',
    note: 'Коллекция эталонов БондАналитик. Импортируется кнопкой «📥 Все».',
    savedAt: new Date().toISOString(),
    count: arr.length,
    entries: arr
  };
  const blob = new Blob([JSON.stringify(bundle, null, 2)], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'bondan-refs-' + new Date().toISOString().slice(0,10) + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Массовый импорт коллекции: принимает:
//   • bundle (schema: 'bondan/ref-bundle/v1') — массив под ключом `entries`;
//   • обычный ref-catalogue (schema: 'bondan/ref-catalogue/v1');
//   • голый массив эталонов;
//   • одиночный эталон (тогда это то же что и repOnRefFile).
// Сливает с локальным по ключу «ИНН+период», новые записи перезаписывают
// старые (при желании можно будет сделать выбор «заменить/слить»).
function repImportAllRefs(input){
  const f = input.files[0];
  if(!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const raw = JSON.parse(reader.result);
      let entries = [];
      if(raw && raw.schema && /bondan\/ref-bundle/.test(raw.schema)) entries = raw.entries || [];
      else if(raw && raw.schema && /bondan\/ref-catalogue/.test(raw.schema)) entries = raw.entries || [];
      else if(Array.isArray(raw)) entries = raw;
      else if(raw && raw.schema && /bondan\/ref\b/.test(raw.schema)) entries = [raw];
      if(!entries.length){
        alert('В файле нет эталонов или формат не распознан.');
        return;
      }
      let local = [];
      try { local = JSON.parse(localStorage.getItem('bondan_refs') || '[]'); } catch(e){}
      const keyOf = r => (r.inn || '') + '|' + _normalisePeriod(r.period);
      const merged = new Map();
      for(const r of local)   merged.set(keyOf(r), r);
      let added = 0, replaced = 0;
      for(const r of entries){
        const k = keyOf(r);
        if(merged.has(k)) replaced++;
        else added++;
        merged.set(k, r);
      }
      const arr = [...merged.values()];
      localStorage.setItem('bondan_refs', JSON.stringify(arr));
      if(window._refCatalogue) window._refCatalogue.localEntries = arr;
      alert(`Импортировано: ${entries.length}\nНовых: ${added}, заменено: ${replaced}.\nВсего в коллекции: ${arr.length}.`);
      // Если текущий отчёт распознан и совпал по ИНН — применим.
      if(window._reportMeta){
        const period = document.getElementById('rep-np-year')?.value;
        const found = _findRefFor(window._reportMeta, period);
        if(found){
          const ref = normaliseReference(found) || found;
          ref._autoSource = 'кэш';
          window._reportReference = ref;
          repRenderRefResult();
        }
      }
    } catch(e){
      alert('Не удалось прочитать JSON: ' + e.message);
    }
  };
  reader.readAsText(f);
  input.value = '';
}

// Краткие подписи показателей — одни и те же для матрицы и графика.
const _REF_LABELS = {
  'rep-np-rev':'Выручка','rep-np-ebitda':'EBITDA','rep-np-ebit':'EBIT',
  'rep-np-np':'ЧП','rep-np-int':'Проценты','rep-np-assets':'Активы',
  'rep-np-ca':'Обор. активы','rep-np-cl':'Кр. обяз.','rep-np-debt':'Долг',
  'rep-np-cash':'ДС','rep-np-ret':'Нераспр.','rep-np-eq':'Капитал'
};
const _REF_FIDS_ORDER = [
  'rep-np-rev','rep-np-ebitda','rep-np-ebit','rep-np-np','rep-np-int',
  'rep-np-assets','rep-np-ca','rep-np-cl','rep-np-debt','rep-np-cash',
  'rep-np-ret','rep-np-eq'
];

function repRenderRefResult(){
  const box = document.getElementById('rep-np-ref-result');
  const wrap = document.getElementById('rep-np-ref-wrap');
  if(!box || !wrap) return;
  wrap.style.display = 'block';
  const ref = window._reportReference;
  if(!ref){ box.innerHTML = ''; return; }
  const meta = window._reportMeta || {};

  // Совместимость scope (МСФО-группа vs РСБУ-standalone).
  let warning = '';
  const scopeMismatch = meta.scope && ref.scope && meta.scope !== ref.scope;
  if(scopeMismatch){
    warning = `<div style="color:var(--warn);padding:5px 8px;background:rgba(250,200,80,.08);border-left:2px solid var(--warn);margin-bottom:6px;font-size:.6rem;line-height:1.5">⚠️ <strong>НЕ прямое сравнение.</strong> Эталон — ${ref.scope === 'standalone' ? '<strong>РСБУ юрлица</strong>' : '<strong>МСФО группы</strong>'}, отчёт — <strong>${meta.scope === 'group' ? 'МСФО группы' : 'РСБУ юрлица'}</strong>. Цифры заведомо разного масштаба, красный ≠ ошибка парсера.</div>`;
  } else if(ref.scope === 'standalone' && meta.scope === 'standalone'){
    warning = `<div style="color:var(--green);font-size:.58rem;margin-bottom:4px">✓ Однотипные отчёты — прямая сверка.</div>`;
  }

  const header = [
    ref.source || '?',
    ref.period || null,
    ref.company || null,
    ref.scope === 'group' ? 'группа' : (ref.scope === 'standalone' ? 'юрлицо' : null),
    ref.standard
  ].filter(Boolean).join(' · ');
  const autoTag = ref._autoSource
    ? ` <span style="color:var(--text3)">· 🤖 авто (${ref._autoSource})</span>`
    : '';

  const series = ref.series || (ref.values ? {[_periodLabel('—', ref.period||'')]: ref.values} : null);
  const periods = series
    ? Object.keys(series).sort((a, b) => _periodSortKey(a) - _periodSortKey(b))
    : [];

  // ── Матричный режим: ≥2 периодов ──
  if(series && periods.length >= 2){
    // Для каждого показателя — массив значений по периодам, sparkline,
    // последний vs текущий из формы.
    const cols = periods.length;
    const rows = _REF_FIDS_ORDER.filter(fid => periods.some(p => typeof series[p]?.[fid] === 'number'));
    if(!rows.length){
      box.innerHTML = `<div style="color:var(--text3);font-size:.58rem">Эталон: ${header}.${autoTag}</div>${warning}<div style="font-size:.6rem;color:var(--text3);margin-top:4px">В эталоне нет числовых данных по показателям.</div>`;
      return;
    }
    const fmtNum = v => v == null ? '—' : (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1));
    // Отраслевые медианы — если в базе отраслей есть ИНН эмитента,
    // подтягиваем медиану по его отрасли для самого свежего периода.
    const indKey = _industryKeyForInn(meta.inn);
    const indMed = indKey && window._industryMedians?.[indKey] || null;
    const indLabel = indKey ? (window._industryData?.industries?.[indKey]?.label || indKey) : null;
    const newestPeriod = periods[periods.length - 1];
    const hasIndCol = !!(indMed && indMed[newestPeriod]);
    const headRow = `<div style="display:contents">
      <div style="padding:4px 6px;font-weight:600;color:var(--text)">Показатель</div>
      ${periods.map(p => `<div style="padding:4px 4px;text-align:right;font-size:.55rem;color:var(--text3);font-variant-numeric:tabular-nums">${p}</div>`).join('')}
      <div style="padding:4px 4px;text-align:center;color:var(--text3);font-size:.55rem">тренд</div>
      <div style="padding:4px 4px;text-align:right;font-size:.55rem;color:var(--text3)">в форме</div>
      ${hasIndCol ? `<div style="padding:4px 4px;text-align:right;font-size:.55rem;color:var(--text3)" title="Медиана по отрасли «${indLabel}» за ${newestPeriod}">отрасль p50</div>` : ''}
    </div>`;
    let okN = 0, knownN = 0;
    const dataRows = rows.map(fid => {
      const vals = periods.map(p => series[p]?.[fid]);
      const cur  = vals[vals.length - 1];
      const formV = parseFloat(document.getElementById(fid)?.value);
      const haveForm = !isNaN(formV);
      let status = 'missing', clr = 'var(--text3)';
      if(haveForm && cur != null){
        knownN++;
        const rel = cur ? Math.abs(formV - cur) / Math.abs(cur) : 0;
        status = rel <= 0.02 ? 'ok' : (rel <= 0.1 ? 'warn' : 'err');
        clr = {ok:'var(--green)', warn:'var(--warn)', err:'var(--danger)'}[status];
        if(status === 'ok') okN++;
      }
      const ico = {ok:'✅', warn:'⚠️', err:'🔴', missing:''}[status] || '';
      const cells = vals.map((v, i) => {
        const isLast = i === vals.length - 1;
        const prev = i > 0 ? vals[i-1] : null;
        const yoy = (typeof v === 'number' && typeof prev === 'number' && prev) ? ((v - prev) / Math.abs(prev) * 100) : null;
        const yoyTag = yoy != null
          ? ` <span style="color:${yoy >= 0 ? 'var(--green)' : 'var(--danger)'};font-size:.5rem">${yoy >= 0 ? '+' : ''}${yoy.toFixed(0)}%</span>`
          : '';
        return `<div style="padding:3px 4px;text-align:right;font-variant-numeric:tabular-nums;font-size:.6rem;${isLast?'color:var(--text);font-weight:600':'color:var(--text2)'}">${fmtNum(v)}${yoyTag}</div>`;
      }).join('');
      const sparkBtn = `<div style="padding:3px 4px;text-align:center;cursor:pointer" onclick="refOpenChart('${fid}')" title="Открыть полный график">${_sparkline(vals)}</div>`;
      const formCell = `<div style="padding:3px 4px;text-align:right;font-variant-numeric:tabular-nums;font-size:.6rem;color:${clr}">${haveForm ? fmtNum(formV) + ' ' + ico : '<span style="color:var(--text3)">—</span>'}</div>`;
      // Отраслевая ячейка: медиана + %-отклонение «в форме» от p50.
      let indCell = '';
      if(hasIndCol){
        const cell = indMed[newestPeriod][fid];
        if(cell){
          let rel = '';
          if(haveForm && cell.p50){
            const d = (formV - cell.p50) / Math.abs(cell.p50) * 100;
            rel = ` <span style="color:${d >= 0 ? 'var(--green)' : 'var(--danger)'};font-size:.5rem">${d >= 0 ? '+' : ''}${d.toFixed(0)}%</span>`;
          }
          indCell = `<div style="padding:3px 4px;text-align:right;font-variant-numeric:tabular-nums;font-size:.6rem;color:var(--text2)" title="p25=${fmtNum(cell.p25)} · p50=${fmtNum(cell.p50)} · p75=${fmtNum(cell.p75)} · n=${cell.n}">${fmtNum(cell.p50)}${rel}</div>`;
        } else {
          indCell = `<div style="padding:3px 4px;text-align:right;color:var(--text3);font-size:.6rem">—</div>`;
        }
      }
      return `<div style="display:contents">
        <div style="padding:3px 6px;color:var(--text2);font-size:.6rem">${_REF_LABELS[fid] || fid}</div>
        ${cells}${sparkBtn}${formCell}${indCell}
      </div>`;
    }).join('');
    const okBadge = scopeMismatch ? '' :
      `<span style="color:${okN === knownN && knownN ? 'var(--green)' : 'var(--warn)'}">Точность сейчас: ${okN}/${knownN}</span>`;
    const indBadge = hasIndCol
      ? ` <span style="color:var(--text3)">· 🏭 ${indLabel} (n=${indMed[newestPeriod] && Object.values(indMed[newestPeriod])[0]?.n || '?'})</span>`
      : (indKey ? ` <span style="color:var(--text3)">· 🏭 ${indLabel} (медианы не рассчитаны)</span>` : '');
    const gridCols = `minmax(110px,1.2fr) repeat(${cols},minmax(60px,1fr)) 70px minmax(80px,1fr)${hasIndCol ? ' minmax(80px,1fr)' : ''}`;
    const minW = 360 + cols*64 + (hasIndCol ? 80 : 0);
    box.innerHTML = `
      <div style="color:var(--text3);margin-bottom:4px;font-size:.58rem">Эталон: ${header}.${autoTag} ${okBadge}${indBadge}</div>
      ${warning}
      <div style="overflow:auto"><div style="display:grid;grid-template-columns:${gridCols};gap:1px;background:var(--border);border:1px solid var(--border);font-size:.6rem;min-width:${minW}px">
        ${headRow}
        ${dataRows}
      </div></div>
      <div style="margin-top:6px;font-size:.52rem;color:var(--text3)">Клик по тренду → крупный график. «в форме» — что сейчас распознано. ${hasIndCol ? '«отрасль p50» — медиана по отрасли (hover → p25/p75/n). Цветной % — отклонение «в форме» от медианы отрасли.' : ''}</div>
      ${_rosstatCompareBlock(meta, newestPeriod)}
    `;
    // Сохраняем series в DOM-памяти кнопок графика.
    window._refChartData = {series, periods, ref};
    return;
  }

  // ── Одноразовый режим: показываем как раньше, плюс sparkline-плейсхолдер. ──
  const diffs = repCompareReference(ref);
  const ico = {ok:'✅',warn:'⚠️',err:'🔴',missing:'⚫'};
  const clr = {ok:'var(--green)',warn:'var(--warn)',err:'var(--danger)',missing:'var(--text3)'};
  const rowsHtml = diffs.map(d => {
    const lbl = _REF_LABELS[d.fid] || d.fid;
    const dlt = d.status === 'missing'
      ? '— не заполнено в форме'
      : `${d.parsed} vs <strong>${d.expected}</strong>${d.rel != null ? ` (Δ ${(d.rel*100).toFixed(1)}%)` : ''}`;
    return `<div style="padding:2px 0;border-bottom:1px dotted rgba(30,48,72,.3)">${ico[d.status]} <strong>${lbl}</strong>: <span style="color:${clr[d.status]}">${dlt}</span></div>`;
  }).join('');
  const okCount = diffs.filter(d => d.status === 'ok').length;
  const totalKnown = diffs.filter(d => d.status !== 'missing').length;
  const okBadge = scopeMismatch ? '' :
    `<span style="color:${okCount === totalKnown ? 'var(--green)' : 'var(--warn)'}">Точность: ${okCount}/${totalKnown}</span>`;
  box.innerHTML = `<div style="color:var(--text3);margin-bottom:4px;font-size:.58rem">Эталон: ${header}.${autoTag} ${okBadge}</div>${warning}${rowsHtml}${_rosstatCompareBlock(meta, ref.period)}`;
  window._refChartData = null;
}

// Блок сравнения ROS/ROA эмитента со среднеотраслевыми данными ФНС.
// Показывается только если (a) эмитент определён по ИНН в какой-то
// отрасли, (b) для этой отрасли есть мэппинг на строку ФНС, (c) для
// года `period` данные ФНС загружены. Иначе возвращает пустую строку.
function _rosstatCompareBlock(meta, period){
  if(!meta || !meta.inn) return '';
  const indKey = _industryKeyForInn(meta.inn);
  if(!indKey) return '';
  // Вытаскиваем год из подписи периода — первая 4-значная цифра 19xx/20xx.
  const ym = String(period || '').match(/(19\d{2}|20\d{2})/);
  if(!ym) return '';
  const year = +ym[1];
  const hit = rosstatLookup(indKey, year);
  if(!hit) return '';
  // Значения эмитента — из текущей формы РасБух-блока.
  const num = id => {
    const v = parseFloat(document.getElementById(id)?.value);
    return isNaN(v) ? null : v;
  };
  const rev = num('rep-np-rev');
  const ebit = num('rep-np-ebit');
  const ebitda = num('rep-np-ebitda');
  const np = num('rep-np-np');
  const assets = num('rep-np-assets');
  // ROS = прибыль от продаж (EBIT) / Выручка. Если EBIT не распознан —
  // пробуем ЧП, это ближе всего к «прибыли до налогов и процентов»
  // в рамках простой формы ФНС (у них тоже грубый знаменатель).
  const rosSrc = ebit != null ? 'EBIT' : (np != null ? 'ЧП' : null);
  const rosNum = ebit != null ? ebit : (np != null ? np : null);
  const rosEmit = (rosNum != null && rev && rev !== 0) ? (rosNum / rev * 100) : null;
  const roaEmit = (np != null && assets && assets !== 0) ? (np / assets * 100) : null;
  if(rosEmit == null && roaEmit == null) return '';

  const indLabel = window._industryData?.industries?.[indKey]?.label || indKey;
  const fmt = v => v == null ? '—' : v.toFixed(1) + '%';
  const fmtRef = (val, neg) => {
    if(neg && val == null) return '<span style="color:var(--danger)">&lt;0</span>';
    return val == null ? '—' : val.toFixed(1) + '%';
  };
  const deltaCell = (emit, ref) => {
    if(emit == null || ref == null || ref === 0) return '<span style="color:var(--text3)">—</span>';
    const d = emit - ref;
    const pp = (d >= 0 ? '+' : '') + d.toFixed(1) + ' п.п.';
    const clr = Math.abs(d) < 2 ? 'var(--green)' : (Math.abs(d) < 10 ? 'var(--warn)' : 'var(--danger)');
    return `<span style="color:${clr}">${pp}</span>`;
  };

  return `
    <div style="margin-top:10px;padding:8px 10px;background:var(--s2);border:1px solid var(--border);font-size:.6rem">
      <div style="color:var(--text3);font-size:.55rem;letter-spacing:.06em;text-transform:uppercase;margin-bottom:6px">
        🇷🇺 сравнение с фнс/росстат · отрасль «${indLabel}» · ${year} г.
      </div>
      <div style="display:grid;grid-template-columns:minmax(60px,auto) repeat(3,minmax(70px,1fr)) minmax(100px,2fr);gap:1px;background:var(--border);border:1px solid var(--border);font-variant-numeric:tabular-nums">
        <div style="padding:3px 6px;background:var(--bg);color:var(--text3);font-size:.52rem">Пок-ль</div>
        <div style="padding:3px 6px;background:var(--bg);color:var(--text3);font-size:.52rem;text-align:right">эмитент</div>
        <div style="padding:3px 6px;background:var(--bg);color:var(--text3);font-size:.52rem;text-align:right">ФНС ${year}</div>
        <div style="padding:3px 6px;background:var(--bg);color:var(--text3);font-size:.52rem;text-align:right">Δ</div>
        <div style="padding:3px 6px;background:var(--bg);color:var(--text3);font-size:.52rem">строка ФНС</div>

        <div style="padding:3px 6px;background:var(--s1);color:var(--text2)" title="ROS = ${rosSrc || '—'} / Выручка · 100%">ROS</div>
        <div style="padding:3px 6px;background:var(--s1);text-align:right">${rosEmit == null ? '—' : fmt(rosEmit)}${rosSrc && rosSrc !== 'EBIT' ? ` <span style="color:var(--text3);font-size:.5rem">(из ${rosSrc})</span>` : ''}</div>
        <div style="padding:3px 6px;background:var(--s1);text-align:right">${fmtRef(hit.ros, hit.rosNeg)}</div>
        <div style="padding:3px 6px;background:var(--s1);text-align:right">${deltaCell(rosEmit, hit.ros)}</div>
        <div style="padding:3px 6px;background:var(--s1);color:var(--text3);font-size:.5rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${hit.matchedName || hit.name}">${hit.matchedName || hit.name}</div>

        <div style="padding:3px 6px;background:var(--s1);color:var(--text2)" title="ROA = ЧП / Активы · 100%">ROA</div>
        <div style="padding:3px 6px;background:var(--s1);text-align:right">${roaEmit == null ? '—' : fmt(roaEmit)}</div>
        <div style="padding:3px 6px;background:var(--s1);text-align:right">${fmtRef(hit.roa, hit.roaNeg)}</div>
        <div style="padding:3px 6px;background:var(--s1);text-align:right">${deltaCell(roaEmit, hit.roa)}</div>
        <div style="padding:3px 6px;background:var(--s1);color:var(--text3);font-size:.5rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${hit.matchedName || hit.name}">${hit.matchedName || hit.name}</div>
      </div>
      <div style="margin-top:4px;font-size:.5rem;color:var(--text3);line-height:1.4">
        Источник: ФНС, Приложение № 4 к Приказу ММ-3-06/333@, данные Росстата по крупным и средним организациям. Зелёный = в пределах ±2 п.п. от средней, жёлтый = ±2…±10, красный = &gt;10.
      </div>
    </div>
  `;
}

// ── Крупный график показателя по годам ──
// Открывается кликом по sparkline в матрице. Использует данные,
// сохранённые в window._refChartData при последнем рендере.
function refOpenChart(fid){
  const data = window._refChartData;
  if(!data) return;
  const {series, periods} = data;
  const vals = periods.map(p => series[p]?.[fid]);
  const valid = vals.map((v,i) => typeof v === 'number' ? {v, i} : null).filter(Boolean);
  if(!valid.length){ alert('Нет данных по этому показателю'); return; }
  const W = 760, H = 360, mLeft = 60, mRight = 12, mTop = 16, mBottom = 36;
  const innerW = W - mLeft - mRight, innerH = H - mTop - mBottom;
  const min = Math.min(...valid.map(o => o.v), 0);
  const max = Math.max(...valid.map(o => o.v));
  const range = max - min || Math.abs(max) || 1;
  const xOf = i => mLeft + (vals.length === 1 ? innerW/2 : (i / (vals.length - 1)) * innerW);
  const yOf = v => mTop + (1 - (v - min) / range) * innerH;
  // Сетка по Y (5 линий).
  const ticks = 5;
  let yGrid = '', yLabels = '';
  for(let k = 0; k <= ticks; k++){
    const v = min + (k/ticks) * range;
    const y = yOf(v);
    yGrid += `<line x1="${mLeft}" y1="${y}" x2="${W-mRight}" y2="${y}" stroke="var(--border)" stroke-dasharray="2 2"/>`;
    yLabels += `<text x="${mLeft - 6}" y="${y + 3}" text-anchor="end" font-size="9" fill="var(--text3)" font-family="var(--mono)">${(v >= 100 ? v.toFixed(0) : v.toFixed(1))}</text>`;
  }
  let xLabels = '';
  vals.forEach((_, i) => {
    xLabels += `<text x="${xOf(i)}" y="${H - mBottom + 18}" text-anchor="middle" font-size="10" fill="var(--text2)" font-family="var(--mono)">${periods[i]}</text>`;
  });
  const path = valid.map((o, k) => (k===0?'M':'L') + xOf(o.i).toFixed(1) + ',' + yOf(o.v).toFixed(1)).join(' ');
  const dots = valid.map(o =>
    `<circle cx="${xOf(o.i).toFixed(1)}" cy="${yOf(o.v).toFixed(1)}" r="3.5" fill="var(--acc)"/>` +
    `<text x="${xOf(o.i).toFixed(1)}" y="${yOf(o.v).toFixed(1) - 8}" text-anchor="middle" font-size="10" fill="var(--text)" font-family="var(--mono)" font-weight="600">${o.v >= 100 ? o.v.toFixed(0) : o.v.toFixed(1)}</text>`
  ).join('');
  const svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;display:block;margin:0 auto;background:var(--bg)">
    ${yGrid}${yLabels}${xLabels}
    <path d="${path}" fill="none" stroke="var(--acc)" stroke-width="2" stroke-linejoin="round"/>
    ${dots}
  </svg>`;
  const title = (_REF_LABELS[fid] || fid) + (data.ref?.unit ? ', ' + data.ref.unit : '');
  document.getElementById('ref-chart-title').textContent = title;
  document.getElementById('ref-chart-svg').innerHTML = svg;
  document.getElementById('modal-ref-chart').classList.add('open');
}
function repCopyRawText(){
  const ta = document.getElementById('rep-np-raw-text');
  if(!ta || !ta.value){ alert('Сначала загрузите файл.'); return; }
  // textarea может быть display:none — временно показываем для копирования.
  const wasHidden = ta.style.display === 'none';
  if(wasHidden) ta.style.display = 'block';
  ta.select();
  try {
    document.execCommand('copy');
    alert('Распознанный текст скопирован в буфер.');
  } catch(e){
    alert('Не удалось скопировать: '+e.message);
  }
  if(wasHidden) ta.style.display = 'none';
  ta.setSelectionRange(0,0);
}

// ── Ручной подбор значений ──
// Список целевых полей: по умолчанию — поля модалки Отчётности. Но
// когда picker вызывается из лупы эмитента, _pickerFields подменяется
// на одно конкретное поле (is-rev, is-ebitda, и т.п.).
// hint — ключевые слова строки отчёта, которые помогут найти числа.
const REP_PICKER_FIELDS = [
  {id:'rep-np-rev',    label:'Выручка',              hint:'выручка|revenue|sales|оборот|доходы? от реализации|доходы? от обычных видов|выручка от продаж|выручка от контрактов|выручка от реализац|чистая выручка|общая выручка|net sales|total revenue|net revenue|total sales'},
  {id:'rep-np-ebitda', label:'EBITDA',               hint:'ebitda|показатель ebitda|скорр\\w* ebitda|adjusted ebitda|оibda'},
  {id:'rep-np-np',     label:'Чистая прибыль',       hint:'чистая прибыль|чистый убыток|net profit|net income|прибыль \\(убыток\\) за|прибыль за (период|год|отчет)|чистая прибыль \\(убыток\\)|итоговая прибыль'},
  {id:'rep-np-ebit',   label:'EBIT',                 hint:'\\bebit\\b|операционная прибыль|операционный результат|прибыль от продаж|прибыль от операционной|operating profit|operating income|прибыль до (налог|финансовых|процентов)|прибыль до налогообложени'},
  {id:'rep-np-assets', label:'Совокупные активы',    hint:'всего активов|итого активов|итого активы|total assets|активов,? всего|активы,? всего|валюта баланса|итого раздела баланса'},
  {id:'rep-np-eq',     label:'Собственный капитал',  hint:'итого (собственного )?капитал|всего капитал|total equity|капитал,? всего|капитал и резервы|итого собственных средств|итого раздела iii|total shareholders'},
  {id:'rep-np-debt',   label:'Долг (кредиты+займы)', hint:'кредиты и займы|займы и кредиты|заемные средства|заёмные средства|borrowings|loans and borrowings|долгосрочные (кредиты|заимствования|займы)|краткосрочные (кредиты|заимствования|займы)|долговые обязательства|общий долг|total debt|кредиты банков|банковские кредиты'},
  {id:'rep-np-cash',   label:'Денежные средства',    hint:'денежные средства|денежные средства и (их )?эквивалент|cash and cash equivalents|\\bcash\\b|эквиваленты денежных средств'},
  {id:'rep-np-ca',     label:'Оборотные активы',     hint:'итого оборотных активов|оборотные активы|итого краткосрочных активов|краткосрочные активы|итого текущих активов|текущие активы|current assets|total current assets|итого раздела ii'},
  {id:'rep-np-cl',     label:'Краткосрочные обяз.',  hint:'итого краткосрочных обязательств|краткосрочные обязательства|итого текущих обязательств|текущие обязательства|current liabilities|total current liabilities|итого раздела v'},
  {id:'rep-np-int',    label:'Процентные расходы',   hint:'процентные расходы|расходы по процентам|проценты к уплате|проценты уплаченные|проценты начисленные|проценты по (кредитам|займам)|interest expense|finance (cost|expenses)|финансовые расходы'},
  {id:'rep-np-ret',    label:'Нераспр. прибыль',     hint:'нераспределенн|нераспределённ|retained|непокрытый убыток|нераспредел\\w+ прибыль'},
];

// Общая таблица контекста — используется и для REP_PICKER_FIELDS
// (ключи rep-np-*), и для IS_FIELD_HINTS (is-*). Маппинг — по суффиксу.
function repPickerCtxFor(fieldId){
  if(FIELD_CTX[fieldId]) return FIELD_CTX[fieldId];
  // rep-np-rev → is-rev
  const key = fieldId.replace(/^rep-np-/, 'is-');
  return FIELD_CTX[key] || null;
}

// Хинты для полей вкладки «Данные эмитента» (is-*). Используются,
// когда picker открывается из лупы конкретного поля.
const IS_FIELD_HINTS = {
  'is-rev':   'выручка|revenue|доходы от реализации|выручка от продаж',
  'is-ebitda':'ebitda',
  'is-ebit':  'ebit|операционная прибыль|прибыль от продаж|operating profit|прибыль до (налога|финансовых)',
  'is-np':    'чистая прибыль|net profit|net income|прибыль за (период|год)',
  'is-int':   'процентные расходы|проценты к уплате|interest expense|финансовые расходы|finance cost|проценты по кредитам',
  'is-tax':   'налог на прибыль|income tax',
  'is-dep':   'амортизация|depreciation|d&a',
  'is-assets':'всего активов|итого активов|total assets|активов, всего',
  'is-ca':    'итого оборотных активов|оборотные активы|current assets',
  'is-cl':    'итого краткосрочных обязательств|краткосрочные обязательства|current liabilities',
  'is-debt':  'кредиты и займы|заемные средства|заёмные средства|borrowings|долговые обязательства|долгосрочные заимствования',
  'is-cash':  'денежные средства|денежные средства и.*эквивалент|cash and cash equivalents|cash',
  'is-ret':   'нераспределенн|нераспределённ|retained',
  'is-eq':    'итого (собственного )?капитал|всего капитал|total equity|капитал, всего',
  'is-mkt':   'рыночная капитализация|market cap',
  'is-peak':  'погашение|оферта|пиковые выплаты',
};

// Контекстные подсказки: какие соседние строки УКРЕПЛЯЮТ / ОСЛАБЛЯЮТ
// вероятность того, что строка — искомый показатель. Разделы отчёта
// (ОПиУ / Баланс / ОДДС / Капитал) легко распознать по заголовкам —
// рядом с «Прибыль до налога» значит это ОПиУ, рядом с «Операционная
// деятельность» — это ОДДС, и т.д.
const FIELD_CTX = {
  // ОПиУ
  'is-rev':    { near: /себестоимость|валовая прибыль|выручка|ebitda/i,               anti: /поступлени|движение денежных/i },
  'is-ebitda': { near: /операционная прибыль|амортизаци|ebit\b/i,                      anti: /12\s+месяц|ltm/i /* мы ищем за период отчёта */ },
  'is-ebit':   { near: /себестоимость|валовая|коммерческие|административн/i,           anti: /поступлени|движение денежных/i },
  'is-np':     { near: /налог на прибыль|прибыль до налога|совокупный доход/i,         anti: /изменение (капитала|резерва)|дивиденд/i },
  'is-int':    { near: /прибыль до налога|операционная прибыль|налог на прибыль|финансовые доходы/i, anti: /поступлени|выплат[ыа]|инвестиционная деятельность|\bкорректировк/i },
  'is-tax':    { near: /прибыль до налога|чистая прибыль/i,                            anti: /поступлени/i },
  'is-dep':    { near: /корректировк|прибыль за период|износ|операционная деятельность/i, anti: /накопленная амортизаци/i },
  // Баланс
  'is-assets': { near: /капитал и обязательства|внеоборотн|оборотные активы|пассив/i,  anti: /поступлени|выплат/i },
  'is-ca':     { near: /запасы|дебиторск|денежные средства|аванс/i,                    anti: /капитал|обязательств/i },
  'is-cl':     { near: /кредиторск|краткосрочн|обязательств|резерв/i,                  anti: /оборотные активы/i },
  'is-debt':   { near: /долгосрочн|краткосрочн|займ|облигаци|финансовая аренда/i,      anti: /дебиторск|активы/i },
  'is-cash':   { near: /эквивалент|банк|счет|депозит|внеоборотн|оборотные/i,           anti: /движение денежных средств/i /* в ОДДС итог по-другому */ },
  'is-ret':    { near: /уставн|нераспредел|капитал участник|капитал группы/i,          anti: /обязательств|активы/i },
  'is-eq':     { near: /обязательств|уставн|нераспредел|резерв/i,                      anti: /дебиторск|поступлени/i },
};

// Текущий список полей для picker'а (по умолчанию — все 12 из модалки
// Отчётности). Подменяется при вызове из лупы эмитента.
window._pickerFields = REP_PICKER_FIELDS;

// ── Лупа у полей во вкладке «Данные эмитента»: меню выбора источника ──
window._flTargetField = null; // {id,label,hint}

function openFieldLookup(fieldId, fieldLabel){
  const hint = IS_FIELD_HINTS[fieldId] || fieldLabel.toLowerCase();
  window._flTargetField = {id:fieldId, label:fieldLabel, hint};
  const lblEl = document.getElementById('fl-field-label');
  if(lblEl) lblEl.textContent = fieldLabel;
  const info = document.getElementById('fl-recent-info');
  if(info){
    info.textContent = window._lastParsedText
      ? `↳ уже загружен текст (${window._lastParsedText.length.toLocaleString('ru')} симв.) — подбор откроется сразу.`
      : '↳ текст ещё не загружен. Выберите PDF или вставьте текст.';
  }
  document.getElementById('modal-field-lookup').classList.add('open');
}

function flRunAiSearch(){
  const t = window._flTargetField;
  closeModal('modal-field-lookup');
  if(!t) return;
  if(typeof searchSingleField === 'function') searchSingleField(t.id, t.label);
}

function flLoadPdf(){
  const t = window._flTargetField;
  if(!t) return;
  // Если уже есть распознанный текст — не грузим заново, открываем сразу.
  if(window._lastParsedText){
    closeModal('modal-field-lookup');
    openPickerForField(t.id, t.label, t.hint);
    return;
  }
  const input = document.getElementById('fl-pdf-input');
  if(!input) return;
  input.value = '';
  input.onchange = async () => {
    const file = input.files[0];
    if(!file) return;
    const ext = (file.name.split('.').pop()||'').toLowerCase();
    try {
      let text = '';
      if(ext === 'pdf' && typeof repExtractPdf === 'function') text = await repExtractPdf(file);
      else if(ext === 'docx' && typeof repExtractDocx === 'function') text = await repExtractDocx(file);
      else if((ext === 'xlsx' || ext === 'xls') && typeof repExtractXlsx === 'function') text = await repExtractXlsx(file);
      else if(typeof isImageExt === 'function' && isImageExt(ext) && typeof repOcrImage === 'function') {
        text = await repOcrImage(file);
      }
      else { alert('Поддерживаются PDF / DOCX / XLSX или фото (JPG/PNG)'); return; }
      window._lastParsedText = text || '';
      closeModal('modal-field-lookup');
      openPickerForField(t.id, t.label, t.hint);
    } catch(e){
      alert('Ошибка чтения файла: ' + e.message);
    }
  };
  input.click();
}

function flPasteText(){
  const t = window._flTargetField;
  if(!t) return;
  const ta = document.getElementById('fl-paste-area');
  if(ta) ta.value = window._lastParsedText || '';
  closeModal('modal-field-lookup');
  document.getElementById('modal-paste-text').classList.add('open');
}

function flAcceptPastedText(){
  const t = window._flTargetField;
  const ta = document.getElementById('fl-paste-area');
  if(!t || !ta) return;
  const text = (ta.value || '').trim();
  if(!text){ alert('Вставьте текст.'); return; }
  window._lastParsedText = text;
  closeModal('modal-paste-text');
  openPickerForField(t.id, t.label, t.hint);
}

// Открыть picker для ОДНОГО конкретного поля (с вкладки Данные эмитента).
function openPickerForField(fieldId, fieldLabel, hint){
  window._pickerFields = [{id:fieldId, label:fieldLabel, hint:hint||''}];
  repOpenPicker(/*singleHint=*/hint||'');
}


function repOpenPicker(singleHint){
  // Если вызываем из модалки Отчётности — восстанавливаем полный список полей.
  // Из лупы эмитента _pickerFields уже подменён через openPickerForField.
  if(!singleHint && window._pickerFields !== REP_PICKER_FIELDS){
    window._pickerFields = REP_PICKER_FIELDS;
  }
  const fields = window._pickerFields || REP_PICKER_FIELDS;
  const text = window._lastParsedText || '';
  if(!text){ alert('Сначала загрузите файл или вставьте распознанный текст.'); return; }
  // Заполняем dropdown полей
  const sel = document.getElementById('rep-picker-target');
  if(sel){
    sel.innerHTML = '';
    fields.forEach(f=>{
      const opt = document.createElement('option');
      opt.value = f.id;
      const cur = document.getElementById(f.id);
      const curVal = cur && cur.value ? ` = ${cur.value}` : '';
      opt.textContent = f.label + curVal;
      sel.appendChild(opt);
    });
    sel.selectedIndex = 0;
  }
  const unit = document.getElementById('rep-picker-unit');
  if(unit) unit.value = '0.001'; // по умолчанию млн ₽
  // Рисуем кнопки-пресеты: клик ставит поле + включает поиск по hint.
  const presetBox = document.getElementById('rep-picker-presets');
  if(presetBox){
    // чистим всё кроме вводного label (первый child)
    while(presetBox.children.length > 1) presetBox.removeChild(presetBox.lastChild);
    fields.forEach(f => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = f.label;
      b.className = 'btn btn-sm';
      b.style.cssText = 'padding:2px 8px;font-size:.58rem';
      b.onclick = () => repPickerPreset(f.id, f.hint);
      presetBox.appendChild(b);
    });
    const all = document.createElement('button');
    all.type = 'button';
    all.textContent = '🔓 показать всё';
    all.className = 'btn btn-sm';
    all.style.cssText = 'padding:2px 8px;font-size:.58rem;margin-left:auto';
    all.onclick = () => { repPickerResetFilters(); };
    presetBox.appendChild(all);
  }
  // Сбрасываем фильтры.
  repPickerResetFilters(true);
  // Если открыто для одного поля — сразу включаем фильтр по hint.
  if(singleHint){
    const s = document.getElementById('rep-picker-f-search');
    if(s) s.value = singleHint;
  }
  repRenderPickerLines(text);
  repPickerUpdateCurrent();
  document.getElementById('modal-rep-picker').classList.add('open');
}

// Кликнули по кнопке-пресету: выставляем поле + ставим поиск по ключевым словам.
function repPickerPreset(fieldId, hint){
  const sel = document.getElementById('rep-picker-target');
  if(sel){
    for(let i=0;i<sel.options.length;i++){
      if(sel.options[i].value === fieldId){ sel.selectedIndex = i; break; }
    }
  }
  const searchEl = document.getElementById('rep-picker-f-search');
  if(searchEl){ searchEl.value = hint || ''; }
  repPickerUpdateCurrent();
  repPickerRerender();
}

// Сброс фильтров к дефолту (не скрываем мелкие числа).
function repPickerResetFilters(skipRender){
  const set = (id, val) => { const el=document.getElementById(id); if(el) el.value = val; };
  const chk = (id, val) => { const el=document.getElementById(id); if(el) el.checked = val; };
  set('rep-picker-f-min', '0');
  chk('rep-picker-f-nofrac', false);
  chk('rep-picker-f-intonly', false);
  set('rep-picker-f-mindigits', '1');
  set('rep-picker-f-search', '');
  if(!skipRender) repPickerRerender();
}

// Подхватить выделенный мышью фрагмент (из текста модалки или с любой части страницы).
function repPickerGrabSelection(){
  const sel = (window.getSelection && window.getSelection().toString()) || '';
  const el = document.getElementById('rep-picker-manual');
  if(!el) return;
  if(!sel.trim()){ alert('Сначала выделите фрагмент текста в распознанном тексте.'); return; }
  el.value = sel.trim();
  el.focus();
}

// Форматирование числа из найденной строки в JS-число.
// Поддерживает "1 234,56", "1.234,56", "1,234.56", скобки для отрицательных.
function repPickerParseNumber(raw){
  if(!raw) return null;
  let s = raw.trim();
  let neg = false;
  if(/^\(.*\)$/.test(s)){ neg = true; s = s.slice(1,-1); }
  s = s.replace(/\s+/g,'').replace(/\u00a0/g,'');
  // Если есть и ',' и '.', последний по позиции считаем десятичным
  const hasComma = s.indexOf(',') >= 0;
  const hasDot   = s.indexOf('.') >= 0;
  if(hasComma && hasDot){
    if(s.lastIndexOf(',') > s.lastIndexOf('.')){
      s = s.replace(/\./g,'').replace(',','.');
    } else {
      s = s.replace(/,/g,'');
    }
  } else if(hasComma){
    // одна запятая — десятичный разделитель, если после ≤3 цифр и это единственный разделитель
    const parts = s.split(',');
    if(parts.length === 2 && parts[1].length <= 3) s = parts[0] + '.' + parts[1];
    else s = s.replace(/,/g,'');
  }
  const n = parseFloat(s);
  if(!isFinite(n)) return null;
  return neg ? -n : n;
}

// Вытаскиваем текущие настройки фильтров из панели.
function repPickerGetFilters(){
  const num = id => { const el=document.getElementById(id); const v=el?parseFloat(el.value):NaN; return isFinite(v)?v:null; };
  const chk = id => { const el=document.getElementById(id); return !!(el && el.checked); };
  const str = id => { const el=document.getElementById(id); return el ? el.value.trim().toLowerCase() : ''; };
  return {
    min: num('rep-picker-f-min') ?? 1,
    noFrac: chk('rep-picker-f-nofrac'),
    intOnly: chk('rep-picker-f-intonly'),
    minDigits: Math.max(1, num('rep-picker-f-mindigits') ?? 1),
    search: str('rep-picker-f-search'),
  };
}

// Решаем, показывать ли число как кликабельный чип.
function repPickerShouldShow(n, f){
  if(n === null || !isFinite(n)) return false;
  const abs = Math.abs(n);
  if(abs < (f.min ?? 1)) return false;
  if(RSBU_CODE_SET.has(abs) || (Number.isInteger(n) && RSBU_CODE_SET.has(n))) return false;
  const isFrac = !Number.isInteger(n);
  if((f.noFrac || f.intOnly) && isFrac) return false;
  // Длина значащей целой части
  const digits = Math.floor(Math.abs(n)).toString().length;
  if(digits < (f.minDigits ?? 1)) return false;
  return true;
}

// Ищем шапку таблицы. В PDF-извлечении она часто разбита на несколько
// смежных строк («закончившихся» / «30 июня 2025 года» / «30 июня 2024
// года») — склеиваем их в один заголовок.
function repPickerFindColumnHeader(lines, fromIdx){
  const yearRe  = /\b(19|20)\d{2}\b/;
  const monthRe = /(январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)/i;
  const keyRe   = /(закончи|по состоянию|за\s+\S+\s+(месяц|полуг|квартал|год)|\d+\s+месяц|полугоди|квартал\b|period ended|as of|\d+\s+months|three months|six months|twelve months|ltm)/i;

  // Признак: строка выглядит как шапка, а не как строка-данные.
  // В шапке не может быть больших сумм денег — только годы/подписи.
  const hasBigMoney = L => {
    const nums = L.match(/-?\d{1,3}(?:[ \u00a0]\d{3})+(?:[.,]\d+)?|-?\d{4,}(?:[.,]\d+)?/g) || [];
    for(const s of nums){
      const cleaned = s.replace(/[ \u00a0]/g,'').replace(/\(|\)/g,'').replace(',','.');
      const n = parseFloat(cleaned);
      if(isFinite(n) && Math.abs(n) >= 1000){
        // исключение: год «2024» сам по себе — не деньги
        if(/^(19|20)\d{2}$/.test(cleaned)) continue;
        return true;
      }
    }
    return false;
  };
  const isHeaderLike = L => {
    if(hasBigMoney(L)) return false;
    return yearRe.test(L) || monthRe.test(L) || keyRe.test(L);
  };

  // Найдём первую сверху header-like строку как якорь.
  let anchor = -1;
  for(let i = fromIdx - 1; i >= Math.max(0, fromIdx - 40); i--){
    const L = (lines[i] || '').trim();
    if(!L) continue;
    if(isHeaderLike(L)){ anchor = i; break; }
    // Номер страницы / разделитель — не прерывает поиск.
    if(/^\s*\d+\s*$/.test(L)) continue;
  }
  if(anchor < 0) return null;

  // Расширяем блок: все смежные header-like строки вокруг якоря.
  let start = anchor, end = anchor;
  for(let i = anchor - 1; i >= Math.max(0, anchor - 4); i--){
    const L = (lines[i] || '').trim();
    if(!L){ continue; }
    if(!isHeaderLike(L)) break;
    start = i;
  }
  for(let i = anchor + 1; i < fromIdx && i <= anchor + 4; i++){
    const L = (lines[i] || '').trim();
    if(!L){ continue; }
    if(!isHeaderLike(L)) break;
    end = i;
  }
  const parts = [];
  for(let i = start; i <= end; i++){
    const L = (lines[i] || '').trim();
    if(L) parts.push(L);
  }
  return repPickerFixBrokenYears(parts.join(' · ')).slice(0, 200);
}

// Склеиваем годы, разбитые на куски в PDF ("202 4" -> "2024", "2 025" -> "2025").
function repPickerFixBrokenYears(s){
  if(!s) return s;
  // "20 25" / "20 24" -> "2025"/"2024"
  s = s.replace(/\b(19|20)\s+(\d{2})\b/g, '$1$2');
  // "202 5" / "202 4" -> "2025"/"2024"
  s = s.replace(/\b((?:19|20)\d)\s+(\d)\b/g, '$1$2');
  // "2 025" / "2 024" -> "2025"/"2024"
  s = s.replace(/\b([12])\s+(\d{3})\b/g, (m,a,b) => (a==='1'||a==='2') && /^0\d{2}$|^\d{3}$/.test(b) ? a+b : m);
  return s;
}

// ── Самые вероятные кандидаты для активного поля ──
// Достаём подписи колонок из найденной шапки раздела. Если количество
// найденных подписей совпадает с количеством числовых колонок кандидата —
// используем; иначе возвращаем null, чтобы UI написал «кол. N».
function repPickerDeriveColLabels(header, n){
  if(!header || !n) return null;
  const parts = [];
  // Предпочитаем полные даты «30 июня 2025».
  const dateRe = /\b\d{1,2}\s+(январ\S*|феврал\S*|март\S*|апрел\S*|ма[йя]\S*|июн\S*|июл\S*|август\S*|сентябр\S*|октябр\S*|ноябр\S*|декабр\S*)\s+(19|20)\d{2}\b/gi;
  let m;
  while((m = dateRe.exec(header)) !== null) parts.push(m[0]);
  // Иначе — одиночные годы.
  if(parts.length < 2){
    const yrs = (header.match(/\b(19|20)\d{2}\b/g) || []);
    parts.length = 0;
    for(const y of yrs) parts.push(y);
  }
  if(parts.length === n) return parts;
  // Если дат чуть меньше (например 2 года на 3 колонки restatement:
  // до/влияние/после за одну дату) — не рискуем, возвращаем null.
  return null;
}

function repPickerRenderSuggestions(text){
  const box = document.getElementById('rep-picker-suggest');
  const list = document.getElementById('rep-picker-suggest-list');
  const labelEl = document.getElementById('rep-picker-suggest-label');
  if(!box || !list) return;
  list.innerHTML = '';

  const sel = document.getElementById('rep-picker-target');
  const fields = window._pickerFields || REP_PICKER_FIELDS;
  const curId = sel ? sel.value : (fields[0] && fields[0].id);
  const f = fields.find(x => x.id === curId);
  if(!f || !f.hint){ box.style.display = 'none'; return; }
  if(labelEl) labelEl.textContent = f.label;

  let hintRe = null;
  try { hintRe = new RegExp(f.hint, 'i'); } catch(e){ hintRe = null; }
  if(!hintRe){ box.style.display = 'none'; return; }
  // Fallback: в PDF слова часто разбиты на части («Всего а ктивов»),
  // поэтому дополнительно ищем подстроку в «схлопнутой» версии строки.
  const hintsNorm = f.hint.split('|').map(x => x.toLowerCase().replace(/\s+/g,'')).filter(Boolean);
  const lineMatchesHint = (L) => {
    if(hintRe.test(L)) return true;
    const norm = L.toLowerCase().replace(/\s+/g,'');
    return hintsNorm.some(h => h && norm.includes(h));
  };

  const numRe = /-?\(?\d{1,3}(?:[ \u00a0]\d{3})+(?:[.,]\d+)?\)?|-?\(?\d+(?:[.,]\d+)?\)?/g;
  const lines = text.split(/\r?\n/);

  // Парсер чисел из одной строки.
  const parseNumsFrom = (srcLine, offset) => {
    numRe.lastIndex = 0;
    const out = [];
    let m;
    while((m = numRe.exec(srcLine)) !== null){
      const n = repPickerParseNumber(m[0]);
      if(n === null) continue;
      const abs = Math.abs(n);
      if(abs < 1) continue;
      if(RSBU_CODE_SET.has(abs)) continue;
      if(Number.isInteger(n) && n >= 1 && n <= 99) continue;
      out.push({n, raw:m[0].trim(), pos: (offset||0) + m.index});
    }
    return out;
  };

  // ТАБЛИЧНЫЙ РЕЖИМ: если PDF был разобран в структуру (desc + cols[]),
  // используем её — в ней числа уже разнесены по колонкам, и описание
  // статьи не мешается с цифрами.
  const tableRows = window._pickerPdfTableRows || [];
  const pageHeaders = window._pickerPdfPageHeaders || {};
  const useTable = tableRows.length > 0;
  const candidates = [];

  if(useTable){
    // Индекс по lineIdx — для look-ahead.
    const byLineIdx = new Map();
    tableRows.forEach(r => byLineIdx.set(r.lineIdx, r));

    tableRows.forEach(r => {
      const desc = r.desc || '';
      if(!lineMatchesHint(desc)) return;
      // 1. Сначала пытаемся взять числа из своей row.cols.
      let nums = [];
      const collectFrom = (rr, baseColIdx) => {
        (rr.cols || []).forEach((c, ci) => {
          const parsed = parseNumsFrom(c, 0);
          if(parsed.length){
            const best = parsed.reduce((a,b) => Math.abs(b.n) > Math.abs(a.n) ? b : a);
            nums.push({...best, colIdx: (baseColIdx || 0) + ci});
          }
        });
      };
      collectFrom(r, 0);
      // 2. Если пусто — fallback на plain-text строку (числа могли не
      // попасть в cols из-за классификации).
      if(!nums.length){
        const plain = lines[r.lineIdx] || '';
        const parsed = parseNumsFrom(plain, 0);
        if(parsed.length) nums = parsed.map((p, ci) => ({...p, colIdx: ci}));
      }
      // 3. Look-ahead: «Итого …» может быть без чисел, а числа — на
      // следующих 1-2 строках (той же страницы).
      if(!nums.length){
        for(let la = 1; la <= 2; la++){
          const next = byLineIdx.get(r.lineIdx + la);
          if(!next || next.page !== r.page) break;
          if(next.desc && lineMatchesHint(next.desc)) break; // следующая сама — кандидат
          collectFrom(next, 0);
          if(nums.length) break;
          // fallback на её plain-text
          const plain = lines[r.lineIdx + la] || '';
          const parsed = parseNumsFrom(plain, 0);
          if(parsed.length){
            nums = parsed.map((p, ci) => ({...p, colIdx: ci}));
            break;
          }
        }
      }
      if(!nums.length) return;

      const idx = r.lineIdx;
      const maxAbs = nums.reduce((acc, x) => Math.max(acc, Math.abs(x.n)), 0);
      const descLower = desc.toLowerCase();
      const mAll = descLower.match(new RegExp(hintRe.source, 'ig')) || [];
      const matchLen = mAll.reduce((a,b)=>a + b.length, 0);
      let score = matchLen + Math.log10(maxAbs + 10) * 3;

      // Шапка раздела (восстановим как и в текстовом режиме).
      const header = repPickerFindColumnHeader(lines, idx) || '';
      const headerLc = header.toLowerCase();
      if(/влияни|пересч|перес\s*чит|restat/i.test(headerLc)) score -= 6;
      const yearsInHeader = (header.match(/\b20\d{2}\b/g) || []);
      if(yearsInHeader.length >= 2) score += 4;
      const nowYear = new Date().getFullYear();
      if(yearsInHeader.includes(String(nowYear))) score += 1;
      if(yearsInHeader.includes(String(nowYear-1))) score += 1;

      if(/^\s*(итого|всего|total)\b/i.test(desc)) score += 6;
      if(/^\s*от\s+[а-я]/i.test(desc)) score -= 3;
      if(/признаваема(я|ой)/i.test(desc) && !/итого|всего/i.test(desc)) score -= 1;

      const ctx = repPickerCtxFor(f.id);
      if(ctx){
        const from = Math.max(0, idx - 6);
        const to   = Math.min(lines.length - 1, idx + 6);
        let nearHits = 0, antiHits = 0;
        for(let k = from; k <= to; k++){
          if(k === idx) continue;
          const L = lines[k] || '';
          if(!L.trim()) continue;
          if(ctx.near && ctx.near.test(L)) nearHits++;
          if(ctx.anti && ctx.anti.test(L)) antiHits++;
        }
        score += Math.min(nearHits, 3) * 1.5;
        score -= Math.min(antiHits, 3) * 2.0;
      }

      // Подписи колонок для карточки — из накопленной шапки страницы.
      const colLabels = (pageHeaders[r.page] || []).slice();

      candidates.push({
        idx, line: desc, origLine: desc, score,
        pick: nums[0], allNums: nums, maxAbs, header, table: true, colLabels
      });
    });
  }
  // Fallback: табличный режим ничего не нашёл — пробуем текстовый.
  if(!useTable || candidates.length === 0){
  // ТЕКСТОВЫЙ РЕЖИМ (fallback для не-PDF или старого кода).
  lines.forEach((line, idx) => {
    if(!lineMatchesHint(line)) return;
    let nums = parseNumsFrom(line, 0);
    let displayLine = line;
    // Если в строке с ключевым словом нет чисел — в PDF числа часто
    // оказываются на следующей строке (извлечение таблиц). Смотрим +1/+2.
    if(!nums.length){
      for(let la = 1; la <= 2 && idx + la < lines.length; la++){
        const next = lines[idx + la];
        if(!next || !next.trim()) continue;
        // Не прыгать через явно текстовую строку.
        if(/[а-яa-z]{4,}/i.test(next) && !/\d/.test(next)) break;
        const ns = parseNumsFrom(next, line.length + 1);
        if(ns.length){
          nums = ns;
          displayLine = line + ' ' + next;
          break;
        }
      }
    }
    if(!nums.length) return;

    const last = nums[nums.length - 1];
    const maxAbs = nums.reduce((acc, x) => Math.max(acc, Math.abs(x.n)), 0);
    const lineLower = line.toLowerCase();
    const mAll = lineLower.match(new RegExp(hintRe.source, 'ig')) || [];
    const matchLen = mAll.reduce((a,b)=>a + b.length, 0);
    let score = matchLen + Math.log10(maxAbs + 10) * 3;

    // Ищем шапку ПО ТОМУ ЖЕ idx и штрафуем/премируем строку.
    const header = repPickerFindColumnHeader(lines, idx) || '';
    const headerLc = header.toLowerCase();
    if(/влияни|пересч|перес\s*чит|restat/i.test(headerLc)) score -= 6;
    const yearsInHeader = (header.match(/\b20\d{2}\b/g) || []);
    if(yearsInHeader.length >= 2) score += 4;
    // Текущий год даёт небольшой бонус.
    const nowYear = new Date().getFullYear();
    if(yearsInHeader.includes(String(nowYear))) score += 1;
    if(yearsInHeader.includes(String(nowYear-1))) score += 1;

    // Строки, начинающиеся с «Итого/Всего/Total», поднимаем —
    // это почти всегда финальные суммы раздела.
    if(/^\s*(итого|всего|total)\b/i.test(line)) score += 6;
    // Подпункты обычно начинаются с «От …» (От реализации, От оказания…)
    // — это не итоги, а детализация. Пессимизируем.
    if(/^\s*от\s+[а-я]/i.test(line)) score -= 3;
    // Строки-заголовки разделов типа «Выручка, признаваемая в течение
    // времени» (без чисел или с малыми подпунктами в ней) — штрафуем,
    // чтобы настоящие ИТОГО всплывали.
    if(/признаваема(я|ой)/i.test(line) && !/итого|всего/i.test(line)) score -= 1;

    // Контекст раздела: смотрим ±6 строк вокруг кандидата. Если рядом
    // ожидаемые соседи (напр. «налог на прибыль» для процентных
    // расходов) — бонус; если чужой раздел (напр. «поступления» из
    // ОДДС) — штраф.
    const ctx = repPickerCtxFor(f.id);
    if(ctx){
      const from = Math.max(0, idx - 6);
      const to   = Math.min(lines.length - 1, idx + 6);
      let nearHits = 0, antiHits = 0;
      for(let k = from; k <= to; k++){
        if(k === idx) continue;
        const L = lines[k] || '';
        if(!L.trim()) continue;
        if(ctx.near && ctx.near.test(L)) nearHits++;
        if(ctx.anti && ctx.anti.test(L)) antiHits++;
      }
      score += Math.min(nearHits, 3) * 1.5;  // до +4.5
      score -= Math.min(antiHits, 3) * 2.0;  // до −6
    }

    candidates.push({idx, line: displayLine, origLine: line, score, pick: last, allNums: nums, maxAbs, header});
  });
  } // else (text mode)

  // Fallback: если по ключевым словам ничего не нашлось, собираем
  // топ-30 самых больших чисел по всему тексту с их строками — лучше
  // дать пользователю просмотреть глазами, чем прятать панель.
  let fallbackUsed = false;
  if(!candidates.length){
    fallbackUsed = true;
    const allByLine = [];
    lines.forEach((line, idx) => {
      const nums = parseNumsFrom(line, 0);
      if(!nums.length) return;
      const maxAbs = nums.reduce((acc, x) => Math.max(acc, Math.abs(x.n)), 0);
      // Отсекаем «мелочь» — в отчётах показатели обычно в тыс./млн ₽,
      // бизнес-значения всегда крупнее 1 000.
      if(maxAbs < 1000) return;
      // Штрафуем строки, похожие на шапку (годы/даты/номера страниц).
      const isDate  = /\b(19|20)\d{2}\b.*\b(19|20)\d{2}\b/.test(line) && !/\d{4,}/.test(line.replace(/\b(19|20)\d{2}\b/g,''));
      const isPage  = /^\s*(стр\.?|page)\s*\d+/i.test(line);
      if(isDate || isPage) return;
      const header = repPickerFindColumnHeader(lines, idx) || '';
      allByLine.push({idx, line, origLine:line, score:Math.log10(maxAbs+10), pick:nums[nums.length-1], allNums:nums, maxAbs, header});
    });
    allByLine.sort((a,b) => b.maxAbs - a.maxAbs);
    candidates.push(...allByLine.slice(0, 30));
  }

  if(!candidates.length){
    // Совсем пусто (в тексте нет крупных чисел — скан не распознался).
    list.innerHTML = `<div style="padding:10px;text-align:center;color:var(--warn);font-size:.6rem">⚠ В распознанном тексте вообще не нашлось подходящих чисел. Попробуйте «📄 Показать распознанный текст» и проверьте, что текст нормально извлёкся.</div>`;
    box.style.display = 'flex';
    return;
  }

  candidates.sort((a,b) => b.score - a.score);
  const top = candidates.slice(0, fallbackUsed ? 30 : 8);
  if(fallbackUsed){
    const warn = document.createElement('div');
    warn.style.cssText = 'padding:6px 8px;background:rgba(250,200,80,.08);border-left:2px solid var(--warn);color:var(--warn);font-size:.58rem;line-height:1.5';
    warn.innerHTML = `⚠ Ни одна строка не совпала с ключевыми словами для <strong>«${f.label}»</strong>. Показываю топ-${top.length} самых крупных чисел из текста — выберите подходящее вручную. Если нужного числа здесь нет — воспользуйтесь ручным поиском в поле «поиск» выше.`;
    list.appendChild(warn);
  }

  top.forEach(c => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;align-items:flex-start;flex-wrap:wrap;padding:6px 8px;background:var(--bg);border:1px solid var(--border)';

    // Заголовок карточки: название статьи + (если найдена) шапка колонок
    const head = document.createElement('div');
    head.style.cssText = 'flex:1 1 100%;display:flex;justify-content:space-between;gap:8px;align-items:baseline';

    const desc = document.createElement('div');
    desc.style.cssText = 'font-size:.62rem;color:var(--text2);line-height:1.4;flex:1';
    desc.title = c.line;
    const firstNumPos = c.allNums[0].pos;
    const descText = repPickerFixBrokenYears((c.line.slice(0, firstNumPos) || c.line).trim().replace(/\s+/g,' '));
    desc.textContent = descText.slice(0, 100) + (descText.length > 100 ? '…' : '');
    head.appendChild(desc);

    const ctxBtn = document.createElement('button');
    ctxBtn.type = 'button';
    ctxBtn.textContent = '📖 контекст';
    ctxBtn.className = 'btn btn-sm';
    ctxBtn.style.cssText = 'padding:2px 6px;font-size:.55rem';
    ctxBtn.onclick = () => repPickerOpenContext(c.idx);
    head.appendChild(ctxBtn);
    row.appendChild(head);

    // Шапка колонок (используем уже найденную в ранжировании).
    const colHeader = c.header;
    if(colHeader){
      const hd = document.createElement('div');
      hd.style.cssText = 'flex:1 1 100%;font-size:.56rem;color:var(--acc);opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
      hd.title = 'Шапка таблицы (ближайшая строка сверху с датой/годом)';
      hd.textContent = '↑ колонки: ' + colHeader.slice(0, 120);
      row.appendChild(hd);
    }

    // Если табличный режим — над числами показываем подписи колонок
    // (даты / «2025 / 2024») в один ряд с кнопками-значениями.
    const numsBar = document.createElement('div');
    numsBar.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;flex:1 1 100%;align-items:flex-end';
    c.allNums.forEach((num, i) => {
      const cell = document.createElement('div');
      cell.style.cssText = 'display:flex;flex-direction:column;gap:2px';
      if(c.table){
        const lab = document.createElement('div');
        lab.style.cssText = 'font-size:.52rem;color:var(--text3);text-align:center;letter-spacing:.05em';
        // Пытаемся аккуратно распарсить подписи колонок из шапки раздела.
        if(!c._derivedLabels){
          c._derivedLabels = repPickerDeriveColLabels(c.header, c.allNums.length);
        }
        const colIdx = num.colIdx != null ? num.colIdx : i;
        const derived = c._derivedLabels;
        lab.textContent = (derived && derived[colIdx]) ? derived[colIdx] : ('кол. ' + (colIdx+1));
        cell.appendChild(lab);
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = num.raw;
      b.title = 'Применить: ' + num.raw + ' × ' + (document.getElementById('rep-picker-unit')?.value || 1);
      b.className = 'btn btn-sm';
      b.style.cssText = 'padding:3px 8px;font-size:.64rem';
      b.onclick = () => repPickerAssign(num.n, b);
      cell.appendChild(b);
      numsBar.appendChild(cell);
    });
    row.appendChild(numsBar);

    list.appendChild(row);
  });

  box.style.display = 'flex';
}

// ── Полноэкранный просмотрщик контекста ──
// Сохраняем исходные позиции символов (pre, no-wrap, горизонтальная
// прокрутка) — удобно для больших таблиц отчётности.
window._pickerCtxIdx = 0;

function repPickerOpenContext(idx){
  window._pickerCtxIdx = idx;
  const before = document.getElementById('ctx-before'); if(before) before.value = '5';
  const after  = document.getElementById('ctx-after');  if(after)  after.value  = '5';
  const s = document.getElementById('ctx-search'); if(s) s.value = '';
  document.getElementById('modal-picker-context').classList.add('open');
  // Ловим системную кнопку «Назад» на мобилках — чтобы она закрывала
  // модалку, а не выкидывала с текущей страницы.
  try { history.pushState({pickerCtx:1}, ''); } catch(e){}
  // Восстанавливаем последнее состояние мини-окна PDF. По умолчанию:
  // если есть _pickerPdfDoc (загружен PDF) — pane показан, иначе скрыт.
  const pane = document.getElementById('ctx-pdf-pane');
  if(pane){
    let saved = null;
    try { saved = localStorage.getItem('bondan_ctx_pdf_pane'); } catch(e){}
    if(saved === '1' && window._pickerPdfDoc)      pane.style.display = 'flex';
    else if(saved === '0')                          pane.style.display = 'none';
    else                                            pane.style.display = window._pickerPdfDoc ? 'flex' : 'none';
  }
  // Восстанавливаем состояние маски распознавания.
  try {
    const savedMask = localStorage.getItem('bondan_ctx_mask');
    window._ctxMaskOn = savedMask === '1';
    const btn = document.getElementById('ctx-pdf-mask-btn');
    if(btn) btn.style.background = window._ctxMaskOn ? 'var(--acc)' : '';
    const legend = document.getElementById('ctx-pdf-legend');
    if(legend) legend.style.display = window._ctxMaskOn ? 'block' : 'none';
  } catch(e){}
  repPickerCtxRender();
}

// Закрыть контекст: если мы ранее делали pushState — откатываем историю
// (Назад и кнопка X тогда идут одинаково), иначе просто прячем.
function pickerCtxClose(){
  const m = document.getElementById('modal-picker-context');
  if(!m) return;
  if(history.state && history.state.pickerCtx){
    history.back(); // popstate → закроет модалку
  } else {
    m.classList.remove('open');
  }
}

// Системная кнопка «Назад» на мобилках: закрываем картой открытую модалку
// контекста (одну за раз), чтобы пользователь не выпадал из страницы.
window.addEventListener('popstate', () => {
  const m = document.getElementById('modal-picker-context');
  if(m && m.classList.contains('open')) m.classList.remove('open');
});

function repPickerCtxSet(b, a){
  const before = document.getElementById('ctx-before'); if(before) before.value = String(b);
  const after  = document.getElementById('ctx-after');  if(after)  after.value  = String(a);
  repPickerCtxRender();
}

function repPickerCtxRender(){
  const text = window._lastParsedText || '';
  if(!text) return;
  const lines = text.split(/\r?\n/);
  const idx = window._pickerCtxIdx || 0;
  const b = Math.max(0, parseInt(document.getElementById('ctx-before')?.value, 10) || 0);
  const a = Math.max(0, parseInt(document.getElementById('ctx-after')?.value, 10)  || 0);
  const from = Math.max(0, idx - b);
  const to   = Math.min(lines.length - 1, idx + a);
  const search = (document.getElementById('ctx-search')?.value || '').toLowerCase();

  const box = document.getElementById('ctx-text');
  const info = document.getElementById('ctx-info');
  if(!box) return;
  box.innerHTML = '';
  if(info) info.textContent = `строки ${from+1}–${to+1} из ${lines.length} (якорь: строка ${idx+1})`;

  // Регекс чисел — тот же, что в кандидатах.
  const numRe = /-?\(?\d{1,3}(?:[ \u00a0]\d{3})+(?:[.,]\d+)?\)?|-?\(?\d+(?:[.,]\d+)?\)?/g;

  // Сохранение пространственного положения: строки у нас — tab-разделённые
  // [desc, val1, val2 …]. В monospace можно выровнять по колонкам, если
  // каждое поле padding'овать до максимума по окну (desc — слева, value —
  // справа, чтобы цифры единиц/тысяч совпадали вертикально).
  const splitted = [];
  let maxCols = 0;
  for(let k = from; k <= to; k++){
    const raw = lines[k] || '';
    const parts = raw.split('\t');
    splitted.push(parts);
    if(parts.length > maxCols) maxCols = parts.length;
  }
  const colWidths = new Array(maxCols).fill(0);
  for(const parts of splitted){
    for(let i = 0; i < parts.length; i++){
      if(parts[i].length > colWidths[i]) colWidths[i] = parts[i].length;
    }
  }
  const padLeft  = (s, w) => s + ' '.repeat(Math.max(0, w - s.length));
  const padRight = (s, w) => ' '.repeat(Math.max(0, w - s.length)) + s;
  const GAP = '  ';

  for(let k = from; k <= to; k++){
    const parts = splitted[k - from];
    // Склеиваем обратно с padding'ом: desc слева, value-колонки — справа.
    const aligned = parts.map((p, i) => {
      if(!colWidths[i]) return p;
      return i === 0 ? padLeft(p, colWidths[i]) : padRight(p, colWidths[i]);
    }).join(GAP);
    const line = repPickerFixBrokenYears(aligned);
    const row = document.createElement('div');
    row.style.cssText = 'display:block' + (k === idx ? ';background:rgba(100,200,255,.08);border-left:2px solid var(--acc);padding-left:4px' : ';padding-left:6px');

    // Номер строки
    const ln = document.createElement('span');
    ln.textContent = (k === idx ? '▶ ' : '  ') + String(k+1).padStart(5,' ') + ' │ ';
    ln.style.color = 'var(--text3)';
    row.appendChild(ln);

    // Разбиваем строку на числовые и не-числовые куски.
    numRe.lastIndex = 0;
    const matches = [];
    let m;
    while((m = numRe.exec(line)) !== null){
      matches.push({start:m.index, end:m.index + m[0].length, raw:m[0]});
    }
    // Функция подсветки поиска в тексте.
    const appendText = (txt) => {
      if(!search){ row.appendChild(document.createTextNode(txt)); return; }
      const low = txt.toLowerCase();
      let i = 0;
      while(i < txt.length){
        const p = low.indexOf(search, i);
        if(p < 0){ row.appendChild(document.createTextNode(txt.slice(i))); break; }
        if(p > i) row.appendChild(document.createTextNode(txt.slice(i, p)));
        const hi = document.createElement('mark');
        hi.textContent = txt.slice(p, p + search.length);
        hi.style.cssText = 'background:var(--acc);color:#000;padding:0 1px';
        row.appendChild(hi);
        i = p + search.length;
      }
    };

    let cursor = 0;
    matches.forEach(mt => {
      if(mt.start > cursor) appendText(line.slice(cursor, mt.start));
      const n = repPickerParseNumber(mt.raw);
      const abs = n !== null ? Math.abs(n) : 0;
      const isClickable = n !== null && abs >= 1 && !RSBU_CODE_SET.has(abs) && !(Number.isInteger(n) && n >= 1 && n <= 99);
      if(isClickable){
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = mt.raw;
        btn.style.cssText = 'display:inline-block;padding:0 4px;margin:0;border:1px solid var(--border2);background:var(--s2);color:var(--text);font:inherit;cursor:pointer;border-radius:2px';
        btn.onclick = () => repPickerAssign(n, btn);
        row.appendChild(btn);
      } else {
        const sp = document.createElement('span');
        sp.textContent = mt.raw;
        sp.style.color = 'var(--text3)';
        row.appendChild(sp);
      }
      cursor = mt.end;
    });
    if(cursor < line.length) appendText(line.slice(cursor));
    if(!line.trim()) row.innerHTML += '&nbsp;';
    box.appendChild(row);
  }

  // Прокрутка к якорной строке — только внутри контейнера ctx-text,
  // чтобы не скроллить основное окно страницы.
  const anchor = box.children[idx - from];
  if(anchor){
    const target = anchor.offsetTop - box.clientHeight / 2 + anchor.clientHeight / 2;
    box.scrollTop = Math.max(0, target);
  }

  // Мини-окно PDF справа — синхронизируем страницу с текущим якорем.
  // Видимость pane контролируется кнопкой «🖼️ оригинал» (состояние
  // запоминается в localStorage).
  ctxPdfSyncToAnchor();
}

// ── Мини-окно оригинала PDF рядом с контекстом ───────────────────
// Ключевая боль распознавания: иногда парсер рвёт/склеивает цифры и
// не ясно, откуда взялись «триллионы в выручке». Имея оригинал
// страницы сбоку, можно за 2 секунды свериться глазами без
// переключения на другую вкладку с PDF.

window._ctxPdfPage = null;
window._ctxPdfTask = null;

function ctxTogglePdfPane(){
  const pane = document.getElementById('ctx-pdf-pane');
  if(!pane) return;
  const shown = pane.style.display !== 'none' && pane.style.display !== '';
  if(shown){
    pane.style.display = 'none';
    try { localStorage.setItem('bondan_ctx_pdf_pane','0'); } catch(e){}
  } else {
    pane.style.display = 'flex';
    try { localStorage.setItem('bondan_ctx_pdf_pane','1'); } catch(e){}
    ctxPdfSyncToAnchor();
  }
}

function ctxPdfSyncToAnchor(){
  const pane = document.getElementById('ctx-pdf-pane');
  if(!pane || pane.style.display === 'none' || pane.style.display === '') return;
  const idx = window._pickerCtxIdx || 0;
  const pb = window._pickerPdfPageBoundaries || [0];
  let p = 1;
  for(let i = pb.length - 1; i >= 0; i--){
    if(idx >= pb[i]){ p = i + 1; break; }
  }
  _ctxRenderMiniPdf(p);
}

function ctxPdfNav(delta){
  const pdf = window._pickerPdfDoc;
  if(!pdf) return;
  const cur = window._ctxPdfPage || 1;
  const next = Math.max(1, Math.min(pdf.numPages, cur + delta));
  _ctxRenderMiniPdf(next);
}

async function _ctxRenderMiniPdf(pageNum){
  const pdf = window._pickerPdfDoc;
  const canvas = document.getElementById('ctx-pdf-canvas');
  const empty = document.getElementById('ctx-pdf-empty');
  const info = document.getElementById('ctx-pdf-info');
  if(!canvas) return;
  if(!pdf){
    canvas.style.display = 'none';
    if(empty) empty.style.display = 'block';
    if(info) info.textContent = 'нет PDF';
    _ctxRenderMask(null, null);
    return;
  }
  if(empty) empty.style.display = 'none';
  canvas.style.display = 'inline-block';
  pageNum = Math.max(1, Math.min(pdf.numPages, pageNum || 1));
  window._ctxPdfPage = pageNum;
  if(info) info.textContent = `стр. ${pageNum} / ${pdf.numPages}`;
  try {
    const page = await pdf.getPage(pageNum);
    const scroll = document.getElementById('ctx-pdf-scroll');
    const paneW = Math.max(200, (scroll?.clientWidth || 400) - 8);
    const vp1 = page.getViewport({scale: 1});
    const scale = paneW / vp1.width;
    const vp = page.getViewport({scale});
    canvas.width = vp.width;
    canvas.height = vp.height;
    if(window._ctxPdfTask) try { window._ctxPdfTask.cancel(); } catch(e){}
    window._ctxPdfTask = page.render({canvasContext: canvas.getContext('2d'), viewport: vp});
    await window._ctxPdfTask.promise;
    window._ctxPdfTask = null;
    _ctxRenderMask(pageNum, vp);
  } catch(e){
    if(info) info.textContent = 'ошибка: ' + (e.message || e);
  }
}

// ── Маска распознавания поверх мини-PDF ──────────────────────────
// Цель: наглядно показать, как парсер понял страницу. Рисуем рамки
// колонок (colStarts + classified kind) и box вокруг каждого item
// с цветом по типу (desc/value/note/code/period). Вкл/выкл кнопкой
// «🎭 маска». По умолчанию — выкл (маска может закрывать текст).
window._ctxMaskOn = false;
function ctxPdfToggleMask(){
  window._ctxMaskOn = !window._ctxMaskOn;
  try { localStorage.setItem('bondan_ctx_mask', window._ctxMaskOn ? '1' : '0'); } catch(e){}
  const btn = document.getElementById('ctx-pdf-mask-btn');
  if(btn) btn.style.background = window._ctxMaskOn ? 'var(--acc)' : '';
  const legend = document.getElementById('ctx-pdf-legend');
  if(legend) legend.style.display = window._ctxMaskOn ? 'block' : 'none';
  // Перерисовать — viewport неизвестен здесь, используем последний
  // кэшированный через повторный render страницы.
  const p = window._ctxPdfPage;
  if(p) _ctxRenderMiniPdf(p);
}

const _MASK_BG = {
  desc:   'rgba(100,150,255,.18)',
  value:  'rgba(100,255,150,.18)',
  note:   'rgba(255,220,100,.22)',
  code:   'rgba(180,180,180,.22)',
  period: 'rgba(200,100,255,.22)'
};
const _MASK_BD = {
  desc:   'rgba(100,150,255,.8)',
  value:  'rgba(100,255,150,.8)',
  note:   'rgba(255,220,100,.9)',
  code:   'rgba(180,180,180,.9)',
  period: 'rgba(200,100,255,.9)'
};

function _ctxRenderMask(pageNum, viewport){
  const overlay = document.getElementById('ctx-pdf-overlay');
  if(!overlay) return;
  overlay.innerHTML = '';
  if(!pageNum || !viewport || !window._ctxMaskOn) return;
  const layout = window._pickerPdfPageLayout?.[pageNum];
  if(!layout) return;
  overlay.style.width  = viewport.width  + 'px';
  overlay.style.height = viewport.height + 'px';
  const {colStarts, colKinds, items} = layout;
  // 1) Колоночные зоны — фоновые вертикальные полосы.
  for(let c = 0; c < colStarts.length; c++){
    const kind = colKinds[c] || 'desc';
    const sx = viewport.convertToViewportPoint(colStarts[c], 0)[0];
    const ex = c + 1 < colStarts.length
      ? viewport.convertToViewportPoint(colStarts[c+1], 0)[0]
      : viewport.width;
    const d = document.createElement('div');
    d.style.cssText = `position:absolute;left:${sx}px;top:0;width:${Math.max(1, ex - sx)}px;height:100%;background:${_MASK_BG[kind] || 'transparent'};border-left:1px dashed ${_MASK_BD[kind] || '#888'}`;
    d.title = `col ${c}: ${kind}`;
    overlay.appendChild(d);
  }
  // 2) Boxes вокруг items — точная классификация каждого токена.
  for(const it of items){
    const kind = it.kind || 'desc';
    // PDF baseline → canvas coords: verttex наверху = y_base − h.
    const topLeft = viewport.convertToViewportPoint(it.x, it.y + it.h);
    const bottomRight = viewport.convertToViewportPoint(it.x + it.w, it.y);
    const x = Math.min(topLeft[0], bottomRight[0]);
    const y = Math.min(topLeft[1], bottomRight[1]);
    const w = Math.abs(bottomRight[0] - topLeft[0]);
    const h = Math.abs(bottomRight[1] - topLeft[1]);
    if(w < 0.5 || h < 0.5) continue;
    const b = document.createElement('div');
    b.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;border:1px solid ${_MASK_BD[kind] || '#888'};box-sizing:border-box`;
    b.title = `${kind}: ${it.str}`;
    overlay.appendChild(b);
  }
}

// ── PDF-вид страницы с кликабельными числами ──
window._pdfvPage = 1;
window._pdfvScale = 1.5;

function pdfvOpenFromCtx(){
  if(!window._pickerPdfDoc){ alert('PDF-вид доступен только для PDF-файлов, загруженных через «Ручной подбор из PDF».'); return; }
  // Определяем страницу по якорной строке контекста.
  const pb = window._pickerPdfPageBoundaries || [0];
  const idx = window._pickerCtxIdx || 0;
  let pageNum = 1;
  for(let i = pb.length - 1; i >= 0; i--){
    if(idx >= pb[i]){ pageNum = i + 1; break; }
  }
  pdfvOpen(pageNum);
}

async function pdfvOpen(pageNum){
  const pdf = window._pickerPdfDoc;
  if(!pdf){ alert('Сначала загрузите PDF.'); return; }
  window._pdfvPage = Math.max(1, Math.min(pdf.numPages, pageNum || 1));
  document.getElementById('modal-pdf-view').classList.add('open');
  try { history.pushState({pdfv:1}, ''); } catch(e){}
  const total = document.getElementById('pdfv-total');
  if(total) total.textContent = String(pdf.numPages);
  await pdfvRender();
}

function pdfvClose(){
  const m = document.getElementById('modal-pdf-view');
  if(!m) return;
  if(history.state && history.state.pdfv){
    history.back();
  } else {
    m.classList.remove('open');
  }
}

function pdfvNav(delta){
  const pdf = window._pickerPdfDoc;
  if(!pdf) return;
  const next = Math.max(1, Math.min(pdf.numPages, (window._pdfvPage || 1) + delta));
  window._pdfvPage = next;
  pdfvRender();
}

function pdfvZoom(delta){
  window._pdfvScale = Math.max(0.5, Math.min(4.0, (window._pdfvScale || 1.5) + delta * 0.25));
  pdfvRender();
}

async function pdfvRender(){
  const pdf = window._pickerPdfDoc;
  const container = document.getElementById('pdfv-container');
  if(!pdf || !container) return;
  const pn = window._pdfvPage || 1;
  const pageLbl = document.getElementById('pdfv-page');
  if(pageLbl) pageLbl.textContent = String(pn);
  container.innerHTML = '<div style="padding:20px;color:#444">⏳ рендеринг…</div>';

  let page;
  try { page = await pdf.getPage(pn); } catch(e){ container.innerHTML = 'Ошибка: '+e.message; return; }
  const scale = window._pdfvScale || 1.5;
  const viewport = page.getViewport({scale});

  container.innerHTML = '';
  container.style.width = viewport.width + 'px';
  container.style.height = viewport.height + 'px';

  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  canvas.style.cssText = 'position:absolute;top:0;left:0;display:block';
  container.appendChild(canvas);
  const cctx = canvas.getContext('2d');
  try { await page.render({canvasContext:cctx, viewport}).promise; }
  catch(e){ console.warn('render err', e); }

  // Текстовый слой с кликабельными числами поверх canvas.
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:absolute;top:0;left:0;width:'+viewport.width+'px;height:'+viewport.height+'px;pointer-events:none';
  container.appendChild(overlay);

  let content;
  try { content = await page.getTextContent(); } catch(e){ return; }

  const numRe = /-?\(?\d{1,3}(?:[ \u00a0]\d{3})+(?:[.,]\d+)?\)?|-?\(?\d+(?:[.,]\d+)?\)?/g;

  for(const it of (content.items || [])){
    const str = it.str || '';
    if(!str.trim()) continue;
    // Проверяем, есть ли в item числа.
    numRe.lastIndex = 0;
    let hasNum = false;
    const matches = [];
    let m;
    while((m = numRe.exec(str)) !== null){
      const n = repPickerParseNumber(m[0]);
      if(n === null) continue;
      const abs = Math.abs(n);
      if(abs < 1) continue;
      if(RSBU_CODE_SET.has(abs)) continue;
      if(Number.isInteger(n) && n >= 1 && n <= 99) continue;
      matches.push({raw:m[0], n, start:m.index, end:m.index+m[0].length});
      hasNum = true;
    }
    if(!hasNum) continue;

    // Позиционирование: transform item через viewport
    const tx = pdfjsLib.Util.transform(viewport.transform, it.transform);
    const fontH = Math.abs(tx[3] || tx[0] || 12);
    const left = tx[4];
    const top  = tx[5] - fontH; // PDF origin — нижний левый, у нас верхний

    // Один кликабельный overlay-span на всё содержимое item. Если
    // чисел несколько — применяется ПЕРВОЕ (редкий случай).
    const pick = matches[0];
    const span = document.createElement('button');
    span.type = 'button';
    span.textContent = str;
    span.title = 'Применить: ' + pick.raw;
    span.style.cssText = 'position:absolute;left:'+left+'px;top:'+top+'px;height:'+fontH+'px;line-height:'+fontH+'px;font-size:'+fontH*0.9+'px;padding:0 1px;margin:0;border:1px solid rgba(255,200,0,.9);background:rgba(255,240,120,.45);color:transparent;cursor:pointer;white-space:pre;pointer-events:auto;font-family:sans-serif;border-radius:2px';
    span.onmouseover = () => { span.style.background = 'rgba(120,255,120,.7)'; };
    span.onmouseout  = () => { span.style.background = 'rgba(255,240,120,.45)'; };
    span.onclick = (ev) => {
      ev.preventDefault();
      // Если чисел несколько — можно ткнуть снова; применяем все по очереди
      // (простая логика: по количеству нажатий — круговой выбор).
      const idx = (parseInt(span.dataset.pickIdx,10) || 0) % matches.length;
      const m = matches[idx];
      span.dataset.pickIdx = String(idx + 1);
      repPickerAssign(m.n, span);
      // Мини-тост снизу
      const hint = document.getElementById('pdfv-hint');
      if(hint) hint.textContent = '✓ применено: ' + m.raw + (matches.length>1 ? ' ('+ (idx+1) +'/'+ matches.length +') — тапни ещё для другого числа' : '');
    };
    overlay.appendChild(span);
  }
}

// Закрытие по системной «Назад» (в дополнение к уже настроенной
// для modal-picker-context).
(function(){
  const orig = window.onpopstate;
  window.addEventListener('popstate', () => {
    const m = document.getElementById('modal-pdf-view');
    if(m && m.classList.contains('open')) m.classList.remove('open');
  });
})();

function repRenderPickerLines(text){
  repPickerRenderSuggestions(text);
  const box = document.getElementById('rep-picker-lines');
  if(!box) return;
  box.innerHTML = '';
  const f = repPickerGetFilters();
  const lines = text.split(/\r?\n/);
  const numRe = /-?\(?\d{1,3}(?:[ \u00a0]\d{3})+(?:[.,]\d+)?\)?|-?\(?\d+(?:[.,]\d+)?\)?/g;
  let totalNums = 0, shownNums = 0, shownLines = 0;

  // Поиск: если есть '|' — интерпретируем как regex-альтернативы.
  let searchRe = null;
  if(f.search){
    try { searchRe = new RegExp(f.search, 'i'); }
    catch(e){ searchRe = null; }
  }
  // Fallback: поиск по «схлопнутой» строке (без пробелов между буквами)
  // — PDF часто разбивает слова на части, регекс их не находит.
  const searchNormParts = f.search ? f.search.split('|').map(x => x.toLowerCase().replace(/\s+/g,'')).filter(Boolean) : [];
  const lineMatchesSearch = (line) => {
    if(!f.search) return true;
    if(searchRe && searchRe.test(line)) return true;
    const norm = line.toLowerCase().replace(/\s+/g,'');
    return searchNormParts.some(h => norm.includes(h));
  };

  lines.forEach((line, idx) => {
    // Поиск по строкам — отфильтровываем целиком
    if(!lineMatchesSearch(line)) return;

    const matches = [];
    let m; numRe.lastIndex = 0;
    while((m = numRe.exec(line)) !== null){
      matches.push({start:m.index, end:m.index + m[0].length, raw:m[0], n: repPickerParseNumber(m[0])});
    }
    totalNums += matches.length;
    const visibleChips = matches.filter(mt => repPickerShouldShow(mt.n, f));
    // Если в строке нет ни одного видимого чипа и нет поиска — можно скрыть строку,
    // чтобы не плодить шум. Но при активном поиске строку оставляем.
    if(!visibleChips.length && !f.search) return;

    shownLines++;
    shownNums += visibleChips.length;

    const row = document.createElement('div');
    row.style.padding = '2px 0';
    row.style.borderBottom = '1px dashed var(--border)';
    const idxSpan = document.createElement('span');
    idxSpan.textContent = String(idx+1).padStart(4,' ') + '  ';
    idxSpan.style.color = 'var(--text3)';
    row.appendChild(idxSpan);

    // Вспом. для подсветки совпадений поискового regex в текстовых кусках.
    const appendTextHighlighted = (txt) => {
      if(!searchRe || !txt){ row.appendChild(document.createTextNode(txt)); return; }
      let i = 0;
      const re = new RegExp(searchRe.source, 'ig');
      let mm;
      while((mm = re.exec(txt)) !== null){
        if(mm.index > i) row.appendChild(document.createTextNode(txt.slice(i, mm.index)));
        const hi = document.createElement('mark');
        hi.textContent = mm[0];
        hi.style.cssText = 'background:var(--acc);color:#000;padding:0 2px;border-radius:2px';
        row.appendChild(hi);
        i = mm.index + mm[0].length;
        if(!mm[0].length) re.lastIndex++;
      }
      if(i < txt.length) row.appendChild(document.createTextNode(txt.slice(i)));
    };

    let cursor = 0;
    matches.forEach(mt => {
      if(mt.start > cursor) appendTextHighlighted(line.slice(cursor, mt.start));
      if(repPickerShouldShow(mt.n, f)){
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = mt.raw.trim();
        btn.dataset.value = String(mt.n);
        btn.style.cssText = 'display:inline-block;margin:0 2px;padding:1px 6px;border:1px solid var(--border2);background:var(--s2);color:var(--text);font:inherit;cursor:pointer;border-radius:3px';
        btn.onmouseover = ()=>{ btn.style.background = 'var(--accent)'; btn.style.color = '#fff'; };
        btn.onmouseout  = ()=>{ btn.style.background = 'var(--s2)';    btn.style.color = 'var(--text)'; };
        btn.onclick = ()=> repPickerAssign(mt.n, btn);
        row.appendChild(btn);
      } else {
        // Скрытые числа — серым текстом, чтобы были видны, но не кликались
        const sp = document.createElement('span');
        sp.textContent = mt.raw;
        sp.style.color = 'var(--text3)';
        sp.style.opacity = '.6';
        row.appendChild(sp);
      }
      cursor = mt.end;
    });
    if(cursor < line.length) appendTextHighlighted(line.slice(cursor));
    if(!line.trim()) row.innerHTML = '&nbsp;';
    box.appendChild(row);
  });

  const stats = document.getElementById('rep-picker-stats');
  if(stats) stats.textContent = `чипов: ${shownNums}/${totalNums}, строк: ${shownLines}/${lines.length}`;
  if(!box.children.length){
    const empty = document.createElement('div');
    empty.style.color = 'var(--text3)';
    empty.textContent = '— нет строк под текущие фильтры —';
    box.appendChild(empty);
  }
}

// Перерисовка при смене любого фильтра.
function repPickerRerender(){
  const text = window._lastParsedText || '';
  if(text) repRenderPickerLines(text);
}

// «Нет в отчёте» — очищаем текущее поле, двигаемся к следующему.
// Используется когда показатель не представлен в загруженном PDF (напр.
// EBITDA в промежуточном отчёте, или LTM-значение для полугодия).
function repPickerSkip(){
  const sel = document.getElementById('rep-picker-target');
  if(!sel) return;
  const fields = window._pickerFields || REP_PICKER_FIELDS;
  const input = document.getElementById(sel.value);
  if(input) input.value = '';
  const idx = sel.selectedIndex;
  fields.forEach((f,i)=>{
    const cur = document.getElementById(f.id);
    const curVal = cur && cur.value ? ` = ${cur.value}` : (i === idx ? ' — нет в отчёте' : '');
    if(sel.options[i]) sel.options[i].textContent = f.label + curVal;
  });
  if(idx + 1 < sel.options.length) sel.selectedIndex = idx + 1;
  repPickerUpdateCurrent();
}

// Применить число, вписанное/вставленное вручную.
function repPickerApplyManual(){
  const el = document.getElementById('rep-picker-manual');
  if(!el) return;
  const raw = el.value.trim();
  if(!raw){ alert('Введите число или вставьте фрагмент.'); return; }
  const n = repPickerParseNumber(raw);
  if(n === null){ alert('Не удалось распознать число из: '+raw); return; }
  repPickerAssign(n, null);
  el.value = '';
  el.focus();
}

function repPickerAssign(value, btn){
  const sel = document.getElementById('rep-picker-target');
  const unitSel = document.getElementById('rep-picker-unit');
  if(!sel || !sel.value) return;
  const unit = unitSel ? parseFloat(unitSel.value) : 1;
  const finalVal = value * (isFinite(unit) ? unit : 1);
  const input = document.getElementById(sel.value);
  if(input){
    // округляем до 3 знаков, убираем хвостовые нули
    input.value = (Math.round(finalVal * 1000) / 1000).toString();
  }
  // визуальная отметка кнопки
  if(btn){
    btn.style.background = 'var(--green, #2a7a2a)';
    btn.style.color = '#fff';
    btn.style.borderColor = 'var(--green, #2a7a2a)';
  }
  // Обновляем подписи с текущими значениями в select
  const idx = sel.selectedIndex;
  const fields = window._pickerFields || REP_PICKER_FIELDS;
  fields.forEach((f,i)=>{
    const cur = document.getElementById(f.id);
    const curVal = cur && cur.value ? ` = ${cur.value}` : '';
    if(sel.options[i]) sel.options[i].textContent = f.label + curVal;
  });
  // двигаемся на следующее поле
  if(idx + 1 < sel.options.length){
    sel.selectedIndex = idx + 1;
  }
  repPickerUpdateCurrent();
}

function repPickerUpdateCurrent(){
  const sel = document.getElementById('rep-picker-target');
  const info = document.getElementById('rep-picker-current');
  if(!sel || !info) return;
  const fields = window._pickerFields || REP_PICKER_FIELDS;
  const f = fields.find(x => x.id === sel.value);
  // пересчитать кандидатов для нового поля
  if(window._lastParsedText) repPickerRenderSuggestions(window._lastParsedText);
  if(!f){ info.textContent = ''; return; }
  const input = document.getElementById(f.id);
  const cur = input && input.value ? input.value : '—';
  info.innerHTML = `Текущее значение «${f.label}»: <strong style="color:var(--text)">${cur}</strong>`;
}

function repNewPeriodModal(){
  // По умолчанию открываем модал в режиме «добавить новый» — сбрасываем
  // флаг режима редактирования и возвращаем оригинальный заголовок.
  window._repEditOldKey = null;
  const hdr = document.querySelector('#modal-rep-period .modal-hdr');
  if(hdr && hdr.firstChild) hdr.firstChild.nodeValue = 'Добавить период отчётности ';
  // Сброс переключателя единиц в «млрд» (в памяти данные всегда в млрд).
  window._repNpCurrentUnit = 'млрд';
  const bnRadio = document.querySelector('input[name="rep-np-unit"][value="млрд"]');
  if(bnRadio){ bnRadio.checked = true; _repNpSetUnit('млрд'); }
  // Clear fields
  ['rep-np-rev','rep-np-ebitda','rep-np-np','rep-np-ebit','rep-np-assets','rep-np-eq',
   'rep-np-debt','rep-np-cash','rep-np-ca','rep-np-cl','rep-np-int','rep-np-ret','rep-np-note'].forEach(id=>{
    const el=document.getElementById(id); if(el) el.value='';
  });
  document.getElementById('rep-np-file-status').textContent='файл не выбран';
  document.getElementById('rep-np-parse-log').style.display='none';
  const rawWrap = document.getElementById('rep-np-raw-wrap');
  if(rawWrap) rawWrap.style.display='none';
  const rawArea = document.getElementById('rep-np-raw-text');
  if(rawArea){ rawArea.value=''; rawArea.style.display='none'; }
  const rawBtn = document.getElementById('rep-np-raw-btn');
  if(rawBtn) rawBtn.textContent = '📄 Показать распознанный текст';
  const scaleWrap = document.getElementById('rep-np-scale-wrap');
  if(scaleWrap) scaleWrap.style.display='none';
  const autoRadio = document.querySelector('input[name="rep-np-scale"][value="auto"]');
  if(autoRadio) autoRadio.checked = true;
  // Единицы ручного ввода сбрасываем на млрд ₽ (дефолт, placeholder'ы
  // и подпись подогнаны под этот случай).
  const bln = document.querySelector('input[name="rep-np-manual-unit"][value="1"]');
  if(bln){ bln.checked = true; if(typeof repManualUnitChanged === 'function') repManualUnitChanged(); }
  window._lastParsedText = '';
  // Сбрасываем блок сверки с ГИР БО — чтобы при открытии/новом периоде
  // не висели результаты от предыдущего сеанса.
  const girboWrap = document.getElementById('rep-np-girbo-wrap');
  if(girboWrap){ girboWrap.style.display = 'none'; }
  const girboRes = document.getElementById('rep-np-girbo-result');
  if(girboRes) girboRes.innerHTML = '';
  const girboStatus = document.getElementById('rep-np-girbo-status');
  if(girboStatus) girboStatus.innerHTML = '';
  // Статус библиотек распознавания. Теперь они грузятся лениво
  // (при первом выборе файла), поэтому до клика это нормально, что
  // PDF/DOCX/XLSX «ещё не загружены» — паниковать не надо.
  const libEl=document.getElementById('rep-lib-status');
  if(libEl){
    const xlsxOk = typeof XLSX!=='undefined';
    const mammothOk = typeof mammoth!=='undefined';
    const pdfOk = typeof pdfjsLib!=='undefined';
    if(xlsxOk&&mammothOk&&pdfOk){
      libEl.innerHTML='<span style="color:var(--green)">✓ PDF, DOCX, XLSX готовы</span>';
    } else {
      const loaded = [pdfOk && 'PDF', mammothOk && 'DOCX', xlsxOk && 'XLSX'].filter(Boolean);
      const pending = [!pdfOk && 'PDF', !mammothOk && 'DOCX', !xlsxOk && 'XLSX'].filter(Boolean);
      const parts = [];
      if(loaded.length) parts.push(`<span style="color:var(--green)">✓ ${loaded.join(', ')}</span>`);
      if(pending.length) parts.push(`<span style="color:var(--text3)">${pending.join(', ')} — догрузятся при выборе файла (~2 МБ)</span>`);
      libEl.innerHTML = parts.join(' · ');
    }
  }
  document.getElementById('modal-rep-period').classList.add('open');
}

// Коэффициент перевода из выбранной пользователем единицы в млрд ₽
// (внутреннее представление в reportsDB).
const _REP_UNIT_TO_BN = {'млн': 1/1000, 'млрд': 1, 'трлн': 1000};

// Текущая единица ввода в форме. Меняется радио-кнопками; при сохранении
// используется для пересчёта всех числовых полей в млрд.
window._repNpCurrentUnit = 'млрд';

// Переключение единицы: пересчитывает все числовые поля формы, чтобы
// отображать то же значение в новой шкале. При сохранении данные
// интерпретируются в текущей единице и переводятся в млрд.
function _repNpSetUnit(newUnit){
  const prev = window._repNpCurrentUnit || 'млрд';
  // Подсветка активной метки (border/background).
  document.querySelectorAll('#rep-np-unit-switch label').forEach(lbl => {
    const active = lbl.querySelector('input')?.value === newUnit;
    lbl.style.borderColor = active ? 'var(--acc)' : 'var(--border)';
    lbl.style.background  = active ? 'var(--acc-dim)' : 'transparent';
  });
  if(newUnit === prev){ window._repNpCurrentUnit = newUnit; return; }
  // Множитель перевода «величина, как она есть в поле» из prev в new.
  // Поле содержит число в единицах prev; чтобы остаться в тех же млрд,
  // новое число = старое × (prev→млрд) / (new→млрд).
  const factor = _REP_UNIT_TO_BN[prev] / _REP_UNIT_TO_BN[newUnit];
  ['rep-np-rev','rep-np-ebitda','rep-np-np','rep-np-ebit',
   'rep-np-assets','rep-np-eq','rep-np-debt','rep-np-cash',
   'rep-np-ca','rep-np-cl','rep-np-int','rep-np-ret'].forEach(id => {
    const el = document.getElementById(id);
    if(!el || !el.value) return;
    const v = parseFloat(el.value);
    if(isNaN(v)) return;
    const out = v * factor;
    const abs = Math.abs(out);
    el.value = abs >= 100 ? out.toFixed(0)
             : abs >= 1   ? out.toFixed(2)
             : abs >= 0.01 ? out.toFixed(3)
             : out.toFixed(5);
  });
  window._repNpCurrentUnit = newUnit;
}

// Пересчёт значений формы множителем без смены единицы ввода. Для
// исправления уже введённых чисел, попавших не в ту шкалу.
function _repNpRescale(factor){
  const ids = ['rep-np-rev','rep-np-ebitda','rep-np-np','rep-np-ebit',
               'rep-np-assets','rep-np-eq','rep-np-debt','rep-np-cash',
               'rep-np-ca','rep-np-cl','rep-np-int','rep-np-ret'];
  const anyFilled = ids.some(id => document.getElementById(id)?.value);
  if(!anyFilled){ alert('В форме пока нет чисел для пересчёта.'); return; }
  const op = factor < 1 ? `÷ ${Math.round(1/factor)}` : `× ${factor}`;
  if(!confirm(`Пересчитать все заполненные поля: ${op}? Единица ввода останется прежней — ${window._repNpCurrentUnit || 'млрд'} ₽.`)) return;
  ids.forEach(id => {
    const el = document.getElementById(id);
    if(!el || !el.value) return;
    const v = parseFloat(el.value);
    if(isNaN(v)) return;
    const out = v * factor;
    const abs = Math.abs(out);
    el.value = abs >= 100 ? out.toFixed(0)
             : abs >= 1   ? out.toFixed(2)
             : abs >= 0.01 ? out.toFixed(3)
             : out.toFixed(5);
  });
}

function repSavePeriod(){
  if(!repActiveIssuerId) return;
  const year=document.getElementById('rep-np-year').value;
  const period=document.getElementById('rep-np-period').value;
  const type=document.getElementById('rep-np-type').value;
  const key=`${year}_${period}_${type}`;
  // Множитель в млрд из текущей единицы ввода формы.
  const unit = window._repNpCurrentUnit || 'млрд';
  const toBn = _REP_UNIT_TO_BN[unit] || 1;
  const gn = id => {
    const v = parseFloat(document.getElementById(id).value);
    return isNaN(v) ? null : v * toBn;
  };
  const data={
    year,period,type,note:document.getElementById('rep-np-note').value.trim(),
    rev:gn('rep-np-rev'), ebitda:gn('rep-np-ebitda'), np:gn('rep-np-np'), ebit:gn('rep-np-ebit'),
    assets:gn('rep-np-assets'), eq:gn('rep-np-eq'), debt:gn('rep-np-debt'), cash:gn('rep-np-cash'),
    ca:gn('rep-np-ca'), cl:gn('rep-np-cl'), int:gn('rep-np-int'), ret:gn('rep-np-ret'),
  };
  // Режим редактирования: если ключ изменился (поменяли год/период/тип) —
  // удаляем старую запись, чтобы не плодить дубликаты. Если такой ключ
  // уже есть и не наш — спросим подтверждение.
  const oldKey = window._repEditOldKey || null;
  const periods = reportsDB[repActiveIssuerId].periods;
  if(periods[key] && key !== oldKey){
    if(!confirm(`Период ${year} ${period} ${type} уже существует у этого эмитента. Перезаписать?`)) return;
  }
  if(oldKey && oldKey !== key) delete periods[oldKey];
  // Сохраняем заметку из старой записи, если редактируем и новое поле пустое.
  if(oldKey && periods[oldKey] && !data.note) data.note = periods[oldKey].note || '';
  periods[key]=data;
  repActivePeriodKey=key;
  window._repEditOldKey = null;
  save(); closeModal('modal-rep-period');
  repBuildPeriodTabs();
}

// Открыть форму с заполненными значениями активного периода.
function repEditPeriod(){
  if(!repActiveIssuerId || !repActivePeriodKey) return;
  const p = reportsDB[repActiveIssuerId]?.periods?.[repActivePeriodKey];
  if(!p){ alert('Активный период не найден'); return; }
  // Сбрасываем модал в чистое состояние тем же путём, что и для нового.
  repNewPeriodModal();
  // Помечаем «режим редактирования» (для repSavePeriod) и заполняем поля.
  window._repEditOldKey = repActivePeriodKey;
  const setVal = (id, v) => { const el = document.getElementById(id); if(el) el.value = (v == null ? '' : v); };
  setVal('rep-np-year',  p.year);
  setVal('rep-np-period', p.period || 'FY');
  setVal('rep-np-type',  p.type || 'РСБУ');
  setVal('rep-np-note',  p.note || '');
  setVal('rep-np-rev',   p.rev);
  setVal('rep-np-ebitda',p.ebitda);
  setVal('rep-np-np',    p.np);
  setVal('rep-np-ebit',  p.ebit);
  setVal('rep-np-assets',p.assets);
  setVal('rep-np-eq',    p.eq);
  setVal('rep-np-debt',  p.debt);
  setVal('rep-np-cash',  p.cash);
  setVal('rep-np-ca',    p.ca);
  setVal('rep-np-cl',    p.cl);
  setVal('rep-np-int',   p.int);
  setVal('rep-np-ret',   p.ret);
  // Подменяем заголовок модала, чтобы было ясно — это правка.
  const hdr = document.querySelector('#modal-rep-period .modal-hdr');
  if(hdr) hdr.firstChild.nodeValue = `Редактирование периода ${p.year} ${p.period || 'FY'} ${p.type || ''} `;
}

function repDeletePeriod(){
  if(!repActiveIssuerId || !repActivePeriodKey) return;
  const p = reportsDB[repActiveIssuerId]?.periods?.[repActivePeriodKey];
  if(!p) return;
  if(!confirm(`Удалить период ${p.year} ${p.period || 'FY'} ${p.type || ''}?`)) return;
  delete reportsDB[repActiveIssuerId].periods[repActivePeriodKey];
  repActivePeriodKey = null;
  save();
  repBuildPeriodTabs();
  _repSyncPeriodToolbar();
}

// ═════════════════════════════════════════════════════════════════════
// СВЕРКА С ГИР БО (привязка ввода к реальности)
// ─────────────────────────────────────────────────────────────────────
// Правила «EBITDA ≤ выручки» ловят грубые нарушения, но не защищают от
// главной беды — смешивания цифр разных лет или разного масштаба.
// Единственный доступный нам внешний источник истины — ГИР БО ФНС.
// Для каждого поля формы сравниваем введённое значение с официальной
// строкой РСБУ за тот же год по ИНН эмитента. Работает только для
// годовых РСБУ-периодов (квартальные и МСФО ФНС не публикует).
//
// Пороги: ≤2% — ок (округления), 2-10% — предупреждение, >10% — ошибка.
// Рядом с каждой строкой — кнопка «применить», чтобы одним кликом
// подставить значение ФНС в поле формы.
// ═════════════════════════════════════════════════════════════════════

// Поля, которые сверяем. EBITDA сюда не включена — ФНС её не считает
// (это не строка РСБУ, а расчёт). Пользователь поймёт по отсутствию.
const _REP_GIRBO_COMPARE_FIELDS = [
  {id:'rep-np-rev',    label:'Выручка (2110)'},
  {id:'rep-np-ebit',   label:'Прибыль от продаж (2200)'},
  {id:'rep-np-np',     label:'Чистая прибыль (2400)'},
  {id:'rep-np-int',    label:'Проценты к уплате (2330)'},
  {id:'rep-np-assets', label:'Всего активов (1600)'},
  {id:'rep-np-ca',     label:'Оборотные активы (1200)'},
  {id:'rep-np-cash',   label:'Денежные средства (1250)'},
  {id:'rep-np-eq',     label:'Капитал и резервы (1300)'},
  {id:'rep-np-ret',    label:'Нераспр. прибыль (1370)'},
  {id:'rep-np-debt',   label:'Долг — займы (1410+1510)'},
  {id:'rep-np-cl',     label:'Кр. обязательства (1500)'},
];

function _repGirboHide(){
  const wrap = document.getElementById('rep-np-girbo-wrap');
  if(wrap) wrap.style.display = 'none';
}

function _repGirboFmt(v){
  if(v == null || isNaN(v)) return '—';
  const a = Math.abs(v);
  if(a >= 100) return v.toFixed(0);
  if(a >= 1)   return v.toFixed(2);
  if(a >= 0.01) return v.toFixed(3);
  return v.toFixed(5);
}

// Подставить значение ГИР БО в конкретное поле формы (в единицах
// текущего ввода). Подсвечиваем поле на 1.5 сек.
function _repGirboApply(fieldId, value){
  const el = document.getElementById(fieldId);
  if(!el) return;
  const rounded = Math.round(value * 1000) / 1000;
  el.value = rounded.toString();
  const prevBg = el.style.background;
  el.style.background = 'rgba(30,180,90,.22)';
  setTimeout(() => { el.style.background = prevBg; }, 1500);
}

async function repVerifyGirbo(){
  if(!repActiveIssuerId){ alert('Сначала выберите эмитента'); return; }
  const iss = reportsDB[repActiveIssuerId];
  const wrap = document.getElementById('rep-np-girbo-wrap');
  const res = document.getElementById('rep-np-girbo-result');
  const status = document.getElementById('rep-np-girbo-status');
  if(!wrap || !res || !status) return;
  wrap.style.display = 'block';
  res.innerHTML = '';

  // 1. ИНН. Если пуст — спрашиваем и сохраняем в карточку.
  let inn = iss?.inn;
  if(!inn){
    inn = (prompt('У эмитента не указан ИНН. Введите (10 цифр для юрлица, 12 для ИП):', '') || '').trim();
    if(!inn){ wrap.style.display = 'none'; return; }
    if(!/^\d{10}(\d{2})?$/.test(inn)){
      status.innerHTML = '<span style="color:var(--danger)">ИНН должен быть 10 или 12 цифр.</span>';
      return;
    }
    iss.inn = inn;
    save();
  }

  // 2. Параметры текущего периода в форме.
  const year = parseInt(document.getElementById('rep-np-year').value, 10);
  const period = document.getElementById('rep-np-period').value;
  const type = document.getElementById('rep-np-type').value;
  if(!year){
    status.innerHTML = '<span style="color:var(--danger)">Сначала выберите год периода в форме.</span>';
    return;
  }
  const isAnnual = !period || /год|FY|year|annual/i.test(period);
  const warnings = [];
  if(!isAnnual) warnings.push(`⚠ ГИР БО содержит только <strong>годовые</strong> РСБУ. Период «${period}» напрямую не сравнить — покажу годовой итог ${year} как ориентир.`);
  if(type === 'МСФО') warnings.push('⚠ Тип периода — МСФО (консолидация). ГИР БО отдаёт standalone РСБУ головной компании. Расхождения в разы — нормальны, это <strong>разная отчётность</strong>, не ошибка.');
  if(type === 'ГИРБО') warnings.push('⚠ Период уже помечен как ГИРБО — сверка потенциально круговая.');

  status.innerHTML = `<span style="color:var(--warn)">⏳ Запрос к ГИР БО по ИНН ${inn} через прокси <code style="font-size:.55rem">${_girboProxyBase()}</code>…</span>`;

  let data;
  try {
    data = await fetchGirboByInn(inn, 10);
  } catch(e){
    status.innerHTML = `<span style="color:var(--danger)">❌ ${e.message}</span>`;
    res.innerHTML = `<div style="font-size:.58rem;color:var(--text3);margin-top:6px">Если прокси не работает — поменяйте его в «⚡ Sync» → «📡 ГИР БО — прокси». Либо разверните свой Cloudflare Worker (см. cf-worker.js в репо) — надёжнее и приватнее.</div>`;
    return;
  }

  // 3. Найти годовой отчёт того же года.
  const targetLbl = _periodLabel(year, 'FY');
  const years = Object.keys(data.series || {}).sort((a, b) => _periodSortKey(b) - _periodSortKey(a));
  const girboVals = data.series && data.series[targetLbl];
  if(!girboVals){
    const avail = years.length ? years.join(', ') : '—';
    status.innerHTML = `<span style="color:var(--warn)">Нет годового отчёта ${year} в ГИР БО.</span> Доступно: ${avail}.`;
    res.innerHTML = `<div style="font-size:.58rem;color:var(--text3);margin-top:6px">ФНС публикует годовую РСБУ с лагом 3–6 мес. после конца года. Свежие цифры могут ещё не быть загружены.</div>`;
    return;
  }

  // 4. Сравниваем поле за полем. inBn — введённое в млрд (для
  // арифметики); в колонках показываем в текущих единицах формы,
  // чтобы было удобно править рядом.
  const unit = window._repNpCurrentUnit || 'млрд';
  const toBn = _REP_UNIT_TO_BN[unit] || 1;
  let ok = 0, warn = 0, err = 0, missForm = 0, missGirbo = 0;

  const rows = _REP_GIRBO_COMPARE_FIELDS.map(f => {
    const el = document.getElementById(f.id);
    const rawIn = el && el.value !== '' ? parseFloat(el.value) : null;
    const inBn = rawIn == null || isNaN(rawIn) ? null : rawIn * toBn;
    const girboBn = typeof girboVals[f.id] === 'number' ? girboVals[f.id] : null;

    if(inBn == null && girboBn == null) return ''; // нечего показывать

    let color = 'var(--text3)', label = '—', verdict = 'skip';
    if(inBn == null){
      missForm++;
      verdict = 'miss-form'; color = 'var(--text3)'; label = 'в форме пусто';
    } else if(girboBn == null){
      missGirbo++;
      verdict = 'miss-girbo'; color = 'var(--text3)'; label = 'нет в ГИР БО';
    } else {
      const base = Math.max(Math.abs(inBn), Math.abs(girboBn), 1e-9);
      const pct = (inBn - girboBn) / base * 100;
      const abs = Math.abs(pct);
      const signed = (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%';
      if(abs <= 2){ ok++; color = 'var(--green)'; label = '✓ Δ ' + signed; }
      else if(abs <= 10){ warn++; verdict = 'warn'; color = 'var(--warn)'; label = '⚠ Δ ' + signed; }
      else { err++; verdict = 'err'; color = 'var(--danger)'; label = '❌ Δ ' + signed; }
    }

    // Значение для «применить» — в единицах текущего ввода.
    const applyVal = girboBn != null ? (girboBn / toBn) : null;
    const applyBtn = applyVal != null
      ? `<button type="button" class="btn btn-sm" style="padding:1px 6px;font-size:.54rem" onclick="_repGirboApply('${f.id}', ${applyVal})" title="Подставить значение ГИР БО в поле формы">→</button>`
      : '';
    const girboShow = girboBn == null ? '—' : _repGirboFmt(girboBn / toBn);
    const formShow = rawIn == null ? '—' : _repGirboFmt(rawIn);
    const rowBg = verdict === 'err' ? 'background:rgba(220,60,60,.06);'
                : verdict === 'warn' ? 'background:rgba(240,180,0,.05);' : '';

    return `<tr style="${rowBg}">
      <td style="padding:3px 6px">${f.label}</td>
      <td style="padding:3px 6px;text-align:right;font-family:var(--mono)">${formShow}</td>
      <td style="padding:3px 6px;text-align:right;font-family:var(--mono);color:var(--text2)">${girboShow}</td>
      <td style="padding:3px 6px;color:${color};white-space:nowrap;font-weight:600">${label}</td>
      <td style="padding:3px 6px;text-align:center">${applyBtn}</td>
    </tr>`;
  }).filter(Boolean).join('');

  const company = data.company ? `<span style="color:var(--text3)">${data.company}</span>` : '';
  const summary = `<strong style="color:var(--green)">✓ ${ok}</strong> &nbsp; <strong style="color:var(--warn)">⚠ ${warn}</strong> &nbsp; <strong style="color:var(--danger)">❌ ${err}</strong> &nbsp; <span style="color:var(--text3)">нет в ГИР БО: ${missGirbo}, пусто в форме: ${missForm}</span>`;
  const warnBanner = warnings.length
    ? `<div style="background:rgba(240,180,0,.08);border-left:3px solid var(--warn);padding:6px 10px;margin-bottom:8px;font-size:.58rem;color:var(--text2);line-height:1.5">${warnings.join('<br>')}</div>`
    : '';
  const bigErrHint = err > 0
    ? `<div style="margin-top:6px;padding:6px 10px;background:rgba(220,60,60,.06);border-left:3px solid var(--danger);font-size:.58rem;color:var(--text2);line-height:1.5"><strong>❌ Расхождения > 10%</strong> — самая частая причина:<br>• значения попали <strong>не из того года</strong> (проверь год в форме и в исходнике);<br>• ошибка <strong>масштаба</strong> (кнопки ÷1000 / ×1000 сверху помогут);<br>• распознавание PDF подставило не ту строку — можно нажать «→» чтобы применить цифру ФНС.</div>`
    : '';

  status.innerHTML = `<span style="color:var(--text2)">ГИР БО ${targetLbl} ${company}</span>`;
  res.innerHTML = `
    ${warnBanner}
    <div style="margin-bottom:4px;font-size:.58rem">${summary}</div>
    <table style="width:100%;font-size:.6rem;border-collapse:collapse">
      <thead><tr style="background:var(--bg2);color:var(--text3);font-size:.54rem;letter-spacing:.05em">
        <th style="padding:3px 6px;text-align:left">Показатель (строка РСБУ)</th>
        <th style="padding:3px 6px;text-align:right">В форме, ${unit} ₽</th>
        <th style="padding:3px 6px;text-align:right">ГИР БО, ${unit} ₽</th>
        <th style="padding:3px 6px;text-align:left">Δ</th>
        <th style="padding:3px 6px"></th>
      </tr></thead>
      <tbody>${rows || '<tr><td colspan="5" style="padding:10px;text-align:center;color:var(--text3)">Нет совпадений — ни в форме, ни в ГИР БО.</td></tr>'}</tbody>
    </table>
    ${bigErrHint}
    <div style="margin-top:6px;font-size:.54rem;color:var(--text3);line-height:1.5">
      Пороги: ≤ 2% — округления (✓); 2–10% — предупреждение (⚠); > 10% — почти наверняка ошибка (❌).
      Данные ФНС появляются с лагом 3–6 мес. после конца года; EBITDA и ebitda-маржа в РСБУ не публикуются.
    </div>
  `;
}

// ═════════════════════════════════════════════════════════════════════
// АУДИТ reportsDB: проверка логических нестыковок по всем периодам
// всех эмитентов. Две категории:
//   🔴 HARD — балансовые тождества нарушены (такое в реальной
//              отчётности невозможно, значит поле перепутано).
//   🟡 SOFT — подозрительно, но теоретически возможно (редко).
//
// Толерантность 0.5% — округления в отчётах в млрд с 1 знаком после
// запятой периодически дают «балансовые» отклонения до 0.3%.
// ═════════════════════════════════════════════════════════════════════

const _REP_AUDIT_TOL = 1.005; // +0.5%
const _REP_AUDIT_RULES = [
  // ── HARD: нарушения балансового уравнения ──
  {id:'eq_gt_assets', sev:'hard', label:'Капитал > Активы',
   hint:'Капитал (eq) — часть пассивов, всегда ≤ Активов. Скорее всего перепутано значение eq/assets или одно из них в другом масштабе.',
   test:d => d.eq!=null && d.assets!=null && d.eq > d.assets * _REP_AUDIT_TOL,
   fields:['eq','assets']},
  {id:'ca_gt_assets', sev:'hard', label:'Оборотные активы > Всего активов',
   hint:'Оборотные активы (ca) — часть всех активов. Должно быть ca ≤ assets.',
   test:d => d.ca!=null && d.assets!=null && d.ca > d.assets * _REP_AUDIT_TOL,
   fields:['ca','assets']},
  {id:'cl_gt_assets', sev:'hard', label:'Кр. обязательства > Активы',
   hint:'Краткосрочные обязательства не могут превышать все активы — иначе даже ликвидировав всё, компания не погасит долги в течение года.',
   test:d => d.cl!=null && d.assets!=null && d.cl > d.assets * _REP_AUDIT_TOL,
   fields:['cl','assets']},
  {id:'cash_gt_ca', sev:'hard', label:'ДС > Оборотные активы',
   hint:'Денежные средства (cash) — часть оборотных активов (ca). Должно быть cash ≤ ca.',
   test:d => d.cash!=null && d.ca!=null && d.cash > d.ca * _REP_AUDIT_TOL,
   fields:['cash','ca']},
  {id:'cash_gt_assets', sev:'hard', label:'ДС > Все активы',
   hint:'Денежные средства не могут превышать все активы.',
   test:d => d.cash!=null && d.assets!=null && d.cash > d.assets * _REP_AUDIT_TOL,
   fields:['cash','assets']},
  {id:'ebit_gt_ebitda', sev:'hard', label:'EBIT > EBITDA',
   hint:'EBITDA = EBIT + амортизация, амортизация ≥ 0. Значит EBITDA всегда ≥ EBIT. Скорее всего местами перепутаны.',
   test:d => d.ebit!=null && d.ebitda!=null && d.ebit > d.ebitda * _REP_AUDIT_TOL,
   fields:['ebit','ebitda']},
  {id:'debt_gt_assets_x2', sev:'hard', label:'Долг более чем в 2 раза превышает активы',
   hint:'Долг > 2 × активов — почти наверняка разный масштаб (млн ₽ vs млрд ₽) или перепутали поле.',
   test:d => d.debt!=null && d.assets!=null && d.debt > d.assets * 2,
   fields:['debt','assets']},
  // ── SOFT: подозрительно ──
  {id:'ebitda_gt_rev', sev:'soft', label:'EBITDA > Выручка',
   hint:'EBITDA выше выручки встречается только у холдингов с большими прочими доходами. Чаще всего — перепутаны местами.',
   test:d => d.ebitda!=null && d.rev!=null && d.rev > 0 && d.ebitda > d.rev * _REP_AUDIT_TOL,
   fields:['ebitda','rev']},
  {id:'np_gt_ebit_x2', sev:'soft', label:'ЧП > EBIT × 2',
   hint:'ЧП обычно меньше EBIT (из-за налогов и процентов). Если больше — перепутано или большой финансовый доход. Для очень маленьких компаний (EBIT < 0.5 млрд) правило не срабатывает — при такой базе любой ×2 легко достигается округлениями.',
   // Отсекаем шум при малом EBIT: 0.29 против 0.06 формально в 4.8×,
   // но это 60 млн против 290 млн — разница не о «перепутанных
   // полях», а об особенностях округления до млрд.
   test:d => d.np!=null && d.ebit!=null && d.ebit > 0.5 && d.np > d.ebit * 2,
   fields:['np','ebit']},
  {id:'ret_gt_eq', sev:'soft', label:'Нераспр. прибыль существенно > Капитал',
   hint:'В МСФО капитал = уставный + добавочный + нераспределённая + накопленный OCI ± казначейские. Если OCI отрицательный (курсовые потери, переоценки), нераспр. прибыль законно превышает итоговый капитал. Мы триггерим только при ret > 1.5 × eq и eq > 0 — это уже не структурный эффект, а вероятная ошибка поля.',
   test:d => d.ret!=null && d.eq!=null && d.eq > 0.1 && d.ret > d.eq * 1.5,
   fields:['ret','eq']},
  {id:'rev_neg', sev:'soft', label:'Отрицательная выручка',
   hint:'Отрицательная выручка в РСБУ/МСФО бывает лишь как корректировки. Проверьте знак.',
   test:d => d.rev!=null && d.rev < -0.0001,
   fields:['rev']},
  {id:'int_neg', sev:'soft', label:'Отрицательные процентные расходы',
   hint:'В карточке отчётности проценты принято вводить как положительную величину.',
   test:d => d.int!=null && d.int < -0.0001,
   fields:['int']},
  {id:'net_margin_huge', sev:'soft', label:'Чистая маржа > 80%',
   hint:'np/rev > 80% — очень редко бывает (только у финансовых холдингов в отдельные периоды). Проверьте, не перепутаны ли np и rev.',
   test:d => d.np!=null && d.rev!=null && d.rev > 0 && d.np / d.rev > 0.8,
   fields:['np','rev']},
  {id:'ebitdam_huge', sev:'soft', label:'EBITDA-маржа > 95%',
   hint:'Почти чистая EBITDA из выручки — нереалистично для производственной/торговой компании.',
   test:d => d.ebitda!=null && d.rev!=null && d.rev > 0 && d.ebitda / d.rev > 0.95,
   fields:['ebitda','rev']}
];

function _repAuditIssuer(iss, issId){
  const out = [];
  for(const [pKey, p] of Object.entries(iss.periods || {})){
    if(!p) continue;
    for(const rule of _REP_AUDIT_RULES){
      if(rule.test(p)){
        out.push({issId, issName: iss.name || issId, pKey, p, rule});
      }
    }
  }
  return out;
}

// Импорт одного эмитента с периодами из JSON-файла. Формат:
// {schema:'bondan/issuer/v1', name:'…', ind:'transport',
//  periods:{<key>: {year, period, type, rev, ebitda, …}}}
// Если эмитент с таким же name уже есть — мёрджим периоды (новые
// добавляются, существующие перезаписываются). Если нет — создаём.
function repImportIssuerJson(input){
  const file = input.files && input.files[0];
  if(!file) return;
  input.value = '';
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const d = JSON.parse(e.target.result);
      if(!d || !d.name) throw new Error('В файле нет поля name');
      if(!d.periods || typeof d.periods !== 'object') throw new Error('В файле нет поля periods');
      let issId = Object.keys(reportsDB).find(k => reportsDB[k].name === d.name);
      let created = false;
      if(!issId){
        issId = 'iss_imp_' + Math.floor(Math.random() * 1e9).toString(36) + '_' + Date.now().toString(36);
        reportsDB[issId] = {name: d.name, ind: d.ind || '', periods: {}};
        created = true;
      } else if(d.ind && !reportsDB[issId].ind){
        reportsDB[issId].ind = d.ind;
      }
      let added = 0, updated = 0;
      for(const [key, p] of Object.entries(d.periods)){
        if(!p || !p.year) continue;
        if(reportsDB[issId].periods[key]) updated++;
        else added++;
        reportsDB[issId].periods[key] = p;
      }
      save();
      document.getElementById('sb-rep').textContent = Object.keys(reportsDB).length;
      alert(`✅ ${d.name}\n${created ? 'Создан новый эмитент' : 'Эмитент уже существовал'} · периодов: +${added} добавлено, ${updated} обновлено.`);
      // Перейти на импортированного эмитента и отрендерить.
      repActiveIssuerId = issId;
      repActivePeriodKey = null;
      const sel = document.getElementById('rep-issuer-sel');
      if(sel){
        repRebuildSelect();
        sel.value = issId;
        repSelectIssuer();
      }
    } catch(err){
      alert('❌ Не удалось импортировать: ' + err.message);
    }
  };
  reader.readAsText(file);
}

function repRunAudit(){
  const all = [];
  for(const [issId, iss] of Object.entries(reportsDB || {})){
    all.push(..._repAuditIssuer(iss, issId));
  }
  // Подсчёт периодов всего.
  let totalPeriods = 0, totalIssuers = 0;
  for(const iss of Object.values(reportsDB || {})){
    totalIssuers++;
    totalPeriods += Object.keys(iss.periods || {}).length;
  }
  const hardCnt = all.filter(a => a.rule.sev === 'hard').length;
  const softCnt = all.filter(a => a.rule.sev === 'soft').length;
  const sumEl = document.getElementById('rep-audit-summary');
  const bodyEl = document.getElementById('rep-audit-body');
  if(sumEl){
    if(!all.length){
      sumEl.innerHTML = `<span style="color:var(--green)">✓ Проверено ${totalPeriods} период(ов) у ${totalIssuers} эмитент(ов). Логических нестыковок не найдено.</span>`;
    } else {
      sumEl.innerHTML = `Проверено <strong>${totalPeriods}</strong> период(ов) у <strong>${totalIssuers}</strong> эмитент(ов). Найдено проблем: <span style="color:var(--danger)">🔴 ${hardCnt} критичных</span>, <span style="color:var(--warn)">🟡 ${softCnt} подозрительных</span>. Кликните по строке — откроется редактирование периода.`;
    }
  }
  if(bodyEl){
    if(!all.length){
      bodyEl.innerHTML = '<div style="padding:12px;color:var(--text3);text-align:center">Все значения логически согласованы.</div>';
    } else {
      // Группируем по эмитенту.
      const byIss = {};
      for(const a of all){ (byIss[a.issId] ||= {name: a.issName, items: []}).items.push(a); }
      // HARD сначала, в пределах эмитента — периоды по убыванию.
      const fmtV = v => v == null ? '—' : (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2));
      const html = Object.entries(byIss).map(([issId, g]) => {
        g.items.sort((a, b) => (a.rule.sev === 'hard' ? 0 : 1) - (b.rule.sev === 'hard' ? 0 : 1));
        const rows = g.items.map(a => {
          const p = a.p;
          const sevIco = a.rule.sev === 'hard' ? '🔴' : '🟡';
          const sevClr = a.rule.sev === 'hard' ? 'var(--danger)' : 'var(--warn)';
          const vals = a.rule.fields.map(f => `<code style="color:var(--text2)">${f}=${fmtV(p[f])}</code>`).join(' · ');
          return `<tr onclick="repAuditJumpTo('${a.issId}','${a.pKey}')" style="cursor:pointer" onmouseover="this.style.background='var(--acc-dim)'" onmouseout="this.style.background=''">
            <td style="padding:4px 6px;border:1px solid var(--border);text-align:center">${sevIco}</td>
            <td style="padding:4px 6px;border:1px solid var(--border);white-space:nowrap;color:var(--text2)">${p.year} ${p.period || 'FY'} <span style="color:var(--text3);font-size:.55rem">${p.type || ''}</span></td>
            <td style="padding:4px 6px;border:1px solid var(--border);color:${sevClr}"><strong>${a.rule.label}</strong><div style="color:var(--text3);font-size:.55rem;margin-top:2px">${a.rule.hint}</div></td>
            <td style="padding:4px 6px;border:1px solid var(--border)">${vals}</td>
          </tr>`;
        }).join('');
        return `<div style="margin-top:10px">
          <div style="font-weight:600;font-size:.65rem;color:var(--text);margin-bottom:4px">🏢 ${g.name} <span style="color:var(--text3);font-size:.55rem">· ${g.items.length} проблем(ы)</span></div>
          <table style="width:100%;border-collapse:collapse">
            <thead><tr style="color:var(--text3);background:var(--bg)">
              <th style="padding:3px 4px;border:1px solid var(--border);width:28px">!</th>
              <th style="padding:3px 4px;border:1px solid var(--border);text-align:left;width:110px">Период</th>
              <th style="padding:3px 4px;border:1px solid var(--border);text-align:left">Правило</th>
              <th style="padding:3px 4px;border:1px solid var(--border);text-align:left">Значения</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
      }).join('');
      bodyEl.innerHTML = html;
    }
  }
  document.getElementById('modal-rep-audit').classList.add('open');
}

// Клик по строке аудита → переход к этому эмитенту/периоду и сразу в режим редактирования.
function repAuditJumpTo(issId, pKey){
  if(!reportsDB[issId] || !reportsDB[issId].periods[pKey]) return;
  closeModal('modal-rep-audit');
  showPage('reports');
  repActiveIssuerId = issId;
  repActivePeriodKey = pKey;
  const sel = document.getElementById('rep-issuer-sel');
  if(sel){
    sel.value = issId;
    if(typeof repSelectIssuer === 'function') repSelectIssuer();
  }
  // После того как repSelectIssuer сбросил активный период — восстанавливаем тот, куда прыгаем.
  repActivePeriodKey = pKey;
  repBuildPeriodTabs();
  _repSyncPeriodToolbar();
  // Прямо открываем модал редактирования.
  setTimeout(() => repEditPeriod(), 50);
}

// ── File parsers ──
// Последний распознанный текст — доступен для копирования через кнопку
// «📄 Показать распознанный текст» под логом парсинга.
window._lastParsedText = '';

// При смене radio-переключателя единиц заново пересчитываем поля из
// того же текста — это быстрее чем перечитывать файл.
function repChangeScale(){
  if(!window._lastParsedText) return;
  const sel = document.querySelector('input[name="rep-np-scale"]:checked');
  const val = sel ? sel.value : 'auto';
  const override = val === 'auto' ? null : parseFloat(val);
  repFillFromText(window._lastParsedText, override);
}

async function repParseFile(input){
  const file=input.files[0]; if(!file) return;
  const status=document.getElementById('rep-np-file-status');
  const log=document.getElementById('rep-np-parse-log');
  status.style.color='var(--warn)';
  status.textContent='⏳ Читаю '+file.name+'...';
  log.style.display='none';

  const ext=file.name.split('.').pop().toLowerCase();
  try{
    let text='';
    if(ext==='pdf'){
      text = await repExtractPdf(file);
    } else if(ext==='docx'){
      text = await repExtractDocx(file);
    } else if(ext==='xlsx'||ext==='xls'){
      text = await repExtractXlsx(file);
    } else if(isImageExt(ext)){
      status.style.color='var(--warn)';
      status.textContent='⏳ OCR изображения '+file.name+'...';
      text = await repOcrImage(file, (p, n, phase) => {
        status.style.color='var(--warn)';
        status.textContent = phase==='init'
          ? '⏳ Загружаю OCR-модели (русский/английский)...'
          : '⏳ Распознаю изображение...';
      });
    } else {
      status.style.color='var(--danger)';
      status.textContent='Формат не поддерживается. Используйте PDF, DOCX, XLSX или фото (JPG/PNG).';
      return;
    }
    window._lastParsedText = text;
    const rawWrap = document.getElementById('rep-np-raw-wrap');
    const rawArea = document.getElementById('rep-np-raw-text');
    if(rawWrap) rawWrap.style.display = 'block';
    if(rawArea) rawArea.value = text;
    const scaleWrap = document.getElementById('rep-np-scale-wrap');
    if(scaleWrap) scaleWrap.style.display = 'block';
    // Сбрасываем radio на «авто» при новой загрузке.
    const autoRadio = document.querySelector('input[name="rep-np-scale"][value="auto"]');
    if(autoRadio) autoRadio.checked = true;
    let filled = repFillFromText(text);

    // Фоллбэк: PDF без текстового слоя («скан»). Если текст слишком короткий
    // или цифр не нашлось — предлагаем OCR.
    const looksLikeScan = ext==='pdf' && filled===0 && text.replace(/\s/g,'').length < 300;
    if(looksLikeScan){
      const ok = confirm(
        'В PDF не нашли текстового слоя — похоже, это скан.\n\n'+
        'Запустить OCR (распознавание по изображениям)?\n'+
        '• ~8 МБ моделей языков скачается один раз\n'+
        '• ~15–30 сек на страницу\n'+
        '• Распознаётся до 15 первых страниц\n\n'+
        'Продолжить?'
      );
      if(ok){
        try {
          const ocrText = await repOcrPdf(file, (p, n, phase) => {
            status.style.color='var(--warn)';
            status.textContent = phase==='init'
              ? `⏳ Загружаю OCR-модели (русский/английский)...`
              : `⏳ OCR стр. ${p}/${n}...`;
          });
          filled = repFillFromText(ocrText);
          status.style.color = filled>0 ? 'var(--green)' : 'var(--warn)';
          status.textContent = filled>0
            ? `✓ OCR: найдено ${filled} показателей · ${file.name}`
            : `OCR завершён, но цифры не распознаны. Проверьте качество скана.`;
          return;
        } catch(e){
          status.style.color='var(--danger)';
          status.textContent='OCR не удался: '+e.message;
          return;
        }
      }
    }

    status.style.color = filled>0?'var(--green)':'var(--warn)';
    status.textContent = filled>0 ? `✓ Найдено ${filled} показателей · ${file.name}` : `Цифры не найдены · ${file.name}`;
  } catch(e){
    status.style.color='var(--danger)';
    status.textContent='Ошибка: '+e.message;
  }
}

// OCR картинки (JPG/PNG/WebP и т.п.): прогоняем через tesseract.js
// напрямую — без промежуточной отрисовки. Языки: русский + английский.
// Предобработка: большие картинки (>1600 px по узкой стороне) уменьшаем,
// чтобы уложиться в разумное время распознавания.
async function repOcrImage(file, onProgress) {
  if(typeof window._loadTesseract !== 'function') throw new Error('OCR-лоадер не инициализирован');
  if(onProgress) onProgress(0, 1, 'init');
  await window._loadTesseract();
  if(typeof Tesseract === 'undefined') throw new Error('Tesseract.js недоступен');

  // Готовим источник: пробуем уменьшить слишком большие снимки.
  let source = file;
  try {
    const bmp = await createImageBitmap(file);
    const minSide = Math.min(bmp.width, bmp.height);
    const MAX_MIN_SIDE = 1600;
    if(minSide > MAX_MIN_SIDE){
      const k = MAX_MIN_SIDE / minSide;
      const w = Math.round(bmp.width * k);
      const h = Math.round(bmp.height * k);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
      source = canvas;
    } else {
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width; canvas.height = bmp.height;
      canvas.getContext('2d').drawImage(bmp, 0, 0);
      source = canvas;
    }
  } catch(_) {
    // Браузер не поддержал createImageBitmap / файл не-картинка —
    // tesseract сам справится с File.
  }

  const worker = await Tesseract.createWorker(['rus','eng'], 1, {
    logger: m => {
      if(m.status && onProgress && m.status.includes('loading')) {
        onProgress(0, 1, 'init');
      }
    }
  });
  try {
    if(onProgress) onProgress(1, 1, 'ocr');
    const { data } = await worker.recognize(source);
    return data.text || '';
  } finally {
    await worker.terminate();
  }
}

const IMG_EXTS = ['jpg','jpeg','png','webp','bmp','gif'];
function isImageExt(ext){ return IMG_EXTS.includes((ext||'').toLowerCase()); }

// OCR PDF-скана: рендерим каждую страницу в canvas и прогоняем через
// tesseract.js. Языки: русский + английский. Возвращаем склеенный текст.
async function repOcrPdf(file, onProgress) {
  if(typeof window._loadTesseract !== 'function') throw new Error('OCR-лоадер не инициализирован');
  if(onProgress) onProgress(0, 0, 'init');
  await window._loadTesseract();
  if(typeof Tesseract === 'undefined') throw new Error('Tesseract.js недоступен');

  await _ensurePdfjs();
  pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({data: buf}).promise;

  // Переиспользуем один worker — языковые пакеты тогда скачаются один раз.
  const worker = await Tesseract.createWorker(['rus','eng'], 1, {
    // прогресс загрузки моделей в статус-строку
    logger: m => {
      if(m.status && onProgress && m.status.includes('loading')) {
        onProgress(0, 0, 'init');
      }
    }
  });

  const maxPages = Math.min(pdf.numPages, 15);
  let allText = '';
  try {
    for(let i = 1; i <= maxPages; i++) {
      if(onProgress) onProgress(i, maxPages, 'ocr');
      const pg = await pdf.getPage(i);
      const viewport = pg.getViewport({scale: 2}); // 2x — хороший баланс качества и скорости
      const canvas = document.createElement('canvas');
      canvas.width  = viewport.width;
      canvas.height = viewport.height;
      await pg.render({canvasContext: canvas.getContext('2d'), viewport}).promise;
      const { data } = await worker.recognize(canvas);
      allText += (data.text || '') + '\n';
    }
  } finally {
    await worker.terminate();
  }
  return allText;
}

async function repExtractPdf(file){
  await _ensurePdfjs();
  pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const buf=await file.arrayBuffer();
  const pdf=await pdfjsLib.getDocument({data:buf}).promise;
  return await extractPdfTextLines(pdf, 80);
}

async function repExtractDocx(file){
  await _ensureMammoth();
  const buf=await file.arrayBuffer();
  // mammoth.convertToHtml сохраняет таблицы как <table><tr><td> — мы
  // можем пройтись по DOM и собрать настоящую структуру (ячейки таблиц
  // идут по своим колонкам, а параграфы — как одна длинная ячейка).
  // Это то, что нужно Picker'у: кандидаты с контекстом берутся из
  // tableRows одинаково для PDF/DOCX/XLSX.
  let html='';
  try {
    const res = await mammoth.convertToHtml({arrayBuffer: buf});
    html = res.value || '';
  } catch(e){
    // Fallback: если convertToHtml упал — возвращаемся к plain text,
    // Picker будет работать в «слабом» режиме look-ahead по строкам.
    const res = await mammoth.extractRawText({arrayBuffer: buf});
    return _buildRowsFromAoa(_aoaFromFlatText(res.value||''));
  }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const aoa = [];
  function walk(node){
    if(!node) return;
    if(node.nodeType !== 1){ return; }
    const tag = (node.tagName || '').toLowerCase();
    if(tag === 'table'){
      for(const tr of node.querySelectorAll('tr')){
        const cells = [...tr.querySelectorAll('td,th')]
          .map(c => (c.textContent || '').replace(/\s+/g,' ').trim());
        if(cells.some(c => c)) aoa.push(cells);
      }
      return;
    }
    if(['p','h1','h2','h3','h4','h5','li'].includes(tag)){
      const t = (node.textContent || '').replace(/\s+/g,' ').trim();
      if(t) aoa.push([t]);
      return;
    }
    for(const ch of node.childNodes) walk(ch);
  }
  walk(doc.body);
  return _buildRowsFromAoa(aoa);
}

async function repExtractXlsx(file){
  await _ensureXlsx();
  const buf=await file.arrayBuffer();
  const wb=XLSX.read(buf,{type:'array'});
  // Используем sheet_to_json с header:1 — получаем настоящий
  // array-of-arrays (каждая строка = массив ячеек), Picker сможет
  // показать структуру отчёта 1-в-1 как в Excel.
  const aoa = [];
  for(const name of wb.SheetNames){
    const ws = wb.Sheets[name];
    const sheet = XLSX.utils.sheet_to_json(ws, {header:1, raw:false, defval:''});
    if(aoa.length && sheet.length) aoa.push([]); // пустая строка-разделитель
    if(sheet.length) aoa.push(['— Лист: ' + name + ' —']);
    for(const row of sheet) aoa.push(row || []);
  }
  return _buildRowsFromAoa(aoa);
}

// Определение масштаба по тексту документа. Возвращает самый частый
// маркер; при равных частотах — приоритет у «миллионов» (типичный
// масштаб российской МСФО-отчётности). null — если в тексте вообще
// нет маркеров единиц.
function detectScaleByText(txt){
  const SCALE_RES = [
    {re: /в\s+миллиардах\s+рубл/gi,          s: 1},
    {re: /(?:^|[\s(])млрд\.?\s*руб/gi,       s: 1},
    {re: /в\s+миллионах\s+рубл/gi,           s: 0.001},
    {re: /(?:^|[\s(])млн\.?\s*руб/gi,        s: 0.001},
    {re: /миллионах\s+росс/gi,               s: 0.001},
    {re: /в\s+тысячах\s+рубл/gi,             s: 0.000001},
    {re: /(?:^|[\s(])тыс\.?\s*руб/gi,        s: 0.000001},
  ];
  const counts = {'1':0,'0.001':0,'0.000001':0};
  for(const {re, s} of SCALE_RES){
    const m = txt.match(re);
    if(m) counts[String(s)] += m.length;
  }
  if(counts['1']===0 && counts['0.001']===0 && counts['0.000001']===0) return null;
  // Победитель — с наибольшим счётчиком; при равном — миллионы.
  const order = ['0.001','1','0.000001'];
  let winner = order[0];
  for(const k of order) if(counts[k] > counts[winner]) winner = k;
  return parseFloat(winner);
}

function repFillFromText(rawText, scaleOverride){
  const txt = rawText || '';
  // Определяем формат чисел (рус/англ) и сохраняем в глобал, чтобы
  // extractNumbersFromLine и filter-ы работали корректно для обоих.
  _numFormat = detectNumberFormat(txt);

  // Мета-информация отчёта (стандарт, scope, ИНН, название) — для
  // отображения под логом разбора и для проверки совместимости эталона.
  const _meta = detectReportMeta(txt);
  window._reportMeta = _meta;

  let scale = 1;

  const sources = {};
  // Разметка по разделам отчёта — определяется один раз на файл.
  const _sections = _detectReportSections(txt);
  window._reportSections = _sections;

  // findValTrace: то же что findVal из parseAnyReport, но ещё записывает
  // источник значения (строка, год, раздел, паттерн) в `sources` для
  // отладочного лога. Поддерживает __HDR__-строки для выбора «самого
  // свежего года», ранжирование «итог vs раздел» и приоритет ожидаемого
  // раздела отчёта (напр. ДС ищется в балансе, а не в ОДДС).
  function findValTrace(patterns, traceId){
    const lines = txt.split('\n');
    const wantTotal = patterns.some(p => /итог|итого|total/i.test(p));
    const expSecs = _expectedSectionsForFieldId(traceId);
    let curHeaders = null;
    const cands = [];
    for(let li = 0; li < lines.length; li++){
      const line = lines[li];
      const hdr = _parseHeaderCells(line);
      if(hdr){ curHeaders = hdr; continue; }
      if(!line) continue;
      const cells = line.split('\t');
      const desc = cells[0] || '';
      const isTabFormat = cells.length > 1;
      let patIdx = -1, matchedPat = null;
      for(let pi = 0; pi < patterns.length; pi++){
        const re = new RegExp(patterns[pi], 'i');
        if(isTabFormat ? re.test(desc) : re.test(line)){ patIdx = pi; matchedPat = patterns[pi]; break; }
      }
      if(patIdx < 0) continue;
      let value = null, year = null;
      if(isTabFormat){
        const cellNums = [];
        for(let i = 1; i < cells.length; i++){
          const nums = filterMeaningfulNumbers(extractNumbersFromLine(cells[i]), {minAbs:1});
          cellNums.push(nums.length ? nums[0] : null);
        }
        if(!cellNums.some(v => v != null)) continue;
        const colY = curHeaders ? cellNums.map((_, i) => curHeaders[i] ?? null) : cellNums.map(() => null);
        const picked = _pickValueCell(cellNums, colY);
        if(!picked) continue;
        value = picked.value; year = picked.year;
      } else {
        const nums = filterMeaningfulNumbers(extractNumbersFromLine(line), {minAbs:1})
          .filter(n => !RSBU_CODE_SET.has(Math.abs(n)));
        const v = pickPrimaryNumber(nums);
        if(v == null) continue;
        value = v;
      }
      const isTotalDesc = /итог|итого|total/i.test(desc);
      let score = -patIdx * 10;
      if(wantTotal === isTotalDesc) score += 100;
      else if(wantTotal) score -= 50;
      else score -= 5;
      // Приоритет ожидаемого раздела (решает путаницу ДС/ОДДС,
      // Выручка/сегменты и т.п.).
      const sect = _sectionAt(_sections, li);
      const sectKind = sect ? sect.kind : null;
      score += _sectionScoreAdj(sectKind, expSecs);
      // Также: если подпись явно содержит год-тег из extractPdfTextLines
      // (перевёрнутая таблица), используем его, если колоночного года нет.
      if(year == null){
        const tag = desc.match(/\[(19[5-9]\d|20\d{2})\]/);
        if(tag) year = parseInt(tag[1], 10);
      }
      cands.push({score, value, year, line, pattern: matchedPat, patIdx, sectionKind: sectKind, sectionTitle: sect ? sect.title : null});
    }
    if(!cands.length) return null;
    cands.sort((a, b) => b.score - a.score || a.patIdx - b.patIdx);
    const best = cands[0];
    if(traceId) sources[traceId] = {
      line: best.line.replace(/\t/g,' | ').trim(),
      value: best.value,
      pattern: best.pattern,
      year: best.year,
      sectionKind: best.sectionKind,
      sectionTitle: best.sectionTitle
    };
    return best.value;
  }
  const findVal = (pats) => findValTrace(pats);

  // 1. Собираем сырые значения (без применения scale).
  const rawMap = {
    'rep-np-rev':   findValTrace(['Выручка по договорам','Выручка от реализации','Итого выручк[а-яё]*','^\\s*Выручка\\b','Доходы от реализации','Revenue'], 'rep-np-rev'),
    'rep-np-ebitda':findValTrace(['EBITDA','Прибыль до вычета процентов','ЕБИТДА'], 'rep-np-ebitda'),
    'rep-np-ebit':  findValTrace(['Операционная прибыль','Прибыль от продаж','EBIT'], 'rep-np-ebit'),
    'rep-np-np':    findValTrace(['Чистая прибыль','Итого чистая прибыль','Прибыль за период','Прибыль за отчетн','Net profit','Profit for the period'], 'rep-np-np'),
    'rep-np-int':   findValTrace(['Проценты к уплате','Процентные расходы','Расходы по процентам','Финансовые расходы','Finance costs'], 'rep-np-int'),
    'rep-np-assets':findValTrace(['Итого активы','Итого активов','Совокупные активы','Всего активов','Total assets','ИТОГО АКТИВЫ','БАЛАНС'], 'rep-np-assets'),
    'rep-np-ca':    findValTrace(['Итого оборотн[а-яё]*\\s+активов','Итого оборотных','Оборотные активы','Total current assets','Current assets'], 'rep-np-ca'),
    'rep-np-cl':    findValTrace(['Итого краткосрочн[а-яё]*\\s+обязательств','Итого краткосрочных','Краткосрочные обязательства','Total current liabilities','Current liabilities'], 'rep-np-cl'),
    'rep-np-debt':  findValTrace(['Заемные средства','Кредиты и займы','Total borrowings'], 'rep-np-debt'),
    'rep-np-cash':  findValTrace(['Денежные средства и (их )?эквивалент','Cash and cash equivalents','ДС и их эквивалент'], 'rep-np-cash'),
    'rep-np-ret':   findValTrace(['Нераспредел[её]нная прибыль','Retained earnings'], 'rep-np-ret'),
    'rep-np-eq':    findValTrace(['Итого капитал','Итого собственн[а-яё]*\\s+капитал','Собственный капитал','Total equity','ИТОГО КАПИТАЛ'], 'rep-np-eq'),
  };

  // 2. Определяем scale. Сначала override пользователя, затем текстовый
  // детектор, иначе — значение по умолчанию «млн ₽» (типичный масштаб
  // российских МСФО-отчётов).
  const scaleAuto = detectScaleByText(txt);
  scale = scaleOverride != null ? scaleOverride : (scaleAuto != null ? scaleAuto : 0.001);

  // 3. Применяем scale.
  const sc=v=>v!=null?parseFloat((v*scale).toFixed(6)):null;
  const map = {};
  for(const [k, v] of Object.entries(rawMap)) map[k] = sc(v);
  const log=document.getElementById('rep-np-parse-log');
  const labels = {
    'rep-np-rev':'Выручка','rep-np-ebitda':'EBITDA','rep-np-ebit':'EBIT',
    'rep-np-np':'ЧП','rep-np-int':'Проценты','rep-np-assets':'Активы',
    'rep-np-ca':'Обор. активы','rep-np-cl':'Кр. обяз.','rep-np-debt':'Долг',
    'rep-np-cash':'ДС','rep-np-ret':'Нераспр.','rep-np-eq':'Капитал'
  };
  const logLines=[];
  let filled=0;
  for(const[id,val] of Object.entries(map)){
    if(val!=null){
      document.getElementById(id).value=val;
      const src = sources[id];
      // Источник для отладки: какая строка PDF, какое сырое число, какое после scale.
      const lineShort = src?.line?.slice(0,90) + (src?.line?.length>90 ? '…' : '') || '';
      const yearTag = src?.year != null
        ? ` <span style="color:var(--text3)">· год ${src.year}</span>`
        : '';
      const sectNames = {
        pnl: 'ОПиУ', balance: 'Баланс', cashflow: 'ОДДС',
        equity: 'Капитал', segments: 'Сегменты', note: 'Примечание'
      };
      const sectTag = src?.sectionKind
        ? ` <span style="color:var(--text3)">· ${sectNames[src.sectionKind] || src.sectionKind}</span>`
        : '';
      logLines.push(
        `<div style="padding:3px 0;border-bottom:1px dotted rgba(30,48,72,.4)">`+
        `<span style="color:var(--green)">✓</span> <strong>${labels[id]||id}</strong> = `+
        `<span style="color:var(--acc)">${val}</span> <span style="color:var(--text3)">(сырое ${src?.value??'?'} × scale ${scale})</span>${yearTag}${sectTag}`+
        (lineShort ? `<br><span style="color:var(--text3);font-size:.56rem">↳ ${lineShort.replace(/</g,'&lt;')}</span>` : '')+
        `</div>`
      );
      filled++;
    }
  }
  const notFound = Object.keys(map).filter(k => map[k]==null);
  if(notFound.length) {
    logLines.push(
      `<div style="padding:4px 0;margin-top:4px;color:var(--warn);font-size:.58rem">`+
      `⚠ Не найдено: ${notFound.map(k=>labels[k]||k).join(', ')}`+
      `</div>`
    );
  }
  if(logLines.length){
    log.style.display='block';
    const scaleName = scale===1 ? 'млрд ₽' : scale===0.001 ? 'млн ₽ → млрд' : 'тыс. ₽ → млрд';
    const howChosen = scaleOverride != null ? 'вручную' :
      (scaleAuto != null ? 'авто: по тексту' : 'по умолчанию (млн)');
    log.innerHTML = `<div style="color:var(--text3);font-size:.55rem;margin-bottom:4px">Масштаб: <strong style="color:var(--acc)">${scaleName}</strong> · ${howChosen}. Если неверно — переключите над этим блоком.</div>` + logLines.join('');
  }
  // Информация о scale в over-UI: подсказка рядом с radio.
  const note = document.getElementById('rep-np-scale-auto-note');
  if(note && scaleOverride == null) {
    const ss = scale===1 ? 'млрд' : scale===0.001 ? 'млн' : 'тыс.';
    note.textContent = ' · авто: ' + ss;
  } else if(note) {
    note.textContent = ' · выбрано вручную';
  }
  // Показываем распознанную мета-инфо + авто-подбор эталона.
  // Каталог эталонов (references/index.json + localStorage) подтянут
  // при старте приложения; ищем запись с совпадающим ИНН (и по
  // возможности периодом) и молча применяем. Если пользователь
  // позже импортирует другой JSON руками — он перезапишет.
  repRenderMeta(_meta);
  (async () => {
    await _ensureRefCatalogue();
    let ref = null;
    if(!window._reportReference){
      const period = document.getElementById('rep-np-year')?.value;
      const cat = window._refCatalogue || {localEntries:[], repoEntries:[]};
      const found = _findRefFor(_meta, period);
      if(found){
        ref = normaliseReference(found) || found;
        ref._autoSource = cat.localEntries.includes(found) ? 'кэш' : 'каталог';
      }
    } else {
      ref = window._reportReference;
    }
    // Авто-мёрдж многолетней истории из reportsDB того же эмитента —
    // даёт «график динамики» даже если внешнего эталона нет.
    const histSeries = _seriesFromReportsDB(_meta);
    if(histSeries){
      if(!ref){
        ref = {
          values: null, series: histSeries,
          standard: _meta.standard, scope: _meta.scope,
          company: _meta.orgName, inn: _meta.inn, period: null,
          source: 'reportsDB', unit: 'млрд ₽', format: 'reportsdb',
          _autoSource: 'reportsDB'
        };
      } else {
        ref.series = _mergeSeries(histSeries, ref.series);
      }
    }
    if(ref) window._reportReference = ref;
    if(window._reportReference) repRenderRefResult();
  })();
  return filled;
}

// ══ КОДЫ РСБУ → поля ══
// Приоритетный поиск по стандартным кодам строк РСБУ
const RSBU_CODES = {
  'is-rev':    ['2110'],
  'is-ebitda': [], // нет кода, считается
  'is-ebit':   ['2200'],
  'is-np':     ['2400'],
  'is-int':    ['2330'],
  'is-tax':    ['2410'],
  'is-assets': ['1600'],
  'is-ca':     ['1200'],
  'is-cl':     ['1500'],
  'is-debt':   ['1410','1510'], // долгосрочные + краткосрочные займы
  'is-cash':   ['1250'],
  'is-ret':    ['1370'],
  'is-eq':     ['1300'],
};

function extractByRsbuCodes(txt) {
  const result = {};
  const lines = (txt||'').split('\n');
  for (const [fieldId, codes] of Object.entries(RSBU_CODES)) {
    if (!codes.length) continue;
    for (const code of codes) {
      const codeRe = new RegExp('(?:^|[\\s,\\t])' + code + '(?:[\\s,\\t]|$)');
      for (const line of lines) {
        if(!codeRe.test(line)) continue;
        // Используем корректный извлекатель чисел с разделителем тысяч.
        // После кода строки идёт пояснение, потом значение(я) — берём первое
        // число, которое не равно самому коду.
        const codeNum = parseInt(code);
        const nums = extractNumbersFromLine(line)
          .filter(n => Math.abs(n) >= 1 && Math.abs(n) !== codeNum);
        const val = pickPrimaryNumber(nums);
        if (val != null) {
          if (fieldId === 'is-debt' && fieldId in result) {
            result[fieldId] = (result[fieldId] || 0) + val;
          } else if (!(fieldId in result)) {
            result[fieldId] = val;
          }
          break;
        }
      }
    }
  }
  return result;
}

// Обновлённый parseAnyReport — сначала пробует коды, потом текст
// (патчим уже существующую функцию через обёртку)
const _origParseAny = parseAnyReport;

// ══ АВТОНОМНЫЙ АНАЛИЗ ══
function gv(id) { const v=parseFloat(document.getElementById(id)?.value); return isNaN(v)?null:v; }

// Текущая единица отображения в карточках анализа: 'auto'|'млрд'|'млн'|'тыс'.
// Пользовательский выбор сохраняется в localStorage, 'auto' = угадать по данным.
let _fmtUnit = 'млрд';

function fmtB(v) {
  if(v==null) return '—';
  const abs = Math.abs(v);
  const u = _fmtUnit;
  if(u === 'млрд'){
    if(abs >= 1000) return (v/1000).toFixed(2)+' трлн ₽';
    return v.toFixed(abs >= 10 ? 1 : 2)+' млрд ₽';
  }
  if(u === 'млн'){
    const m = v*1000, absM = abs*1000;
    return m.toFixed(absM >= 100 ? 0 : absM >= 10 ? 1 : 2)+' млн ₽';
  }
  if(u === 'тыс'){
    return (v*1e6).toFixed(0)+' тыс ₽';
  }
  // fallback (старое поведение)
  if(abs>=1000) return (v/1000).toFixed(2)+' трлн ₽';
  if(abs>=1)    return v.toFixed(2)+' млрд ₽';
  return (v*1000).toFixed(0)+' млн ₽';
}

// Определяет «главную» единицу отчёта по медиане набора значений (в млрд).
// Внутри приложения всё в млрд: 1 = 1 млрд, 0.001 = 1 млн, 1e-6 = 1 тыс.
function pickFmtUnit(vals){
  const nums = (vals||[]).filter(v => v != null && isFinite(v) && Math.abs(v) > 1e-9);
  if(!nums.length) return 'млрд';
  const sorted = nums.map(Math.abs).sort((a,b)=>a-b);
  const med = sorted[Math.floor(sorted.length/2)];
  if(med >= 1)     return 'млрд';
  if(med >= 0.001) return 'млн';
  return 'тыс';
}

// Переключатель единиц: пользователь нажал кнопку. Сохраняем в localStorage и
// перерисовываем последнюю карточку анализа из кэша.
function setFmtUnit(choice){
  try { localStorage.setItem('ba_fmt_unit', choice); } catch(_){}
  const last = window._lastAnalysis;
  if(!last) return;
  const c = document.getElementById(last.containerId);
  if(c) c.innerHTML = buildAnalysisHTML(last.d, last.opts);
}

// Цветная шкала с маркером позиции
function gauge(val, min, max, goodFrom, warnFrom, lowerIsBetter=false) {
  if(val==null) return '';
  const clamp = v => Math.min(100,Math.max(0,(v-min)/(max-min)*100));
  const pos = clamp(val);
  const gp  = clamp(goodFrom), wp = clamp(warnFrom);
  const [cBad,cWarn,cGood] = ['var(--danger)','var(--warn)','var(--green)'];
  const segs = lowerIsBetter
    ? `<div style="position:absolute;left:0;width:${gp}%;height:100%;background:${cGood};opacity:.25"></div>
       <div style="position:absolute;left:${gp}%;width:${wp-gp}%;height:100%;background:${cWarn};opacity:.25"></div>
       <div style="position:absolute;left:${wp}%;width:${100-wp}%;height:100%;background:${cBad};opacity:.25"></div>`
    : `<div style="position:absolute;left:0;width:${wp}%;height:100%;background:${cBad};opacity:.25"></div>
       <div style="position:absolute;left:${wp}%;width:${gp-wp}%;height:100%;background:${cWarn};opacity:.25"></div>
       <div style="position:absolute;left:${gp}%;width:${100-gp}%;height:100%;background:${cGood};opacity:.25"></div>`;
  return `<div style="position:relative;height:8px;background:var(--border);margin:5px 0 2px;overflow:visible">
    ${segs}
    <div style="position:absolute;left:${pos}%;top:-3px;width:3px;height:14px;background:var(--text);transform:translateX(-50%);z-index:2"></div>
  </div>
  <div style="display:flex;justify-content:space-between;font-size:.52rem;color:var(--text3)">
    <span>${min}</span><span>${max}+</span>
  </div>`;
}

function metricBlock(termEn, termRu, formula, val, displayVal, unit, color, gaugeHtml, comment, normText) {
  if(val==null) return '';
  const clr={green:'var(--green)',warn:'var(--warn)',danger:'var(--danger)'};
  const ico={green:'✅',warn:'⚠️',danger:'🔴'};
  const c = clr[color]||'var(--text2)';
  const i = ico[color]||'•';
  return `<div style="padding:11px 0;border-bottom:1px solid rgba(30,48,72,.5)">
    <div style="display:flex;align-items:flex-start;gap:10px">
      <span style="font-size:1rem;min-width:22px;margin-top:2px">${i}</span>
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:2px">
          <span style="font-size:.8rem;font-weight:600;color:var(--text)">${termEn}</span>
          <span style="font-size:.67rem;color:var(--text3)">— ${termRu}</span>
        </div>
        <div style="font-size:.58rem;color:var(--text3);margin-bottom:5px">${formula}</div>
        <div style="display:flex;align-items:baseline;gap:6px;margin-bottom:4px">
          <span style="font-size:1.15rem;font-weight:700;color:${c}">${displayVal}</span>
          <span style="font-size:.68rem;color:var(--text2)">${unit}</span>
          ${normText?`<span style="font-size:.6rem;color:var(--text3);margin-left:4px">${normText}</span>`:''}
        </div>
        ${gaugeHtml}
        <div style="font-size:.65rem;color:var(--text2);margin-top:4px;line-height:1.5">${comment}</div>
      </div>
    </div>
  </div>`;
}

// Ядро анализа: принимает данные объектом, возвращает HTML-строку со шкалами.
// opts.mode: 'editor' (по умолчанию) — добавляет сводку и кнопки «Сохранить»/«Экспорт».
//            'archive' — только шкалы (используется в «📂 База отчётности»).
function buildAnalysisHTML(d, opts={}) {
  const mode = opts.mode || 'editor';
  const co    = d.co||'Эмитент';
  const ind   = d.ind||'other';
  const bond  = d.bond||'';
  const rating= d.rating||'';
  const rev    = d.rev ?? null;
  const ebitdaInput = d.ebitda ?? null;
  const ebit   = d.ebit ?? null;
  const np     = d.np ?? null;
  const intExp = d.intExp ?? null;
  const tax    = d.tax ?? null;
  const dep    = d.dep ?? null;
  const assets = d.assets ?? null;
  const ca     = d.ca ?? null;
  const cl     = d.cl ?? null;
  const debt   = d.debt ?? null;
  const cash   = d.cash ?? null;
  const eq     = d.eq ?? null;
  const sz     = d.sz ?? null;
  const peak   = d.peak ?? null;
  const repType = d.repType||'';
  const period  = d.period||'';

  // Единица отображения: пользовательский выбор или авто-подбор по медиане.
  const userUnit = (function(){
    try { return localStorage.getItem('ba_fmt_unit') || 'auto'; } catch(_){ return 'auto'; }
  })();
  _fmtUnit = userUnit === 'auto'
    ? pickFmtUnit([rev, d.ebitda, ebit, np, assets, ca, cl, debt, cash, eq])
    : userUnit;

  const norms = IND_NORMS[ind]||IND_NORMS.other;

  // EBITDA — с пояснением как считалась
  let ebitda = ebitdaInput;
  let ebitdaHow = '';
  if(!ebitda) {
    if(ebit!=null && dep!=null)       { ebitda=ebit+dep; ebitdaHow=`EBIT + Амортизация`; }
    else if(np!=null&&intExp!=null&&tax!=null) { ebitda=np+intExp+tax+(dep||0); ebitdaHow=`ЧП + Проценты + Налог`+(dep?` + D&A`:''); }
    else if(ebit!=null)               { ebitda=ebit; ebitdaHow=`≈ EBIT (без амортизации)`; }
  }

  // Все мультипликаторы
  const nd       = (debt!=null&&cash!=null)?debt-cash:debt;
  const ndE      = (nd!=null&&ebitda)  ? nd/ebitda          : null;
  const icr      = (ebitda&&intExp)    ? ebitda/intExp       : null;
  const cur      = (ca&&cl)            ? ca/cl               : null;
  const deRatio  = (debt&&eq)          ? debt/eq             : null;
  const eqRatio  = (eq&&assets)        ? eq/assets*100       : null;
  const debtA    = (debt&&assets)      ? debt/assets*100     : null;
  const npm      = (np!=null&&rev)     ? np/rev*100          : null;
  const ebitdam  = (ebitda&&rev)       ? ebitda/rev*100      : null;
  const ebitm    = (ebit&&rev)         ? ebit/rev*100        : null;
  const roa      = (np!=null&&assets)  ? np/assets*100       : null;
  const roe      = (np!=null&&eq)      ? np/eq*100           : null;
  const szEbitda = (sz&&ebitda)        ? sz/ebitda           : null;
  const szNd     = (sz&&nd&&nd>0)      ? sz/nd*100           : null;
  const peakCov  = (ebitda&&peak)      ? ebitda/peak         : null;

  function color(val, goodV, warnV, lower=false) {
    if(val==null) return null;
    if(lower) return val<=goodV?'green':val<=warnV?'warn':'danger';
    return val>=goodV?'green':val>=warnV?'warn':'danger';
  }

  // Секция: Долговая нагрузка
  const debtSection = [
    metricBlock(
      'ND/EBITDA', 'Чистый долг к прибыли',
      `(Долг ${fmtB(debt)} − Кэш ${fmtB(cash)}) ÷ EBITDA ${fmtB(ebitda)}`,
      ndE, ndE!=null?ndE.toFixed(2):'—', 'x',
      color(ndE,norms.ndE,norms.ndE*1.5,true),
      gauge(ndE,0,8,norms.ndE,norms.ndE*1.5,true),
      ndE==null?'Нужны: долг и EBITDA'
        :`За ${ndE.toFixed(1)} лет компания погасит весь долг из операционной прибыли при текущем темпе.`,
      `норма для ${IND_NAMES[ind]}: < ${norms.ndE}x`),

    metricBlock(
      'ICR / DSCR', 'Покрытие процентов',
      `EBITDA ${fmtB(ebitda)} ÷ Проценты ${fmtB(intExp)}`,
      icr, icr!=null?icr.toFixed(2):'—', 'x',
      color(icr,norms.dscr,1.5),
      gauge(icr,0,10,norms.dscr,1.5),
      icr==null?'Нужны: EBITDA и процентные расходы'
        :`Прибыль покрывает проценты в ${icr.toFixed(1)} раз. ${icr>=norms.dscr?'Хороший запас прочности.':icr>=1.5?'Приемлемо, следить за ростом ставок.':'⚠️ Мало — при росте ставок или падении прибыли риск дефолта.'}`,
      `норма: > ${norms.dscr}x`),

    metricBlock(
      'D/E Ratio', 'Финансовый рычаг (долг к капиталу)',
      `Долг ${fmtB(debt)} ÷ Собств. капитал ${fmtB(eq)}`,
      deRatio, deRatio!=null?deRatio.toFixed(2):'—', 'x',
      color(deRatio,1,2,true),
      gauge(deRatio,0,5,1,2,true),
      deRatio==null?'Нужны: долг и собственный капитал'
        :`На каждый рубль собственного капитала приходится ${deRatio.toFixed(2)} руб. заёмных. ${deRatio<=1?'Низкая зависимость от кредиторов.':deRatio<=2?'Умеренный рычаг.':'Высокий рычаг — бизнес сильно зависит от долга.'}`,
      `< 1x — низкий, 1–2x — умеренный, > 3x — высокий`),

    metricBlock(
      'Debt/Assets', 'Долг к активам',
      `Долг ${fmtB(debt)} ÷ Активы ${fmtB(assets)}`,
      debtA, debtA!=null?debtA.toFixed(1):'—', '%',
      color(debtA,40,60,true),
      gauge(debtA,0,100,40,60,true),
      debtA==null?'':`${debtA.toFixed(0)}% активов профинансировано за счёт долга.`,
      `< 40% — комфортно`),

  ].filter(Boolean).join('');

  // Секция: Рентабельность
  const profSection = [
    ebitda && ebitdaHow ? `<div style="font-size:.6rem;color:var(--warn);padding:6px 10px;background:rgba(245,166,35,.07);border:1px solid rgba(245,166,35,.2);margin-bottom:8px">
      ℹ️ EBITDA рассчитана автоматически: ${ebitdaHow} = ${fmtB(ebitda)}
    </div>` : '',

    metricBlock(
      'EBITDA Margin', 'Операционная рентабельность',
      `EBITDA ${fmtB(ebitda)} ÷ Выручка ${fmtB(rev)}`,
      ebitdam, ebitdam!=null?ebitdam.toFixed(1):'—', '%',
      color(ebitdam,norms.marg,norms.marg*0.5),
      gauge(ebitdam,0,50,norms.marg,norms.marg*0.5),
      ebitdam==null?'Нужны: EBITDA и выручка'
        :`С каждых 100 ₽ выручки компания зарабатывает ${ebitdam.toFixed(1)} ₽ до налогов, процентов и амортизации.`,
      `норма для ${IND_NAMES[ind]}: > ${norms.marg}%`),

    metricBlock(
      'Net Profit Margin', 'Чистая рентабельность',
      `Чистая прибыль ${fmtB(np)} ÷ Выручка ${fmtB(rev)}`,
      npm, npm!=null?npm.toFixed(1):'—', '%',
      color(npm,5,0),
      gauge(npm,-20,30,5,0),
      npm==null?'':`С каждых 100 ₽ выручки остаётся ${npm.toFixed(1)} ₽ чистой прибыли. ${npm>=5?'Прибыльный бизнес.':npm>=0?'Низкая маржа — внимательно следить за динамикой.':'Убыток. Красный флаг.'}`,
      '> 5% — хорошо'),

    metricBlock(
      'ROE', 'Рентабельность собственного капитала',
      `Чистая прибыль ${fmtB(np)} ÷ Капитал ${fmtB(eq)}`,
      roe, roe!=null?roe.toFixed(1):'—', '%',
      color(roe,15,5),
      gauge(roe,-10,40,15,5),
      roe==null?'Нужны: чистая прибыль и собственный капитал'
        :`На каждые 100 ₽ вложенных акционерами компания зарабатывает ${roe.toFixed(1)} ₽. ${roe>=15?'Высокая отдача на капитал.':roe>=5?'Умеренная.':'Низкая — бизнес не окупает вложения акционеров.'}`,
      '> 15% — высокая'),

    metricBlock(
      'ROA', 'Рентабельность активов',
      `Чистая прибыль ${fmtB(np)} ÷ Активы ${fmtB(assets)}`,
      roa, roa!=null?roa.toFixed(1):'—', '%',
      color(roa,5,2),
      gauge(roa,-5,20,5,2),
      roa==null?'':`${roa.toFixed(1)}% — отдача со всех активов компании (своих и заёмных).`,
      '> 5% — хорошо'),

  ].filter(Boolean).join('');

  // Секция: Ликвидность и устойчивость
  const liqSection = [
    metricBlock(
      'Current Ratio', 'Коэффициент текущей ликвидности',
      `Оборотные активы ${fmtB(ca)} ÷ Краткосрочные обяз. ${fmtB(cl)}`,
      cur, cur!=null?cur.toFixed(2):'—', 'x',
      color(cur,norms.cur,0.8),
      gauge(cur,0,3,norms.cur,0.8),
      cur==null?'Нужны: оборотные активы и краткосрочные обязательства'
        :`Показывает, хватит ли оборотных активов погасить краткосрочные долги. ${cur>=norms.cur?'Достаточная ликвидность.':cur>=0.8?'Умеренная — следить за кассой.':'⚠️ Низкая — возможен кассовый разрыв.'}`,
      `норма: > ${norms.cur}x`),

    metricBlock(
      'Equity Ratio', 'Доля собственного капитала',
      `Капитал ${fmtB(eq)} ÷ Активы ${fmtB(assets)}`,
      eqRatio, eqRatio!=null?eqRatio.toFixed(1):'—', '%',
      color(eqRatio,40,20),
      gauge(eqRatio,0,100,40,20),
      eqRatio==null?'':`${eqRatio.toFixed(0)}% активов принадлежит владельцам, остальное — кредиторам. ${eqRatio>=40?'Высокая финансовая независимость.':eqRatio>=20?'Умеренный леверидж.':'Высокий — уязвимость при падении стоимости активов.'}`,
      '> 40% — независимость'),

  ].filter(Boolean).join('');

  // Секция: Параметры выпуска
  const bondSection = [
    metricBlock(
      'Issue / EBITDA', 'Выпуск к операционной прибыли',
      `Выпуск ${fmtB(sz)} ÷ EBITDA ${fmtB(ebitda)}`,
      szEbitda, szEbitda!=null?szEbitda.toFixed(2):'—', 'x',
      color(szEbitda,1,2,true),
      gauge(szEbitda,0,5,1,2,true),
      szEbitda==null?'Заполните объём выпуска'
        :`Выпуск составляет ${szEbitda.toFixed(2)} годовых EBITDA. ${szEbitda<=1?'Небольшой — низкий риск.':szEbitda<=2?'Умеренный.':'Крупный выпуск относительно прибыли — повышенный риск.'}`,
      '< 1x — комфортно'),

    metricBlock(
      'Issue / ND', 'Выпуск к чистому долгу',
      `Выпуск ${fmtB(sz)} ÷ Чистый долг ${fmtB(nd)}`,
      szNd, szNd!=null?szNd.toFixed(1):'—', '%',
      color(szNd,30,60,true),
      gauge(szNd,0,150,30,60,true),
      szNd==null?'':`Этот выпуск составляет ${szNd.toFixed(0)}% от всего чистого долга компании.`,
      '< 30% — небольшая доля'),

    metricBlock(
      'Peak Debt Coverage', 'Покрытие пиковых выплат',
      `EBITDA ${fmtB(ebitda)} ÷ Пик выплат/год ${fmtB(peak)}`,
      peakCov, peakCov!=null?peakCov.toFixed(2):'—', 'x',
      color(peakCov,2,1.2),
      gauge(peakCov,0,6,2,1.2),
      peakCov==null?'Заполните пиковые выплаты'
        :`В худший год компания должна выплатить ${fmtB(peak)}. Покрытие ${peakCov.toFixed(1)}x. ${peakCov>=2?'Комфортно.':peakCov>=1.2?'Приемлемо.':'⚠️ Мало — при снижении прибыли риск проблем с выплатами.'}`,
      '> 2x — хорошо'),

  ].filter(Boolean).join('');

  // Итоговый вердикт
  const dangerCount = [
    ndE!=null&&ndE>norms.ndE*1.5,
    icr!=null&&icr<1.5,
    cur!=null&&cur<0.8,
    npm!=null&&npm<0,
    deRatio!=null&&deRatio>3,
  ].filter(Boolean).length;
  const dataCount = [ndE,icr,cur,npm].filter(v=>v!=null).length;
  let riskLevel='нет данных', riskColor='var(--text3)', riskIcon='❓';
  if(dataCount>=2){
    if(dangerCount===0){riskLevel='Низкий';riskColor='var(--green)';riskIcon='🟢';}
    else if(dangerCount===1){riskLevel='Умеренный';riskColor='var(--warn)';riskIcon='🟡';}
    else{riskLevel='Высокий';riskColor='var(--danger)';riskIcon='🔴';}
  }

  const hasAny = debtSection||profSection||liqSection||bondSection;

  if(!hasAny) {
    return `<div class="empty"><div class="ei">📊</div><p>${mode==='archive'
      ? 'Для этого периода нет числовых данных для построения шкал.'
      : 'Заполните показатели на вкладке «Данные эмитента»<br>или загрузите файл отчётности — нажмите «Рассчитать»'}</p></div>`;
  }

  const periodLabel = (period||repType) ? `${[repType,period].filter(Boolean).join(' · ')}` : '';

  const footerExtras = mode==='editor' ? `
    <!-- Краткая сводка для копирования -->
    <div class="card" style="margin-top:4px;border-color:rgba(0,212,255,.2)">
      <div class="card-hdr" style="color:var(--acc)">📋 Сводка для копирования
        <button class="btn btn-sm" style="margin-left:auto" onclick="copyAnalysisSummary()">📄 Скопировать</button>
      </div>
      <div class="card-body">
        <pre id="analysis-summary-text" style="font-size:.64rem;color:var(--text2);white-space:pre-wrap;line-height:1.7;font-family:var(--mono)">${buildSummaryText({co,bond,ind,rating,repType,period,rev,ebitda,ebitdaHow,ebit,np,intExp,tax,dep,assets,ca,cl,debt,cash,eq,sz,nd,ndE,icr,cur,deRatio,eqRatio,npm,ebitdam,roe,roa,szEbitda,szNd,peakCov,riskLevel})}</pre>
      </div>
    </div>

    <!-- Кнопки действий -->
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
      <button class="btn btn-p btn-sm" onclick="saveAnalysisToBase()">💾 Сохранить в базу отчётности</button>
      <button class="btn btn-sm" onclick="exportAllData()">⬇️ Экспорт всех данных (JSON)</button>
    </div>
  ` : '';

  // Переключатель единиц: «авто» помечает подобранное значение в скобках,
  // остальные — принудительный пересчёт без повторного импорта.
  const unitBtn = (u, label) => {
    const active = userUnit === u;
    return `<button type="button" onclick="setFmtUnit('${u}')"
      style="padding:2px 9px;font-size:.58rem;font-family:var(--mono);cursor:pointer;
      border:1px solid ${active?'var(--acc)':'var(--border)'};
      background:${active?'var(--acc)':'transparent'};
      color:${active?'var(--bg)':'var(--text2)'};border-radius:3px">${label}</button>`;
  };
  const unitBar = `
    <div style="display:flex;align-items:center;gap:5px;font-size:.58rem;color:var(--text3);margin-bottom:10px;flex-wrap:wrap">
      <span style="margin-right:4px">Единицы:</span>
      ${unitBtn('auto','авто'+(userUnit==='auto'?` · ${_fmtUnit}`:''))}
      ${unitBtn('млрд','млрд')}
      ${unitBtn('млн','млн')}
      ${unitBtn('тыс','тыс')}
    </div>`;

  return `
    <div style="display:flex;align-items:center;gap:14px;padding:12px 16px;background:var(--s1);border:1px solid var(--border);margin-bottom:14px;flex-wrap:wrap">
      <div>
        <div style="font-size:.57rem;letter-spacing:.1em;text-transform:uppercase;color:var(--text3)">Эмитент${periodLabel?' · '+periodLabel:''}</div>
        <div style="font-size:.95rem;font-weight:600;color:var(--text)">${co}${bond?' · '+bond:''}</div>
        <div style="font-size:.63rem;color:var(--text2)">${IND_NAMES[ind]}${rating?' · '+rating:''}</div>
      </div>
      <div style="margin-left:auto;text-align:center">
        <div style="font-size:1.8rem">${riskIcon}</div>
        <div style="font-size:.72rem;font-weight:600;color:${riskColor}">${riskLevel} риск</div>
      </div>
    </div>
    ${unitBar}

    ${debtSection?`<div class="card" style="margin-bottom:10px">
      <div class="card-hdr">💼 Долговая нагрузка</div>
      <div class="card-body" style="padding:4px 15px">${debtSection}</div>
    </div>`:''}

    ${profSection?`<div class="card" style="margin-bottom:10px">
      <div class="card-hdr">📈 Рентабельность</div>
      <div class="card-body" style="padding:4px 15px">${profSection}</div>
    </div>`:''}

    ${liqSection?`<div class="card" style="margin-bottom:10px">
      <div class="card-hdr">💧 Ликвидность и устойчивость</div>
      <div class="card-body" style="padding:4px 15px">${liqSection}</div>
    </div>`:''}

    ${bondSection?`<div class="card" style="margin-bottom:10px">
      <div class="card-hdr">📋 Параметры выпуска</div>
      <div class="card-body" style="padding:4px 15px">${bondSection}</div>
    </div>`:''}

    <div style="font-size:.58rem;color:var(--text3);padding:8px 2px;line-height:1.6">
      Расчёт автономный · без AI · ${mode==='archive'?'по данным периода':'по введённым данным'} · ${new Date().toLocaleDateString('ru-RU')}
    </div>
    ${footerExtras}
  `;
}

// Публичная обёртка: собирает данные из форм «🏢 Эмитент» и рендерит шкалы.
function analyzeAuto() {
  const perSel   = document.getElementById('is-rep-period')?.value||'';
  const perCustom= document.getElementById('is-rep-period-custom')?.value?.trim()||'';
  const d = {
    co:     document.getElementById('is-co')?.value?.trim()||'Эмитент',
    ind:    document.getElementById('is-ind')?.value||'other',
    bond:   document.getElementById('is-bond')?.value?.trim()||'',
    rating: document.getElementById('is-rating')?.value?.trim()||'',
    rev:    gv('is-rev'),
    ebitda: gv('is-ebitda'),
    ebit:   gv('is-ebit'),
    np:     gv('is-np'),
    intExp: gv('is-int'),
    tax:    gv('is-tax'),
    dep:    gv('is-dep'),
    assets: gv('is-assets'),
    ca:     gv('is-ca'),
    cl:     gv('is-cl'),
    debt:   gv('is-debt'),
    cash:   gv('is-cash'),
    eq:     gv('is-eq'),
    sz:     gv('is-sz'),
    peak:   gv('is-peak'),
    repType: document.getElementById('is-rep-type')?.value||'',
    period:  perSel==='custom' ? perCustom : perSel,
  };
  window._lastAnalysis = { d, opts:{mode:'editor'}, containerId:'iss-res-content' };
  document.getElementById('iss-res-content').innerHTML = buildAnalysisHTML(d, {mode:'editor'});
}

function analyzeAutoClick() {
  const btn = document.getElementById('btn-analyze');
  btn.textContent = '⏳ Считаю...';
  btn.disabled = true;
  setTimeout(() => {
    analyzeAuto();
    // Переключаем на вкладку результатов
    const resTab = document.getElementById('iss-res-tab');
    swIssTab('result', resTab);
    btn.textContent = '✅ Пересчитать';
    btn.disabled = false;
    setTimeout(() => { btn.textContent = '📊 Рассчитать мультипликаторы'; }, 2500);
  }, 80);
}

// Автоопределение РСБУ/МСФО/ГИРБО по тексту файла
function detectReportType(text) {
  // ГИРБО — госресурс бухучёта ФНС (bo.nalog.gov.ru). Строго до МСФО/РСБУ,
  // т.к. выгрузки ГИРБО сами содержат ключевые слова «РСБУ» в шапке.
  if (/ГИРБО|bo\.nalog\.ru|Госресурс\s+бухгалтерской|Ресурс\s+бухгалтерской\s+отч/i.test(text)) return 'ГИРБО';
  if (/IFRS|международн\w+ стандарт|IAS |МСФО/i.test(text)) return 'МСФО';
  if (/ПБУ |РСБУ|российск\w+ стандарт|Приказ Минфин/i.test(text)) return 'РСБУ';
  // Коды РСБУ — явный признак
  if (/\b(2110|2400|1600|1300)\b/.test(text)) return 'РСБУ';
  return null;
}

// Строим текст сводки
function buildSummaryText(d) {
  const f = v => v!=null ? fmtB(v) : '—';
  const fx = (v,dec=2) => v!=null ? v.toFixed(dec) : '—';
  const lines = [
    `═══ ${d.co}${d.bond?' · '+d.bond:''} ═══`,
    `Отрасль: ${IND_NAMES[d.ind]||d.ind}${d.rating?' · Рейтинг: '+d.rating:''}`,
    d.repType||d.period ? `Отчётность: ${[d.repType,d.period].filter(Boolean).join(', ')}` : '',
    '',
    '── Исходные данные ──',
    d.rev    != null ? `Выручка:              ${f(d.rev)}` : '',
    d.ebitda != null ? `EBITDA:               ${f(d.ebitda)}${d.ebitdaHow?' ('+d.ebitdaHow+')':''}` : '',
    d.ebit   != null ? `EBIT:                 ${f(d.ebit)}` : '',
    d.np     != null ? `Чистая прибыль:       ${f(d.np)}` : '',
    d.intExp != null ? `Процентные расходы:   ${f(d.intExp)}` : '',
    d.tax    != null ? `Налог на прибыль:     ${f(d.tax)}` : '',
    d.dep    != null ? `Амортизация (D&A):    ${f(d.dep)}` : '',
    d.assets != null ? `Активы:               ${f(d.assets)}` : '',
    d.eq     != null ? `Собств. капитал:      ${f(d.eq)}` : '',
    d.debt   != null ? `Долг:                 ${f(d.debt)}` : '',
    d.cash   != null ? `Ден. средства:        ${f(d.cash)}` : '',
    d.nd     != null ? `Чистый долг (ND):     ${f(d.nd)}` : '',
    d.ca     != null ? `Оборотные активы:     ${f(d.ca)}` : '',
    d.cl     != null ? `Краткосрочн. обяз.:   ${f(d.cl)}` : '',
    d.sz     != null ? `Объём выпуска:        ${f(d.sz)}` : '',
    '',
    '── Мультипликаторы ──',
    d.ndE      != null ? `ND/EBITDA:            ${fx(d.ndE)}x` : '',
    d.icr      != null ? `ICR (покрытие %):     ${fx(d.icr)}x` : '',
    d.deRatio  != null ? `D/E Ratio:            ${fx(d.deRatio)}x` : '',
    d.cur      != null ? `Current Ratio:        ${fx(d.cur)}x` : '',
    d.eqRatio  != null ? `Equity Ratio:         ${fx(d.eqRatio,1)}%` : '',
    d.npm      != null ? `Чистая маржа:         ${fx(d.npm,1)}%` : '',
    d.ebitdam  != null ? `EBITDA маржа:         ${fx(d.ebitdam,1)}%` : '',
    d.roe      != null ? `ROE:                  ${fx(d.roe,1)}%` : '',
    d.roa      != null ? `ROA:                  ${fx(d.roa,1)}%` : '',
    d.szEbitda != null ? `Выпуск/EBITDA:        ${fx(d.szEbitda)}x` : '',
    d.szNd     != null ? `Выпуск/ND:            ${fx(d.szNd,1)}%` : '',
    d.peakCov  != null ? `Покрытие пика:        ${fx(d.peakCov)}x` : '',
    '',
    `Вердикт: ${d.riskLevel} риск`,
  ];
  return lines.filter(l=>l!==null).join('\n');
}

function copyAnalysisSummary() {
  const el = document.getElementById('analysis-summary-text');
  if(!el) return;
  navigator.clipboard.writeText(el.textContent).then(() => {
    const btn = event.target;
    btn.textContent = '✓ Скопировано';
    setTimeout(() => btn.textContent = '📄 Скопировать', 1800);
  }).catch(() => {
    // Fallback для мобильных
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  });
}

// Сохранить текущий анализ в базу отчётности
function saveAnalysisToBase() {
  const co   = document.getElementById('is-co')?.value?.trim();
  const ind  = document.getElementById('is-ind')?.value||'other';
  if(!co){ alert('Заполните название компании'); return; }

  // Находим или создаём эмитента в базе
  let issId = Object.keys(reportsDB).find(k => reportsDB[k].name === co);
  if(!issId) {
    issId = 'iss_'+Date.now();
    reportsDB[issId] = {name:co, ind, periods:{}};
  }

  const repType = document.getElementById('is-rep-type')?.value||'';
  const perSel  = document.getElementById('is-rep-period')?.value||'';
  const perCustom = document.getElementById('is-rep-period-custom')?.value?.trim()||'';
  const period  = perSel==='custom'?perCustom:perSel;
  const [yearStr] = (period||'').match(/\d{4}/)||[''];
  const year    = yearStr||new Date().getFullYear().toString();
  const perLabel= period.replace(/\d{4}/,'').trim()||'FY';

  const key = `${year}_${perLabel||'FY'}_${repType||'?'}`;
  const gv2 = id => { const v=parseFloat(document.getElementById(id)?.value); return isNaN(v)?null:v; };

  reportsDB[issId].periods[key] = {
    year, period:perLabel||'FY', type:repType||'?',
    note: document.getElementById('is-notes')?.value?.trim()||'',
    rev:gv2('is-rev'), ebitda:gv2('is-ebitda'), ebit:gv2('is-ebit'), np:gv2('is-np'),
    int:gv2('is-int'), tax:gv2('is-tax'), assets:gv2('is-assets'), ca:gv2('is-ca'),
    cl:gv2('is-cl'), debt:gv2('is-debt'), cash:gv2('is-cash'), ret:gv2('is-ret'),
    eq:gv2('is-eq'),
    analysisHTML: document.getElementById('iss-res-content')?.innerHTML || '',
  };
  save();

  // Обновляем счётчик
  document.getElementById('sb-rep').textContent = Object.keys(reportsDB).length;

  alert(`✅ Сохранено в базу: ${co} · ${period||year} · ${repType||'тип не указан'}\n\nОткройте раздел «📂 Отчётность» чтобы просмотреть.`);
}

// ═══ ЭКСПОРТ / ИМПОРТ ═══
function exportAllData() {
  const data = JSON.stringify({ytmBonds, portfolio, watchlists, calEvents, reportsDB}, null, 2);
  const blob = new Blob([data], {type:'application/json'});
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `bondanalytics_backup_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// Развернуть двойную кодировку UTF-8 → CP1251 (классический мохо́на,
// когда UTF-8-файл читают как Windows-1251, а потом полученные
// «кракозябры» сохраняют как UTF-8). Возвращает null, если строка
// не восстанавливается.
const _cp1251ToByte = (() => {
  const buf = new Uint8Array(256);
  for(let i=0;i<256;i++) buf[i]=i;
  const decoded = new TextDecoder('windows-1251').decode(buf);
  const map = new Map();
  for(let i=0;i<256;i++){
    // Для всех символов CP1251 сохраняем обратный байт; неопределённые
    // позиции (U+FFFD от дыр в CP1251) пропускаем, иначе коллизии.
    if(decoded.charCodeAt(i) !== 0xFFFD) map.set(decoded[i], i);
  }
  return map;
})();

function demojibakeCp1251(str){
  const bytes = new Uint8Array(str.length);
  for(let i=0;i<str.length;i++){
    const b = _cp1251ToByte.get(str[i]);
    if(b === undefined) return null;
    bytes[i] = b;
  }
  try { return new TextDecoder('utf-8', {fatal:true}).decode(bytes); }
  catch(_){ return null; }
}

// Признак того, что строка — мохо́на CP1251 (а не нормальный текст).
// Считаем пары «Р<кириллица/типографика>» — в обычном русском тексте
// столько таких пар подряд не бывает.
function looksLikeMojibake(s){
  if(typeof s !== 'string' || !s) return false;
  const hits = (s.match(/Р[\u0400-\u04FF\u2010-\u2122]/g) || []).length;
  return hits >= 2;
}

function maybeFixString(s){
  if(!looksLikeMojibake(s)) return s;
  const fixed = demojibakeCp1251(s);
  return (fixed && /[А-Яа-яЁё]/.test(fixed)) ? fixed : s;
}

// Глубокое восстановление: ходим по объекту и исправляем все строки,
// включая ключи словарей (ключи периодов вида "2025_РџРѕР»СѓРіРѕРґРёРµ_РњРЎР¤Рћ").
function fixMojibakeDeep(v){
  if(typeof v === 'string') return maybeFixString(v);
  if(Array.isArray(v)) return v.map(fixMojibakeDeep);
  if(v && typeof v === 'object'){
    const out = {};
    for(const [k, val] of Object.entries(v)){
      out[maybeFixString(k)] = fixMojibakeDeep(val);
    }
    return out;
  }
  return v;
}

// Чистит всё состояние приложения in-place; возвращает статистику.
function fixMojibakeEverywhere(){
  const before = JSON.stringify({ytmBonds, portfolio, watchlists, calEvents, reportsDB});
  ytmBonds   = fixMojibakeDeep(ytmBonds);
  portfolio  = fixMojibakeDeep(portfolio);
  watchlists = fixMojibakeDeep(watchlists);
  calEvents  = fixMojibakeDeep(calEvents);
  reportsDB  = fixMojibakeDeep(reportsDB);
  const after = JSON.stringify({ytmBonds, portfolio, watchlists, calEvents, reportsDB});
  const changed = before !== after;
  if(!changed){
    alert('Кракозябр в текущих данных не найдено — чинить нечего.');
    return;
  }
  save();
  if(typeof renderYtm === 'function') renderYtm();
  if(typeof renderPort === 'function') renderPort();
  if(typeof renderSbLists === 'function') renderSbLists();
  if(typeof repInit === 'function') repInit();
  alert('✅ Кириллица восстановлена. Проверьте вкладку «Отчётность».');
}

// Общий обработчик импорта: принимает уже прочитанный текст, парсит,
// спрашивает режим (merge/replace) и применяет. Возвращает true при успехе.
function applyImportedJsonText(raw){
  if(!raw || !raw.trim()){ alert('Пустой текст — вставьте содержимое JSON.'); return false; }
  let clean = String(raw).replace(/^\uFEFF/, '').trim();

  // Эвристика мохо́ны: характерный «Р<кириллица>» в 3+ местах.
  // Разворачиваем только если в результате появляется нормальная кириллица.
  const mojibakeHits = (clean.match(/Р[\u0400-\u04FF\u2010-\u2122]/g) || []).length;
  if(mojibakeHits >= 3){
    const fixed = demojibakeCp1251(clean);
    if(fixed && /[А-Яа-яЁё]/.test(fixed)) clean = fixed;
  }

  let d;
  try { d = JSON.parse(clean); }
  catch(err){
    alert('Не получилось разобрать JSON.\n\n' + err.message + '\n\nПроверьте, что текст начинается с { и заканчивается }.');
    return false;
  }
  if(!d || typeof d !== 'object' || Array.isArray(d)){
    alert('Это не объект бэкапа. Ожидается JSON вида { "reportsDB": {...}, "portfolio": [...] }.');
    return false;
  }

  // Single-issuer schema (bondan/issuer/v1 или просто объект с name+periods)
  // авто-оборачиваем в reportsDB — дальше работает общий merge.
  const isSingleIssuer =
    !d.reportsDB && !d.portfolio && !d.ytmBonds && !d.watchlists && !d.calEvents &&
    d.name && d.periods && typeof d.periods === 'object';
  if(isSingleIssuer){
    const id = 'iss_imp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,7);
    d = { reportsDB: { [id]: {
      name: d.name, ind: d.ind || 'other', note: d.note || '',
      isin: d.isin, inn: d.inn, ogrn: d.ogrn, disclosureUrl: d.disclosureUrl,
      rating: d.rating,
      periods: d.periods,
    } } };
  }

  // Bare-reportsDB: плоский словарь {issuerId: {name, periods, ...}}
  // без обёртки «reportsDB». Детект: нет известных ключей верхнего
  // уровня, но ВСЕ значения — объекты с name+periods.
  const knownKeys = ['reportsDB','portfolio','ytmBonds','watchlists','calEvents','schema','name','periods'];
  const hasKnown = knownKeys.some(k => k in d);
  if(!hasKnown){
    const entries = Object.entries(d);
    const looksLikeIssuerMap = entries.length > 0 && entries.every(([, v]) =>
      v && typeof v === 'object' && !Array.isArray(v) && typeof v.name === 'string' && v.periods && typeof v.periods === 'object'
    );
    if(looksLikeIssuerMap) d = { reportsDB: d };
  }

  const hasAnything = ['ytmBonds','portfolio','watchlists','calEvents','reportsDB'].some(k => d[k] != null);
  if(!hasAnything){
    alert('В файле нет ни одного из ожидаемых разделов (ytmBonds / portfolio / watchlists / calEvents / reportsDB), и это не файл отдельного эмитента (schema bondan/issuer/v1).');
    return false;
  }
  const choice = (prompt(
    'Что сделать с текущими данными?\n\n' +
    '1 — ОБЪЕДИНИТЬ (рекомендуется): добавить новое, ничего не терять.\n' +
    '      Для отчётности: периоды, которых ещё нет, добавятся; существующие не трогаются.\n' +
    '2 — ЗАМЕНИТЬ: полностью перезаписать текущие данные файлом (ВНИМАНИЕ: старое удалится).\n\n' +
    'Введите 1 или 2 (или нажмите Отмена):',
    '1'
  ) || '').trim();
  if(choice !== '1' && choice !== '2') return false;

  if(choice === '2'){
    if(d.ytmBonds)   ytmBonds   = d.ytmBonds;
    if(d.portfolio)  portfolio  = d.portfolio;
    if(d.watchlists) watchlists = d.watchlists;
    if(d.calEvents)  calEvents  = d.calEvents;
    if(d.reportsDB)  reportsDB  = d.reportsDB;
  } else {
    mergeImportedData(d);
  }
  save();
  renderYtm(); renderPort(); renderSbLists();
  document.getElementById('sb-pc').textContent = portfolio.length;
  document.getElementById('sb-rep').textContent = Object.keys(reportsDB).length;
  alert(choice==='2' ? '✅ Данные заменены на содержимое файла.' : '✅ Данные объединены с текущими.');
  return true;
}

function openPasteImportModal(){
  const ta = document.getElementById('import-paste-area');
  if(ta) ta.value = '';
  document.getElementById('modal-import-paste').classList.add('open');
}

function importFromPastedText(){
  const ta = document.getElementById('import-paste-area');
  const raw = ta ? ta.value : '';
  if(applyImportedJsonText(raw)) closeModal('modal-import-paste');
}

function importAllData(input) {
  const file = input.files[0]; if(!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const raw = String(e.target.result || '');
      applyImportedJsonText(raw);
    } catch(err) {
      alert('Ошибка чтения файла: ' + err.message);
    } finally {
      input.value = '';
    }
  };
  reader.onerror = () => alert('Не удалось прочитать файл. Попробуйте «📋 Вставить JSON».');
  reader.readAsText(file);
}

// ═══ ИМПОРТ ГИРБО (CSV/TXT/XML, Windows-1251 или UTF-8) ═══
// ГИРБО — Государственный информационный ресурс бухгалтерской отчётности
// ФНС (bo.nalog.gov.ru). Отдаёт выгрузки в двух форматах:
//   * CSV/TXT — строки баланса и ОФР с кодами РСБУ;
//   * XML КНД 0710099 — машиночитаемая форма с тегами вида
//     <стр2110>...</стр2110> или атрибутами Код="1600" Знач="...".
// Оба варианта чаще всего в Windows-1251. Формат отличается от МСФО:
// это госреестр РСБУ-отчётности, поэтому отдельный тип «ГИРБО».

function decodeBytesAutoCp1251(buf){
  const bytes = new Uint8Array(buf);
  // BOM UTF-8
  if(bytes.length >= 3 && bytes[0]===0xEF && bytes[1]===0xBB && bytes[2]===0xBF){
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'UTF-8 (BOM)' };
  }
  try {
    return { text: new TextDecoder('utf-8', {fatal:true}).decode(bytes), encoding: 'UTF-8' };
  } catch(_) {
    return { text: new TextDecoder('windows-1251').decode(bytes), encoding: 'Windows-1251' };
  }
}

// Для XML уважаем заявленную кодировку в прологе: <?xml encoding="..."?>.
// Первые ~300 байт читаем как ASCII (latin1) — этого хватит, чтобы
// вытащить имя кодировки даже если сам контент в Windows-1251.
function decodeXmlBytes(buf){
  const bytes = new Uint8Array(buf);
  if(bytes.length >= 3 && bytes[0]===0xEF && bytes[1]===0xBB && bytes[2]===0xBF){
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'UTF-8 (BOM)' };
  }
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 300)));
  const declMatch = head.match(/<\?xml[^?]*encoding\s*=\s*["']([^"']+)["']/i);
  const declared = declMatch ? declMatch[1].toLowerCase() : null;
  if(declared && /windows-?1251|cp1251/.test(declared)){
    return { text: new TextDecoder('windows-1251').decode(bytes), encoding: 'Windows-1251 (XML prolog)' };
  }
  if(declared && /utf-?8/.test(declared)){
    return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'UTF-8 (XML prolog)' };
  }
  return decodeBytesAutoCp1251(buf);
}

// Распознаём XML либо по расширению, либо по содержимому: строгий
// ГИРБО-XML начинается с «<?xml», встречаются вариации «<Файл...>».
function looksLikeXml(name, text){
  if(/\.xml$/i.test(name||'')) return true;
  const head = (text||'').trimStart().slice(0, 80);
  return /^<\?xml/i.test(head) || /^<(?:Файл|Документ|БухОтч)\b/u.test(head);
}

// RSBU_CODES — это {fieldId: [кодыСтрок]}. Здесь делаем обратное:
// для каждого кода — список fieldId, на который его значение пойдёт.
// Делаем ленивое построение: RSBU_CODES объявляется ниже по файлу.
function _rsbuInverseMap(){
  const inv = {};
  for(const [fid, codes] of Object.entries(RSBU_CODES||{})){
    for(const c of (codes||[])) (inv[String(c)] = inv[String(c)] || []).push(fid);
  }
  return inv;
}

// ── Семантическая схема ФНС КНД 0710099 (1С 5.02/5.10) ──
// XML от 1С:БУХГАЛТЕРИЯ не пишет коды РСБУ в теги. Вместо этого
// элементы называются осмысленно (<Выруч>, <ЧистПриб>, <ИтБалансАкт>),
// а цифры лежат в атрибуте НаОтч (или НаОтчДату). Ниже — карта
// «имя тега → код строки РСБУ». Включены оба варианта: развёрнутые
// (ОсновСредств, ДенежнСредств) и сокращённые (ОсновСр, ДенежнСр),
// которые реально фигурируют в выгрузках 1С v5.10.
const GIRBO_XML_SEMANTIC = {
  // === Баланс · Актив ===
  // 1110
  'НематАкт':'1110','НематАктив':'1110','НематАктивы':'1110','НемАкт':'1110',
  // 1120
  'РезНИОКР':'1120','РезультИР':'1120','РезИсслРазр':'1120',
  // 1130
  'НематПоиск':'1130','НемПоискАкт':'1130',
  // 1140
  'МатПоиск':'1140','МатПоискАкт':'1140',
  // 1150
  'ОсновСр':'1150','ОсновСредств':'1150','ОсновСредства':'1150','ОснСр':'1150',
  // 1160
  'ДохВлож':'1160','ДоходнВлож':'1160','ДохВложМатЦен':'1160',
  // 1170 — внеоборотные ФинВлож (перекрывается с 1240 через контекст)
  'ФинВложВнеоб':'1170',
  // 1180
  'ОтлНалАкт':'1180','ОтложНалАкт':'1180',
  // 1190
  'ПрочВнеобАкт':'1190','ПрочВнеоборАкт':'1190',
  // 1100 — итог внеоборотных
  'ИтВнеобАкт':'1100','ИтВнеоборАкт':'1100','ВнеобАктИт':'1100',
  // 1210
  'Запасы':'1210',
  // 1220
  'НДС':'1220',
  // 1230
  'ДебЗадолж':'1230','ДебиторЗадолж':'1230','ДебЗад':'1230',
  // 1250
  'ДенежнСр':'1250','ДенежнСредств':'1250','ДенСр':'1250','ДенСредств':'1250',
  // 1260
  'ПрочОбАкт':'1260','ПрочОборАкт':'1260',
  // 1200 — итог оборотных
  'ИтОборАкт':'1200','ОборАктИт':'1200',
  // 1600 — БАЛАНС (актив)
  'ИтАктБаланс':'1600','БалансАкт':'1600','ИтБалансАкт':'1600','ИтАкт':'1600','БалАкт':'1600',

  // === Баланс · Пассив ===
  // 1310
  'УстКап':'1310','УставКап':'1310','УставКапитал':'1310',
  // 1320
  'СобАкц':'1320','СобствАкц':'1320',
  // 1340
  'ПереоцВнеобАкт':'1340','ПереоцВнеоб':'1340',
  // 1350
  'ДобКап':'1350','ДобавКап':'1350','ДобавКапитал':'1350',
  // 1360
  'РезКап':'1360','РезервКап':'1360',
  // 1370
  'НераспПриб':'1370','НераспрПриб':'1370','НераспрПрибыль':'1370',
  // 1300 — итог капитала
  'ИтКапРез':'1300','ИтКап':'1300','ИтКапитал':'1300','КапИт':'1300',
  // 1420
  'ОтлНалОбязат':'1420','ОтложНалОбяз':'1420','ОтлНалОбяз':'1420',
  // 1400 — итог долгосрочных
  'ИтДолгОбязат':'1400','ИтДолгОбяз':'1400','ДолгОбязИт':'1400','ИтДолгосрОбяз':'1400',
  // 1520
  'КредЗадолж':'1520','КредиторЗадолж':'1520',
  // 1530
  'ДохБудПер':'1530','ДоходыБудПер':'1530',
  // 1500 — итог краткосрочных
  'ИтКраткОбязат':'1500','ИтКраткОбяз':'1500','ИтКраткосрОбяз':'1500',
  // 1700 — БАЛАНС (пассив)
  'ИтПасБаланс':'1700','БалансПас':'1700','ИтБалансПас':'1700',

  // === Отчёт о финрезультатах ===
  // 2110
  'Выруч':'2110','Выручка':'2110',
  // 2120
  'СебестПродаж':'2120','СебестПрод':'2120',
  // 2100
  'ВалПрибУб':'2100','ВалПрибыль':'2100','ВаловПриб':'2100','ВаловаяПрибыль':'2100',
  // 2210
  'КоммРасх':'2210','КоммерчРасх':'2210','КомРасход':'2210',
  // 2220
  'УпрРасх':'2220','УправлРасх':'2220','УпрРасход':'2220',
  // 2200 — прибыль от продаж
  'ПрибУбПрод':'2200','ПрибыльПродаж':'2200','ПрибУб':'2200','ПрибПрод':'2200',
  // 2310
  'ДохУчастДрОрг':'2310','ДохУчаст':'2310',
  // 2320
  'ПроцПолуч':'2320',
  // 2330 — проценты к уплате
  'ПроцУпл':'2330','ПроцДолгОбяз':'2330',
  // 2340
  'ПрочДох':'2340','ПрочДоход':'2340',
  // 2350
  'ПрочРасх':'2350',
  // 2300 — прибыль до налогообложения
  'ПрибУбДоНал':'2300','ПрибУбНал':'2300',
  // 2410 — текущий налог на прибыль (у 1С просто НалПриб или НалогПриб)
  'ТекНалПриб':'2410','ТекНалогПриб':'2410','НалогПриб':'2410','НалПриб':'2410','Налог':'2410',
  // 2400 — чистая прибыль
  'ЧистПриб':'2400','ЧистПрибыль':'2400','ЧистПрибУб':'2400',
  // 1350
  'ДобКапитал':'1350',

  // ── v5.10 aliases (1С:Бухгалтерия 3.0) ──
  // Баланс: короткие имена с «Об» вместо «Оборот»
  'ВнеОбА':'1100',      // Итого внеоборотные (в контейнере НаОтч)
  'ОбА':'1200',         // Итого оборотные
  // Активы
  'ИнвНедв':'1160',     // Доходные вложения в материальные ценности
  'ПрочВнеОбА':'1190',
  'НДСПриобрЦен':'1220',
  'ДебЗад':'1230',
  'ПрочОбА':'1260',
  // Капитал
  'НакОцВнеОбА':'1340', // Накопленная оценка внеоборотных активов (переоценка)
  'РезКапитал':'1360',  // Резервный капитал (было РезКап)
  // Обязательства
  'ЗаемСредств':'1510', // ВНИМАНИЕ: дефолт 1510; для 1410 нужен контекст (ниже)
  // ОФР
  'СебестПрод':'2120',
  'ВаловаяПрибыль':'2100',
  'КомРасход':'2210',
  'УпрРасход':'2220',
  'ПрочРасход':'2350',
};

// Контекст родителя: один и тот же тег в разных разделах баланса имеет
// разный код. ЗаемнСр (или ЗаемнСредств) под ДолгОбязат → 1410, под
// КраткОбязат → 1510. ФинВлож под ВнеобАкт → 1170, под ОборАкт → 1240.
const GIRBO_XML_CONTEXT = {
  // Итоговые секции баланса (1С v5.10 пишет значения в атрибуты контейнеров)
  'Баланс/Актив':'1600','Баланс/Пассив':'1700',
  'Актив/ВнеОбА':'1100','Актив/ОбА':'1200',
  'Пассив/Капитал':'1300',
  'Пассив/ДолгосрОбяз':'1400','Пассив/ДолгОбязат':'1400',
  'Пассив/КраткосрОбяз':'1500','Пассив/КраткОбязат':'1500',
  // ЗаемСредств — в 1С v5.10 без «н». Контекст обязателен:
  //   ДолгосрОбяз → 1410, КраткосрОбяз → 1510.
  'ДолгосрОбяз/ЗаемСредств':'1410','КраткосрОбяз/ЗаемСредств':'1510',
  // ПрочОбяз v5.10 (без «ат»)
  'ДолгосрОбяз/ПрочОбяз':'1450','КраткосрОбяз/ПрочОбяз':'1550',
  // ФинВлож v5.10 (внеоборотные в ВнеОбА, оборотные в ОбА)
  'ВнеОбА/ФинВлож':'1170','ОбА/ФинВлож':'1240',
  'ДолгОбязат/ЗаемнСр':'1410','ДолгосрОбязат/ЗаемнСр':'1410',
  'ДолгОбязат/ЗаемнСредств':'1410','ДолгосрОбязат/ЗаемнСредств':'1410',
  'КраткОбязат/ЗаемнСр':'1510','КраткосрОбязат/ЗаемнСр':'1510',
  'КраткОбязат/ЗаемнСредств':'1510','КраткосрОбязат/ЗаемнСредств':'1510',
  'ДолгОбязат/ОценОбязат':'1430','ДолгосрОбязат/ОценОбязат':'1430',
  'КраткОбязат/ОценОбязат':'1540','КраткосрОбязат/ОценОбязат':'1540',
  'ДолгОбязат/ПрочДолгОбязат':'1450','ДолгосрОбязат/ПрочДолгосрОбяз':'1450',
  'ДолгОбязат/ПрочОбязат':'1450','ДолгосрОбязат/ПрочОбязат':'1450',
  'КраткОбязат/ПрочКраткОбязат':'1550','КраткосрОбязат/ПрочКраткосрОбяз':'1550',
  'КраткОбязат/ПрочОбязат':'1550','КраткосрОбязат/ПрочОбязат':'1550',
  // ФинВлож: внеоборотные (1170) vs оборотные (1240)
  'ВнеобАкт/ФинВлож':'1170','ВнеоборАкт/ФинВлож':'1170',
  'ОборАкт/ФинВлож':'1240','ОборотнАкт/ФинВлож':'1240',
};

// Извлекает значения по семантической схеме КНД 0710099 + коды в
// именах тегов (ВписПоказ1220). Для v5.10 1С значения часто лежат в
// ребёнке <НаОтч>N</НаОтч>, а не в атрибуте — именно поэтому главные
// итоги (ИтБалансАкт, ИтКапРез, ИтОборАкт) раньше пропускались как
// «не-leaf». Теперь проверяем 4 источника значения:
//   1) атрибуты (НаОтч, НаПредОтч, НаОтчДату, СумНаОтч, Знач...);
//   2) ребёнок <НаОтч>/<НаОтчДату>/<Знач>...;
//   3) любой числовой атрибут (если не похож на дату);
//   4) textContent, если у элемента нет детей-элементов.
function _extractGirboSemanticCodes(doc){
  const toNum = s => {
    const n = parseFloat(String(s||'').replace(/\u00a0/g,'').replace(/\s/g,'').replace(',','.'));
    return isFinite(n) ? n : null;
  };
  // v5.10 1С кладёт значение в СумОтч (а прошлый период в СумПред / СумПрдщ /
  // СумПрдшв). СумОтч стоит ПЕРВЫМ в списке — иначе фолбэк на «любой числовой
  // атрибут» может подхватить ссылку на сноску (ПрПояснен="3.15") и вернуть
  // номер сноски вместо реальной суммы.
  const VAL_ATTRS = ['СумОтч','НаОтч','НаОтчДату','НаОтчДат','СумНаОтч','Знач','ЗначОтч','ЗначГод','Значение','Сумма'];
  const VAL_CHILDREN_RE = /^(сумотч|наотч|наотчдату?|наотчдат|сумнаотч|знач|значотч|значгод|значение|сумма)$/i;
  // Явные «не-значения»: ссылки на пояснения, идентификаторы, коды ОКВЭД/ОКУД,
  // числовые коды строк (2110 и т.п.) — хоть и проходят регексп «число», но это
  // служебные поля, не финансовые показатели.
  const SKIP_ATTRS = /^(ПрПояснен|ПрПоясн|НомерПоясн|ПрПриме|Код|ОКВЭД|ОКУД|ОКПО|ОКФС|ОКОПФ|ОКЕИ|КНД|Период|ОтчетГод|НомКорр|ПрАудит|ПрУтвер|ПрПодп|ИННЮЛ|КПП|СумПред|СумПрдщ|СумПрдшв|СумПредОтч)$/i;
  const pickValue = (el) => {
    for(const a of VAL_ATTRS){
      const v = el.getAttribute(a);
      if(v != null){ const n = toNum(v); if(n != null) return n; }
    }
    const kids = el.children || [];
    for(let j=0;j<kids.length;j++){
      const ch = kids[j];
      const chTag = (ch.localName || ch.nodeName || '').toLowerCase();
      if(VAL_CHILDREN_RE.test(chTag)){
        const n = toNum(ch.textContent);
        if(n != null) return n;
      }
    }
    // Fallback на любой числовой атрибут, но без дат, номеров сносок
    // (ПрПояснен="3.15"), кодов ОКВЭД/КНД/ИНН и прошлых периодов (СумПред,
    // СумПрдщ, СумПрдшв) — иначе вместо суммы 21 333 260 подхватит «3.15».
    for(let j=0;j<el.attributes.length;j++){
      const a = el.attributes[j];
      if(SKIP_ATTRS.test(a.name)) continue;
      const v = (a.value||'').trim();
      if(!/^-?\d[\d\s.,]*$/.test(v)) continue;
      if(/^20\d{2}$/.test(v)) continue;
      if(/^20\d{6}$/.test(v)) continue;
      if(/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(v)) continue;
      const n = toNum(v);
      if(n != null) return n;
    }
    // textContent без детей-элементов.
    if(!(el.children||[]).length){
      const n = toNum(el.textContent);
      if(n != null) return n;
    }
    return null;
  };

  const codeValues = {};
  const all = doc.getElementsByTagName('*');
  for(let i=0;i<all.length;i++){
    const el = all[i];
    const tag = el.localName || el.nodeName;
    if(!tag) continue;
    let code = null;
    const parent = el.parentNode;
    const parentTag = parent && (parent.localName || parent.nodeName);
    if(parentTag) code = GIRBO_XML_CONTEXT[parentTag + '/' + tag] || null;
    if(!code) code = GIRBO_XML_SEMANTIC[tag] || null;
    if(!code){
      // Код прямо в имени тега: ВписПоказ1220, Доп1520, line_2110 и т.п.
      const m = tag.match(/(\d{4})(?!\d)/);
      if(m && /^(1\d{3}|2\d{3})$/.test(m[1])) code = m[1];
    }
    if(!code) continue;
    const num = pickValue(el);
    if(num == null) continue;
    if(!(code in codeValues)) codeValues[code] = num;
  }
  return codeValues;
}

// Парсер ГИРБО-XML: извлекает ИНН/год/наименование + код→значение,
// маппит коды на внутренние поля (is-rev, is-np, ...) через RSBU_CODES.
function parseGirboXml(text){
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const perr = doc.querySelector('parsererror');
  if(perr){
    // Попробуем как text/xml — другой кодек ошибок в Firefox.
    const doc2 = new DOMParser().parseFromString(text, 'text/xml');
    if(doc2.querySelector('parsererror')){
      throw new Error('XML не удалось разобрать: ' + (perr.textContent||'').slice(0,200));
    }
  }
  const root = doc.documentElement;

  // ── Метаданные: ИНН, наименование, отчётный год ──
  // ВАЖНО: ОтчетГод и ДатаДок собираем отдельно — иначе при обходе атрибутов
  // ДатаДок="30.03.2026" срабатывает раньше ОтчетГод="2025" (годовой отчёт
  // сдают в марте СЛЕДУЮЩЕГО года), и год отчёта получается завышен на 1.
  let inn = '', name = '', year = null, dateYear = null;
  const all = root.getElementsByTagName('*');
  for(let i=0;i<all.length;i++){
    const el = all[i];
    for(let j=0;j<el.attributes.length;j++){
      const a = el.attributes[j];
      const v = (a.value||'').trim();
      const n = a.name.toLowerCase();
      if(!inn && /инн/.test(n) && /^(\d{10}|\d{12})$/.test(v)) inn = v;
      if(!name && /наим(орг|юл|полн|сокр)?|наименование/.test(n) && v.length >= 2) name = v;
      if(!year && /отчетгод|отчгод|отчётгод|периодотч|годотч|отчетныйгод/.test(n) && /^20\d{2}$/.test(v)) year = parseInt(v);
      if(!dateYear && /датадок|даталок|дата/.test(n)){
        const m = v.match(/(?:^|[^\d])(\d{2})\.(\d{2})\.(20\d{2})(?:$|[^\d])/);
        if(m) dateYear = parseInt(m[3]);
      }
    }
  }
  // Фолбэк по ДатаДок только если ОтчетГод нигде не нашёлся.
  // Точно угадать тут нельзя (годовой сдают в Q1 следующего года, квартальный —
  // в том же), поэтому берём как есть — большинство кейсов перекрывает основной
  // путь через ОтчетГод.
  if(!year && dateYear) year = dateYear;
  if(!inn){
    const m = (root.textContent||'').match(/\b(\d{10}|\d{12})\b/);
    if(m) inn = m[1];
  }
  if(!year){
    const m = text.match(/за\s+(20\d{2})\s*г|ОтчетГод\s*=\s*["'](20\d{2})/i);
    if(m) year = parseInt(m[1]||m[2]);
  }

  // ── Коды → значения ──
  // Вариант A: теги вида <стр2110>15876000</стр2110>
  // Вариант B: элемент с атрибутом Код="2110" + Знач/ЗначОтч/ЗначГод
  // Вариант C (1С КНД 0710099 5.x): семантические теги (<Выруч>,
  // <ЧистПриб>, <ИтБалансАкт>) с значением в атрибуте НаОтч.
  const codeValues = {}; // {codeStr: number}
  const toNum = s => {
    const n = parseFloat(String(s||'').replace(/\u00a0/g,'').replace(/\s/g,'').replace(',','.'));
    return isFinite(n) ? n : null;
  };
  for(let i=0;i<all.length;i++){
    const el = all[i];
    const tag = el.localName || el.nodeName;
    const tm = tag && tag.match(/^стр_?(\d{4})$/i);
    if(tm){
      const num = toNum(el.textContent);
      if(num != null) codeValues[tm[1]] = num;
    }
    // Атрибут Код/код
    const codeAttr = el.getAttribute('Код') || el.getAttribute('код') || el.getAttribute('KOD');
    if(codeAttr && /^\d{4}$/.test(codeAttr)){
      const val = el.getAttribute('Знач') || el.getAttribute('ЗначОтч') ||
                  el.getAttribute('ЗначГод') || el.getAttribute('Значение') ||
                  el.getAttribute('значение') || el.textContent;
      const num = toNum(val);
      if(num != null && codeValues[codeAttr] == null) codeValues[codeAttr] = num;
    }
  }

  // Вариант C: семантические имена тегов из схемы ФНС КНД 0710099.
  const semantic = _extractGirboSemanticCodes(doc);
  for(const [code, num] of Object.entries(semantic)){
    if(codeValues[code] == null) codeValues[code] = num;
  }

  // ── Маппинг кода на внутренние поля через RSBU_CODES ──
  const inv = _rsbuInverseMap();
  const codes = {};
  for(const [code, num] of Object.entries(codeValues)){
    const fids = inv[code] || [];
    for(const fid of fids){
      if(fid === 'is-debt' && codes[fid] != null) codes[fid] += num; // 1410+1510
      else if(codes[fid] == null) codes[fid] = num;
    }
  }

  // ── Fallback: прогоняем плоское представление через extractByRsbuCodes,
  // чтобы поймать нестандартные схемы (например, с человекочитаемой
  // шапкой внутри XML). ──
  if(Object.keys(codes).length < 6){
    const flat = [];
    for(let i=0;i<all.length;i++){
      const el = all[i];
      const attrs = Array.from(el.attributes).map(a => a.name + '\t' + a.value).join('\t');
      const txt = el.childNodes.length === 1 && el.firstChild.nodeType === 3 ? el.textContent : '';
      flat.push((el.localName||el.nodeName) + '\t' + attrs + '\t' + txt);
    }
    const fromText = extractByRsbuCodes(flat.join('\n'));
    for(const [fid, v] of Object.entries(fromText)){
      if(codes[fid] == null && v != null) codes[fid] = v;
    }
  }

  return { inn, name, year, codes };
}

function parseGirboText(raw){
  // CSV-разделитель «;» (де-факто стандарт ГИРБО) заменяем на TAB —
  // тогда extractByRsbuCodes и findVal видят привычные границы колонок.
  const text = raw.replace(/;/g, '\t');
  const lines = text.split(/\r?\n/);

  // ИНН: 10 цифр (юрлицо) или 12 (ИП). Берём первое отдельно стоящее вхождение.
  const innMatch = text.match(/(?:^|[^\d])(\d{10}|\d{12})(?:[^\d]|$)/);
  const inn = innMatch ? innMatch[1] : '';

  // Год отчётности: «за 2023 год», «отчётный период … 2023», «на 31.12.2023».
  let year = null;
  const yMatches = [
    text.match(/за\s+(20\d{2})\s*г(?:од)?/i),
    text.match(/отч[её]тн\w+\s+(?:период|год)[^0-9]{0,40}(20\d{2})/i),
    text.match(/на\s+31[.\/-]12[.\/-](20\d{2})/),
  ];
  for(const m of yMatches){ if(m){ year = parseInt(m[1]); break; } }

  // Наименование: «ПАО "Газпром"», «АО «РЖД»», «ООО Ромашка».
  // \b не работает для кириллицы в JS, поэтому фиксируем границу вручную:
  // начало строки или символ, который точно не буква.
  let name = '';
  const nameRe = /(?:^|[^А-ЯЁа-яёA-Za-z])((?:ПАО|АО|ОАО|ЗАО|ООО|НКО|ФГУП|ГУП|МУП|ИП)\s+(?:«[^»]{2,120}»|"[^"]{2,120}"|[А-ЯЁA-Z][А-ЯЁа-яёA-Za-z0-9\-\s«»"]{1,80}?))(?=[\s,;:\t\r\n]|$)/u;
  for(const l of lines){
    const m = l.match(nameRe);
    if(m){ name = m[1].trim().replace(/\s+/g,' '); break; }
  }

  // Сначала пробуем строковый вариант (одна строка на код).
  let codes = extractByRsbuCodes(text);

  // Колоночный fallback: open-data ФНС публикует гигантские CSV, где
  // каждая компания — отдельная строка, а коды стоят в заголовках:
  //   ИНН;Наим;...;строка_2110_3;строка_2110_4;строка_1600_3;...
  // В таком случае extractByRsbuCodes находит <2 полей. Тогда читаем
  // заголовок, ищем строку по ИНН и тянем значения по индексам колонок.
  if(Object.keys(codes).length < 4){
    const byHeader = extractByRsbuCsvHeader(raw, inn);
    for(const [fid, v] of Object.entries(byHeader)){
      if(codes[fid] == null && v != null) codes[fid] = v;
    }
  }

  return { inn, year, name, codes, encoding: null, text };
}

// Колоночный разбор CSV: ищем в заголовке имена колонок с кодом РСБУ
// (строка_2110, line_2110, "2110", "2110_3", "2110.3", "2110_от" и т.п.),
// затем берём значения из строки-данных. Если ИНН уже определён — ищем
// именно его строку, иначе — первую строку с числами.
function extractByRsbuCsvHeader(raw, expectedInn){
  if(!raw) return {};
  // Разделитель колонок: выбираем по частоте — «;», «\t», «,» (в открытых
  // CSV ФНС подавляющее — точка с запятой).
  const counts = {
    ';': (raw.match(/;/g)||[]).length,
    '\t': (raw.match(/\t/g)||[]).length,
    ',': (raw.match(/,/g)||[]).length,
  };
  const delim = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0][0];
  if(!counts[delim] || counts[delim] < 4) return {};

  const lines = raw.split(/\r?\n/).filter(l => l.trim().length);
  if(lines.length < 2) return {};

  // Простой CSV-сплит: если в колонке кавычки — уважаем. Достаточно для ФНС.
  const splitRow = (line) => {
    const out = [];
    let cur = '', inQ = false;
    for(let i=0;i<line.length;i++){
      const ch = line[i];
      if(ch === '"'){
        if(inQ && line[i+1] === '"'){ cur += '"'; i++; }
        else inQ = !inQ;
      } else if(ch === delim && !inQ){ out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };

  const headers = splitRow(lines[0]).map(h => h.trim().toLowerCase());
  // code → preferred colIdx (предпочитаем колонку «за отчётный» — обычно
  // суффикс _3 в схеме ФНС; _4 — прошлый период, _5 — позапрошлый).
  const codeColMap = {};
  const isPreferred = variant => !variant || /^3$|^от|^отч/i.test(variant);

  headers.forEach((h, i) => {
    // строка_2110, строка2110, стр_2110, стр2110, line_2110, line2110
    // или просто 2110, 2110_3, 2110.3, 2110_от
    const m = h.match(/(?:^|[\s_\-.:/;])(?:строка|стр|line|code)?[\s_\-.:/;]?(\d{4})(?:[\s_\-.:/;]?([а-яёa-z0-9]+))?(?=\s*$|[\s_\-.:/;])/iu);
    if(!m) return;
    const code = m[1];
    if(!/^(1\d{3}|2\d{3})$/.test(code)) return;
    const variant = (m[2]||'').toLowerCase();
    const cur = codeColMap[code];
    if(cur == null || (!isPreferred(cur.variant) && isPreferred(variant))){
      codeColMap[code] = { idx: i, variant };
    }
  });
  if(!Object.keys(codeColMap).length) return {};

  // Ищем нужную строку-данные. Если знаем ИНН — предпочитаем совпадение.
  let dataRow = null;
  const innColIdx = headers.findIndex(h => /инн|^inn\b/.test(h));
  if(expectedInn && innColIdx >= 0){
    for(let k=1; k<lines.length; k++){
      const cells = splitRow(lines[k]);
      if((cells[innColIdx]||'').trim() === expectedInn){ dataRow = cells; break; }
    }
  }
  if(!dataRow){
    // Fallback: первая строка, где хотя бы половина ячеек с кодами — числа.
    for(let k=1; k<lines.length; k++){
      const cells = splitRow(lines[k]);
      let numCnt = 0, total = 0;
      for(const {idx} of Object.values(codeColMap)){
        total++;
        const n = parseFloat(String(cells[idx]||'').replace(/\s/g,'').replace(',','.'));
        if(isFinite(n) && n !== 0) numCnt++;
      }
      if(total && numCnt >= Math.max(3, total/3)){ dataRow = cells; break; }
    }
  }
  if(!dataRow) return {};

  const inv = _rsbuInverseMap();
  const codes = {};
  for(const [code, {idx}] of Object.entries(codeColMap)){
    const raw = String(dataRow[idx]||'').trim();
    const num = parseFloat(raw.replace(/\u00a0/g,'').replace(/\s/g,'').replace(',','.'));
    if(!isFinite(num)) continue;
    const fids = inv[code] || [];
    for(const fid of fids){
      if(fid === 'is-debt' && codes[fid] != null) codes[fid] += num;
      else if(codes[fid] == null) codes[fid] = num;
    }
  }
  return codes;
}

// Ядро: берёт ArrayBuffer + имя файла, определяет формат, декодирует,
// парсит и пишет в reportsDB. Общая точка входа для файл-инпута, paste
// и drag-and-drop — чтобы логика не дублировалась.
// opts = { quiet: true, autoOverwrite: true } — используется батчем.
// Всегда возвращает сводку {ok, issName, year, format, encoding, filled, missed, error, skippedReason}.
function _processGirboFile(buf, filename, opts){
  opts = opts || {};
  const quiet = !!opts.quiet;
  const autoOverwrite = !!opts.autoOverwrite;
  if(!buf || !buf.byteLength){
    if(!quiet) alert('Пустой файл.');
    return { ok:false, error:'пустой файл', file:filename };
  }
  const peek = new TextDecoder('latin1').decode(new Uint8Array(buf).subarray(0, Math.min(buf.byteLength, 80)));
  const isXml = looksLikeXml(filename, peek);

  let text, encoding, parsed;
  if(isXml){
    ({ text, encoding } = decodeXmlBytes(buf));
    parsed = parseGirboXml(text);
    parsed.format = 'XML';
  } else {
    ({ text, encoding } = decodeBytesAutoCp1251(buf));
    parsed = parseGirboText(text);
    parsed.format = 'CSV/TXT';
  }
  parsed.encoding = encoding;

  if(!Object.keys(parsed.codes).length){
    // Диагностика: нужно увидеть точные имена тегов и где значения.
    // Три категории: (1) с НаОтч/НаПредОтч-атрибутами — стандарт ФНС;
    // (2) с ЛЮБЫМ числовым атрибутом; (3) вообще все leaf-теги.
    const preview = String(text || '').slice(0, 500).replace(/\t/g, ' | ');
    let tagList = '';
    if(parsed.format === 'XML'){
      try {
        const doc = new DOMParser().parseFromString(text, 'application/xml');
        const naOtchTags = new Set();     // с НаОтч-семейством
        const numAttrTags = new Set();    // с числовым атрибутом
        const numTextTags = new Set();    // с числовым textContent
        const allLeafTags = new Set();    // любой leaf
        const all = doc.getElementsByTagName('*');
        const NUM_RE = /^-?\d[\d\s.,]*$/;
        for(let i=0;i<all.length;i++){
          const el = all[i];
          const hasElChildren = Array.from(el.children||[]).length > 0;
          if(hasElChildren) continue;
          const name = el.localName || el.nodeName;
          allLeafTags.add(name);
          if(el.getAttribute('НаОтч') || el.getAttribute('НаПредОтч') ||
             el.getAttribute('НаПредПредОтч') || el.getAttribute('НаОтчДату') ||
             el.getAttribute('СумНаОтч') || el.getAttribute('Знач')){
            naOtchTags.add(name);
          }
          for(let j=0;j<el.attributes.length;j++){
            const v = (el.attributes[j].value || '').trim();
            if(v && NUM_RE.test(v)){ numAttrTags.add(name); break; }
          }
          const txt = (el.textContent || '').trim();
          if(txt && NUM_RE.test(txt)) numTextTags.add(name);
        }
        const short = (set, limit) => Array.from(set).slice(0, limit).join(', ') +
          (set.size > limit ? ` (+${set.size-limit})` : '');
        if(naOtchTags.size){
          tagList = '\n\n── Leaf-теги с НаОтч (не в схеме) ──\n' + short(naOtchTags, 40);
        } else if(numAttrTags.size){
          tagList = '\n\n── Leaf-теги с числовыми атрибутами ──\n' + short(numAttrTags, 40);
        } else if(numTextTags.size){
          tagList = '\n\n── Leaf-теги с числом в тексте ──\n' + short(numTextTags, 40);
        } else {
          tagList = '\n\n── Leaf-теги (все) ──\n' + short(allLeafTags, 40);
        }
      } catch(e){ tagList = '\n\n── XML parse error: ' + e.message + ' ──'; }
    }
    if(!quiet){
      alert('В файле не найдены строки РСБУ (2110/1600/1300 и т.д.).\n\n' +
            'Формат: '+parsed.format+'\n' +
            'Кодировка: '+encoding+
            tagList +
            '\n\n── Начало файла ──\n' + preview + (text && text.length > 500 ? '\n...' : '') +
            '\n\nЕсли это действительно ГИРБО — пришли теги из первой секции выше.');
    }
    return { ok:false, error:'не найдены коды РСБУ', file:filename, format:parsed.format, encoding };
  }

  let year = parsed.year;
  if(!year){
    if(quiet){
      return { ok:false, error:'не определён год отчёта', file:filename, format:parsed.format, encoding };
    }
    const ans = prompt('Не удалось определить год отчёта из файла.\nУкажите год (например, 2023):', String(new Date().getFullYear()-1));
    year = ans ? parseInt(String(ans).trim()) : null;
    if(!year || year < 2000 || year > 2099){
      return { ok:false, error:'год не указан', file:filename };
    }
  }

  let issName = parsed.name;
  if(!issName){
    if(quiet){
      return { ok:false, error:'не определено имя эмитента', file:filename, year };
    }
    issName = (prompt('Не удалось определить эмитента из файла.\nВведите название компании:', '') || '').trim();
    if(!issName) return { ok:false, error:'имя не указано', file:filename, year };
  }

  // Ищем существующего эмитента: 1) по ИНН, 2) по нормализованному имени.
  // Нормализация: убираем ПАО/АО/ООО/ЗАО/ОАО/ИП, кавычки-ёлочки-апострофы,
  // пунктуацию и лишние пробелы — чтобы «ПАО "ТГК-14"» и «ТГК-14» совпали.
  let issId = null;
  for(const [id, iss] of Object.entries(reportsDB)){
    if(parsed.inn && iss && iss.inn === parsed.inn){ issId = id; break; }
  }
  if(!issId){
    const target = _normIssuerName(issName);
    for(const [id, iss] of Object.entries(reportsDB)){
      if(iss && iss.name && _normIssuerName(iss.name) === target){ issId = id; break; }
    }
  }
  if(!issId){
    issId = 'iss_girbo_' + Date.now().toString(36);
    reportsDB[issId] = {
      name: issName, ind: 'other', periods: {},
      inn: parsed.inn || undefined,
      note: 'Импорт ГИРБО ('+parsed.format+', '+encoding+') · '+new Date().toLocaleDateString('ru-RU'),
    };
  } else if(parsed.inn && !reportsDB[issId].inn){
    // Доп. бонус: если нашли по имени, а ИНН в существующей карточке пустой —
    // прописываем его, чтобы в следующий раз сработал быстрый ИНН-матч.
    reportsDB[issId].inn = parsed.inn;
  }

  const type = 'ГИРБО';
  const period = 'FY';
  const key = year+'_'+period+'_'+type;
  const alreadyExists = !!reportsDB[issId].periods[key];
  if(alreadyExists && !autoOverwrite &&
     !confirm('Период '+year+' · '+type+' для «'+reportsDB[issId].name+'» уже есть в базе.\n\nПерезаписать новыми данными?')){
    return { ok:false, skippedReason:'период уже есть, отказ от перезаписи', file:filename, year, issName:reportsDB[issId].name };
  }

  // ГИРБО хранит суммы в тысячах рублей. БондАналитик считает в млрд ₽.
  const scale = 0.000001;
  const fieldMap = {
    'is-rev':'rev','is-ebit':'ebit','is-np':'np','is-int':'int',
    'is-tax':'tax','is-assets':'assets','is-ca':'ca','is-cl':'cl',
    'is-debt':'debt','is-cash':'cash','is-ret':'ret','is-eq':'eq',
  };
  const fieldLabels = {
    'is-rev':'Выручка (2110)','is-ebit':'Прибыль от продаж (2200)',
    'is-np':'Чистая прибыль (2400)','is-int':'Проценты к уплате (2330)',
    'is-tax':'Налог на прибыль (2410)','is-assets':'Итого активы (1600)',
    'is-ca':'Оборотные активы (1200)','is-cl':'Краткосрочн. обязат. (1500)',
    'is-debt':'Заёмные средства (1410+1510)','is-cash':'Денежные ср-ва (1250)',
    'is-ret':'Нераспр. прибыль (1370)','is-eq':'Итого капитал (1300)',
  };
  const pData = {
    year, period, type,
    note: reportsDB[issId].note || '',
    analysisHTML: '',
    rev:null, ebitda:null, ebit:null, np:null, int:null, tax:null,
    assets:null, ca:null, cl:null, debt:null, cash:null, ret:null, eq:null,
  };
  const filledList = [];
  const missedList = [];
  // Строки 2330 (проценты к уплате) и 2410 (налог на прибыль) — расходы,
  // у нас хранятся как положительные магнитуды. В XML/1С значение часто
  // приходит со знаком минус (внутреннее signed-представление отчёта
  // о финрезультатах). Без нормализации попадает минус в базу, ломает
  // ICR, триггерит ложный аудит «отрицательные проценты».
  const _expenseFields = new Set(['is-int', 'is-tax']);
  for(const [fid, pk] of Object.entries(fieldMap)){
    const v = parsed.codes[fid];
    if(v != null){
      const norm = _expenseFields.has(fid) ? Math.abs(v) : v;
      pData[pk] = parseFloat((norm * scale).toFixed(6));
      filledList.push(fieldLabels[fid]);
    } else {
      missedList.push(fieldLabels[fid]);
    }
  }
  reportsDB[issId].periods[key] = pData;

  save();
  if(typeof repInit === 'function') repInit();
  const sbRep = document.getElementById('sb-rep');
  if(sbRep) sbRep.textContent = Object.keys(reportsDB).length;

  // Закрываем модалку, если открыта.
  const modal = document.getElementById('modal-girbo-import');
  if(modal && modal.classList.contains('open')) modal.classList.remove('open');

  const filledBlock = filledList.length
    ? '✓ Заполнено ('+filledList.length+'):\n  '+filledList.join('\n  ')
    : '⚠ Ни одно поле не заполнено.';
  const missedBlock = missedList.length
    ? '\n\n✗ Не нашлось: '+missedList.length+' из 12 (пусто часто норма)'
    : '';

  // Если формат XML и часть полей не нашлась — готовим диагностический
  // дамп всех тегов (с их структурой: parent · tag · children-count ·
  // значение). Clipboard API на мобильном без user-gesture не срабатывает,
  // поэтому открываем модалку с textarea — пользователь выделит вручную.
  let openDiag = false;
  if(missedList.length && parsed.format === 'XML'){
    const dump = _buildGirboXmlDump(text);
    if(dump){
      const ta = document.getElementById('girbo-diag-text');
      if(ta){ ta.value = dump; openDiag = true; }
    }
  }

  if(!quiet){
    alert('✅ ГИРБО · '+reportsDB[issId].name+' · '+year+'\n' +
          parsed.format+' · '+encoding+'\n\n' +
          filledBlock + missedBlock +
          (openDiag ? '\n\n🔎 Дальше откроется диагностика — вставь её в чат.' : ''));

    if(openDiag){
      const cs = document.getElementById('girbo-diag-copy-status');
      if(cs) cs.textContent = '';
      document.getElementById('modal-girbo-diag').classList.add('open');
    }
  }
  return {
    ok: true,
    file: filename,
    issName: reportsDB[issId].name,
    year,
    format: parsed.format,
    encoding,
    filled: filledList,
    missed: missedList,
    overwrote: alreadyExists,
  };
}

// Формируем плоский дамп XML для ручной передачи в чат.
// Структура:
//   === ROOT: Файл ===
//   Документ > СвНП > НПЮЛ        [inline leaf]          attrs: ИНН=... / НаимОрг=...
//   Документ > БухОтч > БалансАкт  [container/4 kids]    value(НаОтч)=5000000
//   ...
// Выводим только ~120 первых уникальных «путей родитель→тег», с примером
// значения, если нашлось. Этого хватает, чтобы понять схему формы.
function _buildGirboXmlDump(text){
  try {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if(doc.querySelector('parsererror')) return '[XML parse error]';
    const root = doc.documentElement;
    const VAL_ATTRS = ['НаОтч','НаПредОтч','НаПредПредОтч','НаОтчДату','НаОтчДат','СумНаОтч','Знач','ЗначОтч','ЗначГод','Значение','Сумма'];
    const VAL_CHILDREN_RE = /^(наотч|напредотч|напредпредотч|наотчдату?|наотчдат|сумнаотч|знач|значотч|значгод|значение|сумма)$/i;
    const pickVal = (el) => {
      for(const a of VAL_ATTRS){
        const v = el.getAttribute(a);
        if(v != null && v.trim()) return {src: a, val: v.trim()};
      }
      const kids = el.children || [];
      for(let j=0;j<kids.length;j++){
        const ch = kids[j];
        const chTag = (ch.localName || ch.nodeName || '');
        if(VAL_CHILDREN_RE.test(chTag)){
          const t = (ch.textContent||'').trim();
          if(t) return {src:'<'+chTag+'>', val:t};
        }
      }
      if(!(el.children||[]).length){
        const t = (el.textContent||'').trim();
        if(t && t.length < 80) return {src:'text', val:t};
      }
      return null;
    };

    const lines = ['=== ROOT: ' + (root.localName || root.nodeName) + ' ===',
                   'Версия формы: ' + (root.getAttribute('ВерсФорм') || '?') +
                   ' · Программа: ' + (root.getAttribute('ВерсПрог') || '?')];
    const seen = new Set();
    const all = root.getElementsByTagName('*');
    const MAX = 200;
    for(let i=0;i<all.length && lines.length < MAX+2;i++){
      const el = all[i];
      const tag = el.localName || el.nodeName; if(!tag) continue;
      const parent = el.parentNode;
      const parentTag = parent ? (parent.localName || parent.nodeName) : '';
      const key = parentTag + '/' + tag;
      if(seen.has(key)) continue;
      seen.add(key);
      const nKids = (el.children || []).length;
      const marker = nKids ? '['+nKids+' kids]' : '[leaf]';
      const v = pickVal(el);
      const valPart = v ? '  ' + v.src + '=' + v.val.slice(0, 40) : '';
      lines.push(parentTag + ' > ' + tag + '  ' + marker + valPart);
    }
    if(all.length >= MAX) lines.push('... ещё элементов (всего '+all.length+')');
    return lines.join('\n');
  } catch(e){
    return '[dump error: ' + e.message + ']';
  }
}

// Попытка скопировать содержимое textarea — срабатывает, т.к. это
// клик от пользователя. На старых WebView может понадобиться execCommand.
function _girboDiagCopy(){
  const ta = document.getElementById('girbo-diag-text');
  const st = document.getElementById('girbo-diag-copy-status');
  if(!ta){ return; }
  try {
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch(_){}
    if(!ok && navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(ta.value).then(() => {
        if(st) st.textContent = '✓ Скопировано.';
      }, () => { if(st) st.textContent = '⚠ Не получилось — выдели вручную и скопируй.'; });
    } else {
      if(st) st.textContent = ok ? '✓ Скопировано.' : '⚠ Не получилось — выдели вручную и скопируй.';
    }
  } catch(e){
    if(st) st.textContent = '⚠ ' + e.message + ' — выдели вручную и скопируй.';
  }
}

function importGirboCsv(input){
  const files = Array.from(input.files || []);
  if(!files.length) return;

  // Один файл — классический путь: алерт с подробностями, промпты при
  // необходимости, диагностический модал при пропусках.
  if(files.length === 1){
    const file = files[0];
    const reader = new FileReader();
    reader.onload = e => {
      try { _processGirboFile(e.target.result, file.name); }
      catch(err){ alert('Ошибка чтения файла ГИРБО: ' + err.message); }
      finally { input.value = ''; }
    };
    reader.onerror = () => alert('Не удалось прочитать файл ГИРБО.');
    reader.readAsArrayBuffer(file);
    return;
  }

  // Несколько файлов — батч: без промптов, авто-перезапись, одна сводка в конце.
  importGirboBatch(files).finally(() => { input.value = ''; });
}

// Нормализация имени эмитента для слияния дубликатов.
// «ПАО "ТГК-14"», «пао тгк 14», «ТГК-14» → "тгк14".
function _normIssuerName(name){
  if(!name) return '';
  let s = String(name).toLowerCase();
  // Убираем организационные формы в любом месте строки.
  s = s.replace(/\b(пао|ао|оао|зао|ооо|ип|публичное\s+акционерное\s+общество|открытое\s+акционерное\s+общество|закрытое\s+акционерное\s+общество|акционерное\s+общество|общество\s+с\s+ограниченной\s+ответственностью|индивидуальный\s+предприниматель)\b/g, ' ');
  // Кавычки всех мастей, апострофы, угловые скобки, знаки препинания — в пробел.
  s = s.replace(/[«»""''"„"`"‘’"'()\[\]{}<>.,:;!?/\\|*+=~#%^&@]/g, ' ');
  // Тире и подчёркивания — тоже убираем: ТГК-14 = ТГК14.
  s = s.replace(/[-–—_]/g, '');
  // Все пробелы — в один, потом убираем (чтобы «тгк 14» = «тгк14»).
  s = s.replace(/\s+/g, ' ').trim().replace(/\s+/g, '');
  return s;
}

// Объединение эмитентов: переносит периоды из src в dst и удаляет src.
// Дубли периодов (год_период_тип) не трогаем — приоритет у dst.
function _mergeIssuers(srcId, dstId){
  const src = reportsDB[srcId], dst = reportsDB[dstId];
  if(!src || !dst || srcId === dstId) return { moved:0, skipped:0 };
  let moved = 0, skipped = 0;
  for(const [key, p] of Object.entries(src.periods || {})){
    if(dst.periods[key]){ skipped++; continue; }
    dst.periods[key] = p;
    moved++;
  }
  // Переливаем недостающие метаданные (ИНН, ISIN, ОГРН, рейтинг и т.п.).
  for(const k of ['inn','isin','ogrn','url','rating','ind']){
    if(!dst[k] && src[k]) dst[k] = src[k];
  }
  delete reportsDB[srcId];
  return { moved, skipped };
}

// Открывает модалку слияния. Автоматически предлагает кандидатов:
// src = текущий активный, dst = ближайший по ИНН или нормализованному имени.
function repOpenMergeModal(){
  const ids = Object.keys(reportsDB);
  if(ids.length < 2){ alert('Для слияния нужны минимум 2 эмитента в базе.'); return; }
  const srcSel = document.getElementById('merge-src');
  const dstSel = document.getElementById('merge-dst');
  if(!srcSel || !dstSel) return;
  const sorted = ids.slice().sort((a,b) => (reportsDB[a].name||'').localeCompare(reportsDB[b].name||''));
  const opts = sorted.map(id => {
    const iss = reportsDB[id];
    const np  = Object.keys(iss.periods||{}).length;
    const inn = iss.inn ? ' · '+iss.inn : '';
    return `<option value="${id}">${(iss.name||'—').replace(/</g,'&lt;')}${inn} (${np} периодов)</option>`;
  }).join('');
  srcSel.innerHTML = opts;
  dstSel.innerHTML = opts;
  // Подбираем авто-пару: предпочитаем текущий активный как src, ищем совпадение как dst.
  const active = repActiveIssuerId;
  if(active && reportsDB[active]){
    srcSel.value = active;
    const candidate = _findMergeCandidate(active);
    if(candidate) dstSel.value = candidate;
    else dstSel.value = sorted.find(id => id !== active) || active;
  }
  srcSel.onchange = dstSel.onchange = _updateMergePreview;
  _updateMergePreview();
  document.getElementById('modal-merge-issuers').classList.add('open');
}

// Ищем подходящую цель для слияния: по ИНН или нормализованному имени.
function _findMergeCandidate(srcId){
  const src = reportsDB[srcId];
  if(!src) return null;
  const srcNorm = _normIssuerName(src.name);
  for(const [id, iss] of Object.entries(reportsDB)){
    if(id === srcId || !iss) continue;
    if(src.inn && iss.inn && src.inn === iss.inn) return id;
    if(srcNorm && _normIssuerName(iss.name) === srcNorm) return id;
  }
  return null;
}

function _updateMergePreview(){
  const srcId = document.getElementById('merge-src').value;
  const dstId = document.getElementById('merge-dst').value;
  const el = document.getElementById('merge-preview');
  if(!el) return;
  if(srcId === dstId){ el.innerHTML = '<span style="color:var(--warn)">⚠ Источник и цель совпадают. Выбери разные карточки.</span>'; return; }
  const src = reportsDB[srcId], dst = reportsDB[dstId];
  if(!src || !dst){ el.innerHTML = ''; return; }
  const srcPeriods = Object.keys(src.periods || {});
  const dstPeriods = new Set(Object.keys(dst.periods || {}));
  const willMove = srcPeriods.filter(k => !dstPeriods.has(k));
  const willSkip = srcPeriods.filter(k =>  dstPeriods.has(k));
  const fmt = k => k.replace(/_/g, ' ');
  el.innerHTML =
    `<div style="color:var(--green)">Переедет: ${willMove.length}</div>` +
    (willMove.length ? '<div style="margin-left:12px;color:var(--text3)">' + willMove.map(fmt).join(' · ') + '</div>' : '') +
    (willSkip.length ? `<div style="color:var(--warn);margin-top:4px">Пропущено (дубли в цели): ${willSkip.length}</div><div style="margin-left:12px;color:var(--text3)">${willSkip.map(fmt).join(' · ')}</div>` : '') +
    `<div style="color:var(--danger);margin-top:6px">После слияния «${(src.name||'—').replace(/</g,'&lt;')}» будет удалён.</div>`;
}

function repDoMerge(){
  const srcId = document.getElementById('merge-src').value;
  const dstId = document.getElementById('merge-dst').value;
  if(srcId === dstId){ alert('Выбери разные карточки источника и цели.'); return; }
  const src = reportsDB[srcId], dst = reportsDB[dstId];
  if(!src || !dst) return;
  if(!confirm(`Объединить «${src.name}» → «${dst.name}»?\n\nВсе периоды источника (кроме дублей) перейдут в цель. Источник удалится.`)) return;
  const { moved, skipped } = _mergeIssuers(srcId, dstId);
  save();
  if(repActiveIssuerId === srcId) repActiveIssuerId = dstId;
  if(typeof repInit === 'function') repInit();
  closeModal('modal-merge-issuers');
  showToast(`✓ Слияние: перенесено ${moved} периодов${skipped ? ', пропущено '+skipped+' дублей' : ''}`, 'ok');
}

// Очередь файлов для батч-импорта в модалке. Нужна потому, что OEM-пикеры
// на Android (Huawei Files, MIUI и др.) игнорируют multiple-флаг и берут
// только один файл за раз. Пользователь добавляет по одному, список копится,
// затем жмёт «Импортировать все» — и пачка уходит через importGirboBatch.
let _girboQueue = []; // [File, File, ...]

function girboQueueAdd(input){
  const files = Array.from(input.files || []);
  if(!files.length) return;
  // Папочный выбор (webkitdirectory) отдаёт всё содержимое — фильтруем по
  // расширениям, чтобы не тащить случайные файлы и .DS_Store.
  const ACCEPT_EXT = /\.(xml|csv|txt|tsv)$/i;
  const isDir = input.hasAttribute('webkitdirectory');
  const kept = isDir ? files.filter(f => ACCEPT_EXT.test(f.name || '')) : files;
  const dropped = files.length - kept.length;
  for(const f of kept) _girboQueue.push(f);
  input.value = '';
  _girboQueueRender();
  if(isDir && dropped > 0){
    showToast(`📁 Из папки взято ${kept.length} файлов, пропущено ${dropped} (не CSV/XML/TXT)`, 'info');
  }
}

function girboQueueClear(){
  _girboQueue = [];
  _girboQueueRender();
}

function girboQueueRemove(i){
  _girboQueue.splice(i, 1);
  _girboQueueRender();
}

function _girboQueueRender(){
  const wrap  = document.getElementById('girbo-queue-wrap');
  const cnt   = document.getElementById('girbo-queue-count');
  const list  = document.getElementById('girbo-queue-list');
  if(!wrap || !cnt || !list) return;
  if(!_girboQueue.length){ wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';
  cnt.textContent = String(_girboQueue.length);
  list.innerHTML = _girboQueue.map((f, i) => {
    const nameSafe = f.name.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
    return `<div style="display:flex;align-items:center;gap:6px;padding:2px 0;border-bottom:1px dotted rgba(30,48,72,.35)">
      <span style="color:var(--text3);min-width:1.8em;text-align:right">${i+1}.</span>
      <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${nameSafe}</span>
      <span style="color:var(--text3);font-size:.55rem">${(f.size/1024).toFixed(1)} КБ</span>
      <button onclick="girboQueueRemove(${i})" style="background:none;border:none;color:var(--danger);cursor:pointer;padding:0 4px;font-size:.75rem" title="Убрать">✕</button>
    </div>`;
  }).join('');
}

function girboQueueRun(){
  if(!_girboQueue.length) return;
  const files = _girboQueue.slice();
  _girboQueue = [];
  _girboQueueRender();
  importGirboBatch(files);
}

// Пакетный импорт: читаем файлы последовательно (не параллельно — чтобы не
// плодить гонки за reportsDB и localStorage), показываем прогресс-тост,
// в конце — модалка со сводкой (по эмитентам → какие периоды пришли).
async function importGirboBatch(files){
  const progressToast = showToast(`⏳ ГИРБО · 0 / ${files.length}`, 'info');
  const results = [];
  const auto = { quiet: true, autoOverwrite: true };

  for(let i = 0; i < files.length; i++){
    const f = files[i];
    if(progressToast) progressToast.textContent = `⏳ ГИРБО · ${i+1} / ${files.length} · ${f.name.slice(0,40)}`;
    try {
      const buf = await f.arrayBuffer();
      const res = _processGirboFile(buf, f.name, auto) || { ok:false, error:'без ответа', file:f.name };
      results.push(res);
    } catch(err){
      results.push({ ok:false, file:f.name, error:String(err.message || err).slice(0, 200) });
    }
    // Микропауза, чтобы UI успел отрисовать прогресс.
    await new Promise(r => setTimeout(r, 0));
  }
  if(progressToast) progressToast.remove();

  _showGirboBatchSummary(results);
}

// Сводка батч-импорта: группируем по эмитентам, показываем статус каждого файла.
function _showGirboBatchSummary(results){
  const byIssuer = new Map(); // issName → [{year, filled, missed, overwrote, ok, error}]
  const orphans  = []; // файлы без эмитента (ошибки парсинга)
  for(const r of results){
    if(r.issName){
      const arr = byIssuer.get(r.issName) || [];
      arr.push(r);
      byIssuer.set(r.issName, arr);
    } else {
      orphans.push(r);
    }
  }
  const okCount   = results.filter(r => r.ok).length;
  const failCount = results.length - okCount;

  const lines = [];
  lines.push(`ГИРБО · импорт пачкой`);
  lines.push(`Файлов: ${results.length} · успешно: ${okCount} · с ошибкой: ${failCount}`);
  lines.push('');
  for(const [name, arr] of Array.from(byIssuer.entries()).sort((a,b)=>a[0].localeCompare(b[0]))){
    arr.sort((a,b) => (a.year||0) - (b.year||0));
    const years = arr.map(r => {
      if(!r.ok) return `${r.year||'?'} ✗`;
      const f = r.filled?.length || 0;
      const m = r.missed?.length || 0;
      const mark = r.overwrote ? '↻' : '+';
      return `${r.year} ${mark}${f}/${f+m}`;
    }).join(' · ');
    lines.push(`• ${name}`);
    lines.push(`   ${years}`);
  }
  if(orphans.length){
    lines.push('');
    lines.push(`Не обработано (${orphans.length}):`);
    for(const r of orphans){
      lines.push(`  ✗ ${r.file} — ${r.error || r.skippedReason || 'нераспознано'}`);
    }
  }
  lines.push('');
  lines.push(`Легенда: «+N/12» — добавлен новый период, «↻N/12» — перезаписан, ✗ — пропущен.`);
  alert(lines.join('\n'));
}

// Открыть модалку загрузки ГИРБО (рабочий путь для мобильных:
// сайдбар-пункт скрыт на узких экранах, нужна видимая кнопка).
function openGirboImportModal(){
  const ta = document.getElementById('girbo-paste'); if(ta) ta.value = '';
  const st = document.getElementById('girbo-modal-status'); if(st) st.textContent = '';
  document.getElementById('modal-girbo-import').classList.add('open');
  _initGirboDropZone();
  _girboQueueRender();
}

// Вставить содержимое CSV/XML из textarea. Упаковываем строку в байты
// и гоним через тот же _processGirboFile — автодетект и парсер отработают.
function importGirboFromPaste(){
  const ta = document.getElementById('girbo-paste');
  const raw = ta ? String(ta.value || '') : '';
  if(!raw.trim()){ alert('Пусто — вставьте содержимое CSV или XML.'); return; }
  try {
    const buf = new TextEncoder().encode(raw).buffer;
    const guessed = raw.trimStart().startsWith('<') ? 'pasted.xml' : 'pasted.csv';
    _processGirboFile(buf, guessed);
  } catch(err){
    alert('Ошибка обработки вставленного текста: ' + err.message);
  }
}

// Drag-and-drop навешиваем один раз на div-зону внутри модалки.
let _girboDropInit = false;
function _initGirboDropZone(){
  if(_girboDropInit) return;
  const drop = document.getElementById('girbo-drop');
  if(!drop) return;
  _girboDropInit = true;
  const setHover = on => { drop.style.borderColor = on ? 'var(--acc)' : 'var(--border2)'; };
  ['dragenter','dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); setHover(true); }));
  ['dragleave'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); setHover(false); }));
  drop.addEventListener('drop', e => {
    e.preventDefault(); e.stopPropagation(); setHover(false);
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    if(!files.length){ alert('Не удалось получить файл из drop.'); return; }
    // В модалке всё идёт через очередь — и для тапа-пикера, и для drag-and-drop.
    // Пользователь увидит список и жмёт «Импортировать все» сам.
    for(const f of files) _girboQueue.push(f);
    _girboQueueRender();
  });
}

// Merge-импорт: добавляет новое, не трогая то, что уже есть.
// Идентификация: для массивов — по естественному ключу (имя и т.п.);
// для reportsDB — по name эмитента, т.к. id случайные и в разных
// экспортах не совпадают. Для периодов: ключ {year}_{period}_{type}.
function mergeImportedData(d){
  if(Array.isArray(d.ytmBonds)){
    const have = new Set(ytmBonds.map(b => (b && b.name) || ''));
    d.ytmBonds.forEach(b => { if(b && b.name && !have.has(b.name)){ ytmBonds.push(b); have.add(b.name); } });
  }
  if(Array.isArray(d.portfolio)){
    const key = p => ((p && p.id) || '') + '|' + ((p && p.name) || '');
    const have = new Set(portfolio.map(key));
    d.portfolio.forEach(p => { const k=key(p); if(!have.has(k)){ portfolio.push(p); have.add(k); } });
  }
  if(d.watchlists && typeof d.watchlists === 'object'){
    for(const [name, list] of Object.entries(d.watchlists)){
      if(!watchlists[name]){
        watchlists[name] = list;
      } else if(Array.isArray(list) && Array.isArray(watchlists[name])){
        const have = new Set(watchlists[name].map(x => JSON.stringify(x)));
        list.forEach(item => {
          const k = JSON.stringify(item);
          if(!have.has(k)){ watchlists[name].push(item); have.add(k); }
        });
      }
    }
  }
  if(Array.isArray(d.calEvents)){
    const key = ev => ((ev && ev.date) || '') + '|' + ((ev && ev.bond) || '') + '|' + ((ev && ev.text) || '') + '|' + ((ev && ev.type) || '');
    const have = new Set(calEvents.map(key));
    d.calEvents.forEach(ev => { const k=key(ev); if(!have.has(k)){ calEvents.push(ev); have.add(k); } });
  }
  if(d.reportsDB && typeof d.reportsDB === 'object'){
    const byName = {};
    Object.entries(reportsDB).forEach(([id, iss]) => { if(iss && iss.name) byName[iss.name] = id; });
    Object.entries(d.reportsDB).forEach(([impId, impIss]) => {
      if(!impIss || !impIss.name) return;
      let targetId = byName[impIss.name];
      if(!targetId){
        let id = impId && !reportsDB[impId] ? impId : ('iss_imp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,7));
        let n = 0; while(reportsDB[id]){ id = (impId||'iss_imp') + '_' + (++n); }
        reportsDB[id] = impIss;
        byName[impIss.name] = id;
      } else {
        const cur = reportsDB[targetId];
        if(!cur.periods) cur.periods = {};
        if(impIss.periods && typeof impIss.periods === 'object'){
          Object.entries(impIss.periods).forEach(([k, period]) => {
            if(!cur.periods[k]) cur.periods[k] = period;
          });
        }
        if(!cur.ind && impIss.ind) cur.ind = impIss.ind;
        if(!cur.note && impIss.note) cur.note = impIss.note;
        // Идентификаторы/ссылки/рейтинг: из импорта только если у текущего пусто
        ['isin','inn','ogrn','disclosureUrl','rating'].forEach(k => {
          if(!cur[k] && impIss[k]) cur[k] = impIss[k];
        });
      }
    });
  }
}

// Обработчик периода "другой"
document.getElementById('is-rep-period')?.addEventListener('change', function() {
  const wrap = document.getElementById('is-rep-period-custom-wrap');
  if(wrap) wrap.style.display = this.value==='custom'?'block':'none';
});

// ══ GITHUB GIST SYNC ══
const GIST_FILENAME = 'bondanalytics_data.json';

// Плавающее меню ⚡ в правом нижнем углу — дублирует кнопки
// из правой части топбара, чтобы они были доступны даже когда
// топбар уезжает за экран на узких устройствах.
function fabToggle(state){
  const el = document.getElementById('fab-menu');
  if(!el) return;
  const open = typeof state === 'boolean' ? state : !el.classList.contains('open');
  el.classList.toggle('open', open);
}
// Клик вне FAB — закрыть меню.
document.addEventListener('click', (e) => {
  const fab = document.getElementById('fab-menu');
  if(!fab || !fab.classList.contains('open')) return;
  if(!fab.contains(e.target)) fab.classList.remove('open');
});

function openGistModal() {
  // Восстанавливаем сохранённые значения
  const t = localStorage.getItem('ba_gist_token');
  const id = localStorage.getItem('ba_gist_id');
  if(t) document.getElementById('gist-token').value = t;
  if(id) document.getElementById('gist-id').value = id;
  // Код синхронизации (альтернатива без GitHub).
  const syncCode = localStorage.getItem('ba_sync_code');
  const syncInput = document.getElementById('sync-code');
  if(syncInput && syncCode) syncInput.value = syncCode;
  // URL прокси для ГИР БО.
  const proxyVal = localStorage.getItem('bondan_girbo_proxy') || 'https://corsproxy.io/?';
  const proxyInput = document.getElementById('girbo-proxy');
  if(proxyInput) proxyInput.value = proxyVal;
  document.getElementById('gist-status').style.display = 'none';
  const syncStatus = document.getElementById('sync-cloud-status');
  if(syncStatus) syncStatus.style.display = 'none';
  document.getElementById('modal-gist').classList.add('open');
}

// ══════════════════════════════════════════════════════════════════
// АНОНИМНАЯ СИНХРОНИЗАЦИЯ БЕЗ GITHUB
// ══════════════════════════════════════════════════════════════════
// Пользовательский запрос: «на ноутбуке другой аккаунт, переключения
// между GitHub-аккаунтами приводят к странным багам». Нужен способ
// синхронизации, не связанный с GitHub-логином.
//
// Решение: анонимный зашифрованный blob на jsonblob.com.
//  • POST без авторизации создаёт blob, возвращает UUID;
//  • данные шифруются AES-256-GCM в браузере ПЕРЕД отправкой;
//  • ключ шифрования генерируется clientside и попадает только в
//    «код синхронизации» `UUID:ключ_b64`, который пользователь сам
//    переносит между устройствами (копипастом или QR).
//  • сервер видит только непрозрачные байты — сервис jsonblob.com
//    не знает содержимого; если blob утечёт, без ключа он бесполезен.
//
// Этот механизм полностью независим от Gist — в модалке «⚡ Sync»
// оба блока сосуществуют; пользователь выбирает удобный.

const _JSONBLOB_BASE = 'https://jsonblob.com/api/jsonBlob';
const _b64enc = b => btoa(String.fromCharCode(...new Uint8Array(b)));
const _b64dec = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function _syncEncrypt(text, keyB64){
  const key = await crypto.subtle.importKey('raw', _b64dec(keyB64),
    {name:'AES-GCM', length:256}, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({name:'AES-GCM', iv}, key,
    new TextEncoder().encode(text));
  return {v:1, iv: _b64enc(iv), data: _b64enc(new Uint8Array(ct))};
}

async function _syncDecrypt(payload, keyB64){
  if(!payload || payload.v !== 1) throw new Error('Неизвестный формат blob');
  const key = await crypto.subtle.importKey('raw', _b64dec(keyB64),
    {name:'AES-GCM', length:256}, false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({name:'AES-GCM', iv: _b64dec(payload.iv)},
    key, _b64dec(payload.data));
  return new TextDecoder().decode(pt);
}

function _syncCloudStatus(msg, color){
  const el = document.getElementById('sync-cloud-status');
  if(!el) return;
  el.style.display = 'block';
  el.style.color = color || 'var(--text2)';
  el.textContent = msg;
}

// Применить industry-часть полученного снапшота (используется в трёх
// ветвях загрузки: Gist, cloud (шифрованный blob), offline-код / файл).
function _applyIndustryFromSnapshot(d){
  if(d.industryPeers && typeof d.industryPeers === 'object'){
    try {
      localStorage.setItem('bondan_industry_peers', JSON.stringify(d.industryPeers));
      window._industryData = null; // перечитаем при следующем indRender
    } catch(e){}
  }
  if(d.industryMedians && typeof d.industryMedians === 'object'){
    try {
      localStorage.setItem('bondan_industry_medians', JSON.stringify(d.industryMedians));
      window._industryMedians = d.industryMedians;
    } catch(e){}
  }
  if(d.girboProxy){
    try { localStorage.setItem('bondan_girbo_proxy', d.girboProxy); } catch(e){}
    const el = document.getElementById('girbo-proxy');
    if(el) el.value = d.girboProxy;
  }
  // schemaVersion 5: Росстат/ФНС ROS/ROA по отраслям.
  if(d.rosstatRatios && typeof d.rosstatRatios === 'object'){
    try {
      localStorage.setItem('bondan_rosstat_ratios', JSON.stringify(d.rosstatRatios));
      window._rosstatRatios = d.rosstatRatios;
    } catch(e){}
  }
}

function _syncBuildSnapshot(){
  let refs = [], industryPeers = null, industryMedians = null, rosstatRatios = null;
  try { refs = JSON.parse(localStorage.getItem('bondan_refs') || '[]'); } catch(e){}
  try { industryPeers = JSON.parse(localStorage.getItem('bondan_industry_peers') || 'null'); } catch(e){}
  try { industryMedians = JSON.parse(localStorage.getItem('bondan_industry_medians') || 'null'); } catch(e){}
  try { rosstatRatios = JSON.parse(localStorage.getItem('bondan_rosstat_ratios') || 'null'); } catch(e){}
  return {
    ytmBonds, portfolio, watchlists, calEvents, reportsDB,
    refs,
    industryPeers,
    industryMedians,
    rosstatRatios,
    girboProxy: localStorage.getItem('bondan_girbo_proxy') || '',
    apiKey: localStorage.getItem('ba_apikey') || '',
    meta: {schemaVersion: 6}, // v6: reportsDB[id].dossier + .issues (досье эмитента + паспорта выпусков)
    savedAt: new Date().toISOString()
  };
}

async function syncMakeCode(){
  _syncCloudStatus('Создаю шифрованный blob…', 'var(--warn)');
  try {
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    const keyB64 = _b64enc(keyBytes);
    const resp = await fetch(_JSONBLOB_BASE, {
      method: 'POST',
      headers: {'Content-Type':'application/json','Accept':'application/json'},
      body: '{}'
    });
    if(!resp.ok) throw new Error('HTTP ' + resp.status);
    let id = resp.headers.get('X-jsonblob-id');
    if(!id){
      const loc = resp.headers.get('Location') || '';
      id = loc.split('/').pop();
    }
    if(!id) throw new Error('Сервис не вернул ID blob');
    const code = id + ':' + keyB64;
    const input = document.getElementById('sync-code');
    if(input) input.value = code;
    try { localStorage.setItem('ba_sync_code', code); } catch(e){}
    _syncCloudStatus('✅ Код создан. Нажмите ⬆️ Сохранить, чтобы залить текущие данные, и скопируйте код (или QR) на другое устройство.', 'var(--green)');
  } catch(e){
    _syncCloudStatus('❌ Ошибка создания: ' + e.message, 'var(--danger)');
  }
}

async function syncCloudSave(){
  const code = document.getElementById('sync-code')?.value?.trim();
  if(!code || !code.includes(':')){
    _syncCloudStatus('⚠️ Сначала создайте код (🆕) или введите существующий.', 'var(--warn)');
    return;
  }
  const idx = code.indexOf(':');
  const id = code.slice(0, idx), keyB64 = code.slice(idx + 1);
  const btn = document.getElementById('sync-save-btn');
  if(btn){ btn.disabled = true; btn.textContent = '⏳ Сохраняю…'; }
  _syncCloudStatus('Шифрую и отправляю…', 'var(--warn)');
  try {
    const snapshot = _syncBuildSnapshot();
    const payload = await _syncEncrypt(JSON.stringify(snapshot), keyB64);
    const resp = await fetch(_JSONBLOB_BASE + '/' + encodeURIComponent(id), {
      method: 'PUT',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    if(!resp.ok) throw new Error('HTTP ' + resp.status);
    try { localStorage.setItem('ba_sync_code', code); } catch(e){}
    _syncCloudStatus('✅ Сохранено · ' + new Date().toLocaleString('ru-RU'), 'var(--green)');
  } catch(e){
    _syncCloudStatus('❌ Ошибка сохранения: ' + e.message, 'var(--danger)');
  } finally {
    if(btn){ btn.disabled = false; btn.textContent = '⬆️ Сохранить'; }
  }
}

async function syncCloudLoad(){
  const code = document.getElementById('sync-code')?.value?.trim();
  if(!code || !code.includes(':')){
    _syncCloudStatus('⚠️ Введите код синхронизации (скопируйте с другого устройства).', 'var(--warn)');
    return;
  }
  const idx = code.indexOf(':');
  const id = code.slice(0, idx), keyB64 = code.slice(idx + 1);
  const btn = document.getElementById('sync-load-btn');
  if(btn){ btn.disabled = true; btn.textContent = '⏳ Загружаю…'; }
  _syncCloudStatus('Скачиваю и расшифровываю…', 'var(--warn)');
  try {
    const resp = await fetch(_JSONBLOB_BASE + '/' + encodeURIComponent(id));
    if(!resp.ok) throw new Error('HTTP ' + resp.status);
    const payload = await resp.json();
    const plain = await _syncDecrypt(payload, keyB64);
    const d = JSON.parse(plain);
    const savedAt = d.savedAt ? new Date(d.savedAt).toLocaleString('ru-RU') : 'неизвестно';
    const refsCount = Array.isArray(d.refs) ? d.refs.length : 0;
    if(!confirm(`Загрузить снапшот от ${savedAt}?\n\nЭталонов в нём: ${refsCount}\n\nПортфель, watchlist, календарь, reportsDB и AI-ключ будут заменены. Эталоны будут ОБЪЕДИНЕНЫ с локальными (облачные перезаписывают одноимённые).`)){
      _syncCloudStatus('Отменено', 'var(--text3)');
      return;
    }
    if(d.ytmBonds)   ytmBonds   = d.ytmBonds;
    if(d.portfolio)  portfolio  = d.portfolio;
    if(d.watchlists) watchlists = d.watchlists;
    if(d.calEvents)  calEvents  = d.calEvents;
    if(d.reportsDB)  reportsDB  = d.reportsDB;
    if(Array.isArray(d.refs) && d.refs.length){
      try {
        const local = JSON.parse(localStorage.getItem('bondan_refs') || '[]');
        const keyOf = r => (r.inn || '') + '|' + _normalisePeriod(r.period);
        const merged = new Map();
        for(const r of local) merged.set(keyOf(r), r);
        for(const r of d.refs) merged.set(keyOf(r), r);
        const arr = [...merged.values()];
        localStorage.setItem('bondan_refs', JSON.stringify(arr));
        if(window._refCatalogue) window._refCatalogue.localEntries = arr;
      } catch(e){}
    }
    if(d.apiKey){
      localStorage.setItem('ba_apikey', d.apiKey);
      const apiInput = document.getElementById('api-key-input');
      if(apiInput) apiInput.value = d.apiKey;
    }
    _applyIndustryFromSnapshot(d);
    save();
    try { localStorage.setItem('ba_sync_code', code); } catch(e){}
    renderYtm(); renderPort(); renderSbLists();
    document.getElementById('sb-pc').textContent = portfolio.length;
    const repEl = document.getElementById('sb-rep');
    if(repEl) repEl.textContent = Object.keys(reportsDB).length;
    _syncCloudStatus(`✅ Загружено. Эталонов: ${refsCount}`, 'var(--green)');
  } catch(e){
    const msg = /Cipher|invalid|decrypt/i.test(e.message || e)
      ? '❌ Не удалось расшифровать. Проверьте код — он должен быть в точности как на первом устройстве.'
      : '❌ Ошибка: ' + (e.message || e);
    _syncCloudStatus(msg, 'var(--danger)');
  } finally {
    if(btn){ btn.disabled = false; btn.textContent = '⬇️ Загрузить'; }
  }
}

function syncShowQR(){
  const code = document.getElementById('sync-code')?.value?.trim();
  if(!code){
    alert('Сначала создайте код (🆕) или введите существующий.');
    return;
  }
  const pop = document.getElementById('sync-qr-popup');
  const img = document.getElementById('sync-qr-img');
  const txt = document.getElementById('sync-qr-text');
  if(img) img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=360x360&margin=4&data=' + encodeURIComponent(code);
  if(txt) txt.textContent = code;
  if(pop){ pop.style.display = 'flex'; }
}

// ══════════════════════════════════════════════════════════════════
// ОФЛАЙН-КОД — синхронизация без сервера и без сети
// ══════════════════════════════════════════════════════════════════
// Используется когда «Код синхронизации» через jsonblob.com не
// работает (корпоративный firewall, блокирующее расширение в
// браузере, «Failed to fetch» и т.п.). Идея: сам снапшот пакуется в
// gzip+base64 строку, которая копируется между устройствами любым
// способом (Telegram Saved Messages, e-mail себе, AirDrop, заметки).
// Никаких внешних сервисов, никаких fetch'ей — работает всегда.

function _offlineStatus(msg, color){
  const el = document.getElementById('offline-status');
  if(!el) return;
  el.style.display = 'block';
  el.style.color = color || 'var(--text2)';
  el.textContent = msg;
}

async function _gzipB64(text){
  try {
    const stream = new Response(new TextEncoder().encode(text)).body
      .pipeThrough(new CompressionStream('gzip'));
    const buf = await new Response(stream).arrayBuffer();
    const bytes = new Uint8Array(buf);
    // Chrome 80+/Firefox 113+/Safari 16.4+ поддерживают CompressionStream;
    // на старых браузерах fallback на простой base64 без сжатия.
    let s = '';
    for(let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return 'gz:' + btoa(s);
  } catch(e){
    return 'b:' + btoa(unescape(encodeURIComponent(text)));
  }
}

async function _ungzipB64(code){
  if(code.startsWith('gz:')){
    const bytes = _b64dec(code.slice(3));
    const stream = new Response(bytes).body.pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).text();
  }
  if(code.startsWith('b:')){
    return decodeURIComponent(escape(atob(code.slice(2))));
  }
  // Попытка auto-detect: мог быть просто чистый JSON или base64 без префикса.
  try { return decodeURIComponent(escape(atob(code))); } catch(e){}
  return code;
}

async function offlineMakeCode(){
  try {
    const snapshot = _syncBuildSnapshot();
    const json = JSON.stringify(snapshot);
    const code = await _gzipB64(json);
    const ta = document.getElementById('offline-code');
    if(ta) ta.value = code;
    const ratio = (code.length / json.length * 100).toFixed(0);
    _offlineStatus(`✅ Собрано: ${(code.length/1024).toFixed(1)} КБ (сжатие ${ratio}% от оригинала). Нажмите «📋 Скопировать» и вставьте строку на другом устройстве в это же поле → «📥 Применить».`, 'var(--green)');
  } catch(e){
    _offlineStatus('❌ Ошибка сборки: ' + (e.message || e), 'var(--danger)');
  }
}

async function _offlineApplySnapshot(d, source){
  const savedAt = d.savedAt ? new Date(d.savedAt).toLocaleString('ru-RU') : 'неизвестно';
  const refsCount = Array.isArray(d.refs) ? d.refs.length : 0;
  if(!confirm(`${source}: снапшот от ${savedAt}\n\nЭталонов: ${refsCount}\n\nПортфель, watchlist, календарь, reportsDB и AI-ключ будут заменены. Эталоны сверки будут объединены с локальными.`)){
    _offlineStatus('Отменено', 'var(--text3)');
    return false;
  }
  if(d.ytmBonds)   ytmBonds   = d.ytmBonds;
  if(d.portfolio)  portfolio  = d.portfolio;
  if(d.watchlists) watchlists = d.watchlists;
  if(d.calEvents)  calEvents  = d.calEvents;
  if(d.reportsDB)  reportsDB  = d.reportsDB;
  if(Array.isArray(d.refs) && d.refs.length){
    try {
      const local = JSON.parse(localStorage.getItem('bondan_refs') || '[]');
      const keyOf = r => (r.inn || '') + '|' + _normalisePeriod(r.period);
      const merged = new Map();
      for(const r of local) merged.set(keyOf(r), r);
      for(const r of d.refs) merged.set(keyOf(r), r);
      const arr = [...merged.values()];
      localStorage.setItem('bondan_refs', JSON.stringify(arr));
      if(window._refCatalogue) window._refCatalogue.localEntries = arr;
    } catch(e){}
  }
  if(d.apiKey){
    localStorage.setItem('ba_apikey', d.apiKey);
    const apiInput = document.getElementById('api-key-input');
    if(apiInput) apiInput.value = d.apiKey;
  }
  _applyIndustryFromSnapshot(d);
  save();
  renderYtm(); renderPort(); renderSbLists();
  document.getElementById('sb-pc').textContent = portfolio.length;
  const repEl = document.getElementById('sb-rep');
  if(repEl) repEl.textContent = Object.keys(reportsDB).length;
  _offlineStatus(`✅ Применено. Эталонов: ${refsCount}.`, 'var(--green)');
  return true;
}

async function offlineApplyCode(){
  const ta = document.getElementById('offline-code');
  if(!ta) return;
  const code = ta.value.trim();
  if(!code){
    _offlineStatus('⚠️ Сначала вставьте код в textarea.', 'var(--warn)');
    return;
  }
  try {
    const plain = await _ungzipB64(code);
    const d = JSON.parse(plain);
    await _offlineApplySnapshot(d, 'Офлайн-код');
  } catch(e){
    _offlineStatus('❌ Не удалось распаковать: ' + (e.message || e) + '. Возможно, код обрезан при копировании — скопируйте заново полностью.', 'var(--danger)');
  }
}

async function offlineCopyCode(){
  const ta = document.getElementById('offline-code');
  if(!ta) return;
  const code = ta.value;
  if(!code){ _offlineStatus('⚠️ Сначала нажмите «🧳 Собрать».', 'var(--warn)'); return; }
  try {
    await navigator.clipboard.writeText(code);
    _offlineStatus('✅ Скопировано в буфер обмена.', 'var(--green)');
  } catch(e){
    ta.select();
    try { document.execCommand('copy'); _offlineStatus('✅ Скопировано (fallback).', 'var(--green)'); }
    catch(_){ _offlineStatus('Выделите текст в textarea и скопируйте вручную (Ctrl+C).', 'var(--warn)'); }
  }
}

function offlineDownloadFile(){
  const snapshot = _syncBuildSnapshot();
  const json = JSON.stringify(snapshot, null, 2);
  const blob = new Blob([json], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'bondan-snapshot-' + new Date().toISOString().slice(0,16).replace(/[T:]/g,'-') + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  _offlineStatus('✅ Снапшот сохранён. Перенесите файл на другое устройство и загрузите кнопкой «📂 Из файла».', 'var(--green)');
}

function offlineLoadFile(input){
  const f = input.files[0];
  if(!f) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const d = JSON.parse(reader.result);
      await _offlineApplySnapshot(d, 'Файл ' + f.name);
    } catch(e){
      _offlineStatus('❌ Ошибка чтения файла: ' + (e.message || e), 'var(--danger)');
    }
  };
  reader.readAsText(f);
  input.value = '';
}

function gistStatus(msg, color='var(--text2)') {
  const el = document.getElementById('gist-status');
  el.style.display = 'block';
  el.style.color = color;
  el.style.borderColor = color;
  el.textContent = msg;
}

async function gistSave() {
  const token = document.getElementById('gist-token').value.trim();
  const gistId = document.getElementById('gist-id').value.trim();
  if(!token) { gistStatus('⚠️ Введите GitHub Token', 'var(--warn)'); return; }

  const btn = document.getElementById('gist-save-btn');
  btn.disabled = true; btn.textContent = '⏳ Сохраняю...';
  gistStatus('Отправляю данные...', 'var(--warn)');

  // Снапшот для Gist. Помимо основных данных БондАналитика (портфель,
  // watchlist, календарь, reportsDB), кладём:
  //  • refs — эталоны сверки отчётов (localStorage['bondan_refs']);
  //  • apiKey — ключ AI-анализа (чтобы не вводить заново);
  //  • meta.version — версия схемы на случай будущих миграций.
  // UI-флаги (показан ли pane, включена ли маска) НЕ синхронизируем —
  // это device-specific.
  let refs = [];
  try { refs = JSON.parse(localStorage.getItem('bondan_refs') || '[]'); } catch(e){}
  const apiKey = localStorage.getItem('ba_apikey') || '';
  const content = JSON.stringify({
    ytmBonds, portfolio, watchlists, calEvents, reportsDB,
    refs,
    apiKey,
    meta: { schemaVersion: 3 },
    savedAt: new Date().toISOString()
  }, null, 2);

  try {
    let url, method;
    if(gistId) {
      url = `https://api.github.com/gists/${gistId}`;
      method = 'PATCH';
    } else {
      url = 'https://api.github.com/gists';
      method = 'POST';
    }

    const resp = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        description: 'БондАналитик — данные синхронизации',
        public: false,
        files: { [GIST_FILENAME]: { content } }
      })
    });

    if(!resp.ok) {
      const err = await resp.json().catch(()=>({}));
      throw new Error(err.message || `HTTP ${resp.status}`);
    }

    const data = await resp.json();
    const newId = data.id;

    // Сохраняем ID если новый
    if(!gistId && newId) {
      localStorage.setItem('ba_gist_id', newId);
      document.getElementById('gist-id').value = newId;
    }

    gistStatus(`✅ Сохранено! Gist ID: ${newId || gistId}`, 'var(--green)');
  } catch(e) {
    gistStatus(`❌ Ошибка: ${e.message}`, 'var(--danger)');
  } finally {
    btn.disabled = false; btn.textContent = '⬆️ Сохранить в Gist';
  }
}

async function gistLoad() {
  const token = document.getElementById('gist-token').value.trim();
  const gistId = document.getElementById('gist-id').value.trim();
  if(!token) { gistStatus('⚠️ Введите GitHub Token', 'var(--warn)'); return; }
  if(!gistId) { gistStatus('⚠️ Введите Gist ID', 'var(--warn)'); return; }

  const btn = document.getElementById('gist-load-btn');
  btn.disabled = true; btn.textContent = '⏳ Загружаю...';
  gistStatus('Загружаю данные...', 'var(--warn)');

  try {
    const resp = await fetch(`https://api.github.com/gists/${gistId}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
      }
    });

    if(!resp.ok) {
      const err = await resp.json().catch(()=>({}));
      throw new Error(err.message || `HTTP ${resp.status}`);
    }

    const gist = await resp.json();
    const fileContent = gist.files?.[GIST_FILENAME]?.content;
    if(!fileContent) throw new Error(`Файл ${GIST_FILENAME} не найден в Gist`);

    const d = JSON.parse(fileContent);
    const savedAt = d.savedAt ? new Date(d.savedAt).toLocaleString('ru-RU') : 'неизвестно';

    if(!confirm(`Загрузить данные из Gist?\nДата сохранения: ${savedAt}\n\nЭто заменит текущие локальные данные.`)) {
      gistStatus('Отменено', 'var(--text3)');
      return;
    }

    if(d.ytmBonds)   ytmBonds   = d.ytmBonds;
    if(d.portfolio)  portfolio  = d.portfolio;
    if(d.watchlists) watchlists = d.watchlists;
    if(d.calEvents)  calEvents  = d.calEvents;
    if(d.reportsDB)  reportsDB  = d.reportsDB;
    // Эталоны сверки — сливаем с локальными по ключу «ИНН+период»,
    // записи из gist перезаписывают локальные (приоритет облаку).
    if(Array.isArray(d.refs) && d.refs.length){
      try {
        const local = JSON.parse(localStorage.getItem('bondan_refs') || '[]');
        const keyOf = r => (r.inn || '') + '|' + _normalisePeriod(r.period);
        const merged = new Map();
        for(const r of local) merged.set(keyOf(r), r);
        for(const r of d.refs) merged.set(keyOf(r), r);
        const arr = [...merged.values()];
        localStorage.setItem('bondan_refs', JSON.stringify(arr));
        if(window._refCatalogue) window._refCatalogue.localEntries = arr;
      } catch(e){}
    }
    // API-ключ — если в gist есть, подставим и обновим поле ввода.
    if(d.apiKey){
      localStorage.setItem('ba_apikey', d.apiKey);
      const apiInput = document.getElementById('api-key-input');
      if(apiInput) apiInput.value = d.apiKey;
    }
    _applyIndustryFromSnapshot(d);
    save();

    renderYtm(); renderPort(); renderSbLists();
    document.getElementById('sb-pc').textContent = portfolio.length;
    const repEl = document.getElementById('sb-rep');
    if(repEl) repEl.textContent = Object.keys(reportsDB).length;

    const refsCount = Array.isArray(d.refs) ? d.refs.length : 0;
    const extras = refsCount ? ` · эталонов: ${refsCount}` : '';
    gistStatus(`✅ Загружено! Данные от ${savedAt}${extras}`, 'var(--green)');
  } catch(e) {
    gistStatus(`❌ Ошибка: ${e.message}`, 'var(--danger)');
  } finally {
    btn.disabled = false; btn.textContent = '⬇️ Загрузить с Gist';
  }
}

// ═════════════════════════════════════════════════════════════════════
// ДОСЬЕ ЭМИТЕНТА — анкета в духе методологии рейтинговых агентств
// ─────────────────────────────────────────────────────────────────────
// Структура: reportsDB[id].dossier = {biz, mod, updatedAt} + .issues = {ISIN→...}
// Вкладка A (финансы) — считается на лету из последнего FY периода,
//   не хранится (иначе надо пересчитывать при каждой правке отчётности).
// Вкладки B, C — ручной ввод, сохраняется в dossier.
// Вкладка D — малые паспорта выпусков (опционально). В Подходе 3
//   заполнится автоматом из MOEX ISS.
// ═════════════════════════════════════════════════════════════════════

// Подсказки «📖 Где брать» реализованы через простой click на иконке —
// показываем alert с текстом из data-hint. Tooltip не используем, так
// как на мобильном hover не работает, а alert одинаково хорош везде.
document.addEventListener('click', (e) => {
  const h = e.target.closest('.dossier-hint');
  if(!h) return;
  e.preventDefault(); e.stopPropagation();
  alert('📖 Где брать:\n\n' + (h.dataset.hint || ''));
});

function dossierTab(name){
  ['fin','biz','mod','iss'].forEach(t => {
    const pane = document.getElementById('dossier-tab-'+t);
    const btn = document.querySelector('.dossier-tab-btn[data-dt="'+t+'"]');
    if(pane) pane.style.display = (t === name) ? '' : 'none';
    if(btn){
      btn.classList.toggle('active', t === name);
      btn.style.borderBottomColor = (t === name) ? 'var(--acc)' : 'transparent';
    }
  });
  if(name === 'fin') _dossierRenderFin();
  if(name === 'iss') _dossierRenderIssues();
}

function dossierOpen(){
  if(!repActiveIssuerId){ alert('Сначала выберите эмитента'); return; }
  const iss = reportsDB[repActiveIssuerId];
  if(!iss) return;
  // Имя + дата обновления.
  document.getElementById('dossier-issuer-name').textContent = iss.name || '—';
  const upd = iss.dossier?.updatedAt;
  document.getElementById('dossier-updated').textContent = upd
    ? 'Обновлено: ' + new Date(upd).toLocaleDateString('ru-RU')
    : 'Досье ещё не заполнено';
  // Заполняем поля B и C из iss.dossier.
  const d = iss.dossier || {};
  const biz = d.biz || {};
  const mod = d.mod || {};
  _dossierSetVals({
    'dos-biz-marketPosition':biz.marketPosition || '',
    'dos-biz-segments':      biz.segments || '',
    'dos-biz-clientsTop3':   biz.clientsTop3,
    'dos-biz-suppliersTop3': biz.suppliersTop3,
    'dos-biz-geoDiv':        biz.geoDiv || '',
    'dos-biz-exportShare':   biz.exportShare,
    'dos-biz-cyclicality':   biz.cyclicality || '',
    'dos-biz-barriers':      biz.barriers || '',
    'dos-biz-regDependency': biz.regDependency || '',
    'dos-biz-capexIntensity':biz.capexIntensity || '',
    'dos-biz-seasonality':   biz.seasonality || '',
    'dos-biz-currencyRisk':  biz.currencyRisk || '',
    'dos-biz-notes':         biz.notes || '',
    'dos-mod-auditor':       mod.auditor || '',
    'dos-mod-disclosureFreq':mod.disclosureFreq || '',
    'dos-mod-stateSupport':  mod.stateSupport || '',
    'dos-mod-ownership':     mod.ownership || '',
    'dos-mod-rating':        mod.rating || '',
    'dos-mod-defaultHistory':mod.defaultHistory || '',
    'dos-mod-shortDebtShare':mod.shortDebtShare,
    'dos-mod-refinanceRisk': mod.refinanceRisk || '',
    'dos-mod-covenants':     mod.covenants || '',
    'dos-mod-subordination': mod.subordination || '',
    'dos-mod-notes':         mod.notes || '',
  });
  // Счётчик выпусков.
  const issCount = Object.keys(iss.issues || {}).length;
  document.getElementById('dossier-iss-count').textContent = issCount ? '('+issCount+')' : '';
  // Открываем на вкладке A по умолчанию.
  dossierTab('fin');
  document.getElementById('modal-dossier').classList.add('open');
}

function _dossierSetVals(map){
  for(const [id, v] of Object.entries(map)){
    const el = document.getElementById(id);
    if(!el) continue;
    el.value = (v == null || v === '') ? '' : v;
  }
}

function _dossierGetVal(id){
  const el = document.getElementById(id);
  if(!el) return '';
  const v = el.value.trim();
  return v === '' ? '' : v;
}
function _dossierGetNum(id){
  const v = _dossierGetVal(id);
  if(v === '') return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

function dossierSave(){
  if(!repActiveIssuerId) return;
  const iss = reportsDB[repActiveIssuerId];
  if(!iss) return;
  iss.dossier = {
    biz: {
      marketPosition: _dossierGetVal('dos-biz-marketPosition'),
      segments:       _dossierGetVal('dos-biz-segments'),
      clientsTop3:    _dossierGetNum('dos-biz-clientsTop3'),
      suppliersTop3:  _dossierGetNum('dos-biz-suppliersTop3'),
      geoDiv:         _dossierGetVal('dos-biz-geoDiv'),
      exportShare:    _dossierGetNum('dos-biz-exportShare'),
      cyclicality:    _dossierGetVal('dos-biz-cyclicality'),
      barriers:       _dossierGetVal('dos-biz-barriers'),
      regDependency:  _dossierGetVal('dos-biz-regDependency'),
      capexIntensity: _dossierGetVal('dos-biz-capexIntensity'),
      seasonality:    _dossierGetVal('dos-biz-seasonality'),
      currencyRisk:   _dossierGetVal('dos-biz-currencyRisk'),
      notes:          _dossierGetVal('dos-biz-notes'),
    },
    mod: {
      auditor:         _dossierGetVal('dos-mod-auditor'),
      disclosureFreq:  _dossierGetVal('dos-mod-disclosureFreq'),
      stateSupport:    _dossierGetVal('dos-mod-stateSupport'),
      ownership:       _dossierGetVal('dos-mod-ownership'),
      rating:          _dossierGetVal('dos-mod-rating'),
      defaultHistory:  _dossierGetVal('dos-mod-defaultHistory'),
      shortDebtShare:  _dossierGetNum('dos-mod-shortDebtShare'),
      refinanceRisk:   _dossierGetVal('dos-mod-refinanceRisk'),
      covenants:       _dossierGetVal('dos-mod-covenants'),
      subordination:   _dossierGetVal('dos-mod-subordination'),
      notes:           _dossierGetVal('dos-mod-notes'),
    },
    updatedAt: new Date().toISOString()
  };
  save();
  document.getElementById('dossier-updated').textContent = 'Обновлено: ' + new Date().toLocaleDateString('ru-RU');
  // Лёгкая визуальная подтверждашка.
  const btn = document.querySelector('#modal-dossier .modal-ftr .btn-p');
  if(btn){
    const prev = btn.textContent;
    btn.textContent = '✓ Сохранено';
    setTimeout(() => { btn.textContent = prev; }, 1400);
  }
}

// ───────── Финансовый профиль (авто из reportsDB) ─────────

// Находит самый свежий период с данными — предпочтение FY, потом 9M/H1/Q1.
function _dossierLatestPeriod(iss){
  if(!iss || !iss.periods) return null;
  const entries = Object.entries(iss.periods).filter(([k, p]) => p && p.year);
  if(!entries.length) return null;
  entries.sort((a, b) => {
    const [ka, pa] = a, [kb, pb] = b;
    const ya = parseInt(pa.year, 10), yb = parseInt(pb.year, 10);
    if(yb !== ya) return yb - ya;
    // FY важнее квартальных при равном году.
    const rank = p => /год|FY|year/i.test(p.period || 'FY') ? 0
                    : /9М|9M/i.test(p.period || '') ? 1
                    : /H1|Полугод/i.test(p.period || '') ? 2 : 3;
    return rank(pa) - rank(pb);
  });
  return { key: entries[0][0], data: entries[0][1] };
}

// Вердикт для метрики: сравниваем с отраслевой медианой если есть,
// иначе — с жёсткими порогами bond-инвестора (консервативными).
// dir = 'up' значит «больше = лучше», 'down' значит «меньше = лучше».
function _dossierVerdict(val, dir, hardThresholds, medianTriple){
  if(val == null || !isFinite(val)) return {cls:'nd', txt:'—'};
  // 1. Сравнение с отраслевой медианой (квартили p25/p50/p75), если есть.
  if(medianTriple && medianTriple.p25 != null && medianTriple.p75 != null){
    if(dir === 'up'){
      if(val >= medianTriple.p75) return {cls:'ok',  txt:'✓ лучше 75% отрасли'};
      if(val >= medianTriple.p50) return {cls:'ok',  txt:'✓ выше медианы'};
      if(val >= medianTriple.p25) return {cls:'warn',txt:'⚠ ниже медианы'};
      return {cls:'err', txt:'❌ в худших 25%'};
    } else {
      if(val <= medianTriple.p25) return {cls:'ok',  txt:'✓ лучше 75% отрасли'};
      if(val <= medianTriple.p50) return {cls:'ok',  txt:'✓ ниже медианы'};
      if(val <= medianTriple.p75) return {cls:'warn',txt:'⚠ выше медианы'};
      return {cls:'err', txt:'❌ в худших 25%'};
    }
  }
  // 2. Жёсткие пороги (fallback).
  const [ok, warn] = hardThresholds;
  if(dir === 'up'){
    if(val >= ok)   return {cls:'ok',  txt:'✓ хорошо'};
    if(val >= warn) return {cls:'warn',txt:'⚠ средне'};
    return {cls:'err', txt:'❌ плохо'};
  } else {
    if(val <= ok)   return {cls:'ok',  txt:'✓ хорошо'};
    if(val <= warn) return {cls:'warn',txt:'⚠ средне'};
    return {cls:'err', txt:'❌ плохо'};
  }
}

function _dossierFmt(v, opts){
  opts = opts || {};
  if(v == null || !isFinite(v)) return '—';
  if(opts.pct) return (v * 100).toFixed(1) + '%';
  if(opts.years) return v.toFixed(1) + ' лет';
  const a = Math.abs(v);
  if(a >= 100) return v.toFixed(1);
  if(a >= 10)  return v.toFixed(2);
  if(a >= 1)   return v.toFixed(2);
  return v.toFixed(3);
}

function _dossierRenderFin(){
  if(!repActiveIssuerId) return;
  const iss = reportsDB[repActiveIssuerId];
  const meta = document.getElementById('dossier-fin-meta');
  const body = document.getElementById('dossier-fin-body');
  if(!iss){ body.innerHTML = ''; return; }
  const latest = _dossierLatestPeriod(iss);
  if(!latest){
    meta.innerHTML = '<span style="color:var(--danger)">Нет ни одного заполненного периода — не из чего считать.</span>';
    body.innerHTML = '';
    return;
  }
  const p = latest.data;
  const periodLabel = `${p.year} · ${p.period || 'FY'} · ${p.type || '—'}`;

  // Сводка эмитента — синтез из заполненных полей dossier + финансы.
  // Показываем поверх метаданных; если досье пустое — будет только
  // финансовая часть (авто-флаги по мультипликаторам).
  const summaryHTML = _dossierBuildSummary(iss, p);
  meta.innerHTML = summaryHTML + `<div style="margin-top:12px;font-size:.6rem;color:var(--text2)">Источник финансов: <strong style="color:var(--text)">${periodLabel}</strong> · все значения в млрд ₽ (внутренняя единица базы)</div>`;

  // Расчёты.
  const safeDiv = (a, b) => (a != null && b != null && b !== 0) ? a / b : null;
  const rev = p.rev, ebitda = p.ebitda, ebit = p.ebit, np = p.np, intE = p.int,
        assets = p.assets, eq = p.eq, debt = p.debt, cash = p.cash, ca = p.ca, cl = p.cl;
  const netDebt = (debt != null && cash != null) ? (debt - cash) : null;

  // Fallback на EBIT для метрик, требующих EBITDA: если EBITDA нет,
  // но EBIT есть — считаем по EBIT и пометим метрику как «(по EBIT)».
  // РСБУ-форма ФНС вообще не содержит EBITDA, поэтому для всех
  // импортов из ГИР БО этот fallback — основной путь.
  const fb = (fn, ...deps) => {
    const missing = [];
    const names = ['debt','netDebt','ebitda','ebit','int','rev','assets','ca','cl','cash','eq'];
    const vals  = { debt, netDebt, ebitda, ebit, int:intE, rev, assets, ca, cl, cash, eq };
    for(const d of deps){ if(vals[d] == null) missing.push(d); }
    return { val: missing.length ? null : fn(vals), missing };
  };
  const mapMissing = {
    debt:'долг', netDebt:'чистый долг', ebitda:'EBITDA', ebit:'EBIT',
    int:'проценты', rev:'выручка', assets:'активы', ca:'оборотные активы',
    cl:'кр. обязательства', cash:'денежные средства', eq:'капитал'
  };

  // Для «EBITDA-метрик» — если нет EBITDA, смотрим EBIT.
  const debtEbitdaCore = fb(v => v.debt / v.ebitda, 'debt','ebitda');
  const debtEbitFallback = fb(v => v.debt / v.ebit, 'debt','ebit');
  const debtEbitda = debtEbitdaCore.val != null ? debtEbitdaCore
                   : debtEbitFallback.val != null ? { ...debtEbitFallback, proxy:'EBIT' }
                   : debtEbitdaCore;

  const netDebtEbitdaCore = fb(v => v.netDebt / v.ebitda, 'netDebt','ebitda');
  const netDebtEbitFallback = fb(v => v.netDebt / v.ebit, 'netDebt','ebit');
  const netDebtEbitda = netDebtEbitdaCore.val != null ? netDebtEbitdaCore
                      : netDebtEbitFallback.val != null ? { ...netDebtEbitFallback, proxy:'EBIT' }
                      : netDebtEbitdaCore;

  const ebitdaIntCore = fb(v => v.ebitda / v.int, 'ebitda','int');
  const ebitIntFallback = fb(v => v.ebit / v.int, 'ebit','int');
  const ebitdaInt = ebitdaIntCore.val != null ? ebitdaIntCore
                  : ebitIntFallback.val != null ? { ...ebitIntFallback, proxy:'EBIT' }
                  : ebitdaIntCore;

  // Отраслевая медиана (если рассчитана) для сравнения.
  const indKey = iss.ind || 'other';
  const medians = (window._industryMedians && window._industryMedians[indKey] && window._industryMedians[indKey][p.year]) || {};
  const m = (fid) => medians[fid] || null;

  const rows = [
    {sec:'Долговая нагрузка'},
    {name:'Долг / EBITDA',           v: debtEbitda,                                  dir:'down', hard:[3, 5],   med: m('rep-np-debt-ebitda'), hint:'< 3× обычно безопасно для ВДО; > 5× — высокий риск'},
    {name:'Чистый долг / EBITDA',    v: netDebtEbitda,                               dir:'down', hard:[2, 4],   med: null, hint:'С учётом денежной подушки'},
    {name:'EBIT / Проценты (ICR)',   v: fb(x => x.ebit / x.int,  'ebit','int'),      dir:'up',   hard:[3, 1.5], med: m('rep-np-icr'), hint:'< 1.5 — проценты съедают прибыль от операций'},
    {name:'EBITDA / Проценты',       v: ebitdaInt,                                   dir:'up',   hard:[5, 2],   med: null, hint:'Расширенная метрика покрытия'},
    {sec:'Рентабельность'},
    {name:'ROA (ЧП / Активы)',       v: fb(x => x.np / x.assets,  'np','assets'),    dir:'up',   hard:[0.05, 0.02],  med: m('rep-np-roa'),     pct:true,  hint:'Эффективность использования активов'},
    {name:'ROE (ЧП / Капитал)',      v: fb(x => x.np / x.eq,      'np','eq'),        dir:'up',   hard:[0.12, 0.05],  med: m('rep-np-roe'),     pct:true,  hint:'Доходность для акционеров'},
    {name:'ROS (ЧП / Выручка)',      v: fb(x => x.np / x.rev,     'np','rev'),       dir:'up',   hard:[0.08, 0.02],  med: m('rep-np-ros'),     pct:true,  hint:'Чистая маржа'},
    {name:'EBITDA-маржа',            v: fb(x => x.ebitda / x.rev, 'ebitda','rev'),   dir:'up',   hard:[0.15, 0.07],  med: m('rep-np-ebitda-m'),pct:true,  hint:'Операционная эффективность'},
    {name:'EBIT-маржа',              v: fb(x => x.ebit / x.rev,   'ebit','rev'),     dir:'up',   hard:[0.10, 0.04],  med: m('rep-np-ebit-m'),  pct:true,  hint:'Операционная маржа без амортизации'},
    {sec:'Ликвидность и структура'},
    {name:'Current ratio (CA/CL)',   v: fb(x => x.ca / x.cl,       'ca','cl'),       dir:'up',   hard:[1.5, 1.0], med: null, hint:'> 1.5 — подушка оборотного капитала'},
    {name:'Cash / Кр. обязательства',v: fb(x => x.cash / x.cl,     'cash','cl'),     dir:'up',   hard:[0.3, 0.1], med: null, hint:'Сколько кр. обязательств покрывается чистыми деньгами'},
    {name:'Активоёмкость (A/Rev)',   v: fb(x => x.assets / x.rev,  'assets','rev'),  dir:'down', hard:[1, 2],     med: null, hint:'< 1 — быстрый оборот; > 3 — тяжёлые активы'},
    {name:'Капитал / Активы',        v: fb(x => x.eq / x.assets,   'eq','assets'),   dir:'up',   hard:[0.30, 0.15], med: null, pct:true, hint:'Финансовая автономность; < 15% — высокая зависимость от заёмного'},
    {sec:'Масштаб'},
    {name:'Выручка, млрд ₽',         v: fb(x => x.rev,    'rev'),                    dir:'up',   hard:[10, 1],    med: null, hint:'Абсолютный размер — прокси надёжности'},
    {name:'Активы, млрд ₽',          v: fb(x => x.assets, 'assets'),                 dir:'up',   hard:[20, 2],    med: null, hint:'Объём баланса'},
    {name:'Публичная история (лет)', v: { val: _dossierYearsInDB(iss), missing: [] }, dir:'up',  hard:[3, 1],     med: null, years:true, hint:'Сколько лет отчётности у нас накопилось — прокси прозрачности'},
  ];

  let html = `<div class="dossier-fin-row hdr">
    <div>Показатель</div><div style="text-align:right">Значение</div><div style="text-align:right">Медиана отрасли (p50)</div><div>Вердикт</div>
  </div>`;
  let missCount = 0;
  for(const r of rows){
    if(r.sec){ html += `<div class="dossier-fin-sec">${r.sec}</div>`; continue; }
    const val = r.v.val;
    const missing = r.v.missing || [];
    const proxy = r.v.proxy; // 'EBIT' если fallback
    let verdict;
    if(val == null){
      missCount++;
      const miss = missing.map(x => mapMissing[x] || x).join(', ');
      verdict = { cls:'nd', txt: `— нет: ${miss}` };
    } else {
      verdict = _dossierVerdict(val, r.dir, r.hard, r.med);
    }
    const medShow = r.med && r.med.p50 != null ? _dossierFmt(r.med.p50, {pct:r.pct, years:r.years}) : '—';
    const valShow = val == null ? '—' : _dossierFmt(val, {pct:r.pct, years:r.years});
    const proxyTag = proxy ? ` <span style="font-size:.52rem;color:var(--warn)">(по ${proxy})</span>` : '';
    html += `<div class="dossier-fin-row" title="${r.hint || ''}">
      <div>${r.name}${proxyTag}</div>
      <div style="text-align:right;font-family:var(--mono);color:var(--text)">${valShow}</div>
      <div style="text-align:right;font-family:var(--mono);color:var(--text3)">${medShow}</div>
      <div><span class="dossier-pill ${verdict.cls}">${verdict.txt}</span></div>
    </div>`;
  }
  const missHint = missCount > 0
    ? `<div style="margin-top:10px;padding:8px 12px;background:rgba(240,180,0,.06);border-left:2px solid var(--warn);font-size:.58rem;color:var(--text2);line-height:1.55">
         <strong>${missCount} метрик не посчитались — не хватает полей в периоде.</strong> Самое частое: <strong>EBITDA</strong> — её нет в РСБУ-форме ФНС (строки такой нет), поэтому для ГИР БО-периодов эта строка всегда пустая. Варианты:
         <br>• Открыть период (✎ Редактировать) и вписать EBITDA из МСФО-отчёта эмитента — обычно в разделе «Ключевые показатели» или «Alternative Performance Measures».
         <br>• Оставить пустым — часть метрик выше уже посчиталась <strong>по EBIT</strong> как fallback (пометка <span style="color:var(--warn)">(по EBIT)</span>), это менее точно но достаточно для грубой оценки.
       </div>`
    : '';
  html += missHint + `<div style="margin-top:10px;font-size:.55rem;color:var(--text3);line-height:1.5">
    <strong>Логика вердиктов:</strong> если для отрасли посчитана медиана через ГИР БО (страница «🏭 Отрасли / медианы») — сравнение идёт с ней (лучше/хуже квартили).
    Если медианы нет — жёсткие пороги консервативного bond-инвестора.
  </div>`;
  body.innerHTML = html;
}

// ───────── Сводка эмитента (синтез dossier + финансы) ─────────

// Человекочитаемые ярлыки для кодов из select'ов.
const _DOSSIER_LABELS = {
  marketPosition: {
    monopoly:'Монополист', dominant:'Доминирует', large:'Крупный игрок',
    mid:'Средний игрок', small:'Малый игрок', niche:'Нишевый'
  },
  geoDiv: {
    local:'Один регион', ru:'Вся РФ', cis:'РФ + СНГ', global:'Глобальная'
  },
  cyclicality: { low:'Низкая цикличность', mid:'Средняя цикличность', high:'Высокая цикличность' },
  barriers:    { low:'Низкие барьеры',     mid:'Средние барьеры',      high:'Высокие барьеры входа' },
  capexIntensity: { low:'Низкая капексоёмкость', mid:'Средняя капексоёмкость', high:'Высокая капексоёмкость' },
  currencyRisk: { none:'Нет валютных рисков', mitigated:'Валюта хеджируется', exposed:'Открытая валютная позиция' },
  seasonality:  { none:'Без сезонности', mild:'Умеренная сезонность', strong:'Сильная сезонность' },
  auditor:  { big4:'Big-4 / преемники', ru4:'Российская 4 (Б1/ТД/Кэпт/ФБК)', local:'Локальный аудитор', none:'Без аудита' },
  disclosureFreq: { quarterly:'Ежеквартально', semiannual:'Полугодие+год', annual:'Только годовой', sparse:'С пропусками', none:'Нет МСФО' },
  stateSupport: { explicit:'Явная господдержка', implicit:'Неявная господдержка', none:'Без поддержки' },
  ownership: { state:'Госкомпания', strategic:'Стратег-холдинг', pe:'PE/инвестфонд', solo:'Мажоритарий', diverse:'Распылённая' },
  defaultHistory: { none:'', restructure:'Была реструктуризация', 'default':'Был дефолт' },
  refinanceRisk: { low:'', mid:'Средний риск рефинанса', high:'Высокий риск рефинанса' },
  covenants: { strict:'Жёсткие ковенанты', mild:'Мягкие ковенанты', none:'Без ковенантов' },
  subordination: { senior:'Senior', secured:'Обеспеченные', subordinated:'Субординированные', hybrid:'Гибридные' }
};

function _dossierLabel(field, code){
  if(!code) return null;
  return (_DOSSIER_LABELS[field] && _DOSSIER_LABELS[field][code]) || code;
}

// Строит сводную панель: профиль-пилюли + автофлаги + нарратив.
// Возвращает HTML-строку. Если dossier пустой — показывает только
// флаги по финансам и инвайт «заполни B/C для полной картины».
function _dossierBuildSummary(iss, p){
  const d = iss.dossier || {};
  const biz = d.biz || {};
  const mod = d.mod || {};

  // ── Профиль-пилюли: иконка + короткий ярлык на каждое заполненное поле.
  const pills = [];
  const pushPill = (icon, field, value) => {
    const label = _dossierLabel(field, value);
    if(!label) return;
    pills.push(`<span class="dossier-pill nd" style="padding:3px 9px;font-size:.58rem">${icon} ${label}</span>`);
  };
  pushPill('📍', 'marketPosition', biz.marketPosition);
  pushPill('🏛', 'stateSupport',   mod.stateSupport);
  pushPill('👥', 'ownership',      mod.ownership);
  if(mod.rating) pills.push(`<span class="dossier-pill nd" style="padding:3px 9px;font-size:.58rem">📊 ${mod.rating}</span>`);
  pushPill('🔍', 'auditor',        mod.auditor);
  pushPill('📅', 'disclosureFreq', mod.disclosureFreq);
  pushPill('🌍', 'geoDiv',         biz.geoDiv);
  pushPill('📈', 'cyclicality',    biz.cyclicality);
  pushPill('🏗', 'capexIntensity', biz.capexIntensity);
  pushPill('💱', 'currencyRisk',   biz.currencyRisk);
  pushPill('📜', 'covenants',      mod.covenants);
  pushPill('🎯', 'subordination',  mod.subordination);
  if(mod.defaultHistory && mod.defaultHistory !== 'none'){
    pills.push(`<span class="dossier-pill err" style="padding:3px 9px;font-size:.58rem">⚠ ${_dossierLabel('defaultHistory', mod.defaultHistory)}</span>`);
  }

  // ── Автофлаги из сочетаний полей + финансов.
  const flags = _dossierBuildFlags(iss, biz, mod, p);

  // ── Нарратив — 2-4 предложения.
  const narrative = _dossierBuildNarrative(iss, biz, mod, p);

  // ── Собираем HTML.
  const isEmpty = !pills.length && !narrative;
  const pillsHTML = pills.length
    ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">${pills.join('')}</div>`
    : '';
  const flagsHTML = flags.length
    ? `<div style="display:flex;flex-direction:column;gap:4px;margin-top:10px">${
        flags.map(f => `<div style="display:flex;gap:8px;align-items:flex-start;font-size:.62rem;line-height:1.45">
          <span class="dossier-pill ${f.cls}" style="flex-shrink:0;padding:1px 7px">${f.icon}</span>
          <span style="color:var(--text2)">${f.text}</span>
        </div>`).join('')
      }</div>`
    : '';
  const narrHTML = narrative
    ? `<div style="margin-top:10px;padding:8px 12px;background:var(--s2);border-left:2px solid var(--acc);font-size:.66rem;line-height:1.55;color:var(--text)">${narrative}</div>`
    : '';
  const emptyHint = isEmpty && !flags.length
    ? `<div style="padding:10px;background:var(--s2);border:1px dashed var(--border2);font-size:.6rem;color:var(--text3);line-height:1.5">
         Досье ещё не заполнено. Открой вкладки B и C, пройдись по полям — после «💾 Сохранить» здесь появится сводная картинка эмитента: профиль, автофлаги, короткий нарратив.
       </div>`
    : '';

  return `
    <div style="background:var(--s1);border:1px solid var(--border2);padding:12px 14px">
      <div style="font-size:.56rem;letter-spacing:.1em;text-transform:uppercase;color:var(--text3)">📇 Сводка</div>
      ${narrHTML}
      ${flagsHTML}
      ${pillsHTML}
      ${emptyHint}
    </div>
  `;
}

// Риск-флаги: автовывод из комбинации биз+мод+финансов.
// Каждый элемент: {cls: 'ok'|'warn'|'err', icon: '✓'|'⚠'|'❌', text: '...'}
function _dossierBuildFlags(iss, biz, mod, p){
  const flags = [];
  const add = (cls, icon, text) => flags.push({cls, icon, text});
  const safeDiv = (a, b) => (a != null && b != null && b !== 0) ? a / b : null;

  // ── Позитивные ──
  if(biz.marketPosition === 'monopoly')
    add('ok', '✓', 'Монополист — ценовая власть и устойчивость спроса');
  else if(biz.marketPosition === 'dominant')
    add('ok', '✓', 'Доминирующая позиция (30-50% рынка)');
  if(mod.stateSupport === 'explicit')
    add('ok', '✓', 'Явная господдержка — снижает вероятность дефолта');
  if(mod.stateSupport === 'implicit' && (biz.marketPosition === 'monopoly' || biz.marketPosition === 'dominant'))
    add('ok', '✓', 'Стратегическая значимость + рыночная сила');
  if(mod.disclosureFreq === 'quarterly')
    add('ok', '✓', 'Ежеквартальная МСФО-отчётность — высокая прозрачность');
  if(mod.auditor === 'big4' || mod.auditor === 'ru4')
    add('ok', '✓', 'Аудитор уровня ' + _dossierLabel('auditor', mod.auditor));

  if(p){
    const debtEbitda = safeDiv(p.debt, p.ebitda);
    if(debtEbitda != null && debtEbitda > 0 && debtEbitda < 2)
      add('ok', '✓', `Долг/EBITDA ${debtEbitda.toFixed(1)}× — низкая долговая нагрузка`);
    else if(debtEbitda != null && debtEbitda >= 2 && debtEbitda < 3)
      add('ok', '✓', `Долг/EBITDA ${debtEbitda.toFixed(1)}× — умеренная нагрузка`);
    const icr = safeDiv(p.ebit, p.int);
    if(icr != null && icr > 5)
      add('ok', '✓', `ICR ${icr.toFixed(1)}× — высокое покрытие процентов`);
    const currentRatio = safeDiv(p.ca, p.cl);
    if(currentRatio != null && currentRatio > 1.5)
      add('ok', '✓', `Current ratio ${currentRatio.toFixed(2)} — запас оборотного капитала`);
  }

  // ── Предупреждения ──
  if(mod.shortDebtShare != null && mod.shortDebtShare >= 50 && mod.shortDebtShare < 70)
    add('warn', '⚠', `Краткосрочного долга ${mod.shortDebtShare}% — повышенный риск рефинансирования`);
  if(mod.refinanceRisk === 'mid')
    add('warn', '⚠', 'Средний риск рефинансирования долга');
  if(biz.clientsTop3 != null && biz.clientsTop3 >= 50)
    add('warn', '⚠', `Топ-3 клиента = ${biz.clientsTop3}% выручки — высокая концентрация`);
  if(biz.capexIntensity === 'high')
    add('warn', '⚠', 'Высокая капексоёмкость — свободного кешфлоу мало');
  if(biz.currencyRisk === 'exposed')
    add('warn', '⚠', 'Открытая валютная позиция (долг в валюте без соответствующей выручки)');
  if(biz.cyclicality === 'high')
    add('warn', '⚠', 'Высокая цикличность отрасли — EBITDA волатильна к фазе цикла');
  if(biz.geoDiv === 'local')
    add('warn', '⚠', 'Один регион операций — географический риск сконцентрирован');
  if(mod.disclosureFreq === 'annual' || mod.disclosureFreq === 'sparse' || mod.disclosureFreq === 'none')
    add('warn', '⚠', 'Редкое раскрытие МСФО — слепая зона между отчётами');
  if(mod.ownership === 'solo')
    add('warn', '⚠', 'Концентрация у одного мажоритария — корпоративные риски');
  if(mod.subordination === 'subordinated' || mod.subordination === 'hybrid')
    add('warn', '⚠', 'Субординация выпусков — погашение после обычных кредиторов');

  if(p){
    const debtEbitda = safeDiv(p.debt, p.ebitda);
    if(debtEbitda != null && debtEbitda >= 3 && debtEbitda < 5)
      add('warn', '⚠', `Долг/EBITDA ${debtEbitda.toFixed(1)}× — повышенная нагрузка`);
    const icr = safeDiv(p.ebit, p.int);
    if(icr != null && icr >= 1.5 && icr < 3)
      add('warn', '⚠', `ICR ${icr.toFixed(1)}× — покрытие процентов на грани нормы`);
    const eqShare = safeDiv(p.eq, p.assets);
    if(eqShare != null && eqShare > 0 && eqShare < 0.15)
      add('warn', '⚠', `Капитал/Активы ${(eqShare*100).toFixed(0)}% — тонкая финансовая подушка`);
  }

  // ── Красные флаги ──
  if(mod.shortDebtShare != null && mod.shortDebtShare >= 70)
    add('err', '❌', `Краткосрочного долга ${mod.shortDebtShare}% — срочная потребность в рефинансе`);
  if(mod.refinanceRisk === 'high')
    add('err', '❌', 'Высокий риск рефинансирования');
  if(mod.defaultHistory === 'default')
    add('err', '❌', 'В истории был дефолт/технический дефолт');
  if(mod.defaultHistory === 'restructure')
    add('warn', '⚠', 'В истории была реструктуризация долга');

  if(p){
    const debtEbitda = safeDiv(p.debt, p.ebitda);
    if(debtEbitda != null && debtEbitda >= 5)
      add('err', '❌', `Долг/EBITDA ${debtEbitda.toFixed(1)}× — чрезмерная нагрузка`);
    if(p.ebitda != null && p.ebitda < 0)
      add('err', '❌', 'Отрицательная EBITDA — операционный убыток');
    const icr = safeDiv(p.ebit, p.int);
    if(icr != null && icr < 1.5 && icr >= 0)
      add('err', '❌', `ICR ${icr.toFixed(1)}× — проценты съедают EBIT`);
    if(icr != null && icr < 0)
      add('err', '❌', 'ICR отрицательный — EBIT не покрывает проценты');
    if(p.eq != null && p.eq < 0)
      add('err', '❌', `Отрицательный капитал (${p.eq.toFixed(1)} млрд) — накопленные убытки превысили вклады`);
    if(p.np != null && p.np < 0 && p.rev != null && p.rev > 0)
      add('warn', '⚠', 'Чистый убыток в последнем периоде');
  }

  return flags;
}

// Нарратив из 2-4 предложений: позиция → долг → риски → особенности.
function _dossierBuildNarrative(iss, biz, mod, p){
  const safeDiv = (a, b) => (a != null && b != null && b !== 0) ? a / b : null;
  const name = iss.name || 'Эмитент';
  const parts = [];

  // 1. Позиционирование.
  const posTxt = {
    monopoly: 'монополист в своей нише',
    dominant: 'доминирующий игрок',
    large: 'крупный игрок рынка',
    mid: 'средний игрок',
    small: 'малый игрок',
    niche: 'нишевый игрок без прямой конкуренции'
  }[biz.marketPosition];
  if(posTxt){
    let s = `${name} — ${posTxt}`;
    if(mod.stateSupport === 'explicit') s += ' с явной господдержкой';
    else if(mod.stateSupport === 'implicit') s += ' стратегической важности';
    if(biz.geoDiv === 'local') s += ', операции сконцентрированы в одном регионе';
    else if(biz.geoDiv === 'global') s += ' с глобальной географией';
    parts.push(s + '.');
  }

  // 2. Долговой профиль.
  if(p){
    const de = safeDiv(p.debt, p.ebitda);
    if(de != null && de > 0){
      let load = de < 2 ? 'низкая' : de < 3 ? 'умеренная' : de < 5 ? 'повышенная' : 'высокая';
      let s = `Долговая нагрузка ${load} (Долг/EBITDA ${de.toFixed(1)}×)`;
      const icr = safeDiv(p.ebit, p.int);
      if(icr != null){
        const icrTxt = icr < 1.5 ? 'проценты съедают операционную прибыль' :
                       icr < 3 ? 'покрытие процентов на грани нормы' :
                       icr < 5 ? 'нормальное покрытие процентов' :
                       'комфортное покрытие процентов';
        s += `, ${icrTxt} (ICR ${icr.toFixed(1)}×)`;
      }
      parts.push(s + '.');
    }
  }

  // 3. Риски рефинансирования / структура.
  if(mod.shortDebtShare != null && mod.shortDebtShare >= 50){
    parts.push(`Краткосрочного долга ${mod.shortDebtShare}% — риск рефинансирования ${mod.shortDebtShare >= 70 ? 'высокий' : 'повышенный'}.`);
  } else if(mod.refinanceRisk === 'high'){
    parts.push('Риск рефинансирования долга оценён как высокий.');
  }

  // 4. Особенности бизнеса.
  const issues = [];
  if(biz.capexIntensity === 'high') issues.push('высокая капексоёмкость');
  if(biz.cyclicality === 'high') issues.push('высокая цикличность');
  if(biz.currencyRisk === 'exposed') issues.push('открытая валютная позиция');
  if(biz.clientsTop3 != null && biz.clientsTop3 >= 50) issues.push(`концентрация клиентов ${biz.clientsTop3}%`);
  if(issues.length){
    parts.push(`Уязвимости: ${issues.join(', ')}.`);
  }

  // 5. Дефолтная история (если была).
  if(mod.defaultHistory === 'default') parts.push('В истории — дефолт/технический дефолт.');
  else if(mod.defaultHistory === 'restructure') parts.push('В истории — реструктуризация долга.');

  if(!parts.length) return '';
  return parts.join(' ');
}

// Сколько лет (FY-периодов) в базе для этого эмитента.
function _dossierYearsInDB(iss){
  if(!iss || !iss.periods) return 0;
  const fyYears = new Set();
  for(const p of Object.values(iss.periods)){
    if(p && p.year && /год|FY|year/i.test(p.period || 'FY')) fyYears.add(p.year);
  }
  return fyYears.size;
}

// ───────── Вкладка D: паспорта выпусков ─────────

function _dossierRenderIssues(){
  if(!repActiveIssuerId) return;
  const iss = reportsDB[repActiveIssuerId];
  const list = document.getElementById('dossier-iss-list');
  if(!iss || !list) return;
  const issues = iss.issues || {};
  const keys = Object.keys(issues).sort((a, b) => {
    const da = issues[a].maturityDate || '';
    const db = issues[b].maturityDate || '';
    return da.localeCompare(db);
  });
  if(!keys.length){
    list.innerHTML = '<div style="color:var(--text3);font-size:.62rem;padding:10px 0">Паспортов выпусков пока нет.</div>';
    return;
  }
  list.innerHTML = keys.map(k => {
    const e = issues[k];
    const mat = e.maturityDate ? new Date(e.maturityDate).toLocaleDateString('ru-RU') : '—';
    const offer = e.offerDate ? ' · оферта ' + new Date(e.offerDate).toLocaleDateString('ru-RU') : '';
    const coup = e.couponRate != null ? e.couponRate + '%' : '—';
    const lvl = e.listLevel ? ' · ур.' + e.listLevel : '';
    return `<div class="dossier-issue-card" onclick="dossierIssueEdit('${k}')">
      <div style="flex:1">
        <div style="font-size:.72rem;color:var(--text)"><strong>${e.shortName || e.isin || k}</strong> <span style="color:var(--text3);font-size:.58rem">${e.isin || ''}</span></div>
        <div style="font-size:.58rem;color:var(--text2);margin-top:2px">${coup} · ${e.couponType || '—'} · погаш ${mat}${offer}${lvl}</div>
      </div>
      <div style="font-size:.55rem;color:var(--text3)">✎</div>
    </div>`;
  }).join('');
}

function dossierIssueNew(){
  document.getElementById('dossier-iss-form-title').textContent = 'Новый паспорт выпуска';
  document.getElementById('dos-iss-origKey').value = '';
  ['dos-iss-isin','dos-iss-shortName','dos-iss-couponRate','dos-iss-faceValue',
   'dos-iss-maturityDate','dos-iss-offerDate','dos-iss-issueSize','dos-iss-note'].forEach(id => {
    const el = document.getElementById(id); if(el) el.value = '';
  });
  document.getElementById('dos-iss-couponType').value = '';
  document.getElementById('dos-iss-currency').value = 'RUB';
  document.getElementById('dos-iss-listLevel').value = '';
  document.getElementById('dos-iss-del-btn').style.display = 'none';
  document.getElementById('dossier-iss-form').style.display = 'block';
}

function dossierIssueEdit(isinKey){
  if(!repActiveIssuerId) return;
  const iss = reportsDB[repActiveIssuerId];
  const e = iss?.issues?.[isinKey];
  if(!e) return;
  document.getElementById('dossier-iss-form-title').textContent = 'Редактирование: ' + (e.shortName || e.isin || isinKey);
  document.getElementById('dos-iss-origKey').value = isinKey;
  _dossierSetVals({
    'dos-iss-isin':         e.isin || '',
    'dos-iss-shortName':    e.shortName || '',
    'dos-iss-couponRate':   e.couponRate,
    'dos-iss-couponType':   e.couponType || '',
    'dos-iss-faceValue':    e.faceValue,
    'dos-iss-currency':     e.currency || 'RUB',
    'dos-iss-maturityDate': e.maturityDate || '',
    'dos-iss-offerDate':    e.offerDate || '',
    'dos-iss-issueSize':    e.issueSize,
    'dos-iss-listLevel':    e.listLevel || '',
    'dos-iss-note':         e.note || '',
  });
  document.getElementById('dos-iss-del-btn').style.display = '';
  document.getElementById('dossier-iss-form').style.display = 'block';
}

function dossierIssueSave(){
  if(!repActiveIssuerId) return;
  const iss = reportsDB[repActiveIssuerId];
  const isin = _dossierGetVal('dos-iss-isin').toUpperCase();
  if(!isin){ alert('Укажи ISIN — он используется как ключ выпуска.'); return; }
  if(!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin)){
    if(!confirm('ISIN «'+isin+'» не похож на стандартный (2 буквы страны + 10 символов, последний — цифра). Сохранить всё равно?')) return;
  }
  const origKey = _dossierGetVal('dos-iss-origKey');
  iss.issues = iss.issues || {};
  // Если ISIN поменялся — удаляем старую запись.
  if(origKey && origKey !== isin) delete iss.issues[origKey];
  iss.issues[isin] = {
    isin,
    shortName:    _dossierGetVal('dos-iss-shortName'),
    couponRate:   _dossierGetNum('dos-iss-couponRate'),
    couponType:   _dossierGetVal('dos-iss-couponType'),
    faceValue:    _dossierGetNum('dos-iss-faceValue'),
    currency:     _dossierGetVal('dos-iss-currency') || 'RUB',
    maturityDate: _dossierGetVal('dos-iss-maturityDate'),
    offerDate:    _dossierGetVal('dos-iss-offerDate'),
    issueSize:    _dossierGetNum('dos-iss-issueSize'),
    listLevel:    _dossierGetVal('dos-iss-listLevel') ? parseInt(_dossierGetVal('dos-iss-listLevel'), 10) : null,
    note:         _dossierGetVal('dos-iss-note'),
  };
  save();
  document.getElementById('dossier-iss-form').style.display = 'none';
  _dossierRenderIssues();
  const cnt = Object.keys(iss.issues).length;
  document.getElementById('dossier-iss-count').textContent = cnt ? '('+cnt+')' : '';
}

function dossierIssueDelete(){
  if(!repActiveIssuerId) return;
  const iss = reportsDB[repActiveIssuerId];
  const origKey = _dossierGetVal('dos-iss-origKey');
  if(!origKey || !iss?.issues?.[origKey]) return;
  const e = iss.issues[origKey];
  if(!confirm(`Удалить паспорт выпуска ${e.shortName || e.isin || origKey}?`)) return;
  delete iss.issues[origKey];
  save();
  document.getElementById('dossier-iss-form').style.display = 'none';
  _dossierRenderIssues();
  const cnt = Object.keys(iss.issues || {}).length;
  document.getElementById('dossier-iss-count').textContent = cnt ? '('+cnt+')' : '';
}

// ═════════════════════════════════════════════════════════════════════
// КАТАЛОГ ОБЛИГАЦИЙ МОСБИРЖИ (ISS API, публичный, без ключа)
// ─────────────────────────────────────────────────────────────────────
// Источник: https://iss.moex.com/iss/engines/stock/markets/bonds/securities.json
// Пагинация — по 100 записей, параметр `start`. Итого ~4500-5000 бумаг.
// CORS у ISS открыт, поэтому работает прямо из браузера без прокси.
// Хранение: отдельный ключ localStorage['bondan_moex_catalog'],
// НЕ в sync-snapshot (каталог большой и re-fetchable).
// ═════════════════════════════════════════════════════════════════════

const _MOEX_CACHE_KEY = 'bondan_moex_catalog';
const _MOEX_PAGE_SIZE = 100;
// Ключевые первичные торговые доски MOEX для облигаций. Каждая доска
// содержит бумагу ровно один раз, и пагинация естественно заканчивается.
// Вариант «через общий endpoint + фильтр по primaryBoard» оказался плохим:
// MOEX продолжает отдавать сотни страниц дублей с неосновных режимов,
// клиент фильтрует их, но трафик и время идут впустую.
const _MOEX_BOARDS = [
  ['TQOB', 'ОФЗ'],          // госбумаги
  ['TQCB', 'Корп. RUB'],    // корпораты рубли
  ['TQIR', 'Ипотечные'],
  ['TQIY', 'Замещайки'],
  ['TQOD', 'Евро / валютные'],
  ['TQRD', 'Суборды'],
  ['EQOB', 'Евробонды (T+)'],
  ['EQOD', 'Суборды доллар'],
  ['TQUD', 'USD-номинал'],
  ['TQUE', 'EUR-номинал'],
];
const _MOEX_BASE_BOARD = 'https://iss.moex.com/iss/engines/stock/markets/bonds/boards';

function moexInit(){
  if(!window._moexCatalog) _moexLoadCache();
  _moexRenderMeta();
  moexApplyFilters();
}

function _moexLoadCache(){
  try {
    const raw = localStorage.getItem(_MOEX_CACHE_KEY);
    if(!raw) return;
    const parsed = JSON.parse(raw);
    if(parsed && Array.isArray(parsed.items)) window._moexCatalog = parsed;
  } catch(e){}
}

function _moexSaveCache(){
  if(!window._moexCatalog) return;
  try {
    localStorage.setItem(_MOEX_CACHE_KEY, JSON.stringify(window._moexCatalog));
  } catch(e){
    alert('Не удалось сохранить каталог в localStorage (вероятно, не хватает места). Фильтры будут работать в рамках сессии, но после перезагрузки нужно будет обновить снова.\n\n' + e.message);
  }
}

function moexClearCache(){
  if(!confirm('Удалить локальный кэш каталога?')) return;
  localStorage.removeItem(_MOEX_CACHE_KEY);
  window._moexCatalog = null;
  _moexRenderMeta();
  moexApplyFilters();
}

function _moexRenderMeta(){
  const meta = document.getElementById('moex-meta');
  const cat = window._moexCatalog;
  const sbM = document.getElementById('sb-moex');
  if(!cat || !cat.items){
    if(meta) meta.textContent = 'Кэш пуст — нажми «Обновить каталог»';
    if(sbM) sbM.textContent = '0';
    return;
  }
  const age = Math.round((Date.now() - new Date(cat.updatedAt).getTime()) / 86400000 * 10) / 10;
  if(meta) meta.textContent = `В кэше: ${cat.items.length} бумаг · обновлено ${new Date(cat.updatedAt).toLocaleString('ru-RU')}${age >= 1 ? ' · ≈ '+age+' дн. назад' : ''}`;
  if(sbM) sbM.textContent = String(cat.items.length);
}

function _num(v){
  if(v == null || v === '') return null;
  const n = parseFloat(v);
  return isFinite(n) ? n : null;
}

// Парсит одну страницу: securities (статика) + marketdata (котировки), мерджим по SECID.
// Важно: MOEX возвращает одну бумагу по N раз — по числу торговых режимов, где
// она листится (TQCB + EQOD + PSOB + …). Нас интересует только «первичный»
// режим (BOARDID === PRIMARYBOARDID) — там живая цена и корректные котировки.
function _moexParsePage(resp){
  const sec = resp.securities || {};
  const md  = resp.marketdata || {};
  const secCols = sec.columns || [], secData = sec.data || [];
  const mdCols  = md.columns  || [], mdData  = md.data  || [];
  const idx = (cols, name) => cols.indexOf(name);
  const sidIdx = idx(secCols, 'SECID');
  const boardIdx = idx(secCols, 'BOARDID');
  const primaryBoardIdx = idx(secCols, 'PRIMARYBOARDID');
  const mdSidIdx = idx(mdCols, 'SECID');
  const mdBoardIdx = idx(mdCols, 'BOARDID');
  // marketdata тоже приходит по каждой паре (SECID, BOARDID). Берём строку
  // с максимальным объёмом торгов на ту же SECID — это почти всегда primary.
  const mdById = {};
  for(const r of mdData){
    const id = r[mdSidIdx]; if(!id) continue;
    if(!mdById[id]) mdById[id] = r;
  }
  const out = [];
  for(const r of secData){
    const secid = r[sidIdx]; if(!secid) continue;
    const board = r[boardIdx];
    const primary = r[primaryBoardIdx];
    // Пропускаем дубли с неосновных режимов.
    if(primary && board && board !== primary) continue;
    const g  = (name) => r[idx(secCols, name)];
    const mdr = mdById[secid] || [];
    const gm = (name) => mdr[idx(mdCols, name)];
    out.push({
      secid,
      isin:        g('ISIN') || secid,
      shortName:   g('SHORTNAME') || g('SECNAME') || secid,
      secName:     g('SECNAME'),
      boardid:     board,
      coupon:      _num(g('COUPONPERCENT')) || _num(g('COUPONVALUE')),
      couponValue: _num(g('COUPONVALUE')),
      couponPeriod:_num(g('COUPONPERIOD')),
      nextCoupon:  g('NEXTCOUPON') || null,
      faceValue:   _num(g('FACEVALUE')),
      currency:    g('CURRENCYID') || g('FACEUNIT'),
      matDate:     g('MATDATE') || null,
      offerDate:   g('OFFERDATE') || null,
      issueSize:   _num(g('ISSUESIZE')),
      listLevel:   _num(g('LISTLEVEL')),
      secType:     g('SECTYPE'),
      bondType:    g('BOND_TYPE'),        // «Амортизируемые облигации», «Фикс с известным купоном» и т.д.
      bondSubtype: g('BOND_SUBTYPE'),     // «До оферты (call)», «До погашения», «До оферты (put)»
      status:      g('STATUS'),
      price:       _num(gm('LAST')) || _num(g('PREVWAPRICE')) || _num(g('PREVPRICE')) || _num(g('PREVLEGALCLOSEPRICE')),
      ytm:         _num(gm('YIELD')) || _num(g('YIELDATPREVWAPRICE')),
      durationD:   _num(gm('DURATION')) || null,
    });
  }
  return out;
}

async function fetchMoexCatalog(){
  const btn = document.getElementById('moex-refresh-btn');
  const status = document.getElementById('moex-status');
  if(btn){ btn.disabled = true; btn.textContent = '⏳ Загружаю…  (нажми ещё раз — прервать)'; }
  window._moexAbort = false;
  // Второй клик по кнопке во время загрузки отправляет abort.
  const abortOnClick = () => { window._moexAbort = true; };
  if(btn){ btn.onclick = abortOnClick; }

  const items = [];
  const seen = new Set();
  let totalPages = 0;
  try {
    for(const [board, label] of _MOEX_BOARDS){
      if(window._moexAbort) break;
      let start = 0, pagesOnBoard = 0, addedOnBoard = 0;
      while(true){
        if(window._moexAbort) break;
        if(status) status.textContent = `📋 ${label} (${board}) · страница ${pagesOnBoard+1} · всего уникальных: ${items.length}`;
        const url = `${_MOEX_BASE_BOARD}/${board}/securities.json?iss.meta=off&start=${start}&limit=${_MOEX_PAGE_SIZE}`;
        const r = await fetch(url, {cache:'no-store'});
        if(!r.ok){
          // Некоторые доски могут отсутствовать — не валим всю выгрузку.
          console.warn('MOEX board', board, 'HTTP', r.status);
          break;
        }
        const raw = await r.json();
        const rawPageLen = (raw && raw.securities && raw.securities.data && raw.securities.data.length) || 0;
        const batch = _moexParsePageBoard(raw);
        for(const b of batch){
          if(seen.has(b.secid)) continue; // бумага может быть на нескольких досках
          seen.add(b.secid);
          items.push(b);
          addedOnBoard++;
        }
        pagesOnBoard++;
        totalPages++;
        if(rawPageLen < _MOEX_PAGE_SIZE) break;
        start += _MOEX_PAGE_SIZE;
        if(pagesOnBoard > 30){
          console.warn('MOEX board', board, '> 30 страниц, прерываю');
          break;
        }
      }
    }
    window._moexCatalog = { items, updatedAt: new Date().toISOString() };
    _moexSaveCache();
    const abortedMsg = window._moexAbort ? ' (прервано — сохранил что успел)' : '';
    if(status) status.innerHTML = `<span style="color:var(--green)">✓ Готово: ${items.length} бумаг за ${totalPages} запросов${abortedMsg}</span>`;
    _moexRenderMeta();
    moexApplyFilters();
  } catch(e){
    if(status) status.innerHTML = `<span style="color:var(--danger)">❌ ${e.message}</span>`;
  } finally {
    if(btn){
      btn.disabled = false;
      btn.textContent = '📡 Обновить каталог';
      btn.onclick = () => fetchMoexCatalog();
    }
    window._moexAbort = false;
  }
}

// Парсер для board-endpoint. На board-endpoint каждая бумага листится
// ровно один раз (это одна доска), поэтому primary-board фильтр не нужен.
function _moexParsePageBoard(resp){
  const sec = resp.securities || {};
  const md  = resp.marketdata || {};
  const secCols = sec.columns || [], secData = sec.data || [];
  const mdCols  = md.columns  || [], mdData  = md.data  || [];
  const idx = (cols, name) => cols.indexOf(name);
  const sidIdx = idx(secCols, 'SECID');
  const mdSidIdx = idx(mdCols, 'SECID');
  const mdById = {};
  for(const r of mdData){ const id = r[mdSidIdx]; if(id) mdById[id] = r; }
  const out = [];
  for(const r of secData){
    const secid = r[sidIdx]; if(!secid) continue;
    const g  = (name) => r[idx(secCols, name)];
    const mdr = mdById[secid] || [];
    const gm = (name) => mdr[idx(mdCols, name)];
    out.push({
      secid,
      isin:        g('ISIN') || secid,
      shortName:   g('SHORTNAME') || g('SECNAME') || secid,
      secName:     g('SECNAME'),
      boardid:     g('BOARDID'),
      coupon:      _num(g('COUPONPERCENT')) || _num(g('COUPONVALUE')),
      couponValue: _num(g('COUPONVALUE')),
      couponPeriod:_num(g('COUPONPERIOD')),
      nextCoupon:  g('NEXTCOUPON') || null,
      faceValue:   _num(g('FACEVALUE')),
      currency:    g('CURRENCYID') || g('FACEUNIT'),
      matDate:     g('MATDATE') || null,
      offerDate:   g('OFFERDATE') || null,
      issueSize:   _num(g('ISSUESIZE')),
      listLevel:   _num(g('LISTLEVEL')),
      secType:     g('SECTYPE'),
      bondType:    g('BOND_TYPE'),        // «Амортизируемые облигации», «Фикс с известным купоном» и т.д.
      bondSubtype: g('BOND_SUBTYPE'),     // «До оферты (call)», «До погашения», «До оферты (put)»
      status:      g('STATUS'),
      price:       _num(gm('LAST')) || _num(g('PREVWAPRICE')) || _num(g('PREVPRICE')) || _num(g('PREVLEGALCLOSEPRICE')),
      ytm:         _num(gm('YIELD')) || _num(g('YIELDATPREVWAPRICE')),
      durationD:   _num(gm('DURATION')) || null,
    });
  }
  return out;
}

// Индекс эмитентов из reportsDB по нормализованному имени — для флага «есть в базе».
function _moexBuildIssuerIndex(){
  const idx = new Map();
  for(const [issId, iss] of Object.entries(reportsDB || {})){
    if(!iss || !iss.name) continue;
    const n = (typeof _normIssuerName === 'function') ? _normIssuerName(iss.name) : iss.name.toLowerCase();
    if(n) idx.set(n, issId);
  }
  return idx;
}

function _moexMatchIssuer(bond, idx){
  const raw = bond.secName || bond.shortName || '';
  // Обрезаем хвост «Б-04», «БО-02», «П-01», номера выпусков.
  const head = String(raw).split(/[,\s]+/).filter(Boolean)
    .filter(w => !/^(Б|П|Р|БО|ПО|РП)-?\d/i.test(w) && !/^\d/.test(w))
    .slice(0, 3).join(' ');
  if(!head) return null;
  const n = (typeof _normIssuerName === 'function') ? _normIssuerName(head) : head.toLowerCase();
  if(!n) return null;
  if(idx.has(n)) return idx.get(n);
  for(const [key, id] of idx){ if(key.includes(n) || n.includes(key)) return id; }
  return null;
}

// Рейтинговая шкала — числовые уровни, чтобы сравнивать «≥».
const _MOEX_RATING_ORDER = ['D','C','CC','CCC','B','BB','BBB','A','AA','AAA'];
function _moexRatingRank(cls){
  if(!cls) return -1;
  const i = _MOEX_RATING_ORDER.indexOf(String(cls).toUpperCase());
  return i < 0 ? -1 : i;
}

// Из свободного текста «AA-(RU) Эксперт РА · A+(RU) АКРА» → класс «AA».
// Берём ПЕРВЫЙ рейтинг в тексте. Знаки +/- для фильтра игнорируем —
// они внутри класса.
function _moexRatingClass(text){
  if(!text) return null;
  const m = String(text).match(/\b(AAA|AA|A|BBB|BB|B|CCC|CC|C|RD|D)[+\-]?/i);
  return m ? m[1].toUpperCase() : null;
}

// Кэш посчитанных мультипликаторов эмитента за сессию рендера.
// Иначе на 500 строк таблицы пересчитывал бы для одного эмитента
// 10 раз подряд.
function _moexIssuerMetrics(issId, cache){
  if(cache.has(issId)) return cache.get(issId);
  const iss = reportsDB[issId];
  if(!iss){ cache.set(issId, null); return null; }
  // Последний FY период.
  let latest = null;
  for(const p of Object.values(iss.periods || {})){
    if(!p || !p.year) continue;
    if(!/год|FY|year/i.test(p.period || 'FY')) continue;
    if(!latest || parseInt(p.year, 10) > parseInt(latest.year, 10)) latest = p;
  }
  if(!latest){ cache.set(issId, null); return null; }
  const p = latest;
  const div = (a, b) => (a != null && b != null && b !== 0) ? a / b : null;
  // Fallback на EBIT, если EBITDA нет (как в досье).
  const base = p.ebitda != null ? p.ebitda : p.ebit;
  const netDebt = (p.debt != null && p.cash != null) ? (p.debt - p.cash) : null;
  const rating = iss.dossier?.mod?.rating || '';
  const metrics = {
    year: p.year,
    debtEbitda:    div(p.debt, base),
    netDebtEbitda: div(netDebt, base),
    icr:           div(p.ebit, p.int),
    roa:           div(p.np, p.assets),
    ebitdaMargin:  p.ebitda != null ? div(p.ebitda, p.rev) : null,
    ebitMargin:    div(p.ebit, p.rev),
    usedEbit:      p.ebitda == null && p.ebit != null,
    rating:        rating,
    ratingClass:   _moexRatingClass(rating)
  };
  cache.set(issId, metrics);
  return metrics;
}

function moexApplyFilters(){
  const cat = window._moexCatalog;
  const filtersCard = document.getElementById('moex-filters-card');
  const tableCard = document.getElementById('moex-table-card');
  if(!cat || !cat.items || !cat.items.length){
    if(filtersCard) filtersCard.style.display = 'none';
    if(tableCard) tableCard.style.display = 'none';
    return;
  }
  if(filtersCard) filtersCard.style.display = '';
  if(tableCard) tableCard.style.display = '';

  const f = {
    text: (document.getElementById('moex-f-text').value || '').trim().toLowerCase(),
    type: document.getElementById('moex-f-type').value,
    list: document.getElementById('moex-f-list').value,
    ccy:  document.getElementById('moex-f-ccy').value,
    ytmMin: _num(document.getElementById('moex-f-ytm-min').value),
    ytmMax: _num(document.getElementById('moex-f-ytm-max').value),
    matMin: _num(document.getElementById('moex-f-mat-min').value),
    matMax: _num(document.getElementById('moex-f-mat-max').value),
    coupon: document.getElementById('moex-f-coupon').value,
    freq: document.getElementById('moex-f-freq')?.value || '',
    offer: document.getElementById('moex-f-offer').value,
    amort: document.getElementById('moex-f-amort')?.value || '',
    sizeMin: _num(document.getElementById('moex-f-size-min').value),
    inDbOnly: document.getElementById('moex-f-indb').checked,
    showStructured: document.getElementById('moex-f-structured')?.checked || false,
    // Фильтры по фундаменталу:
    deMax:   _num(document.getElementById('moex-f-de-max')?.value),
    ndeMax:  _num(document.getElementById('moex-f-nde-max')?.value),
    icrMin:  _num(document.getElementById('moex-f-icr-min')?.value),
    roaMin:  _num(document.getElementById('moex-f-roa-min')?.value),
    ebmMin:  _num(document.getElementById('moex-f-ebm-min')?.value),
    ratingMin: document.getElementById('moex-f-rating-min')?.value || '',
    ratingHas: document.getElementById('moex-f-rating-has')?.value || '',
    sort: document.getElementById('moex-sort').value || 'ytm-desc',
  };
  // Любой из фундамент-фильтров → подразумевает «только есть в базе».
  const fundActive = f.deMax != null || f.ndeMax != null || f.icrMin != null
                  || f.roaMin != null || f.ebmMin != null
                  || f.ratingMin || f.ratingHas;
  const metricsCache = new Map();

  const issIdx = _moexBuildIssuerIndex();
  const today = Date.now();
  const isOfz = b => /^ОФЗ/i.test(b.shortName || '') || b.boardid === 'TQOB' || String(b.secType || '') === '3';
  const isSubfed = b => String(b.secType || '') === '2' || /муни|субфед/i.test(b.secName || '');

  // Структурные продукты: СберИОС / ГазИОС / вариации. Определяем по:
  // • имени (содержит ИОС, ИО-N, SberIO, GazprombankIO и т.п.)
  // • купон < 1% при обычном номинале = payoff в конце (структурка).
  const isStructured = b => {
    const names = ((b.shortName || '') + ' ' + (b.secName || '')).toUpperCase();
    if(/ИОС|SBERIO|GAZPROM.?IO|\bИО-?\d/i.test(names)) return true;
    // Низкий купон (< 0.5%) + длинный период = часто структурка «до погашения».
    if(b.coupon != null && b.coupon > 0 && b.coupon < 0.5 && b.couponPeriod && b.couponPeriod > 300) return true;
    return false;
  };

  // Категоризация по частоте купона (по COUPONPERIOD в днях).
  const freqOf = b => {
    const p = b.couponPeriod;
    if(!p) return null;
    if(p <= 40)  return 'month';
    if(p <= 105) return 'quarter';
    if(p <= 200) return 'half';
    if(p <= 400) return 'year';
    return null;
  };

  // Оферта/колл/пут: учитываем и OFFERDATE (дата put), и BOND_SUBTYPE
  // (текстовое «До оферты (call)» / «До оферты (put)») — у call-
  // опциона часто нет конкретной даты оферты в OFFERDATE, но по сути
  // это тоже оферта, только от эмитента.
  const hasOffer = b => !!b.offerDate || /оферт|\bcall\b|\bput\b/i.test(b.bondSubtype || '');
  // Амортизация: BOND_TYPE типично «Амортизируемые облигации».
  const isAmort = b => /амортиз/i.test(b.bondType || '');

  const enriched = cat.items.map(b => {
    const matY = b.matDate ? (new Date(b.matDate).getTime() - today) / (365.25 * 86400000) : null;
    const issId = _moexMatchIssuer(b, issIdx);
    const isFloat = /КС|RUONIA|ИПЦ|FLT|флоат/i.test(b.secName || b.shortName || '')
                  || (b.coupon != null && b.coupon < 1 && b.couponPeriod && b.couponPeriod < 95);
    return { ...b, matYears: matY, issId, isFloat, _isOfz: isOfz(b), _isSubfed: isSubfed(b), _isStructured: isStructured(b), _freq: freqOf(b) };
  });

  const filtered = enriched.filter(b => {
    if(f.text){
      const hay = ((b.shortName||'') + ' ' + (b.secName||'') + ' ' + b.isin + ' ' + b.secid).toLowerCase();
      if(!hay.includes(f.text)) return false;
    }
    if(f.type === 'ofz' && !b._isOfz) return false;
    if(f.type === 'corp' && (b._isOfz || b._isSubfed)) return false;
    if(f.type === 'subfed' && !b._isSubfed) return false;
    if(f.type === 'exchange' && !/TQ|EQ/i.test(b.boardid || '')) return false;
    if(f.list && String(b.listLevel) !== f.list) return false;
    if(f.ccy && b.currency !== f.ccy) return false;
    if(f.ytmMin != null && (b.ytm == null || b.ytm < f.ytmMin)) return false;
    if(f.ytmMax != null && (b.ytm == null || b.ytm > f.ytmMax)) return false;
    if(f.matMin != null && (b.matYears == null || b.matYears < f.matMin)) return false;
    if(f.matMax != null && (b.matYears == null || b.matYears > f.matMax)) return false;
    if(f.coupon === 'fix' && b.isFloat) return false;
    if(f.coupon === 'float' && !b.isFloat) return false;
    if(f.freq && b._freq !== f.freq) return false;
    if(!f.showStructured && b._isStructured) return false;
    if(f.offer === 'yes' && !hasOffer(b)) return false;
    if(f.offer === 'no' && hasOffer(b)) return false;
    if(f.amort === 'no' && isAmort(b)) return false;
    if(f.amort === 'yes' && !isAmort(b)) return false;
    if(f.sizeMin != null){
      const sizeM = b.issueSize && b.faceValue ? (b.issueSize * b.faceValue / 1e6) : null;
      if(sizeM == null || sizeM < f.sizeMin) return false;
    }
    if(f.inDbOnly && !b.issId) return false;
    // Фундамент-фильтры: если включены — нужен matched эмитент
    // с посчитанными мультипликаторами.
    if(fundActive){
      if(!b.issId) return false;
      const m = _moexIssuerMetrics(b.issId, metricsCache);
      if(!m) return false;
      if(f.deMax  != null && (m.debtEbitda    == null || m.debtEbitda    > f.deMax))  return false;
      if(f.ndeMax != null && (m.netDebtEbitda == null || m.netDebtEbitda > f.ndeMax)) return false;
      if(f.icrMin != null && (m.icr  == null || m.icr  < f.icrMin)) return false;
      if(f.roaMin != null && (m.roa  == null || m.roa * 100 < f.roaMin)) return false;
      if(f.ebmMin != null && (m.ebitdaMargin == null || m.ebitdaMargin * 100 < f.ebmMin)) return false;
      if(f.ratingMin){
        if(_moexRatingRank(m.ratingClass) < _moexRatingRank(f.ratingMin)) return false;
      }
      if(f.ratingHas === 'yes' && !m.ratingClass) return false;
      if(f.ratingHas === 'no'  &&  m.ratingClass) return false;
    }
    return true;
  });
  // Прокидываем cache в рендер, чтобы показать мини-профиль без повторных расчётов.
  window._moexMetricsCache = metricsCache;

  const cmp = {
    'ytm-desc': (a,b) => (b.ytm||-999) - (a.ytm||-999),
    'ytm-asc':  (a,b) => (a.ytm||999) - (b.ytm||999),
    'mat-asc':  (a,b) => (a.matYears||999) - (b.matYears||999),
    'mat-desc': (a,b) => (b.matYears||-999) - (a.matYears||-999),
    'name-asc': (a,b) => String(a.shortName||'').localeCompare(String(b.shortName||''), 'ru'),
    'coupon-desc':(a,b) => (b.coupon||-999) - (a.coupon||-999),
    'size-desc':(a,b) => ((b.issueSize||0) * (b.faceValue||0)) - ((a.issueSize||0) * (a.faceValue||0)),
  }[f.sort];
  if(cmp) filtered.sort(cmp);

  document.getElementById('moex-count').textContent = `${filtered.length} из ${cat.items.length}`;
  _moexRenderTable(filtered);
  window._moexFilteredCache = filtered;
}

function _moexRenderTable(list){
  const box = document.getElementById('moex-table');
  if(!box) return;
  if(!list.length){
    box.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text3);font-size:.65rem">По текущим фильтрам ничего не нашлось.</div>';
    return;
  }
  const limit = 500;
  const shown = list.slice(0, limit);
  const moreHint = list.length > limit
    ? `<div style="padding:8px 10px;font-size:.58rem;color:var(--text3);background:var(--s2)">Показано первых ${limit} из ${list.length} — сузь фильтры.</div>`
    : '';

  let html = `${moreHint}<table style="width:100%;border-collapse:collapse">
    <thead><tr style="background:var(--s2);color:var(--text3);font-size:.54rem;letter-spacing:.05em;text-transform:uppercase">
      <th style="padding:6px 8px;text-align:left">Бумага</th>
      <th style="padding:6px 8px;text-align:left">Эмитент / тип</th>
      <th style="padding:6px 8px;text-align:right">Цена</th>
      <th style="padding:6px 8px;text-align:right">YTM</th>
      <th style="padding:6px 8px;text-align:right">Купон</th>
      <th style="padding:6px 8px;text-align:right">Срок</th>
      <th style="padding:6px 8px;text-align:center">Лист</th>
      <th style="padding:6px 8px;text-align:right">Объём, млн</th>
      <th style="padding:6px 8px"></th>
    </tr></thead><tbody>`;

  const metricsCache = window._moexMetricsCache || new Map();
  for(const b of shown){
    const issName = b.issId ? (reportsDB[b.issId]?.name || '') : '';
    const metrics = b.issId ? _moexIssuerMetrics(b.issId, metricsCache) : null;
    const inDbBadge = b.issId
      ? `<span class="dossier-pill ok" style="padding:1px 6px;font-size:.52rem">в базе</span>` : '';
    const typeBadge = b._isOfz
      ? '<span class="dossier-pill nd" style="padding:1px 6px;font-size:.52rem;background:rgba(0,212,255,.1);color:var(--acc)">ОФЗ</span>'
      : b._isSubfed ? '<span class="dossier-pill nd" style="padding:1px 6px;font-size:.52rem">субфед</span>' : '';
    const floatBadge = b.isFloat ? '<span class="dossier-pill warn" style="padding:1px 6px;font-size:.52rem">флоатер</span>' : '';
    const offerBadge = b.offerDate ? `<span class="dossier-pill nd" style="padding:1px 6px;font-size:.52rem" title="оферта ${b.offerDate}">оферта</span>` : '';
    const mat = b.matYears != null ? b.matYears.toFixed(1) + ' л' : '—';
    const matDate = b.matDate ? ` <span style="color:var(--text3);font-size:.54rem">(${b.matDate})</span>` : '';
    const ytm = b.ytm != null ? b.ytm.toFixed(2) + '%' : '—';
    const coup = b.coupon != null ? b.coupon.toFixed(2) + '%' : '—';
    const price = b.price != null ? b.price.toFixed(2) : '—';
    const sizeM = b.issueSize && b.faceValue ? Math.round(b.issueSize * b.faceValue / 1e6) : null;
    const size = sizeM != null ? sizeM.toLocaleString('ru-RU') : '—';
    const lvl = b.listLevel || '—';
    const actions = `
      <button class="btn btn-sm" onclick="moexAddToYtm('${b.secid}')" title="Добавить в Сравнение YTM" style="padding:2px 6px;font-size:.54rem">+ YTM</button>
      ${b.issId
        ? `<button class="btn btn-sm" onclick="moexOpenDossier('${b.issId}')" title="Открыть досье эмитента" style="padding:2px 6px;font-size:.54rem;margin-left:4px">📇</button>`
        : `<button class="btn btn-sm" onclick="moexPullGirbo('${b.secid}')" title="Подтянуть РСБУ из ГИР БО по ИНН эмитента и создать его в базе (5 лет годовой отчётности ФНС). После этого мультипликаторы появятся прямо в этой строке." style="padding:2px 6px;font-size:.54rem;margin-left:4px;border-color:var(--acc);color:var(--acc)">📡</button>`}
    `;
    const ytmColor = b.ytm > 20 ? 'var(--warn)' : b.ytm > 15 ? 'var(--green)' : 'var(--text)';
    // Мини-профиль эмитента: Долг/EBITDA, ICR, ROA, EBITDA-маржа, рейтинг.
    let metricsLine = '';
    if(metrics){
      const parts = [];
      const pill = (txt, cls) => `<span style="color:${cls};font-family:var(--mono)">${txt}</span>`;
      if(metrics.debtEbitda != null){
        const c = metrics.debtEbitda < 3 ? 'var(--green)' : metrics.debtEbitda < 5 ? 'var(--warn)' : 'var(--danger)';
        parts.push(pill('D/E ' + metrics.debtEbitda.toFixed(1) + '×' + (metrics.usedEbit ? '*' : ''), c));
      }
      if(metrics.icr != null){
        const c = metrics.icr > 3 ? 'var(--green)' : metrics.icr > 1.5 ? 'var(--warn)' : 'var(--danger)';
        parts.push(pill('ICR ' + metrics.icr.toFixed(1) + '×', c));
      }
      if(metrics.roa != null){
        const roaP = metrics.roa * 100;
        const c = roaP > 5 ? 'var(--green)' : roaP > 0 ? 'var(--warn)' : 'var(--danger)';
        parts.push(pill('ROA ' + roaP.toFixed(1) + '%', c));
      }
      if(metrics.ebitdaMargin != null){
        const mp = metrics.ebitdaMargin * 100;
        const c = mp > 15 ? 'var(--green)' : mp > 7 ? 'var(--warn)' : 'var(--danger)';
        parts.push(pill('EBITDA-м ' + mp.toFixed(0) + '%', c));
      }
      if(metrics.ratingClass){
        parts.push(`<span style="color:var(--acc);font-weight:600">${metrics.ratingClass}</span>`);
      }
      if(parts.length){
        metricsLine = `<div style="font-size:.54rem;color:var(--text3);margin-top:3px;display:flex;gap:8px;flex-wrap:wrap" title="Фундаментал эмитента за FY ${metrics.year}${metrics.usedEbit ? ' — D/E посчитан по EBIT (EBITDA нет)' : ''}">${parts.join(' · ')}</div>`;
      }
    }
    html += `<tr style="border-top:1px solid var(--border)" onmouseover="this.style.background='var(--s2)'" onmouseout="this.style.background=''">
      <td style="padding:5px 8px">
        <div style="font-weight:600;color:var(--text)">${b.shortName || b.secid}</div>
        <div style="font-size:.54rem;color:var(--text3);font-family:var(--mono)">${b.isin}${matDate}</div>
      </td>
      <td style="padding:5px 8px;color:var(--text2);font-size:.58rem">
        ${issName ? `<div>${issName}</div>` : ''}
        <div style="display:flex;gap:3px;flex-wrap:wrap;margin-top:2px">${typeBadge}${inDbBadge}${floatBadge}${offerBadge}</div>
        ${metricsLine}
      </td>
      <td style="padding:5px 8px;text-align:right;font-family:var(--mono)">${price}</td>
      <td style="padding:5px 8px;text-align:right;font-family:var(--mono);color:${ytmColor}"><strong>${ytm}</strong></td>
      <td style="padding:5px 8px;text-align:right;font-family:var(--mono);color:var(--text2)">${coup}</td>
      <td style="padding:5px 8px;text-align:right;font-family:var(--mono);color:var(--text2)">${mat}</td>
      <td style="padding:5px 8px;text-align:center">${lvl}</td>
      <td style="padding:5px 8px;text-align:right;font-family:var(--mono);color:var(--text3)">${size}</td>
      <td style="padding:5px 8px;text-align:right;white-space:nowrap">${actions}</td>
    </tr>`;
  }
  html += '</tbody></table>';
  box.innerHTML = html;
}

function moexResetFilters(){
  ['moex-f-text','moex-f-ytm-min','moex-f-ytm-max','moex-f-mat-min','moex-f-mat-max','moex-f-size-min',
   'moex-f-de-max','moex-f-nde-max','moex-f-icr-min','moex-f-roa-min','moex-f-ebm-min'].forEach(id => {
    const el = document.getElementById(id); if(el) el.value = '';
  });
  ['moex-f-type','moex-f-list','moex-f-ccy','moex-f-coupon','moex-f-freq','moex-f-offer','moex-f-amort','moex-f-rating-min','moex-f-rating-has'].forEach(id => {
    const el = document.getElementById(id); if(el) el.value = '';
  });
  document.getElementById('moex-f-indb').checked = false;
  const struct = document.getElementById('moex-f-structured');
  if(struct) struct.checked = false;
  document.getElementById('moex-sort').value = 'ytm-desc';
  moexApplyFilters();
}

function moexAddToYtm(secid){
  const cat = window._moexCatalog;
  if(!cat) return;
  const b = cat.items.find(x => x.secid === secid);
  if(!b){ alert('Бумага не найдена в кэше'); return; }
  if(ytmBonds.some(x => x.isin === b.isin || x.name === b.shortName)){
    alert('Эта бумага уже есть в списке YTM.'); return;
  }
  const years = b.matDate ? (new Date(b.matDate).getTime() - Date.now()) / (365.25 * 86400000) : null;
  const isOfz = /^ОФЗ/i.test(b.shortName || '') || b.boardid === 'TQOB';
  const isSubfed = String(b.secType || '') === '2';
  const isFloat = /КС|RUONIA|ИПЦ|FLT|флоат/i.test(b.secName || b.shortName || '');
  const bond = {
    id: Date.now() + Math.random(),
    name: b.shortName || b.secid,
    isin: b.isin,
    btype: isOfz ? 'ОФЗ' : isSubfed ? 'Субфед' : 'Корп',
    ctype: isFloat ? 'float' : 'fix',
    price: b.price || 100,
    coupon: b.coupon || 0,
    years: years ? parseFloat(years.toFixed(2)) : 1,
    ytm: b.ytm || null,
  };
  if(bond.ctype === 'float'){
    if(/КС/i.test(b.secName || b.shortName || '')) bond.base = 'КС';
    else if(/ИПЦ/i.test(b.secName || b.shortName || '')) bond.base = 'ИПЦ';
    else if(/RUONIA/i.test(b.secName || b.shortName || '')) bond.base = 'RUONIA';
    bond.spread = 0;
  }
  ytmBonds.push(bond);
  save();
  if(typeof renderYtm === 'function') renderYtm();
  alert(`✓ «${bond.name}» добавлена в «Сравнение YTM»`);
}

// ───────── Автоподтяжка ГИР БО по ИНН эмитента ─────────
// Workflow: взять бумагу из MOEX → узнать ИНН через /iss/securities/{secid}
// → найти/создать эмитента в reportsDB → позвать fetchGirboByInn
// (уже реализован) → записать годовые периоды type='ГИРБО'.

// Кэш инфо о бумагах, чтобы при bulk не дёргать одну и ту же SECID дважды.
window._moexSecInfoCache = window._moexSecInfoCache || new Map();

// ───────── Локальный справочник ИНН (без сети) ─────────
// Корневая проблема: MOEX в description ИНН выдаёт редко, а name-search
// в ГИР БО требует рабочего прокси (сейчас ФНС периодически режет CF).
// Выход: многие «знакомые» эмитенты уже есть в наших локальных источниках:
// • references/industry-peers.json — ~100 ИНН по 15 отраслям (РЖД,
//   Газпром, ПГК, Сбер и т.д.) — проверенные, коммитятся в репо.
// • reportsDB — все эмитенты, которые пользователь уже заводил (у них
//   обычно заполнен inn).
// Для знакомых эмитентов ИНН находится мгновенно, без единого сетевого
// запроса — что критично когда прокси 522.

window._moexLocalInnMap = null;

async function _moexBuildLocalInnMap(){
  if(window._moexLocalInnMap) return window._moexLocalInnMap;
  const map = new Map(); // normName → {inn, name, initials, source}
  const addEntry = (name, inn, source) => {
    if(!name || !inn) return;
    if(!/^\d{10}$|^\d{12}$/.test(String(inn).trim())) return;
    const n = (typeof _normIssuerName === 'function') ? _normIssuerName(name) : String(name).toLowerCase();
    if(!n || n.length < 2) return;
    if(map.has(n)) return; // первый источник побеждает
    map.set(n, { inn: String(inn).trim(), name, initials: _moexInitialsOf(name), source });
  };
  // 1. industry-peers.json (seed + правки пользователя).
  try {
    if(typeof _indLoad === 'function'){
      const ind = await _indLoad();
      for(const [key, data] of Object.entries((ind && ind.industries) || {})){
        for(const p of data.peers || []){
          addEntry(p.name, p.inn, 'peers');
        }
      }
    }
  } catch(e){ /* ignore */ }
  // 2. reportsDB — уже заведённые эмитенты с ИНН.
  for(const iss of Object.values(reportsDB || {})){
    addEntry(iss.name, iss.inn, 'reportsDB');
  }
  window._moexLocalInnMap = map;
  return map;
}

// Аббревиатура по первым буквам значимых слов: «Первая Грузовая
// Компания» → «пгк», «Российские Железные Дороги» → «ржд».
function _moexInitialsOf(name){
  if(!name) return '';
  return String(name).toLowerCase()
    .replace(/[«»"„"()-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !/^(ао|пао|ооо|зао|оао|нао|нк|нп|пкф|ск|ск|тк|ук)$/i.test(w))
    .map(w => w[0])
    .join('');
}

// Синхронный lookup в локальном индексе.
// Пробует: точное совпадение → contains (в обе стороны) → аббревиатура.
function _moexLocalInnLookup(bondName){
  const map = window._moexLocalInnMap;
  if(!map || !bondName) return null;
  const target = (typeof _normIssuerName === 'function') ? _normIssuerName(bondName) : String(bondName).toLowerCase();
  if(!target || target.length < 2) return null;
  // 1. Exact.
  if(map.has(target)){
    return { inn: map.get(target).inn, name: map.get(target).name, matched: 'exact' };
  }
  // 2. Contains в обе стороны + initials.
  for(const [key, data] of map){
    if(target.length >= 3 && key.includes(target)) return { inn: data.inn, name: data.name, matched: 'contains' };
    if(key.length >= 3 && target.includes(key)) return { inn: data.inn, name: data.name, matched: 'contains' };
    if(data.initials && data.initials.length >= 2 && (target === data.initials || target.startsWith(data.initials + ' ') || target.startsWith(data.initials))){
      return { inn: data.inn, name: data.name, matched: 'initials' };
    }
  }
  return null;
}

// MOEX поиск: /iss/securities.json?q={query} — это другой endpoint,
// чем /iss/securities/{secid}.json. Возвращает табличный результат с
// колонками, среди которых бывает `emitent_inn` (не гарантировано,
// но часто). Это единственный бесплатный путь получить ИНН мелких
// ВДО-эмитентов БЕЗ прохода через прокси ФНС.
window._moexSearchInnCache = window._moexSearchInnCache || new Map();
async function _moexFetchInnBySearch(query){
  if(!query) return null;
  if(window._moexSearchInnCache.has(query)) return window._moexSearchInnCache.get(query);
  try {
    const url = 'https://iss.moex.com/iss/securities.json?iss.meta=off&limit=5&q=' + encodeURIComponent(query);
    const r = await fetch(url, {cache:'no-store'});
    if(!r.ok){ window._moexSearchInnCache.set(query, null); return null; }
    const raw = await r.json();
    const sec = raw.securities || {};
    const cols = sec.columns || [];
    const data = sec.data || [];
    // Ищем колонку emitent_inn / inn / issuer_inn (лениво, нерегистрозависимо).
    const innCol = cols.findIndex(c => /^(emitent_inn|issuer_inn|emitent_inn_issuer|inn)$/i.test(c || ''));
    if(innCol < 0){
      // Поле не нашлось — может быть MOEX в этом endpoint'е ИНН не отдаёт.
      // Залогируем один раз для диагностики, кэшируем null.
      if(!window._moexSearchInnColWarned){
        console.warn('[MOEX search] в securities.json?q= нет колонки *_inn. Есть:', cols);
        window._moexSearchInnColWarned = true;
      }
      window._moexSearchInnCache.set(query, null);
      return null;
    }
    // Берём первое непустое валидное ИНН-значение.
    for(const row of data){
      const v = String(row[innCol] || '').trim();
      if(/^\d{10}$|^\d{12}$/.test(v)){
        window._moexSearchInnCache.set(query, v);
        return v;
      }
    }
    window._moexSearchInnCache.set(query, null);
    return null;
  } catch(e){
    return null;
  }
}

// MOEX имеет справочник эмитентов: /iss/emittents/{id}.json или
// /iss/issuers/{id}.json — точное имя зависит от версии ISS. Пробуем
// оба, достаём ИНН из любой секции ответа.
window._moexEmitterCache = window._moexEmitterCache || new Map();
async function _moexFetchInnByEmitterId(emitterId){
  if(window._moexEmitterCache.has(emitterId)) return window._moexEmitterCache.get(emitterId);
  const tryUrls = [
    `https://iss.moex.com/iss/emittents/${emitterId}.json?iss.meta=off`,
    `https://iss.moex.com/iss/issuers/${emitterId}.json?iss.meta=off`,
  ];
  for(const url of tryUrls){
    try {
      const r = await fetch(url, {cache:'no-store'});
      if(!r.ok) continue;
      const raw = await r.json();
      // Может прийти либо «description-format» (rows {name,value}),
      // либо обычная таблица с колонкой INN. Обрабатываем оба.
      for(const [sectionKey, section] of Object.entries(raw)){
        if(!section || typeof section !== 'object') continue;
        const cols = section.columns || [];
        const data = section.data || [];
        const nameIdx = cols.indexOf('name');
        const valIdx = cols.indexOf('value');
        if(nameIdx >= 0 && valIdx >= 0){
          for(const row of data){
            const n = String(row[nameIdx] || '').toUpperCase();
            if(['INN','TAX_ID','EMITTER_INN'].includes(n)){
              const v = String(row[valIdx] || '').trim();
              if(/^\d{10}$|^\d{12}$/.test(v)){
                window._moexEmitterCache.set(emitterId, v);
                return v;
              }
            }
          }
        } else {
          const innIdx = cols.findIndex(c => /^inn$|tax.?id/i.test(c || ''));
          if(innIdx >= 0 && data[0]){
            const v = String(data[0][innIdx] || '').trim();
            if(/^\d{10}$|^\d{12}$/.test(v)){
              window._moexEmitterCache.set(emitterId, v);
              return v;
            }
          }
        }
      }
    } catch(e){ /* следующий URL */ }
  }
  window._moexEmitterCache.set(emitterId, null);
  return null;
}

// Грубая эвристика извлечения бренда эмитента из SHORTNAME.
// У MOEX для структурок и многих выпусков description не содержит
// имя эмитента вообще — только коды. Но в SHORTNAME обычно первые
// буквы до цифр/дефиса/БО — это бренд:
//   «СберИОС790» → «Сбер»
//   «ГазпромКап-02» → «ГазпромКап»
//   «ПГК БО-02» → «ПГК»
//   «РЖД 1Р-20R» → «РЖД»
// Не идеально, но для ГИР БО-поиска по имени даёт зацепку.
function _moexGuessIssuerName(shortName, secName){
  const raw = shortName || secName || '';
  if(!raw) return null;
  // Берём первое «слово» до разделителя (цифра, дефис, пробел, БО/П/Р-№).
  const m = String(raw).match(/^([А-Яа-яA-Za-zЁё]+(?:[А-Яа-яA-Za-zЁё])*)/);
  if(!m) return null;
  let brand = m[1];
  // Отрезаем хвостовые ИОС/БО/ПО, оставляем сам бренд.
  brand = brand.replace(/(ИОС|ИО|БО|ПО|СП)$/i, '').trim();
  return brand.length >= 3 ? brand : null;
}

// Поиск ИНН через ГИР БО по названию эмитента.
// MOEX часто не содержит ИНН (для структурных продуктов, бирж. облиг. и т.п.),
// но ГИР БО позволяет искать организацию по имени. Если имя совпадает — вернёт
// ИНН и дальше работает обычный путь.
async function _girboFindInnByName(name){
  if(!name) return null;
  // Очищаем от кавычек и лишнего, оставляем суть.
  const clean = String(name).replace(/[«»"„""]/g, '').replace(/\s+/g, ' ').trim();
  if(clean.length < 3) return null;
  try {
    const search = await _girboFetchJson('/nbo/organizations/?query=' + encodeURIComponent(clean));
    const orgs = Array.isArray(search) ? search : (search.content || search.organizations || []);
    if(!orgs.length) return null;
    // Первая организация — обычно лучший матч. Возвращаем её ИНН.
    const o = orgs[0];
    const inn = o.inn || o.organisationInn;
    return inn ? String(inn) : null;
  } catch(e){
    return null;
  }
}

// Возвращает {inn, issuer, shortName, isin, regNumber} из MOEX.
// Где искать ИНН: у MOEX оно лежит в description, но название поля
// нестабильное — для разных типов бумаг по-разному. Пробуем варианты,
// затем сканируем все значения на 10/12-значные числа (формат ИНН).
async function _moexFetchSecurityInfo(secid){
  if(window._moexSecInfoCache.has(secid)) return window._moexSecInfoCache.get(secid);
  // Полный ответ (без iss.only) — он маленький, ~1-2 КБ. Раньше я
  // сужал до description, но иногда нужное поле называется EMITTER_INN
  // и попадает в другой раздел.
  const url = `https://iss.moex.com/iss/securities/${encodeURIComponent(secid)}.json?iss.meta=off`;
  const r = await fetch(url, {cache:'no-store'});
  if(!r.ok) throw new Error('MOEX securities info HTTP '+r.status);
  const raw = await r.json();
  const desc = raw.description || {};
  const cols = desc.columns || [], data = desc.data || [];
  const nameIdx = cols.indexOf('name'), valIdx = cols.indexOf('value');
  const find = (n) => {
    if(nameIdx < 0) return null;
    const row = data.find(r => String(r[nameIdx] || '').toUpperCase() === String(n).toUpperCase());
    return row && valIdx >= 0 ? row[valIdx] : null;
  };
  // Варианты названия поля ИНН.
  let inn = null;
  for(const variant of ['INN','EMITTER_INN','ISSUER_INN','EMITENT_INN','TAX_ID']){
    const v = find(variant);
    if(v && /^\d{10}$|^\d{12}$/.test(String(v).trim())){
      inn = String(v).trim(); break;
    }
  }
  // Note: MOEX /iss/emittents/{id} и /iss/issuers/{id} возвращают 404
  // (таких endpoint'ов нет). Отдельный emitter-lookup убран.
  // Last-ditch: сканируем все value на 10/12-значное число — это формат ИНН.
  // Risk: можем поймать ОГРН (13 цифр), КПП (9), но они отсеиваются длиной.
  if(!inn && valIdx >= 0){
    for(const row of data){
      const v = row[valIdx];
      if(v == null) continue;
      const s = String(v).trim();
      if(/^\d{10}$|^\d{12}$/.test(s)){
        // Дополнительная проверка по ИНН-чексумме была бы строже,
        // но на практике 10-значное число в description — это почти
        // всегда ИНН. Берём.
        inn = s; break;
      }
    }
  }
  // Имя эмитента — несколько кандидатов.
  const issuer = find('ISSUER') || find('EMITENT_FULL_NAME') || find('EMITTER_FULL_NAME')
              || find('EMITENT') || find('EMITENTNAME') || find('FULLNAME') || null;
  const shortName = find('SHORTNAME') || find('SECNAME');
  const isin = find('ISIN') || secid;
  const regNumber = find('REGNUMBER') || null;
  // Диагностика — если ИНН не нашёлся, в консоль логируем все поля
  // description, чтобы можно было посмотреть, как называется нужное.
  if(!inn){
    const dump = data.map(r => `${r[nameIdx]}=${r[valIdx]}`);
    console.warn('[MOEX] нет ИНН для', secid, '— поля description:', dump);
  }
  const info = { inn, issuer, shortName, isin, regNumber };
  window._moexSecInfoCache.set(secid, info);
  return info;
}

// Находит в reportsDB эмитента по ИНН → иначе по имени → иначе создаёт.
function _moexEnsureIssuer(inn, issuerName){
  for(const [id, iss] of Object.entries(reportsDB || {})){
    if(iss && iss.inn && String(iss.inn) === String(inn)) return id;
  }
  // По имени — нормализованное.
  if(issuerName){
    const target = (typeof _normIssuerName === 'function') ? _normIssuerName(issuerName) : String(issuerName).toLowerCase();
    for(const [id, iss] of Object.entries(reportsDB || {})){
      if(!iss || !iss.name) continue;
      const n = (typeof _normIssuerName === 'function') ? _normIssuerName(iss.name) : String(iss.name).toLowerCase();
      if(n && (n === target || n.includes(target) || target.includes(n))){
        if(!iss.inn) iss.inn = inn;
        return id;
      }
    }
  }
  // Создаём нового.
  const id = 'iss_moex_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  reportsDB[id] = {
    name: issuerName || ('ИНН ' + inn),
    ind: 'other',
    inn: String(inn),
    periods: {},
  };
  return id;
}

// Полный цикл для одной бумаги: info → ensure issuer → fetch ГИР БО → сохранить.
// allowPrompt=true (только для ручного клика) — при отсутствии ИНН в MOEX
// предложит ввести вручную. В bulk-режиме false, чтобы не спамить prompt'ами.
async function _moexAutoGirbo(secid, allowPrompt){
  // 0. Сначала локальный справочник — мгновенно, без сети.
  // Покрывает всех «знакомых» эмитентов из peers + reportsDB.
  await _moexBuildLocalInnMap();
  const cat = window._moexCatalog;
  const bondFromCat = cat?.items?.find(b => b.secid === secid);
  let info = null;
  if(bondFromCat){
    const local = _moexLocalInnLookup(bondFromCat.shortName || bondFromCat.secName);
    if(local){
      info = {
        inn: local.inn,
        issuer: local.name,
        shortName: bondFromCat.shortName,
        isin: bondFromCat.isin,
        regNumber: null,
        _localMatch: true
      };
    }
  }

  // 1. Если не нашли локально — идём в MOEX description + EMITTER_ID.
  if(!info){
    try { info = await _moexFetchSecurityInfo(secid); }
    catch(e){ return { error: 'MOEX info: ' + e.message, secid }; }
  }

  let inn = info.inn;
  // Автоматический name-search через ГИР БО убран — он упирался в
  // 522 и с retry в cf-worker делал долгие заведомо неудачные попытки.
  // Если ИНН нет в description — пользователь получает имя эмитента
  // для ручного поиска через ИНН-мастер (кнопки ФНС/RusProfile).
  if(!inn && allowPrompt){
    const ent = (prompt(`ИНН не нашёлся для «${info.shortName || secid}» (эмитент: ${info.issuer || '—'}).\n\nВведи вручную (10 или 12 цифр), или Cancel чтобы пропустить.\nМожно найти ИНН на rusprofile.ru или bo.nalog.gov.ru по имени.`, '') || '').trim();
    if(!ent) return { error: 'ИНН не введён, пропущено', secid };
    if(!/^\d{10}$|^\d{12}$/.test(ent)) return { error: 'ИНН должен быть 10 или 12 цифр', secid };
    inn = ent;
  }
  if(!inn){
    return { error: 'ИНН не найден автоматически. Открой «📝 ИНН-мастер» для ручного ввода по списку.', secid, _noInn: true, _issuerName: info.issuer || info.shortName };
  }

  const issId = _moexEnsureIssuer(inn, info.issuer || info.shortName);
  const iss = reportsDB[issId];

  let data;
  try { data = await fetchGirboByInn(inn, 5); }
  catch(e){ return { error: 'ГИР БО: ' + e.message, issId, issName: iss.name, inn }; }

  if(!data.count){
    return { error: 'ГИР БО вернул 0 годовых отчётов по ИНН '+inn+' (компания могла быть исключена из публикации или ещё не отчитывалась)', issId, issName: iss.name, inn };
  }

  // Сериализуем series в reportsDB.periods. Ключи series формата
  // «FY 2024» → year=2024, period='FY', type='ГИРБО'.
  const fieldMap = {
    'rep-np-rev':'rev', 'rep-np-ebit':'ebit', 'rep-np-np':'np', 'rep-np-int':'int',
    'rep-np-assets':'assets', 'rep-np-ca':'ca', 'rep-np-cl':'cl', 'rep-np-debt':'debt',
    'rep-np-cash':'cash', 'rep-np-ret':'ret', 'rep-np-eq':'eq'
  };
  let added = 0, skipped = 0;
  for(const [lbl, values] of Object.entries(data.series || {})){
    const yearMatch = String(lbl).match(/(\d{4})/);
    if(!yearMatch) continue;
    const year = yearMatch[1];
    const key = `${year}_FY_ГИРБО`;
    if(iss.periods[key]){ skipped++; continue; }
    const period = {
      year, period:'FY', type:'ГИРБО', note:'', analysisHTML:'',
      rev:null, ebitda:null, ebit:null, np:null, int:null, tax:null,
      assets:null, ca:null, cl:null, debt:null, cash:null, ret:null, eq:null,
    };
    for(const [fid, shortKey] of Object.entries(fieldMap)){
      if(values[fid] != null) period[shortKey] = values[fid];
    }
    iss.periods[key] = period;
    added++;
  }
  save();
  return { issId, issName: iss.name, added, skipped, inn };
}

async function moexPullGirbo(secid){
  const status = document.getElementById('moex-status');
  if(status) status.innerHTML = `<span style="color:var(--warn)">⏳ Подтягиваю ГИР БО для ${secid}…</span>`;
  const res = await _moexAutoGirbo(secid, true); // allowPrompt=true для ручной кнопки
  if(res.error){
    if(status) status.innerHTML = `<span style="color:var(--danger)">❌ ${res.error}</span>`;
    return;
  }
  if(status) status.innerHTML = `<span style="color:var(--green)">✓ «${res.issName}»: добавлено ${res.added} годов (пропущено ${res.skipped})</span>`;
  // Перерисовываем таблицу — теперь для этой бумаги будет matched issuer и мини-профиль.
  moexApplyFilters();
  const sbRep = document.getElementById('sb-rep');
  if(sbRep) sbRep.textContent = Object.keys(reportsDB).length;
}

async function moexPullGirboBulk(){
  const list = window._moexFilteredCache || [];
  const targets = list.filter(b => !b.issId);
  if(!targets.length){
    alert('Нет выпусков, эмитент которых НЕ в базе — ничего подтягивать. Сузь фильтр до бумаг без мини-профиля.');
    return;
  }
  if(targets.length > 30){
    if(!confirm(`В текущем фильтре ${targets.length} выпусков без matched эмитента. Это может быть 10-30 уникальных эмитентов (одна компания = несколько выпусков). Подтяжка ~1-2 сек на эмитента через прокси ГИР БО. Продолжить?`)) return;
  }
  const status = document.getElementById('moex-status');
  const unique = new Map(); // inn → {secid, shortName}
  let totalOk = 0, totalErr = 0, totalSkipped = 0, totalNewIssuers = 0;
  const errors = [];

  // Шаг 1: группируем бумаги по ИМЕНИ эмитента (без сети).
  // ГИР БО endpoint /nbo/organizations/?query= принимает ЛЮБУЮ
  // строку — ИНН промежуточно не нужен. Для всех бумаг извлекаем
  // бренд из MOEX shortName/secName (_moexGuessIssuerName) и
  // группируем. Локальный справочник используем только чтобы
  // приоритизировать уже известное полное имя из peers.json
  // (там «ПАО Сбербанк» вместо MOEX-шного «Сбер»).
  await _moexBuildLocalInnMap();
  let done = 0;
  for(const b of targets){
    done++;
    if(status && done % 20 === 0) status.innerHTML = `<span style="color:var(--warn)">⏳ 1/2: группирую (${done}/${targets.length}, эмитентов: ${unique.size})</span>`;

    // Ищем имя — приоритет: полное имя из локального справочника
    // (оно точнее для ГИР БО), потом MOEX guess.
    let name = null;
    const local = _moexLocalInnLookup(b.shortName || b.secName);
    if(local) name = local.name;
    if(!name) name = _moexGuessIssuerName(b.shortName, b.secName);
    if(!name) name = b.shortName || b.secName;
    if(!name || name.length < 2) continue;

    // Ключ группировки — нормализованное имя.
    const key = (typeof _normIssuerName === 'function')
      ? _normIssuerName(name)
      : name.toLowerCase();
    if(!key) continue;
    if(!unique.has(key)){
      unique.set(key, { name, query: name, sampleSecid: b.secid });
    }
  }

  const totalInns = unique.size;
  if(totalInns === 0){
    if(status) status.innerHTML = `<span style="color:var(--warn)">Нет эмитентов для обработки — не удалось извлечь имя ни для одной бумаги.</span>`;
    return;
  }

  // Шаг 2: каждого уникального эмитента ищем в ГИР БО по ИМЕНИ.
  // fetchGirboByInn теперь принимает любую строку — внутри она
  // делает поиск organizations/?query=<name>, берёт первый матч,
  // тянет BFO. Результат возвращает и ИНН (из ответа ГИР БО),
  // и финансы.
  if(status) status.innerHTML = `<span style="color:var(--warn)">⏳ 2/2: запрашиваю ГИР БО для ${totalInns} эмитентов…</span>`;
  const fieldMap = {
    'rep-np-rev':'rev', 'rep-np-ebit':'ebit', 'rep-np-np':'np', 'rep-np-int':'int',
    'rep-np-assets':'assets', 'rep-np-ca':'ca', 'rep-np-cl':'cl', 'rep-np-debt':'debt',
    'rep-np-cash':'cash', 'rep-np-ret':'ret', 'rep-np-eq':'eq'
  };
  let idx = 0;
  let consecutiveTimeouts = 0;
  for(const [key, meta] of unique){
    idx++;
    if(status) status.innerHTML = `<span style="color:var(--warn)">⏳ 2/2: ГИР БО ${idx}/${totalInns}: «${meta.name}»</span>`;
    let data;
    try {
      data = await fetchGirboByInn(meta.query, 5);
      consecutiveTimeouts = 0;
    } catch(e){
      totalErr++;
      errors.push(`${meta.name}: ${e.message}`);
      // Если подряд 5 таймаутов/ошибок прокси — сеть нестабильна,
      // дальнейшие попытки бесполезны. Прерываем bulk с честным
      // сообщением, чтобы не ждать минуты впустую.
      if(/timeout|CF→ФНС|Upstream unreachable|Failed to fetch|NetworkError/i.test(e.message || '')){
        consecutiveTimeouts++;
        if(consecutiveTimeouts >= 5){
          if(status) status.innerHTML = `<span style="color:var(--danger)">✋ Остановлено: ${consecutiveTimeouts} таймаутов подряд — прокси/сеть нестабильны. Обработано ${idx-consecutiveTimeouts} из ${totalInns}. Попробуй позже или через «📝 ИНН-мастер».</span>`;
          break;
        }
      }
      await new Promise(r => setTimeout(r, 400));
      continue;
    }
    if(!data || !data.count){
      errors.push(`${meta.name}: ГИР БО вернул 0 годовых отчётов`);
      await new Promise(r => setTimeout(r, 150));
      continue;
    }
    // ИНН настоящий — из ответа ГИР БО (не из нашей догадки).
    const resolvedInn = data.inn || '';
    const issId = _moexEnsureIssuer(resolvedInn || ('noInn_' + idx), data.company || meta.name);
    const iss = reportsDB[issId];
    if(resolvedInn && !iss.inn) iss.inn = resolvedInn;
    const existed = Object.keys(iss.periods || {}).length > 0;
    if(!existed) totalNewIssuers++;
    // Сохраняем series в reportsDB.periods.
    for(const [lbl, values] of Object.entries(data.series || {})){
      const ym = String(lbl).match(/(\d{4})/);
      if(!ym) continue;
      const year = ym[1];
      const pkey = `${year}_FY_ГИРБО`;
      if(iss.periods[pkey]){ totalSkipped++; continue; }
      const period = {
        year, period:'FY', type:'ГИРБО', note:'', analysisHTML:'',
        rev:null, ebitda:null, ebit:null, np:null, int:null, tax:null,
        assets:null, ca:null, cl:null, debt:null, cash:null, ret:null, eq:null,
      };
      for(const [fid, shortKey] of Object.entries(fieldMap)){
        if(values[fid] != null) period[shortKey] = values[fid];
      }
      iss.periods[pkey] = period;
      totalOk++;
    }
    save();
    await new Promise(r => setTimeout(r, 400));
  }
  // Сбрасываем кэш локального справочника — новые ИНН попадут туда.
  window._moexLocalInnMap = null;

  // Результат.
  const msg = totalInns === 0
    ? `Нет эмитентов для обработки — отфильтруй каталог и попробуй снова.`
    : `✓ Готово: обработано ${totalInns} эмитентов, добавлено ${totalOk} периодов, пропущено ${totalSkipped} уже существовавших, новых эмитентов: ${totalNewIssuers}` + (totalErr ? `. Не нашлось в ГИР БО: ${totalErr} — попробуй через 📝 ИНН-мастер.` : '');
  if(status) status.innerHTML = `<span style="color:var(--green)">${msg}</span>`;
  if(errors.length){
    console.warn('GIR BO bulk errors:', errors);
    setTimeout(() => {
      if(confirm(msg + `\n\nОшибок/пропусков: ${errors.length}. Показать первые 10?`)){
        alert(errors.slice(0, 10).join('\n\n'));
      }
    }, 100);
  }
  moexApplyFilters();
  const sbRep = document.getElementById('sb-rep');
  if(sbRep) sbRep.textContent = Object.keys(reportsDB).length;
}

// ───────── ИНН-мастер (ручной ввод ИНН массово) ─────────
// MOEX не отдаёт ИНН в доступных нам API, name-search через ФНС
// упирается в прокси. Для мелких ВДО единственный надёжный путь —
// пользователь находит ИНН глазами на bo.nalog.gov.ru / rusprofile.ru
// и вводит в таблицу. Мастер это и делает — одна модалка, все
// бумаги из текущего фильтра без matched эмитента, рядом с каждой
// поле для ИНН + две ссылки.

function moexOpenInnWizard(){
  const cat = window._moexCatalog;
  if(!cat){ alert('Сначала обнови каталог Мосбиржи.'); return; }
  const filtered = window._moexFilteredCache || [];
  const targets = filtered.filter(b => !b.issId);
  if(!targets.length){
    alert('В текущем фильтре нет бумаг без matched эмитента — всё уже найдено или фильтр слишком узкий.');
    return;
  }
  // Группируем по предполагаемому имени эмитента, чтобы одна строка
  // мастера покрывала все выпуски одного бренда. Ключ: _moexGuessIssuerName
  // от shortName. Если угадать не удалось — используем сам shortName.
  const groups = new Map(); // key (inferred brand) → {brand, name, items:[bonds]}
  for(const b of targets){
    const brand = _moexGuessIssuerName(b.shortName, b.secName) || b.shortName || b.secid;
    const key = brand.toLowerCase();
    if(!groups.has(key)){
      groups.set(key, {
        brand,
        moexName: b.secName || b.shortName,
        items: []
      });
    }
    groups.get(key).items.push(b);
  }

  document.getElementById('inn-wiz-count').textContent = `${groups.size} эмитентов · ${targets.length} выпусков`;
  const rows = [...groups.entries()].map(([key, g]) => {
    const sample = g.items[0];
    const issuesList = g.items.map(b => `<span style="color:var(--text3);font-family:var(--mono);font-size:.56rem">${b.shortName}</span>`).join(' · ');
    const queryFns = encodeURIComponent(g.brand);
    const queryRp = encodeURIComponent(g.brand);
    return `<div class="inn-wiz-row" data-key="${key}" style="display:grid;grid-template-columns:1.6fr 1.2fr auto;gap:10px;align-items:center;padding:8px 6px;border-bottom:1px solid var(--border)">
      <div>
        <div style="font-size:.7rem;color:var(--text);font-weight:600">${g.brand}</div>
        <div style="font-size:.55rem;color:var(--text3);margin-top:2px">${g.items.length} выпуск${g.items.length === 1 ? '' : g.items.length < 5 ? 'а' : 'ов'}: ${issuesList}</div>
        <div style="font-size:.54rem;color:var(--text3);margin-top:2px">MOEX-имя: ${g.moexName || '—'}</div>
      </div>
      <div style="display:flex;gap:4px;align-items:center">
        <input type="text" class="inn-wiz-input" data-key="${key}" placeholder="10 или 12 цифр" maxlength="12" style="flex:1;background:var(--bg);border:1px solid var(--border);color:var(--text);font-family:var(--mono);font-size:.7rem;padding:4px 6px;outline:none">
      </div>
      <div style="display:flex;gap:4px">
        <a href="https://bo.nalog.gov.ru/advanced-search/organizations/search?query=${queryFns}" target="_blank" rel="noopener" class="btn btn-sm" style="text-decoration:none;font-size:.54rem;padding:3px 7px" title="Открыть поиск на сайте ФНС (bo.nalog.gov.ru)">🇷🇺 ФНС</a>
        <a href="https://www.rusprofile.ru/search?query=${queryRp}&type=ul" target="_blank" rel="noopener" class="btn btn-sm" style="text-decoration:none;font-size:.54rem;padding:3px 7px" title="Открыть поиск на rusprofile.ru">🔎 RusProfile</a>
      </div>
    </div>`;
  }).join('');

  document.getElementById('inn-wiz-body').innerHTML = rows;
  // Сохраняем группы для последующего save.
  window._moexInnWizardGroups = groups;
  document.getElementById('modal-inn-wizard').classList.add('open');
}

async function moexSaveInnWizard(){
  const groups = window._moexInnWizardGroups;
  if(!groups) return;
  const autogirbo = document.getElementById('inn-wiz-autogirbo').checked;
  const inputs = document.querySelectorAll('#inn-wiz-body .inn-wiz-input');
  const toProcess = []; // {inn, name, sampleSecid}
  for(const input of inputs){
    const inn = input.value.trim();
    if(!inn) continue;
    if(!/^\d{10}$|^\d{12}$/.test(inn)){
      input.style.borderColor = 'var(--danger)';
      continue;
    }
    const key = input.dataset.key;
    const g = groups.get(key);
    if(!g) continue;
    toProcess.push({ inn, name: g.brand, sampleSecid: g.items[0].secid });
  }
  if(!toProcess.length){
    alert('Введи хотя бы один ИНН (10 или 12 цифр).');
    return;
  }

  // 1. Создаём/обновляем эмитентов в reportsDB (этого достаточно,
  //    чтобы в каталоге появился matched эмитент и мини-профиль
  //    — пусть пока без мультипликаторов).
  for(const item of toProcess){
    _moexEnsureIssuer(item.inn, item.name);
  }
  save();
  // Сброс кэша локального ИНН-индекса — чтобы новые эмитенты
  // сразу попадали в поиск.
  window._moexLocalInnMap = null;
  closeModal('modal-inn-wizard');

  // 2. Обновляем каталог (rebuild issuerIndex, mini-profile).
  moexApplyFilters();

  const sbRep = document.getElementById('sb-rep');
  if(sbRep) sbRep.textContent = Object.keys(reportsDB).length;

  const statusEl = document.getElementById('moex-status');
  if(statusEl) statusEl.innerHTML = `<span style="color:var(--green)">✓ Сохранено ${toProcess.length} эмитентов${autogirbo ? '. Запускаю подтяжку ГИР БО…' : ''}</span>`;

  // 3. Опционально — сразу тянем ГИР БО.
  if(autogirbo){
    let ok = 0, err = 0;
    for(let i = 0; i < toProcess.length; i++){
      const item = toProcess[i];
      if(statusEl) statusEl.innerHTML = `<span style="color:var(--warn)">⏳ ГИР БО ${i+1}/${toProcess.length}: ${item.name}</span>`;
      try {
        const data = await fetchGirboByInn(item.inn, 5);
        // Добавляем периоды в reportsDB.
        let issId = null;
        for(const [id, iss] of Object.entries(reportsDB)){
          if(iss.inn === item.inn){ issId = id; break; }
        }
        if(!issId) continue;
        const iss = reportsDB[issId];
        const fieldMap = {
          'rep-np-rev':'rev', 'rep-np-ebit':'ebit', 'rep-np-np':'np', 'rep-np-int':'int',
          'rep-np-assets':'assets', 'rep-np-ca':'ca', 'rep-np-cl':'cl', 'rep-np-debt':'debt',
          'rep-np-cash':'cash', 'rep-np-ret':'ret', 'rep-np-eq':'eq'
        };
        for(const [lbl, values] of Object.entries(data.series || {})){
          const ym = String(lbl).match(/(\d{4})/);
          if(!ym) continue;
          const year = ym[1];
          const key = `${year}_FY_ГИРБО`;
          if(iss.periods[key]) continue;
          const period = {
            year, period:'FY', type:'ГИРБО', note:'', analysisHTML:'',
            rev:null, ebitda:null, ebit:null, np:null, int:null, tax:null,
            assets:null, ca:null, cl:null, debt:null, cash:null, ret:null, eq:null,
          };
          for(const [fid, shortKey] of Object.entries(fieldMap)){
            if(values[fid] != null) period[shortKey] = values[fid];
          }
          iss.periods[key] = period;
        }
        save();
        ok++;
      } catch(e){
        err++;
      }
      await new Promise(r => setTimeout(r, 150));
    }
    if(statusEl) statusEl.innerHTML = `<span style="color:var(--green)">✓ Сохранено ${toProcess.length} эмитентов; ГИР БО: ${ok} успешно, ${err} упало (прокси/522 — ничего страшного, данные эмитента сохранятся, в следующий раз ГИР БО донесёт)</span>`;
    moexApplyFilters();
  }
}

function moexOpenDossier(issId){
  if(!reportsDB[issId]){ alert('Эмитент не найден в базе'); return; }
  showPage('reports');
  setTimeout(() => {
    const sel = document.getElementById('rep-issuer-sel');
    if(sel){ sel.value = issId; if(typeof repSelectIssuer === 'function') repSelectIssuer(); }
    dossierOpen();
  }, 100);
}

function moexExportCsv(){
  const list = window._moexFilteredCache;
  if(!list || !list.length){ alert('Сначала отфильтруй — выгружается текущий срез.'); return; }
  const cols = ['secid','isin','shortName','secName','boardid','price','ytm','coupon','couponPeriod','faceValue','currency','matDate','offerDate','issueSize','listLevel','secType','matYears'];
  const esc = v => {
    if(v == null) return '';
    const s = String(v);
    return /[,"\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s;
  };
  const rows = [cols.join(',')];
  for(const b of list) rows.push(cols.map(c => esc(b[c])).join(','));
  const blob = new Blob(['\uFEFF'+rows.join('\n')], {type:'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'moex-bonds-' + new Date().toISOString().slice(0,10) + '.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// При старте — если в кэше что-то есть, покажем счётчик в sidebar.
(function _moexBootstrap(){
  try { _moexLoadCache(); _moexRenderMeta(); } catch(e){}
})();
