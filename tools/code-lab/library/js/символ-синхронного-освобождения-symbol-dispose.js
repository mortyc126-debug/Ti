const connection = {
  open: true,
  [Symbol.dispose]() {
    this.open = false;
    console.log("соединение закрыто");
  },
};

console.log(typeof Symbol.dispose);

connection[Symbol.dispose]();
console.log(connection.open);
