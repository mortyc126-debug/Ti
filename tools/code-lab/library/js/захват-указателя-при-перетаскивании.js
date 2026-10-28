const knob = document.createElement("div");
Object.assign(knob.style, { position: "absolute", left: "0px", top: "50px", width: "40px", height: "40px", background: "tomato" });
document.body.append(knob);

knob.addEventListener("pointerdown", event => knob.setPointerCapture(event.pointerId));
knob.addEventListener("pointermove", event => {
  if (knob.hasPointerCapture(event.pointerId)) knob.style.left = `${event.clientX - 20}px`;
});
knob.addEventListener("pointerup", () => console.log(`Отпущено, left = ${knob.style.left}`));
