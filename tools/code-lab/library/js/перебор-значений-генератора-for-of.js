function* generator() {
  yield "утро";
  yield "день";
  yield "вечер";
}

for (const value of generator()) {
  console.log(value);
}
