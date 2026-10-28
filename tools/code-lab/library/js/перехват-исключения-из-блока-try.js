const settings = null;

try {
  console.log(settings.theme);
} catch (error) {
  console.log(`Ошибка: ${error.name}`);
}

console.log("Программа продолжает работу");
