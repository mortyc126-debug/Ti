const callback = () => console.log("после применения стилей и отрисовки");
requestAnimationFrame(() => requestAnimationFrame(callback));
console.log("до кадра");
