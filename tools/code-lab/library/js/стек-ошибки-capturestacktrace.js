const info = { message: "Нет данных" };

Error.captureStackTrace(info);

console.log(typeof info.stack);
console.log(info.stack.split("\n")[0]);
