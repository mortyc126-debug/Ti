document.body.innerHTML = '<div id="theme" style="--accent: #ff6600">Тема</div>';
const theme = document.querySelector("#theme");

console.log(theme.style.getPropertyValue("--accent").trim());
console.log(JSON.stringify(theme.style.getPropertyValue("--missing")));
