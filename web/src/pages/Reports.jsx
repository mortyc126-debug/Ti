// Страница «Отчёты». Пока — встраиваем существующий модуль отчётности
// (analysiscompany.html) как есть, в iframe. Тот же origin (localhost/Pages),
// поэтому localStorage (reportsDB, ba_v2) общий с остальным приложением:
// ручной ввод периодов, шкалы коэффициентов, парсеры — работают нативно,
// без переписывания 30k строк. Позже перенесём по частям, если понадобится.

export default function Reports(){
  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Отчётность</h1>
          <p className="text-text2 text-sm mt-1">
            Ввод и разбор отчётности эмитентов, периоды, коэффициенты. Данные — в
            общем localStorage (reportsDB), видны в сравнении и картах.
          </p>
        </div>
        <a href="/modules/analysiscompany.html" target="_blank" rel="noopener"
           className="text-xs text-text3 hover:text-acc border border-border rounded-md px-2 py-1">
          открыть в отдельной вкладке ↗
        </a>
      </div>
      <div className="border border-border rounded-lg overflow-hidden bg-bg2"
           style={{ height: 'calc(100vh - 150px)' }}>
        <iframe
          src="/modules/analysiscompany.html"
          title="Отчётность"
          className="w-full h-full"
          style={{ border: 'none', display: 'block' }}
        />
      </div>
    </div>
  );
}
