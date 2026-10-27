import { test, expect, vi } from "vitest";

test("задача выполняется через секунду", async () => {
  vi.useFakeTimers();
  const сделано = vi.fn();
  setTimeout(async () => { await Promise.resolve(); сделано(); }, 1000);

  await vi.advanceTimersByTimeAsync(1000);
  expect(сделано).toHaveBeenCalled();
  vi.useRealTimers();
});