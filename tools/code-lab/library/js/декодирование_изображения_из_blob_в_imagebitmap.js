const ответ = await fetch("/снимки/горы.png");
const blob = await ответ.blob();
const битмап = await createImageBitmap(blob);

console.log(битмап.width, битмап.height);
битмап.close();
