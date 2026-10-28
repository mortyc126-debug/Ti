function recurse(depth) {
  if (depth === 0) throw new Error("Слишком глубоко");
  recurse(depth - 1);
}

function framesCount() {
  try {
    recurse(100);
  } catch (error) {
    return error.stack.split("\n").length - 1;
  }
}

console.log(`По умолчанию кадров: ${framesCount()}`);

Error.stackTraceLimit = 50;
console.log(`После изменения кадров: ${framesCount()}`);
