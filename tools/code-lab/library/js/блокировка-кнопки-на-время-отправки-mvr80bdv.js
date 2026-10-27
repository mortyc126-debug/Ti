const кнопка = document.querySelector("#отправить");

кнопка.addEventListener("click", async () => {
  кнопка.disabled = true;
  try {
    await fetch("/api/отправить", { method: "POST" });
  } finally {
    кнопка.disabled = false;
  }
});