const pattern = "кот\\w*";
const flags = "giu";
const регулярка = new RegExp(pattern, flags);
console.log("Кот, котёнок и Котик".match(регулярка));
console.log(регулярка.flags);
