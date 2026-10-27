const шина = new EventTarget();

шина.addEventListener("ready", событие => {
  console.log("Готово:", событие.detail.имя);
});

шина.dispatchEvent(new CustomEvent("ready", { detail: { имя: "модуль" } }));