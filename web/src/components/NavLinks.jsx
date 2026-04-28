// Навигация между страницами. orient: row (десктоп) | column (моб. меню).
// Иконки lucide — единообразно во всех местах.
import { NavLink } from 'react-router-dom';
import { Home, Briefcase, ListChecks, Activity, Star, Map } from 'lucide-react';

const ITEMS = [
  { to: '/',          label: 'Главная',   end: true,  icon: Home },
  { to: '/portfolio', label: 'Портфель',  icon: Briefcase },
  { to: '/bonds',     label: 'Облигации', icon: ListChecks },
  { to: '/market',    label: 'Карта',     icon: Map },
  { to: '/live',      label: 'Live',      icon: Activity },
  { to: '/favorites', label: 'Избранное', icon: Star },
];

export default function NavLinks({ orient = 'row', onNavigate }){
  const wrap = orient === 'column'
    ? 'flex flex-col gap-1'
    : 'flex gap-1';
  return (
    <nav className={wrap}>
      {ITEMS.map(({ to, label, end, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          onClick={onNavigate}
          className={({ isActive }) =>
            [
              'flex items-center gap-2 px-3 py-1.5 text-xs font-mono uppercase tracking-wider rounded transition-colors',
              orient === 'column' ? 'w-full' : '',
              isActive
                ? 'bg-acc-dim text-acc'
                : 'text-text2 hover:text-text hover:bg-s2',
            ].join(' ')
          }
        >
          <Icon size={14} />
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
