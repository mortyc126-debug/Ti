const блок = document.querySelector(".блок");
const движение = блок.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
await движение.finished;
console.log("Готово");