const box = document.createElement("div");
Object.assign(box.style, { width: "200px", padding: "10px", border: "5px solid" });
document.body.append(box);

const observer = new ResizeObserver(entries => {
  for (const entry of entries) {
    console.log(`Ширина содержимого: ${entry.contentBoxSize[0].inlineSize}`);
  }
});
observer.observe(box);
