import { test, expect } from "vitest";

const удвоить = async число => число * 2;

test("удвоение возвращает 42", async () => {
  await expect(удвоить(21)).resolves.toBe(42);
});
