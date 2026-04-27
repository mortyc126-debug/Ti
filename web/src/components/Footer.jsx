// Подвал с тех. ссылкой и текущим годом. Минималистичный.
import { Server } from 'lucide-react';

export default function Footer(){
  return (
    <footer className="text-text3 text-xs font-mono px-6 py-3 border-t border-border flex items-center justify-between flex-wrap gap-2">
      <div className="flex items-center gap-2">
        <Server size={12} />
        <span>backend:</span>
        <a
          className="text-text2 hover:text-acc transition-colors"
          href="https://bondan-backend.marginacall.workers.dev/status"
          target="_blank" rel="noreferrer"
        >bondan-backend.marginacall.workers.dev</a>
      </div>
      <div className="text-text3">© {new Date().getFullYear()} · ВДО-аналитика</div>
    </footer>
  );
}
