document.body.innerHTML = '<button id="send" disabled>Отправить</button>';
const sendButton = document.querySelector("#send");

console.log(sendButton.hasAttribute("disabled"));
console.log(sendButton.hasAttribute("hidden"));
