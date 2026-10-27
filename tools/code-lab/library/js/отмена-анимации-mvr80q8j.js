const блок = document.querySelector(".блок");
const движение = блок.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 1000 });
движение.cancel();