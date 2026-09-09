// Страница «Долг» — встроенный модуль долговой нагрузки (debtload.html) на
// всю область контента. Принимает ?q=<тикер|имя|ISIN> из роута и прокидывает
// в iframe — так с любой карточки компании можно «перейти в Долг» по цели.

import { useSearchParams } from 'react-router-dom';

export default function DebtLoad(){
  const [params] = useSearchParams();
  const q = (params.get('q') || '').trim();
  const src = q ? `/modules/debtload.html?q=${encodeURIComponent(q)}` : '/modules/debtload.html';
  return (
    <iframe
      key={src}                         /* смена цели → перезагрузка модуля */
      src={src}
      title="Долговая нагрузка"
      className="flex-1 w-full"
      style={{ border: 'none', display: 'block', minHeight: 0 }}
    />
  );
}
