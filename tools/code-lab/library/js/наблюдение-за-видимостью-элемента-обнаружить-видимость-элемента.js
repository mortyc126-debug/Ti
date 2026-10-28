const observer = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (entry.isIntersecting) console.log("Элемент виден");
  }
});
observer.observe(document.querySelector(".target"));
