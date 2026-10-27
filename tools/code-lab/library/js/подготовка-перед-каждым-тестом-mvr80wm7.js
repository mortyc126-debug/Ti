import { beforeEach, test, expect } from "vitest";

let корзина;

beforeEach(() => {
  корзина = [];
});

test("в начале корзина пуста", () => {
  expect(корзина).toHaveLength(0);
});

test("товар добавляется", () => {
  корзина.push("чай");
  expect(корзина).toHaveLength(1);
});