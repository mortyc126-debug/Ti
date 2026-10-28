const форма = document.querySelector("form");

форма.addEventListener("submit", событие => {
  событие.preventDefault();
  const данные = new FormData(форма, событие.submitter);
  console.log(данные.get("действие"));
});
