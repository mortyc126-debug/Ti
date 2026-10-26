document.querySelector("#list").addEventListener("click", event => {
  const button = event.target.closest("button[data-id]");
  if (!button) return;
  console.log(button.dataset.id);
});
