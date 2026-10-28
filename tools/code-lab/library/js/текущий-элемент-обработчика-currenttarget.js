document.body.innerHTML = '<div id="menu"><button>Один</button><button>Два</button></div>';
const menu = document.querySelector("#menu");

menu.addEventListener("click", event => {
  console.log(`target: ${event.target.tagName}, currentTarget: ${event.currentTarget.id}`);
});
