const блок = document.querySelector(".блок");
const движение = блок.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1000 });
движение.pause();
