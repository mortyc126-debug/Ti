function* натуральные() {
  let число = 1;
  while (true) yield число++;
}

const первые = натуральные().take(5).toArray();
console.log(первые);
