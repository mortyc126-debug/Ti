class RatingInput extends HTMLElement {
  connectedCallback() {
    const shadow = this.attachShadow({ mode: "open" });
    const button = document.createElement("button");
    button.textContent = "★ Поставить 5";
    shadow.append(button);

    button.addEventListener("click", () => {
      this.dispatchEvent(
        new CustomEvent("change", { detail: 5, bubbles: true, composed: true })
      );
    });
  }
}

customElements.define("rating-input", RatingInput);
document.body.append(document.createElement("rating-input"));

document.addEventListener("change", event => {
  console.log("Оценка:", event.detail);
});
