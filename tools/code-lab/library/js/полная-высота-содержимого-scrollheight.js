document.body.innerHTML = '<div id="chat" style="height: 100px; overflow: auto"><div style="height: 1000px">Сообщения</div></div>';
const chat = document.querySelector("#chat");

console.log(`scrollHeight = ${chat.scrollHeight}`);
console.log(`clientHeight = ${chat.clientHeight}`);
console.log(`ещё можно прокрутить: ${chat.scrollHeight - chat.clientHeight - chat.scrollTop}`);
