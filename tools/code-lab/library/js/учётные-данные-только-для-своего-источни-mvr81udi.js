const ответ = await fetch("/api/профиль", {
  mode: "cors",
  credentials: "same-origin",
});
const профиль = await ответ.json();
console.log(профиль);