const sinon = require("sinon");
const assert = require("node:assert/strict");

const cart = {
  total(prices) {
    return prices.reduce((sum, price) => sum + price, 0);
  },
};

const totalSpy = sinon.spy(cart, "total");

console.log(cart.total([100, 200]));
assert.ok(totalSpy.calledOnceWith([100, 200]));
console.log("вызовов:", totalSpy.callCount);

totalSpy.restore();
