function скрытьПодсказку(скрыто) {
  const подсказка = document.querySelector("#подсказка");
  подсказка?.setAttribute("aria-hidden", String(скрыто));
}

скрытьПодсказку(true);
