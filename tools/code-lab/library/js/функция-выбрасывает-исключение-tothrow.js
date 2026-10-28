import { expect, it } from "vitest";

function parseAge(text) {
  const age = Number(text);
  if (!Number.isInteger(age)) throw new Error("Возраст должен быть целым числом");
  return age;
}

it("плохой ввод вызывает ошибку", () => {
  expect(() => parseAge("abc")).toThrow();
  expect(() => parseAge("42")).not.toThrow();
});
