const картинка = document.querySelector("img");
const фрагмент = await createImageBitmap(картинка, 10, 10, 100, 100);

const рисунок = document.querySelector("canvas").getContext("2d");
рисунок.drawImage(фрагмент, 0, 0);
фрагмент.close();
