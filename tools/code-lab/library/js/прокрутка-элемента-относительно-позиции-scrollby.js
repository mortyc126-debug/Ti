document.body.innerHTML = '<div id="chat" style="height: 100px; overflow: auto"><div style="height: 1000px">Сообщения</div></div>';
const chat = document.querySelector("#chat");

chat.scrollBy({ top: 100, behavior: "smooth" });

setTimeout(() => console.log(`Прокручено на ${chat.scrollTop}`), 1000);
