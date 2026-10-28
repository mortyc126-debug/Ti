const ожидание = new Promise((resolve, reject) => {
  setTimeout(() => {
    if (Math.abs(-1) === 1) resolve("готово");
    else reject(new Error("не получилось"));
  }, 10);
});
ожидание.then(значение => console.log(значение));
