import { Link } from 'react-router-dom';
import {
  Building2, FileText, Factory, Percent, TrendingUp, Archive,
  Star, ArrowUpRight,
} from 'lucide-react';

// Навигационная сетка разделов. layout='sidebar' — вертикальная узкая
// колонка справа на главной (карточки в один столбец); 'grid' — широкая
// решётка снизу. По умолчанию sidebar.

const ITEMS = [
  { id: 'issuers',   icon: Building2,  title: 'Эмитенты',  sub: 'список + сортировки',     to: '#' },
  { id: 'reports',   icon: FileText,   title: 'Отчёты',    sub: 'от свежих к старым',      to: '#' },
  { id: 'sectors',   icon: Factory,    title: 'Отрасли',   sub: 'диаграммы и сравнения',   to: '#' },
  { id: 'cbr',       icon: Percent,    title: 'КС',        sub: 'ключевая ставка ЦБ',      to: '#' },
  { id: 'ytm',       icon: TrendingUp, title: 'YTM/P&L',   sub: 'калькулятор и безубыток', to: '#' },
  { id: 'favs',      icon: Star,       title: 'Избранное', sub: 'папка с ячейками',        to: '/favorites' },
  { id: 'arch',      icon: Archive,    title: 'Архив',     sub: 'старые версии данных',    to: '#' },
];

export default function SectionsGrid({ layout = 'sidebar' }){
  if(layout === 'sidebar'){
    return (
      <aside className="space-y-2">
        <div className="text-[10px] uppercase tracking-wider text-text3 font-mono px-1">Разделы</div>
        {ITEMS.map(it => <Item key={it.id} it={it} compact />)}
      </aside>
    );
  }
  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-[10px] uppercase tracking-wider text-text3 font-mono">Разделы</h2>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3">
        {ITEMS.map(it => <Item key={it.id} it={it} />)}
      </div>
    </section>
  );
}

function Item({ it, compact }){
  const Icon = it.icon;
  return (
    <Link
      to={it.to}
      className={[
        'group bg-bg2 border border-border rounded-lg hover:border-acc/60 hover:bg-s2/40 transition-colors',
        compact ? 'p-3 flex items-center gap-3' : 'p-4 block',
      ].join(' ')}
    >
      <div className={compact ? 'shrink-0' : 'flex items-center justify-between'}>
        <Icon size={compact ? 16 : 18} className="text-text3 group-hover:text-acc transition-colors" />
        {!compact && <ArrowUpRight size={13} className="text-text3 opacity-0 group-hover:opacity-100 transition-opacity" />}
      </div>
      <div className={compact ? 'flex-1 min-w-0' : 'mt-3'}>
        <div className="text-text text-base font-semibold tracking-tight truncate">{it.title}</div>
        <div className="text-text3 text-[11px] font-mono truncate">{it.sub}</div>
      </div>
      {compact && <ArrowUpRight size={12} className="text-text3 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />}
    </Link>
  );
}
