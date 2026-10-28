import { useReducer } from "react";

function редьюсер(состояние, действие) {
  switch (действие.тип) {
    case "добавить": return { ...состояние, число: состояние.число + 1 };
    case "сбросить": return { число: 0 };
    default: return состояние;
  }
}

function Счётчик() {
  const [состояние, dispatch] = useReducer(редьюсер, { число: 0 });
  return (
    <>
      <button onClick={() => dispatch({ тип: "добавить" })}>{состояние.число}</button>
      <button onClick={() => dispatch({ тип: "сбросить" })}>сброс</button>
    </>
  );
}
