const документ = new DOMParser().parseFromString(
  "<p>Привет</p><ul><li>раз</li><li>два</li></ul>",
  "text/html"
);

console.log(документ.querySelectorAll("li").length);
console.log(документ.querySelector("p").textContent);
