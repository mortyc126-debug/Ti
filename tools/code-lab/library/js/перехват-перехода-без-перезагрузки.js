const navigation = new EventTarget(); // вместо настоящего Navigation API
function render() {
  console.log("страница отрисована без перезагрузки");
}
navigation.addEventListener("navigate", event => { if (event.canIntercept) event.intercept({ handler: render }) });

const переход = new Event("navigate");
переход.canIntercept = true;
переход.intercept = параметры => параметры.handler();
navigation.dispatchEvent(переход);
