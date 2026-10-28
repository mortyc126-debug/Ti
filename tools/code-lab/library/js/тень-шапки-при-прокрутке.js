document.body.style.minHeight = "3000px";

const header = document.createElement("header");
header.textContent = "Мой сайт";
Object.assign(header.style, {
  position: "sticky",
  top: "0",
  padding: "12px",
  background: "white",
});
document.body.prepend(header);

function updateHeaderShadow() {
  header.style.boxShadow = window.scrollY > 0 ? "0 2px 6px rgba(0, 0, 0, 0.25)" : "none";
}

window.addEventListener("scroll", updateHeaderShadow);
updateHeaderShadow();
