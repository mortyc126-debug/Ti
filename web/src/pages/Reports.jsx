// Страница «Отчёты» — встроенный модуль отчётности (analysiscompany.html)
// на всю область контента. Тот же origin → localStorage/IndexedDB общий с
// приложением. Принимает ?inn=<ИНН> / ?issuer=<имя> из роута и прокидывает
// в iframe — так из «Портфеля» и др. можно открыть отчётность по эмитенту.

import { useSearchParams } from 'react-router-dom';

export default function Reports(){
  const [params] = useSearchParams();
  const inn = (params.get('inn') || '').trim();
  const issuer = (params.get('issuer') || '').trim();
  const qs = new URLSearchParams();
  if(inn) qs.set('inn', inn);
  if(issuer) qs.set('issuer', issuer);
  const q = qs.toString();
  const src = '/modules/analysiscompany.html' + (q ? '?' + q : '');

  return (
    <iframe
      key={src}                         /* смена эмитента → перезагрузка модуля */
      src={src}
      title="Отчётность"
      className="flex-1 w-full"
      style={{ border: 'none', display: 'block', minHeight: 0 }}
    />
  );
}
