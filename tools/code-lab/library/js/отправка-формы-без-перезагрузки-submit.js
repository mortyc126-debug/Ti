document.body.innerHTML = '<form id="login"><input name="email" value="mira@example.com"><button>Войти</button></form>';
const form = document.querySelector("#login");

form.addEventListener("submit", event => {
  event.preventDefault();
  const data = new FormData(form);
  console.log(`Отправка: ${data.get("email")}`);
});
