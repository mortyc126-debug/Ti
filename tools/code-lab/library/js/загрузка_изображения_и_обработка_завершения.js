const картинка = new Image();
const рисунок = document.querySelector("canvas").getContext("2d");

картинка.onload = () => рисунок.drawImage(картинка, 0, 0);
картинка.onerror = () => console.error("Не удалось загрузить изображение");
картинка.src = "/снимки/горы.png";
