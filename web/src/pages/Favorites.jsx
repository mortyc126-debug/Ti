import { Star, Trash2, ExternalLink, Plus } from 'lucide-react';
import Card from '../components/ui/Card.jsx';
import Badge from '../components/ui/Badge.jsx';
import { useFavorites } from '../store/favorites.js';
import { useWindows } from '../store/windows.js';
import { INDUSTRIES } from '../data/industries.js';

// «Избранное» как папка-сетка ячеек. Каждая ячейка — либо карточка
// эмитента/бумаги (которую можно кинуть в окно), либо «+» — пустой
// слот. Ячейки можно местами менять drag'ом (позже).

export default function Favorites(){
  const slots = useFavorites(s => s.slots);
  const remove = useFavorites(s => s.remove);
  const clear = useFavorites(s => s.clear);
  const openWin = useWindows(s => s.open);

  const filled = slots.filter(Boolean).length;

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Избранное</h1>
          <p className="text-text2 text-sm mt-1">
            Папка-сетка из {slots.length} ячеек. Карточки-ссылки на конкретные эмитенты —
            клик открывает плавающее окно. Добавление через ⭐ в таблице облигаций.
          </p>
        </div>
        {filled > 0 && (
          <button
            onClick={() => confirm('Очистить всё избранное?') && clear()}
            className="text-text3 hover:text-danger text-[11px] font-mono uppercase tracking-wider"
          >
            очистить всё
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {slots.map((s, i) => (
          <Slot key={i} idx={i} item={s} onOpen={() => s && openWin({ kind: s.kind, id: s.refId, title: s.title, ticker: s.ticker, mode: 'medium' })} onRemove={() => remove(i)} />
        ))}
      </div>
    </div>
  );
}

function Slot({ idx, item, onOpen, onRemove }){
  if(!item){
    return (
      <Card padded={false} className="border-dashed opacity-60">
        <div className="aspect-square flex flex-col items-center justify-center gap-2 text-text3 text-xs">
          <Plus size={20} />
          <span className="font-mono">слот {idx + 1}</span>
        </div>
      </Card>
    );
  }
  const ind = item.ind && item.ind !== 'none' ? INDUSTRIES[item.ind] : null;
  return (
    <div className="bg-bg2 border border-border rounded-lg overflow-hidden hover:border-acc/60 transition-colors group">
      <div className="aspect-square p-4 flex flex-col">
        <div className="flex items-start justify-between gap-2">
          <Star size={14} className="text-warn shrink-0" />
          <button
            onClick={onRemove}
            className="text-text3 hover:text-danger opacity-0 group-hover:opacity-100 transition-opacity"
            title="Убрать из избранного"
          >
            <Trash2 size={12} />
          </button>
        </div>
        <button onClick={onOpen} className="flex-1 mt-3 flex flex-col text-left">
          <span className="font-mono text-text text-base font-semibold tracking-tight truncate">{item.title}</span>
          {item.ticker && <span className="font-mono text-text2 text-xs mt-0.5">{item.ticker}</span>}
          <span className="mt-auto flex items-center justify-between gap-2">
            {ind ? <Badge tone="neutral">{ind.label}</Badge> : <span />}
            <ExternalLink size={12} className="text-text3 group-hover:text-acc" />
          </span>
        </button>
      </div>
    </div>
  );
}
