import { useState } from "react";

function Счётчик() {
  const [число, setЧисло] = useState(0);

  const добавитьДва = () => {
    setЧисло(прежнее => прежнее + 1);
    setЧисло(прежнее => прежнее + 1);
  };

  return <button onClick={добавитьДва}>{число}</button>;
}
