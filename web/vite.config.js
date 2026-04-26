import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite-сборщик. На локальной разработке (npm run dev) проксируем /api
// на наш Cloudflare Worker — чтобы fetch('/api/...') ходил к нему,
// а в продакшене fetch использует переменную VITE_BACKEND_URL.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'https://bondan-backend.marginacall.workers.dev',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
