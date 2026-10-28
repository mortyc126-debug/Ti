const params = new URLSearchParams("тег=js&тег=css&тег=html&страница=2");
console.log(params.getAll("тег"));
console.log(params.getAll("нет такого"));
