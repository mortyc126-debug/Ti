const isSmallScreen = screen.width < 768;

console.log(`Ширина экрана: ${screen.width}px`);
console.log(isSmallScreen ? "Похоже на телефон" : "Похоже на компьютер");
