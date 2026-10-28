function dayType(day) {
  switch (day) {
    case "сб":
    case "вс":
      return "выходной";
    case "пн":
    case "вт":
    case "ср":
    case "чт":
    case "пт":
      return "рабочий день";
    default:
      return "неизвестно";
  }
}

console.log(dayType("сб"), dayType("пн"), dayType("xx"));

switch (1) {
  case "1":
    console.log("строка 1");
    break;
  default:
    console.log("1 и «1» — разные значения");
}
