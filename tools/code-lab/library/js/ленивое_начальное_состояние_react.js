import { useState } from "react";

function Тема() {
  const [тема, setТема] = useState(() => localStorage.getItem("тема") ?? "светлая");

  return <button onClick={() => setТема(тема === "светлая" ? "тёмная" : "светлая")}>{тема}</button>;
}
