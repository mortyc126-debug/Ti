const база = { роль: "база" };
const объект = Object.create(база);
объект.имя = "узел";
console.log(Object.hasOwn(объект, "имя"));
console.log(Object.hasOwn(объект, "роль"));
console.log("роль" in объект);
