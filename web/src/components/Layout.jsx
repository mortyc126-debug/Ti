import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Menu, X } from 'lucide-react';
import SearchBar from './SearchBar.jsx';
import Brand from './Brand.jsx';
import NavLinks from './NavLinks.jsx';
import Footer from './Footer.jsx';

export default function Layout(){
  const [menuOpen, setMenuOpen] = useState(false);
  const loc = useLocation();

  // Закрывать бургер при смене роута — иначе оверлей залипает.
  useEffect(() => { setMenuOpen(false); }, [loc.pathname]);

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-bg2/80 backdrop-blur border-b border-border px-4 sm:px-5 py-2.5 flex items-center gap-3 sm:gap-4 sticky top-0 z-40">
        <Brand />
        <SearchBar />
        <div className="hidden md:block">
          <NavLinks orient="row" />
        </div>
        <button
          type="button"
          className="md:hidden ml-1 w-9 h-9 grid place-items-center rounded text-text2 hover:text-text hover:bg-s2"
          aria-label={menuOpen ? 'Закрыть меню' : 'Открыть меню'}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(v => !v)}
        >
          {menuOpen ? <X size={18} /> : <Menu size={18} />}
        </button>
      </header>

      {menuOpen && (
        <div className="md:hidden border-b border-border bg-bg2 px-4 py-3 animate-fade-in">
          <NavLinks orient="column" onNavigate={() => setMenuOpen(false)} />
        </div>
      )}

      <main className="flex-1 px-4 sm:px-6 py-5 max-w-7xl w-full mx-auto">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}
