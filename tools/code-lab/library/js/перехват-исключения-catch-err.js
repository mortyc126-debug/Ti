const text = "{ неправильный json";

try {
  const data = JSON.parse(text);
  console.log(data);
} catch (err) {
  console.log("Не удалось разобрать JSON:", err.name);
}
