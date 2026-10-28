const обработчик = событие => {
  console.log("Прокрутка касанием", событие.touches.length);
};

document.addEventListener("touchmove", обработчик, { passive: true });
