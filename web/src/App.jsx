import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import WindowLayer from './components/WindowLayer.jsx';
import Home from './pages/Home.jsx';
import Portfolio from './pages/Portfolio.jsx';
import Bonds from './pages/Bonds.jsx';
import Live from './pages/Live.jsx';

export default function App(){
  return (
    <>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="portfolio" element={<Portfolio />} />
          <Route path="bonds" element={<Bonds />} />
          <Route path="live" element={<Live />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      {/* Слой плавающих окон — поверх всех страниц, общий стейт через
          zustand-store, состояние сохраняется в localStorage. */}
      <WindowLayer />
    </>
  );
}
