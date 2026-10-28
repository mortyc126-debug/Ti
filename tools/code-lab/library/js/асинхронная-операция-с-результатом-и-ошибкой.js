const задача = new Promise((resolve, reject) => {
  const ok = true;
  if (ok) resolve("готово"); else reject(new Error("сбой"));
});
задача.then(console.log).catch(error => console.error(error.message));
