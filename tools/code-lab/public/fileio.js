// «Открыть файл…» и «Сохранить как…»: любой файл на ДИСКЕ через File System Access API.
// В Chrome/Edge — настоящий диалог и перезапись того же файла (дескриптор помним по id куска);
// в остальных браузерах откат: открытие через <input type=file>, сохранение — скачиванием.
// Это НЕ папка проекта (её ведёт workspace.js) — здесь отдельные файлы откуда угодно с диска.
// Надстройка над window.codelabSandbox; подключать после tabs.js (нужен window.codelabTabs).
(function(){
  const sb = window.codelabSandbox;
  const box = document.getElementById('sandbox');
  const bar = box && box.querySelector('.sb-bar');
  if(!sb || !box || !bar){ return; }

  const EXT_LANG = { html:'html', htm:'html', css:'css', scss:'css', js:'js', mjs:'js', cjs:'js', jsx:'js', ts:'ts', tsx:'ts', json:'json', py:'python', rb:'ruby', php:'php', go:'go', lua:'lua', sh:'bash', bash:'bash', r:'r', sql:'sql', md:'txt', txt:'txt', svg:'html', xml:'txt', yml:'txt', yaml:'txt', csv:'txt' };
  const langOf = n => EXT_LANG[(String(n).split('.').pop() || '').toLowerCase()] || 'txt';
  const uid = () => 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const hasFS = typeof window.showOpenFilePicker === 'function' && typeof window.showSaveFilePicker === 'function';

  // дескрипторы файлов, открытых с диска (ключ — id куска): чтобы «сохранить» писал в тот же файл.
  // После перезагрузки страницы теряются — тогда «сохранить» снова спросит, куда (как «сохранить как»).
  const handles = new Map();
  const files = () => sb.getFiles();

  function activeFile(){
    let id = null; try { id = localStorage.getItem('codelab_sb_active'); } catch(_){}
    const fs = files(); return fs.find(f => f.id === id) || fs[0] || null;
  }
  function activate(id){
    if(window.codelabTabs && window.codelabTabs.setActive) window.codelabTabs.setActive(id, true);
    else { try { localStorage.setItem('codelab_sb_active', id); } catch(_){} }
  }
  // короткое сообщение: используем строку workspace, если она есть, иначе alert не трогаем — просто молча
  function toast(t, err){
    const m = box.querySelector('#wsMsg');
    if(m){ m.textContent = t; m.className = 'ws-msg ' + (err ? 'err' : 'ok'); clearTimeout(toast.t); toast.t = setTimeout(() => { if(m.textContent === t) m.textContent = ''; }, 6000); }
  }

  function addFiles(list){
    if(!list.length) return;
    sb.setFiles([...files(), ...list]);
    activate(list[list.length - 1].id);
    toast('открыто: ' + list.map(f => f.name).join(', '));
  }

  // ── открыть файл(ы) с диска ──
  async function openFromDisk(){
    if(hasFS){
      let hs; try { hs = await window.showOpenFilePicker({ multiple: true }); } catch(_){ return; }  // отмена диалога — не ошибка
      const add = [];
      for(const h of hs){
        try { const file = await h.getFile(); const text = await file.text(); const id = uid(); handles.set(id, h); add.push({ id, name: file.name, lang: langOf(file.name), code: text }); }
        catch(e){ toast('не прочитать файл: ' + e.message, true); }
      }
      addFiles(add);
    } else {
      inp.value = ''; inp.click();
    }
  }
  const inp = document.createElement('input'); inp.type = 'file'; inp.multiple = true; inp.style.display = 'none';
  inp.onchange = async () => {
    const add = [];
    for(const file of [...inp.files]){ try { const text = await file.text(); add.push({ id: uid(), name: file.name, lang: langOf(file.name), code: text }); } catch(_){} }
    addFiles(add);
  };

  // ── сохранить активный файл на диск ──
  async function saveToDisk(){
    const f = activeFile(); if(!f){ toast('нет активного файла', true); return; }
    if(hasFS){
      let handle = handles.get(f.id);
      if(!handle){
        try { handle = await window.showSaveFilePicker({ suggestedName: f.name || 'файл.txt' }); } catch(_){ return; }  // отмена
        handles.set(f.id, handle);
        if(handle.name && handle.name !== f.name){ f.name = handle.name; f.lang = langOf(handle.name); sb.setFiles([...files()]); }
      }
      try { const w = await handle.createWritable(); await w.write(f.code); await w.close(); toast('сохранено на диск: ' + (handle.name || f.name)); }
      catch(e){ toast('не удалось сохранить: ' + e.message, true); }
    } else {
      const blob = new Blob([f.code], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = f.name || 'файл.txt';
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast('скачан файл: ' + (f.name || 'файл.txt'));
    }
  }

  // ── кнопки в панели песочницы (рядом с «+ файл») ──
  const bOpen = document.createElement('button'); bOpen.className = 'btn'; bOpen.textContent = '📂 открыть…';
  bOpen.title = hasFS ? 'открыть файл с диска (можно сохранить обратно в тот же файл)' : 'открыть файл с диска';
  bOpen.onclick = openFromDisk;
  const bSave = document.createElement('button'); bSave.className = 'btn'; bSave.textContent = '💾 на диск…';
  bSave.title = hasFS ? 'сохранить активный файл на диск: в тот же файл, если открыт с диска, иначе выбрать куда' : 'скачать активный файл';
  bSave.onclick = saveToDisk;
  const addBtn = bar.querySelector('#sbAdd');
  if(addBtn){ addBtn.after(bSave); addBtn.after(bOpen); } else { bar.appendChild(bOpen); bar.appendChild(bSave); }
  bar.appendChild(inp);
})();
