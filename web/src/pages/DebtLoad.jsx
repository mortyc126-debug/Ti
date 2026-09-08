// Страница «Долг» — встроенный модуль долговой нагрузки (debt_v7 →
// debtload.html) на всю область контента. У модуля своя шапка и своя
// тема (та же фиолетово-магента палитра, что и у сайта). Тот же origin →
// localStorage общий с приложением. Данные MOEX тянутся через Worker-прокси.

export default function DebtLoad(){
  return (
    <iframe
      src="/modules/debtload.html"
      title="Долговая нагрузка"
      className="flex-1 w-full"
      style={{ border: 'none', display: 'block', minHeight: 0 }}
    />
  );
}
