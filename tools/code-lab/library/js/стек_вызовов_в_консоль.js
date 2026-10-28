function первая() {
  вторая();
}

function вторая() {
  console.trace("Как мы сюда попали?");
}

первая();
