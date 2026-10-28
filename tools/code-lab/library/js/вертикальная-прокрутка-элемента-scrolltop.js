document.body.innerHTML = '<div id="chat" style="height: 100px; overflow: auto"><div style="height: 1000px">Сообщения</div></div>';
const chat = document.querySelector("#chat");

console.log(chat.scrollTop);
chat.scrollTop = chat.scrollHeight;
console.log(chat.scrollTop);
