function readNumber() {
  try {
    console.log("внутри try");
    return 42;
  } finally {
    console.log("завершающий блок выполнен");
  }
}

console.log(readNumber());
