const индикатор = document.querySelector("#загрузка");
индикатор.hidden = false;

const данные = await fetch("/api/список")
  .then(ответ => ответ.json())
  .finally(() => { индикатор.hidden = true; });

console.log(данные);
