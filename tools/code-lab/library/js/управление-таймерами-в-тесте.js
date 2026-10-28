import { expect, it, vi } from "vitest";

function debounce(callback, delay) {
  let timerId;
  return (...args) => {
    clearTimeout(timerId);
    timerId = setTimeout(() => callback(...args), delay);
  };
}

it("debounce вызывает функцию один раз после паузы", () => {
  vi.useFakeTimers();

  const save = vi.fn();
  const debouncedSave = debounce(save, 1000);

  debouncedSave("черновик 1");
  debouncedSave("черновик 2");

  vi.advanceTimersByTime(999);
  expect(save).not.toHaveBeenCalled();

  vi.advanceTimersByTime(1);
  expect(save).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledWith("черновик 2");

  vi.useRealTimers();
});
