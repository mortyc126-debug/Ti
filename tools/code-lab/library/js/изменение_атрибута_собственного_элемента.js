class Индикатор extends HTMLElement {
  static observedAttributes = ["режим"];
  attributeChangedCallback(имя, старое, новое) { console.log(имя, старое, новое); }
}
customElements.define("мой-индикатор", Индикатор);
