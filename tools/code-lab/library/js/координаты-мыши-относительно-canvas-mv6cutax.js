const canvas = document.querySelector("#scene");

canvas.addEventListener("mousemove", event => {
  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) * canvas.width / rect.width;
  const y = (event.clientY - rect.top) * canvas.height / rect.height;
  console.log(x.toFixed(0), y.toFixed(0));
});