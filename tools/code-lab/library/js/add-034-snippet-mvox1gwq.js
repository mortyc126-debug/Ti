function onResize() { console.log(window.innerWidth); }
window.addEventListener("resize", onResize);
window.removeEventListener("resize", onResize);
