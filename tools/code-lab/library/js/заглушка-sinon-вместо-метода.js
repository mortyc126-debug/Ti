const sinon = require("sinon");

const weather = {
  currentTemperature() {
    throw new Error("Настоящий запрос к сервису погоды");
  },
};

const stub = sinon.stub(weather, "currentTemperature").returns(18);

console.log(weather.currentTemperature());
console.log(stub.callCount);

stub.restore();
