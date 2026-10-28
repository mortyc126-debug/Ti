const ответ = await fetch("https://api.example.com/счётчик", {
  referrerPolicy: "no-referrer",
});
console.log(ответ.status);
