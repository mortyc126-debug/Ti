document.body.innerHTML = `
  <div id="shown">Виден</div>
  <div id="removed" style="display: none">Скрыт</div>
  <div id="invisible" style="visibility: hidden">Невидим</div>`;

for (const id of ["shown", "removed", "invisible"]) {
  console.log(id, document.getElementById(id).checkVisibility());
}

const invisible = document.getElementById("invisible");
console.log("invisible с visibilityProperty", invisible.checkVisibility({ visibilityProperty: true }));
