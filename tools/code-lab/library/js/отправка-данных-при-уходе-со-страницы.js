const url = "/аналитика";
const data = JSON.stringify({ событие: "уход со страницы" });
const принято = navigator.sendBeacon(url, data);
console.log(принято);
