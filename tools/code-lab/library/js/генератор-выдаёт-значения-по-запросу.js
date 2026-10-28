function* generator() {
  let id = 1;
  while (true) {
    yield id++;
  }
}

const ids = generator();
console.log(ids.next().value, ids.next().value, ids.next().value);
