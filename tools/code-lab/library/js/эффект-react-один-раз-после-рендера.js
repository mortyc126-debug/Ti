import { createElement, useEffect, useState } from "react";

export default function Stopwatch() {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const timerId = setInterval(() => setSeconds(previous => previous + 1), 1000);
    return () => clearInterval(timerId);
  }, []);

  return createElement("p", null, `Прошло секунд: ${seconds}`);
}
