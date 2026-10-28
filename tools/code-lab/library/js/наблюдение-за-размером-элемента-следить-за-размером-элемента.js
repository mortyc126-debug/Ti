const panel = document.querySelector(".panel");
const observer = new ResizeObserver(entries => {
  for (const entry of entries) console.log(entry.contentRect.width);
});
observer.observe(panel);
