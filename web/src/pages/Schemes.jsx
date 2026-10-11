// «Схемы отраслей» — библиотека HTML-схем анализа по отраслям. Список отраслей
// из общей таксономии; клик по отрасли ЛЕНИВО тянет список её файлов из репо,
// клик по файлу — его содержимое. Добавление/удаление файла = коммит в
// репозиторий через GitHub Contents API (по токену). При старте ничего не
// грузится.

import { useState, useRef, useEffect } from 'react';
import { ChevronRight, ChevronDown, FileCode2, Trash2, Download, Plus, Settings, KeyRound, ExternalLink } from 'lucide-react';
import Card from '../components/ui/Card.jsx';
import { INDUSTRY_GROUPS } from '../data/industries.js';
import { listSchemes, getSchemeContent, putScheme, deleteScheme, getRepo, setRepo, getToken, setToken } from '../lib/schemesRepo.js';

export default function Schemes(){
  const [open, setOpen] = useState(null);          // раскрытая отрасль (key)
  const [files, setFiles] = useState({});          // key → [{name,path,sha,size}]
  const [busy, setBusy] = useState({});            // key → bool (загрузка списка)
  const [err, setErr] = useState('');
  const [viewer, setViewer] = useState(null);      // {name, url}
  const cache = useRef(new Map());                 // path → html (чтобы не тянуть повторно)
  const blobUrl = useRef(null);
  const [cfgOpen, setCfgOpen] = useState(false);
  const [repo, setRepoS] = useState(getRepo());
  const [tok, setTokS] = useState(getToken());
  const hasTok = !!getToken();
  const fileInput = useRef(null);
  const pendingKey = useRef(null);

  const loadDir = async (key) => {
    setBusy(b => ({ ...b, [key]: true })); setErr('');
    try { const list = await listSchemes(key); setFiles(f => ({ ...f, [key]: list })); }
    catch(e){ setErr(String(e.message || e)); }
    setBusy(b => ({ ...b, [key]: false }));
  };
  const toggle = (key) => {
    if(open === key){ setOpen(null); return; }
    setOpen(key);
    if(!files[key]) loadDir(key);
  };
  // Контент берём из кэша или тянем один раз. Для просмотра — blob-URL (грузится
  // как настоящая страница, быстрее большого srcDoc), чистим при закрытии.
  const fetchHtml = async (fileObj) => {
    if(cache.current.has(fileObj.path)) return cache.current.get(fileObj.path);
    const html = await getSchemeContent(fileObj.path);
    cache.current.set(fileObj.path, html);
    return html;
  };
  const makeBlob = html => URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  const closeViewer = () => { if(blobUrl.current){ URL.revokeObjectURL(blobUrl.current); blobUrl.current = null; } setViewer(null); };
  const view = async (fileObj) => {
    setErr(''); setViewer({ name: fileObj.name, url: null });   // показать окно сразу (со спиннером)
    try {
      const html = await fetchHtml(fileObj);
      if(blobUrl.current) URL.revokeObjectURL(blobUrl.current);
      blobUrl.current = makeBlob(html);
      setViewer({ name: fileObj.name, url: blobUrl.current });
    } catch(e){ setErr(String(e.message || e)); closeViewer(); }
  };
  const openTab = async (fileObj) => {
    setErr('');
    try { window.open(makeBlob(await fetchHtml(fileObj)), '_blank', 'noopener'); }
    catch(e){ setErr(String(e.message || e)); }
  };
  const download = async (fileObj) => {
    try {
      const url = makeBlob(await fetchHtml(fileObj));
      const a = document.createElement('a'); a.href = url; a.download = fileObj.name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch(e){ setErr(String(e.message || e)); }
  };
  useEffect(() => () => { if(blobUrl.current) URL.revokeObjectURL(blobUrl.current); }, []);
  const del = async (key, fileObj) => {
    if(!getToken()){ setErr('нужен токен для удаления (⚙ настройки ниже)'); return; }
    if(!confirm(`Удалить ${fileObj.name}? Это коммит в репозиторий.`)) return;
    setBusy(b => ({ ...b, [key]: true })); setErr('');
    try { await deleteScheme(fileObj.path, fileObj.sha); await loadDir(key); }
    catch(e){ setErr(String(e.message || e)); setBusy(b => ({ ...b, [key]: false })); }
  };
  const pickFile = (key) => {
    if(!getToken()){ setErr('нужен токен для добавления файла (⚙ настройки ниже)'); setCfgOpen(true); return; }
    pendingKey.current = key;
    if(fileInput.current){ fileInput.current.value = ''; fileInput.current.click(); }
  };
  const onFile = async (e) => {
    const f = e.target.files && e.target.files[0]; const key = pendingKey.current;
    if(!f || !key) return;
    setBusy(b => ({ ...b, [key]: true })); setErr('');
    try { const text = await f.text(); await putScheme(key, f.name, text); await loadDir(key); }
    catch(er){ setErr(String(er.message || er)); setBusy(b => ({ ...b, [key]: false })); }
  };
  const saveCfg = () => { setRepo(repo); setToken(tok); setCfgOpen(false); setErr(''); };

  return (
    <div className="space-y-6">
      <input ref={fileInput} type="file" accept=".html,.htm,text/html" className="hidden" onChange={onFile} />

      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Схемы отраслей</h1>
          <p className="text-text2 text-sm mt-1">
            Библиотека HTML-схем анализа по отраслям. Файлы лежат в репозитории; открываются лениво — только при выборе отрасли/файла. Храни здесь только свои (доверенные) схемы — их JS выполняется.
          </p>
        </div>
        <button type="button" onClick={() => setCfgOpen(v => !v)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-mono border border-border bg-s2 text-text2 hover:text-acc hover:border-acc/40">
          <Settings size={13} /> {hasTok ? 'репозиторий ✓' : 'подключить репо'}
        </button>
      </div>

      {cfgOpen && (
        <Card title="Подключение к репозиторию">
          <div className="space-y-3 text-sm">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-text3 font-mono mb-1">Репозиторий (owner/repo)</div>
              <input value={repo} onChange={e => setRepoS(e.target.value)} placeholder="mortyc126-debug/ti"
                className="bg-s2 border border-border rounded px-2 h-8 w-full max-w-sm text-xs font-mono text-text" />
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-text3 font-mono mb-1 flex items-center gap-1"><KeyRound size={11} /> GitHub-токен (Contents: read/write)</div>
              <input type="password" value={tok} onChange={e => setTokS(e.target.value)} placeholder="ghp_… / github_pat_…"
                className="bg-s2 border border-border rounded px-2 h-8 w-full max-w-sm text-xs font-mono text-text" />
              <div className="text-[11px] text-text3 mt-1">Нужен персональный токен с правом записи Contents этого репо. Хранится только в браузере, наружу не уходит. Добавление/удаление файла делает коммит.</div>
            </div>
            <button type="button" onClick={saveCfg}
              className="px-3 h-8 rounded text-xs font-mono bg-acc text-bg hover:bg-acc/80">сохранить</button>
          </div>
        </Card>
      )}

      {err && <div className="text-warn text-xs font-mono">{err}</div>}

      <div className="space-y-4">
        {INDUSTRY_GROUPS.map(g => (
          <Card key={g.id} title={g.label} padded={false}>
            <div>
              {g.items.map(it => {
                const expanded = open === it.id;
                const list = files[it.id];
                const n = list ? list.length : null;
                return (
                  <div key={it.id} className="border-t border-border/40 first:border-t-0">
                    <button type="button" onClick={() => toggle(it.id)}
                      className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-s2/40">
                      {expanded ? <ChevronDown size={14} className="text-acc" /> : <ChevronRight size={14} className="text-text3" />}
                      <span className="text-text flex-1">{it.label}</span>
                      {n != null && n > 0 && <span className="text-[10px] font-mono text-acc bg-acc-dim rounded px-1.5 py-0.5">{n}</span>}
                      <span className="text-text3 font-mono text-[10px]">{it.id}</span>
                    </button>
                    {expanded && (
                      <div className="px-4 pb-3 pl-9">
                        {busy[it.id] && <div className="text-text3 text-[11px] font-mono py-1">…</div>}
                        {!busy[it.id] && list && list.length === 0 && (
                          <div className="text-text3 text-[11px] py-1">Пусто. Прикрепи HTML-схему для этой отрасли.</div>
                        )}
                        {!busy[it.id] && list && list.map(fo => (
                          <div key={fo.path} className="flex items-center gap-2 py-1.5 border-b border-border/20 last:border-b-0">
                            <FileCode2 size={13} className="text-blue shrink-0" style={{ color: '#3DD9FF' }} />
                            <button type="button" onClick={() => view(fo)} className="flex-1 text-left text-text2 hover:text-acc truncate text-[13px]" title={fo.name}>{fo.name}</button>
                            <span className="text-text3 font-mono text-[10px]">{Math.round((fo.size || 0) / 1024)} КБ</span>
                            <button type="button" onClick={() => openTab(fo)} title="Открыть в новой вкладке" className="text-text3 hover:text-acc"><ExternalLink size={13} /></button>
                            <button type="button" onClick={() => download(fo)} title="Скачать" className="text-text3 hover:text-text"><Download size={13} /></button>
                            <button type="button" onClick={() => del(it.id, fo)} title="Удалить (коммит)" className="text-text3 hover:text-danger"><Trash2 size={13} /></button>
                          </div>
                        ))}
                        <button type="button" onClick={() => pickFile(it.id)}
                          className="mt-2 inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-mono border border-border text-text2 hover:text-acc hover:border-acc/40">
                          <Plus size={12} /> прикрепить .html
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>
        ))}
      </div>

      {viewer && (
        <div className="fixed inset-0 z-50 bg-black/70 flex flex-col p-2 sm:p-6" onClick={closeViewer}>
          <div className="bg-bg2 border border-border rounded-lg flex flex-col flex-1 min-h-0 w-full max-w-6xl mx-auto overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 px-4 py-2 border-b border-border select-none">
              <FileCode2 size={14} className="text-acc" />
              <span className="text-text text-sm font-mono truncate flex-1">{viewer.name}</span>
              {viewer.url && (
                <a href={viewer.url} target="_blank" rel="noopener noreferrer" title="Открыть в новой вкладке"
                  className="text-text3 hover:text-acc"><ExternalLink size={14} /></a>
              )}
              <button type="button" onClick={closeViewer} className="text-text3 hover:text-text text-lg leading-none px-1">×</button>
            </div>
            {viewer.url ? (
              <iframe title={viewer.name} src={viewer.url} sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-downloads"
                className="flex-1 w-full bg-white" style={{ border: 'none' }} />
            ) : (
              <div className="flex-1 grid place-items-center text-text3 text-sm font-mono">загрузка схемы…</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
