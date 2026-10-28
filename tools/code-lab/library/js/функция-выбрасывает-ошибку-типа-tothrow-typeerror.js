import { expect, it } from "vitest";

function toUpper(text) {
  if (typeof text !== "string") throw new TypeError("Нужна строка");
  return text.toUpperCase();
}

it("число вместо строки — TypeError", () => {
  expect(() => toUpper(42)).toThrow(TypeError);
  expect(() => toUpper(42)).toThrow("Нужна строка");
});
