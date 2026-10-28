import { useCallback, useState, memo } from "react";

const Кнопка = memo(function Кнопка({ onClick }) {
  return <button onClick={onClick}>Плюс</button>;
});

function Счётчик() {
  const [число, setЧисло] = useState(0);
  const добавить = useCallback(() => setЧисло(прежнее => прежнее + 1), []);

  return (
    <>
      <p>{число}</p>
      <Кнопка onClick={добавить} />
    </>
  );
}
