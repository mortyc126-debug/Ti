const блок = document.querySelector(".блок");
const анимации = блок.getAnimations();

console.log(анимации.length);
анимации.forEach(анимация => анимация.pause());
