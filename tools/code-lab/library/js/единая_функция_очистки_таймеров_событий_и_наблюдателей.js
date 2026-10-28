const таймер = setTimeout(() => console.log("тик"), 1000);
const обработчик = () => console.log("размер окна изменился");
window.addEventListener("resize", обработчик);

const наблюдатель = new ResizeObserver(() => console.log("блок изменился"));
наблюдатель.observe(document.body);

const очистка = () => {
  clearTimeout(таймер);
  window.removeEventListener("resize", обработчик);
  наблюдатель.disconnect();
};
