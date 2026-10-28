const list = document.createElement("div");
list.textContent = "Длинный список";
list.style.padding = "40px";
document.body.append(list);

list.addEventListener(
  "touchstart",
  event => console.log(`Касаний: ${event.touches.length}`),
  { passive: true }
);
