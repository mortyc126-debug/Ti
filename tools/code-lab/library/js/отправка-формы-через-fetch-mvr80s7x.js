const анкета = document.querySelector("#анкета");

анкета.addEventListener("submit", async событие => {
  событие.preventDefault();
  const ответ = await fetch(анкета.action, {
    method: анкета.method,
    body: new FormData(анкета),
  });
  console.log(ответ.status);
});