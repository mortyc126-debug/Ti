import { mock } from "node:test";

const функция = mock.fn();
функция(1);
функция(2);

console.log(функция.mock.calls.length);
console.log(функция.mock.calls[0].arguments);
