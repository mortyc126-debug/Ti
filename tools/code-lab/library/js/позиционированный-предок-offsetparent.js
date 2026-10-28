document.body.innerHTML = `
  <div id="wrapper" style="position: relative"><div id="inner">Внутри</div></div>
  <div id="gone" style="display: none">Скрыт</div>`;
const inner = document.querySelector("#inner");
const wrapper = document.querySelector("#wrapper");
const gone = document.querySelector("#gone");

console.log(inner.offsetParent.id);
console.log(wrapper.offsetParent === document.body);
console.log(gone.offsetParent);
