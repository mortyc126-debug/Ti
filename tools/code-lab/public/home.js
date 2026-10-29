// Главный экран: последние проекты (сохранённые схемы конструктора). Клик открывает проект
// прямо в конструкторе (?flow=id). Если проектов нет — показываем свежие шаблоны как запасной вариант.

(async function(){
  const box = document.getElementById('pop');
  let flows = [];
  try { flows = await fetch('/api/flows/list').then(r => r.json()); } catch(_){}
  flows = (flows || []).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0)).slice(0, 10);
  if(flows.length){
    box.innerHTML = '';
    flows.forEach(f => {
      const a = document.createElement('a'); a.className = 'pop'; a.href = '/constructor.html?flow=' + encodeURIComponent(f.id);
      a.innerHTML = '<div class="pop-t"></div><div class="pop-g"></div><div class="pop-l">проект</div>';
      a.querySelector('.pop-t').textContent = f.name || 'без названия';
      a.querySelector('.pop-g').textContent = (f.nodes || 0) + ' узлов · ' + (f.edges || 0) + ' связей' + (f.savedAt ? ' · ' + fmtDate(f.savedAt) : '');
      box.appendChild(a);
    });
    return;
  }
  // проектов пока нет — покажем шаблоны (запасной вариант)
  let list = [];
  try { list = await fetch('/api/list').then(r => r.json()); } catch(_){ box.innerHTML = '<div class="muted">сервер недоступен</div>'; return; }
  if(!list.length){ box.innerHTML = '<div class="muted">Пока нет проектов. Создай первый в Конструкторе и сохрани (кнопка «схемы»).</div>'; return; }
  box.innerHTML = '<div class="muted" style="grid-column:1/-1;margin-bottom:6px">Проектов пока нет — вот шаблоны для старта:</div>';
  list.slice(0, 8).forEach(t => {
    const a = document.createElement('a'); a.className = 'pop'; a.href = '/library.html#' + encodeURIComponent(t.id);
    a.innerHTML = '<div class="pop-t"></div><div class="pop-g"></div><div class="pop-l">' + esc((t.lang || '').toUpperCase() || '—') + '</div>';
    a.querySelector('.pop-t').textContent = t.title || 'без названия';
    a.querySelector('.pop-g').textContent = t.group || '';
    box.appendChild(a);
  });
})();

function fmtDate(ts){ try { const d = new Date(ts); return d.toLocaleDateString('ru') + ' ' + d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' }); } catch(_){ return ''; } }
function esc(s){ return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
