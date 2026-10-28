function подписатьсяНаРазмер() {
  const обработчик = () => console.log(window.innerWidth);
  window.addEventListener("resize", обработчик);
  return () => window.removeEventListener("resize", обработчик);
}

const отписаться = подписатьсяНаРазмер();
// позже: отписаться();
