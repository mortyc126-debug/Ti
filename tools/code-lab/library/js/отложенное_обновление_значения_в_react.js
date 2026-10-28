import { useState, useDeferredValue } from "react";

function Поиск({ элементы }) {
  const [запрос, setЗапрос] = useState("");
  const отложенный = useDeferredValue(запрос);
  const найденные = элементы.filter(пункт => пункт.includes(отложенный));

  return (
    <>
      <input value={запрос} onChange={событие => setЗапрос(событие.target.value)} />
      <ul>{найденные.map(пункт => <li key={пункт}>{пункт}</li>)}</ul>
    </>
  );
}
