const viewer = document.createElement("div");
viewer.textContent = "Крутите колесо";
viewer.style.padding = "40px";
document.body.append(viewer);

let zoom = 1;
viewer.addEventListener(
  "wheel",
  event => {
    event.preventDefault();
    zoom += event.deltaY < 0 ? 0.1 : -0.1;
    console.log(`Масштаб: ${zoom.toFixed(1)}`);
  },
  { passive: false }
);
