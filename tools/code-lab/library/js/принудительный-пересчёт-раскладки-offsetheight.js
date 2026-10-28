document.body.innerHTML = '<div id="box" class="pulse" style="height: 80px; padding: 10px; border: 2px solid">Блок</div>';
const box = document.querySelector("#box");

console.log(box.offsetHeight);

function restartAnimation(target) {
  target.classList.remove("pulse");
  void target.offsetHeight;
  target.classList.add("pulse");
}

restartAnimation(box);
console.log(box.className);
