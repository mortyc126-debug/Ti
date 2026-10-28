function cleanup() {
  console.log("ресурс освобождён");
}

function* gen() {
  try {
    yield "первое";
    yield "второе";
    yield "третье";
  } finally {
    cleanup();
  }
}

for (const value of gen()) {
  console.log(value);
  if (value === "второе") break;
}
