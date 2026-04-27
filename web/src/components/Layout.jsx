import { NavLink, Outlet } from 'react-router-dom';
import SearchBar from './SearchBar.jsx';

const NAV = [
  { to: '/',          label: '🏠 Главная',    end: true },
  { to: '/portfolio', label: '💼 Портфель' },
  { to: '/bonds',     label: '📋 Облигации' },
  { to: '/live',      label: '⚡ Live-цены' },
];

export default function Layout(){
  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-bg2 border-b border-border px-5 py-2.5 flex items-center gap-4 sticky top-0 z-40">
        <div className="flex flex-col leading-tight shrink-0">
          <div className="font-mono text-acc text-base font-bold tracking-wider">БондАналитик</div>
          <div className="text-text3 text-[10px] font-mono">v0.2 • Pages</div>
        </div>
        <SearchBar />
        <nav className="hidden md:flex gap-1 ml-2 shrink-0">
          {NAV.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `px-3 py-1.5 text-xs font-mono uppercase tracking-wider rounded transition-colors ${
                  isActive
                    ? 'bg-acc-dim text-acc'
                    : 'text-text2 hover:text-text hover:bg-s2'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="flex-1 px-6 py-5 max-w-7xl w-full mx-auto">
        <Outlet />
      </main>
      <footer className="text-text3 text-xs font-mono px-6 py-3 border-t border-border">
        Backend: <a className="text-acc hover:underline" href="https://bondan-backend.marginacall.workers.dev/status" target="_blank" rel="noreferrer">bondan-backend.marginacall.workers.dev</a>
      </footer>
    </div>
  );
}
