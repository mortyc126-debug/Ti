import { useState, useTransition } from "react";

function Поиск({ всеЭлементы }) {
  const [запрос, setЗапрос] = useState("");
  const [список, setСписок] = useState(всеЭлементы);
  const [ожидание, startTransition] = useTransition();

  function изменить(событие) {
    const текст = событие.target.value;
    setЗапрос(текст);
    startTransition(() => {
      setСписок(всеЭлементы.filter(пункт => пункт.includes(текст)));
    });
  }

  return (
    <>
      <input value={запрос} onChange={изменить} />
      {ожидание && <p>Обновляю…</p>}
      <ul>{список.map(пункт => <li key={пункт}>{пункт}</li>)}</ul>
    </>
  );
}
