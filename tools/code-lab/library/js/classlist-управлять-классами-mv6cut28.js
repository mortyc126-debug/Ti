const card = document.querySelector(".card");
card.classList.add("selected");
card.classList.toggle("highlight");
console.log(card.classList.contains("selected"));