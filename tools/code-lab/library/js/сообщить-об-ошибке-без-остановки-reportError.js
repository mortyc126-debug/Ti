window.addEventListener("error", event => {
  console.log(`Перехвачено: ${event.message}`);
});

[1, 2, 3].forEach(item => {
  try {
    if (item === 2) throw new Error("Сбой на элементе 2");
    console.log(`Элемент ${item} обработан`);
  } catch (error) {
    reportError(error);
  }
});
