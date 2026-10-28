const шаблон = document.querySelector("#карточка");
const фрагмент = шаблон.content.cloneNode(true);

фрагмент.querySelector(".заголовок").textContent = "Новость";
document.querySelector("#список").append(фрагмент);
