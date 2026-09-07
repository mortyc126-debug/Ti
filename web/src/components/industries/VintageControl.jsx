// Глобальный выбор винтажа отчётности для страницы «Отрасли»: год + тип.
// «Последний доступный» — у каждого эмитента свой последний год (винтажи
// смешаны, но год виден на карточке). Конкретный год — строгий срез: только
// эмитенты, у кого есть отчёт за этот год (чистое сравнение одногодок).

import { useVintage, reloadIssuers } from '../../store/issuers.js';

export default function VintageControl(){
  const { year, std, years, source, loading, error, count, setYear, setStd } = useVintage();

  const sel = 'bg-bg2 border border-border rounded-md px-2 py-1 text-xs text-text';
  const real = source === 'backend' || source === 'cache';

  return (
    <div className="flex items-center gap-2 flex-wrap text-xs" data-no-drag>
      <span className="text-text3 font-mono uppercase tracking-wider">Отчётность за:</span>
      <select className={sel} value={year === 'latest' ? 'latest' : String(year)}
              onChange={e => setYear(e.target.value === 'latest' ? 'latest' : Number(e.target.value))}>
        <option value="latest">Последний доступный</option>
        {years.map(y => <option key={y} value={y}>{y}</option>)}
      </select>
      <select className={sel} value={std} onChange={e => setStd(e.target.value)}>
        <option value="any">Тип: любой</option>
        <option value="РСБУ">РСБУ</option>
        <option value="МСФО">МСФО</option>
      </select>

      <button type="button" onClick={reloadIssuers} className={sel + ' hover:text-acc'} title="Сбросить кэш и перезагрузить данные с backend">
        ⟳ перезагрузить
      </button>

      {/* статус — видно прямо на странице, без консоли */}
      <span className={real ? 'text-green/80' : 'text-yellow'}>
        {loading ? 'загрузка данных…'
          : real ? `${count} компаний · лет: ${years.length} · backend`
          : `ДЕМО-данные (backend не отдал)${error ? ' · ' + error : ''}`}
      </span>

      {real && year === 'latest' && (
        <span className="text-yellow/80" title="У разных эмитентов последний отчёт за разные годы — винтажи смешаны. Для чистого сравнения выбери конкретный год.">
          ⚠ винтажи смешаны — год на карточке
        </span>
      )}
    </div>
  );
}
