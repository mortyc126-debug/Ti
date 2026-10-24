const color = "blue";
let meaning;

switch (color) {
  case "red":
    meaning = "Энергия";
    break;
  case "blue":
    meaning = "Спокойствие";
    break;
  default:
    meaning = "Неизвестный цвет";
}

console.log(meaning);