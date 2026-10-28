const элемент = new EventTarget();
const обработчик = () => console.log("сработал");

элемент.addEventListener("click", обработчик, { once: true });

элемент.dispatchEvent(new Event("click"));
элемент.dispatchEvent(new Event("click"));
