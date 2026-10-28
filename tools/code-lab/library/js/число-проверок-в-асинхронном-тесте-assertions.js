import { expect, it } from "vitest";

function loadName(callback) {
  setTimeout(() => callback("Мира"), 10);
}

it("колбэк получает имя", () => {
  expect.assertions(1);

  return new Promise(resolve => {
    loadName(name => {
      expect(name).toBe("Мира");
      resolve();
    });
  });
});
