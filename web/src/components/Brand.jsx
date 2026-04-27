// Логотип-блок в шапке. Кликабельный, ведёт на главную.
import { Link } from 'react-router-dom';

export default function Brand(){
  return (
    <Link to="/" className="flex items-center gap-2.5 shrink-0 group" aria-label="БондАналитик — на главную">
      <span
        aria-hidden
        className="w-7 h-7 rounded-md bg-bg2 border border-border2 grid place-items-center font-mono font-bold text-acc text-sm group-hover:border-acc transition-colors"
      >₿</span>
      <span className="flex flex-col leading-tight">
        <span className="font-mono text-text text-sm font-bold tracking-wide group-hover:text-acc transition-colors">
          БондАналитик
        </span>
        <span className="text-text3 text-[10px] font-mono">v0.3 · Pages</span>
      </span>
    </Link>
  );
}
