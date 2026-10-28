const trustedOrigin = "https://widgets.example.com";

const widgetFrame = document.createElement("iframe");
widgetFrame.src = `${trustedOrigin}/calendar`;
document.body.append(widgetFrame);

window.addEventListener("message", event => {
  if (event.origin !== trustedOrigin) return;
  if (typeof event.data?.height !== "number") return;

  widgetFrame.style.height = `${event.data.height}px`;
  console.log("Сообщение принято");
});
