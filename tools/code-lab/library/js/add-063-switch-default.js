function label(status) {
  switch (status) {
    case "ok": return "Готово";
    case "pending": return "В ожидании";
    case "error": return "Ошибка";
    default: return "Неизвестный статус";
  }
}
console.log(label("other"));
