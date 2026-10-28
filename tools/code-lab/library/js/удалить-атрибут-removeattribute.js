document.body.innerHTML = '<button id="send" disabled>Отправить</button>';
const sendButton = document.querySelector("#send");

console.log(sendButton.disabled);
sendButton.removeAttribute("disabled");
console.log(sendButton.disabled, sendButton.hasAttribute("disabled"));
