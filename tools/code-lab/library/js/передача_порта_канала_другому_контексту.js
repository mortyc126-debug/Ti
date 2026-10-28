const канал = new MessageChannel();
const рамка = document.querySelector("iframe");

рамка.contentWindow.postMessage("подключение", "*", [канал.port2]);

канал.port1.onmessage = событие => console.log("Ответ рамки:", событие.data);
