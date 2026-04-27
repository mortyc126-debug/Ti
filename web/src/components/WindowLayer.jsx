import { Rnd } from 'react-rnd';
import { useWindows } from '../store/windows.js';

// Слой плавающих окон. Рендерится один раз в App.jsx поверх Outlet.
// Сейчас содержит только каркас окна — пустые вкладки и шапку.
// Содержимое (метрики, выпуски, графики) будет добавлено в следующих
// коммитах по мере готовности данных.

export default function WindowLayer(){
  const windows = useWindows(s => s.windows);
  return (
    <div className="pointer-events-none fixed inset-0 z-30">
      {windows.map(w => <FloatingWindow key={w.wid} win={w} />)}
    </div>
  );
}

function FloatingWindow({ win }){
  const { close, duplicate, focus, setMode, setTab, patch } = useWindows.getState();
  const isMicro = win.mode === 'micro';
  const isFull  = win.mode === 'full';

  // в fullscreen окно занимает почти весь экран (с отступом под шапку)
  const rndProps = isFull
    ? { size: { width: window.innerWidth - 24, height: window.innerHeight - 80 },
        position: { x: 12, y: 64 },
        disableDragging: true, enableResizing: false }
    : { size: { width: win.w, height: win.h },
        position: { x: win.x, y: win.y },
        bounds: 'window',
        dragHandleClassName: 'win-drag',
        minWidth: 280, minHeight: 160,
        onDragStop: (_, d) => patch(win.wid, { x: d.x, y: d.y }),
        onResizeStop: (_, __, ref, ___, pos) =>
          patch(win.wid, { w: parseInt(ref.style.width, 10), h: parseInt(ref.style.height, 10), x: pos.x, y: pos.y }) };

  return (
    <Rnd
      {...rndProps}
      style={{ zIndex: win.z, pointerEvents: 'auto' }}
      onMouseDown={() => focus(win.wid)}
    >
      <div className="w-full h-full bg-bg2 border border-border2 rounded-lg shadow-2xl flex flex-col overflow-hidden">
        {/* шапка окна */}
        <div className="win-drag flex items-center gap-2 px-3 h-9 bg-s2 border-b border-border cursor-move select-none">
          <span className="text-acc text-xs">●</span>
          <span className="font-mono text-text text-sm font-semibold truncate">{win.title}</span>
          {win.ticker && <span className="font-mono text-text3 text-xs">{win.ticker}</span>}
          <div className="ml-auto flex items-center gap-1">
            <HeaderBtn title="Дублировать"  onClick={() => duplicate(win.wid)}>⧉</HeaderBtn>
            {isMicro
              ? <HeaderBtn title="Развернуть" onClick={() => setMode(win.wid, 'medium')}>↕</HeaderBtn>
              : isFull
                ? <HeaderBtn title="Свернуть" onClick={() => setMode(win.wid, 'medium')}>↙</HeaderBtn>
                : <>
                    <HeaderBtn title="Свернуть до Micro" onClick={() => setMode(win.wid, 'micro')}>▭</HeaderBtn>
                    <HeaderBtn title="На весь экран"     onClick={() => setMode(win.wid, 'full')}>⛶</HeaderBtn>
                  </>}
            <HeaderBtn title="Закрыть" onClick={() => close(win.wid)}>✕</HeaderBtn>
          </div>
        </div>

        {/* содержимое */}
        {isMicro
          ? <MicroBody win={win} />
          : <MediumBody win={win} setTab={setTab} />}
      </div>
    </Rnd>
  );
}

function HeaderBtn({ title, onClick, children }){
  return (
    <button
      title={title}
      onClick={onClick}
      className="w-6 h-6 flex items-center justify-center text-text3 hover:text-text hover:bg-bg2 rounded text-xs"
    >{children}</button>
  );
}

const TABS = [
  { id: 'finances', label: 'Финансы' },
  { id: 'papers',   label: 'Бумаги' },
  { id: 'links',    label: 'Связи' },
  { id: 'events',   label: 'События' },
];

function MediumBody({ win, setTab }){
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex border-b border-border bg-bg2">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(win.wid, t.id)}
            className={`px-3 h-8 text-xs font-mono uppercase tracking-wider transition-colors ${
              win.tab === t.id
                ? 'text-acc border-b-2 border-acc -mb-px'
                : 'text-text2 hover:text-text'
            }`}
          >{t.label}</button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto p-4 text-text2 text-sm">
        <Placeholder kind={win.kind} tab={win.tab} title={win.title} />
      </div>
    </div>
  );
}

function MicroBody({ win }){
  return (
    <div className="flex-1 p-3 text-text2 text-xs space-y-2">
      <div className="flex justify-between text-text3 uppercase tracking-wider">
        <span>{win.kind}</span>
        <span>📊 4 метрики</span>
      </div>
      <div className="text-text font-mono text-sm">{win.title}</div>
      <div className="text-text3 italic">Содержимое Micro-виджета — следующий коммит.</div>
    </div>
  );
}

function Placeholder({ kind, tab, title }){
  return (
    <div className="space-y-2">
      <div className="text-text font-mono">{title}</div>
      <div className="text-text3 text-xs">
        Окно типа <span className="text-acc">{kind}</span>, активная вкладка <span className="text-acc">{tab}</span>.
      </div>
      <div className="text-text3 text-xs italic">
        Содержимое будет подключено в следующих коммитах: метрики (Финансы),
        список выпусков (Бумаги), граф контрагентов (Связи), хронология (События).
      </div>
    </div>
  );
}
