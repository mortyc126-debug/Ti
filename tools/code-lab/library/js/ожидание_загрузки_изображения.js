const картинка = new Image();
картинка.src = "/снимки/горы.png";

await new Promise(разрешить => {
  картинка.addEventListener("load", разрешить, { once: true });
});
console.log(картинка.naturalWidth, картинка.naturalHeight);
