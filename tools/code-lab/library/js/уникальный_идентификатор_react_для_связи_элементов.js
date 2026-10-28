import { useId } from "react";

function Поле({ подпись }) {
  const id = useId();
  return (
    <>
      <label htmlFor={id}>{подпись}</label>
      <input id={id} />
    </>
  );
}
