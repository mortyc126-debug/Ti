let ticks = 0;

const timerId = setInterval(() => {
  ticks += 1;
  console.log(`Тик ${ticks}`);

  if (ticks === 3) {
    clearInterval(timerId);
    console.log("Остановлено");
  }
}, 100);
