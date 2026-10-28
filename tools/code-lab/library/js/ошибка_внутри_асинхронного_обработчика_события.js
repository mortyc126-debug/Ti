const кнопка = document.querySelector("#сохранить");

async function сохранить() {
  await fetch("/api/сохранить", { method: "POST" });
}

function показатьОшибку(ошибка) {
  console.error("Не удалось сохранить:", ошибка.message);
}

кнопка.addEventListener("click", async событие => {
  try {
    await сохранить();
  } catch (ошибка) {
    показатьОшибку(ошибка);
  }
});
