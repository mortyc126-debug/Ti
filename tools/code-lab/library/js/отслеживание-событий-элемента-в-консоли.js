const element = document.createElement("button");
document.body.append(element);

if (typeof monitorEvents === "function") {
  monitorEvents(element, "click");
} else {
  console.log("monitorEvents есть только в консоли DevTools");
}
