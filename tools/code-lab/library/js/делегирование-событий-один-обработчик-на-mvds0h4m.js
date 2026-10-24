const список = document.querySelector("#список");

список.addEventListener("click", (e) => {
  const пункт = e.target.closest("li");
  if (!пункт) return;
  console.log("выбран:", пункт.textContent);
});