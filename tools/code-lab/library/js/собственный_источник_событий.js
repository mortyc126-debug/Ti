const шина = new EventTarget();
const обработчик = () => console.log("готово");

шина.addEventListener("ready", обработчик);
шина.dispatchEvent(new Event("ready"));

шина.removeEventListener("ready", обработчик);
шина.dispatchEvent(new Event("ready"));
