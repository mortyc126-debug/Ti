import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import './index.css';

// HashRouter, а не BrowserRouter — чтобы приложение одинаково
// открывалось и через CF Pages, и из standalone-HTML (githack/file://),
// без необходимости в SPA-fallback на сервере.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <HashRouter>
        <App />
      </HashRouter>
    </ErrorBoundary>
  </StrictMode>,
);
