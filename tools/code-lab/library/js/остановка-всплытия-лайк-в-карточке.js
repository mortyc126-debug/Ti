document.body.innerHTML = '<div id="card"><button id="like">Нравится</button></div>';
const card = document.querySelector("#card");
const likeButton = document.querySelector("#like");

card.addEventListener("click", () => console.log("клик по карточке"));
likeButton.addEventListener("click", e => {
  e.stopPropagation();
  console.log("лайк");
});
