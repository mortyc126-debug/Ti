import { test, expect, vi } from "vitest";

test("обработчик вызван позже", async () => {
  const шпион = vi.fn();
  setTimeout(шпион, 50);

  await vi.waitFor(() => expect(шпион).toHaveBeenCalled());
});
