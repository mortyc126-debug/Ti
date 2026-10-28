const promise = Promise.reject(new Error("тихий сбой"));
promise.catch(() => {});
promise.then(
  () => console.log("успех"),
  причина => console.log("всё ещё отклонён:", причина.message)
);
