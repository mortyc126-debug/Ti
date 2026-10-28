const хешСкрипта = "sha256-Заменить_на_настоящий_хеш_ресурса=";

try {
  const ответ = await fetch("https://cdn.example.com/lib.js", {
    integrity: хешСкрипта,
  });
  console.log("Ресурс целый:", ответ.ok);
} catch (ошибка) {
  console.log("Хеш не совпал:", ошибка.name);
}
