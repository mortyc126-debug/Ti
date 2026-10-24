function разобрать(текст) {
  try {
    return JSON.parse(текст);
  } catch (e) {
    console.log("ошибка:", e.name);
    return null;
  } finally {
    console.log("разбор закончен");
  }
}

console.log(разобрать('{"a": 1}'));
console.log(разобрать("не json"));