import { expect, it, vi } from "vitest";

function onceOnly(callback) {
  let isCalled = false;
  return (...args) => {
    if (isCalled) return;
    isCalled = true;
    callback(...args);
  };
}

it("обработчик вызывается один раз", () => {
  const handler = vi.fn();
  const guarded = onceOnly(handler);

  guarded();
  guarded();

  expect(handler).toHaveBeenCalledTimes(1);
});
