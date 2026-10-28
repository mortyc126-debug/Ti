const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const square = document.createElement("div");
Object.assign(square.style, { width: "60px", height: "60px", background: "tomato" });
document.body.append(square);

square.animate(
  [{ transform: "translateX(0)" }, { transform: "translateX(240px)" }],
  { duration: reduceMotion ? 0 : 600, fill: "forwards" }
);

console.log(reduceMotion ? "Анимация отключена" : "Анимация включена");
