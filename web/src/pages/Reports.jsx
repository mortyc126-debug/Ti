// Страница «Отчёты» — встроенный модуль отчётности (analysiscompany.html)
// на всю область контента (между верхней шапкой и боковой панелью). Свою
// шапку не рисуем — у модуля есть собственная. Тот же origin → localStorage
// (reportsDB, ba_v2) общий с приложением: ручной ввод, шкалы, парсеры нативны.

export default function Reports(){
  return (
    <iframe
      src="/modules/analysiscompany.html"
      title="Отчётность"
      className="flex-1 w-full"
      style={{ border: 'none', display: 'block', minHeight: 0 }}
    />
  );
}
