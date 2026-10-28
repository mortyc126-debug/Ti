document.body.innerHTML = '<div id="outer"><button id="inner">OK</button></div>';
const outer = document.querySelector("#outer");
const inner = document.querySelector("#inner");

outer.addEventListener("click", () => console.log("outer: погружение"), { capture: true });
outer.addEventListener("click", () => console.log("outer: всплытие"));
inner.addEventListener("click", () => console.log("inner: цель"));
