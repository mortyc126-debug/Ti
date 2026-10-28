const ответ = prompt("Как вас зовут?", "Гость");

if (ответ === null) {
  console.log("Ввод отменён");
} else {
  console.log(`Привет, ${ответ}!`);
}
