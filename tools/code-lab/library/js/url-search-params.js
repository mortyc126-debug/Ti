const параметры = new URLSearchParams({ поиск: "серебро", страница: "2" });
параметры.append("тег", "металл");
console.log(параметры.toString());
