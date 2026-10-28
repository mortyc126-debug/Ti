const холст = document.querySelector("canvas");
const рисунок = холст.getContext("2d");
const dpr = window.devicePixelRatio || 1;
const ширина = 300;
const высота = 150;

холст.width = ширина * dpr;
холст.height = высота * dpr;
холст.style.width = `${ширина}px`;
холст.style.height = `${высота}px`;
рисунок.scale(dpr, dpr);
