const строка = "цена=10; цена=25";
const результат = строка.replace(/\d+/g, число => String(Number(число) * 2));
console.log(результат);
