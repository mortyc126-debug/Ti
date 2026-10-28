document.body.style.minHeight = "3000px";

const topButton = document.createElement("button");
topButton.textContent = "Наверх";
Object.assign(topButton.style, { position: "fixed", right: "16px", bottom: "16px" });
document.body.append(topButton);

topButton.addEventListener("click", () => {
  window.scrollTo({ top: 0, behavior: "smooth" });
});
