let ticks = 0;
const timerId = setInterval(() => {
  ticks += 1;
  console.log(ticks);

  if (ticks >= 3) {
    clearInterval(timerId);
  }
}, 500);