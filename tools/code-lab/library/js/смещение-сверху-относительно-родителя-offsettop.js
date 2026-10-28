document.body.innerHTML = `
  <div id="container" style="position: relative; padding-top: 20px">
    <div style="height: 30px"></div>
    <p id="target" style="margin: 0">Цель</p>
  </div>`;
const target = document.querySelector("#target");

console.log(target.offsetTop);
console.log(target.offsetParent.id);
