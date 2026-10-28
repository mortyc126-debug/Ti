const холст = document.createElement("canvas");
холст.width = 200;
холст.height = 100;
const рисунок = холст.getContext("2d");
рисунок.fillStyle = "#4a90d9";
рисунок.fillRect(0, 0, 200, 100);

холст.toBlob(blob => {
  const ссылка = document.createElement("a");
  ссылка.href = URL.createObjectURL(blob);
  ссылка.download = "рисунок.png";
  ссылка.click();
  setTimeout(() => URL.revokeObjectURL(ссылка.href), 1000);
}, "image/png");
