const tasks = Array.from({ length: 50 }, (_, index) => index);

function doWork(deadline) {
  while (deadline.timeRemaining() > 1 && tasks.length > 0) {
    tasks.shift();
  }
  console.log(`Осталось задач: ${tasks.length}`);
  if (tasks.length > 0) requestIdleCallback(doWork);
}

requestIdleCallback(doWork);
