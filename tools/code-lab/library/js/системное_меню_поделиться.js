const кнопка = document.querySelector("#поделиться");

кнопка.addEventListener("click", async () => {
  if (!navigator.share) return;
  await navigator.share({
    title: "Статья",
    text: "Посмотри, что я нашёл",
    url: location.href,
  });
});
