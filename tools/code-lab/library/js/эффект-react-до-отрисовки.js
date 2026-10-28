import { createElement, useLayoutEffect, useRef, useState } from "react";

export default function Tooltip({ text }) {
  const boxRef = useRef(null);
  const [shiftLeft, setShiftLeft] = useState(0);

  useLayoutEffect(() => {
    const { right } = boxRef.current.getBoundingClientRect();
    if (right > window.innerWidth) setShiftLeft(window.innerWidth - right);
  }, [text]);

  return createElement(
    "div",
    { ref: boxRef, style: { position: "relative", left: shiftLeft } },
    text
  );
}
