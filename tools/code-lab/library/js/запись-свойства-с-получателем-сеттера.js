const source = {
  _price: 0,
  set price(amount) {
    this._price = amount;
  },
};
const receiver = {};

Reflect.set(source, "price", 99, receiver);

console.log(source._price, receiver._price);
