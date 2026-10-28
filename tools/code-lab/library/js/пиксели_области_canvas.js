const холст = document.querySelector("canvas");
const рисунок = холст.getContext("2d");

const изображение = рисунок.getImageData(10, 10, 1, 1);
const [красный, зелёный, синий, прозрачность] = изображение.data;

console.log(красный, зелёный, синий, прозрачность);
