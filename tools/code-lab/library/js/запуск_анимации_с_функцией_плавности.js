const блок = document.querySelector(".блок");

const анимация = блок.animate(
  [{ transform: "translateX(0)" }, { transform: "translateX(200px)" }],
  { duration: 200, easing: "ease-out" }
);
