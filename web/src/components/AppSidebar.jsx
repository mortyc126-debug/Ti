import { Link, useLocation } from 'react-router-dom';
import {
  Building2, FileText, Factory, Percent, TrendingUp, Archive,
  Star, ChevronsLeft, ChevronsRight,
} from 'lucide-react';
import { useSidebar } from '../store/sidebar.js';

// Глобальный sidebar — список разделов справа на каждой странице.
// Свёрнут: только иконки (узкая колонка ~52px). Развёрнут: иконки +
// подписи (~220px). Состояние persist в localStorage.

const ITEMS = [
  { id: 'issuers', icon: Building2,  label: 'Эмитенты',  to: '#' },
  { id: 'reports', icon: FileText,   label: 'Отчёты',    to: '#' },
  { id: 'sectors', icon: Factory,    label: 'Отрасли',   to: '/industries' },
  { id: 'cbr',     icon: Percent,    label: 'КС',        to: '#' },
  { id: 'ytm',     icon: TrendingUp, label: 'YTM/P&L',   to: '#' },
  { id: 'favs',    icon: Star,       label: 'Избранное', to: '/favorites' },
  { id: 'arch',    icon: Archive,    label: 'Архив',     to: '#' },
];

export default function AppSidebar(){
  const expanded = useSidebar(s => s.expanded);
  const toggle   = useSidebar(s => s.toggle);
  const loc      = useLocation();

  return (
    <aside
      className={[
        'shrink-0 border-l border-border bg-bg2/40 transition-[width] duration-150 hidden md:flex flex-col',
        expanded ? 'w-[200px]' : 'w-[52px]',
      ].join(' ')}
    >
      <button
        type="button"
        onClick={toggle}
        title={expanded ? 'Свернуть' : 'Развернуть'}
        className="h-9 flex items-center justify-end px-2 border-b border-border text-text3 hover:text-text"
      >
        {expanded ? <ChevronsRight size={14} /> : <ChevronsLeft size={14} />}
      </button>

      <nav className="flex-1 p-2 space-y-1 overflow-y-auto">
        {ITEMS.map(it => {
          const Icon = it.icon;
          const active = it.to !== '#' && loc.pathname.startsWith(it.to) && it.to !== '/';
          return (
            <Link
              key={it.id}
              to={it.to}
              title={!expanded ? it.label : undefined}
              className={[
                'flex items-center gap-3 rounded h-9 px-2 transition-colors',
                active
                  ? 'bg-acc-dim text-acc'
                  : 'text-text2 hover:text-text hover:bg-s2/60',
                expanded ? '' : 'justify-center',
              ].join(' ')}
            >
              <Icon size={16} className="shrink-0" />
              {expanded && (
                <span className="text-sm font-mono truncate">{it.label}</span>
              )}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
