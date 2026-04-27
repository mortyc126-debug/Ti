import { Link } from 'react-router-dom';
import {
  Building2, FileText, Factory, Percent, TrendingUp, Archive, ArrowUpRight,
} from 'lucide-react';

// Навигационная сетка разделов: ссылки-карточки с короткой подписью.
// Все ведут на «#» — реальные роуты появятся, когда соответствующая
// страница будет готова (пока мы не плодим пустые маршруты).

const ITEMS = [
  { id: 'issuers', icon: Building2, title: 'Эмитенты', sub: 'список + сортировки',         to: '#' },
  { id: 'reports', icon: FileText,  title: 'Отчёты',   sub: 'от свежих к старым',          to: '#' },
  { id: 'sectors', icon: Factory,   title: 'Отрасли',  sub: 'диаграммы и сравнения',       to: '#' },
  { id: 'cbr',     icon: Percent,   title: 'КС',       sub: 'ключевая ставка ЦБ',          to: '#' },
  { id: 'ytm',     icon: TrendingUp,title: 'YTM/P&L',  sub: 'калькулятор и безубыток',     to: '#' },
  { id: 'arch',    icon: Archive,   title: 'Архив',    sub: 'старые версии данных',        to: '#' },
];

export default function SectionsGrid(){
  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-[10px] uppercase tracking-wider text-text3 font-mono">Разделы</h2>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {ITEMS.map(it => {
          const Icon = it.icon;
          return (
            <Link
              key={it.id}
              to={it.to}
              className="group bg-bg2 border border-border rounded-lg p-4 hover:border-acc/60 hover:bg-s2/40 transition-colors"
            >
              <div className="flex items-center justify-between">
                <Icon size={16} className="text-text3 group-hover:text-acc transition-colors" />
                <ArrowUpRight size={12} className="text-text3 opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
              <div className="mt-3 text-text font-medium">{it.title}</div>
              <div className="text-text3 text-[11px] font-mono mt-0.5">{it.sub}</div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
