import { test, expect, vi } from "vitest";

test("все таймеры отработали", async () => {
  vi.useFakeTimers();
  const журнал = [];
  setTimeout(() => журнал.push("первый"), 500);
  setTimeout(() => журнал.push("второй"), 5000);

  await vi.runAllTimersAsync();
  expect(журнал).toEqual(["первый", "второй"]);
  vi.useRealTimers();
});
