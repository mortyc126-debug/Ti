document.body.dataset.theme = localStorage.getItem("theme") ?? "light";

window.addEventListener("storage", event => {
  if (event.key !== "theme") return;

  document.body.dataset.theme = event.newValue ?? "light";
  console.log(`Тема изменена в другой вкладке: ${event.oldValue} → ${event.newValue}`);
});
