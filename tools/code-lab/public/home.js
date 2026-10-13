// Главный экран: подтягивает список шаблонов и показывает несколько карточек.
// Клик по карточке открывает её в Библиотеке (id — в hash).

(async function(){
  const box = document.getElementById('pop');
  let list = [];
  try { list = await fetch('/api/list').then(r => r.json()); } catch(_){ box.innerHTML = '<div class="muted">сервер недоступен</div>'; return; }
  if(!list.length){ box.innerHTML = '<div class="muted">пока пусто — загляни в Библиотеку и добавь шаблон</div>'; return; }
  // показываем до 8: сперва «Мои куски» и «Из конструктора» (её свои), потом остальные
  const mine = list.filter(t => /куск|конструктор/i.test(t.group || ''));
  const rest = list.filter(t => !/куск|конструктор/i.test(t.group || ''));
  const pick = [...mine, ...rest].slice(0, 8);
  box.innerHTML = '';
  pick.forEach(t => {
    const a = document.createElement('a'); a.className = 'pop'; a.href = '/library.html#' + encodeURIComponent(t.id);
    a.innerHTML = '<div class="pop-t"></div><div class="pop-g"></div>'
      + '<div class="pop-l">' + esc((t.lang || '').toUpperCase() || '—') + '</div>';
    a.querySelector('.pop-t').textContent = t.title || 'без названия';
    a.querySelector('.pop-g').textContent = t.group || '';
    box.appendChild(a);
  });
})();

function esc(s){ return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
