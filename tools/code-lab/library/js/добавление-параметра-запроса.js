const params = new URLSearchParams("цвет=красный");
params.append("цвет", "синий");
params.append("размер", "средний");
console.log(decodeURIComponent(params.toString()));
console.log(params.getAll("цвет"));
