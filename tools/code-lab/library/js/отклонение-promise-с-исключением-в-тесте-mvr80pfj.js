import { test, expect } from "vitest";

async function загрузитьПрофиль(id) {
  if (!id) throw new Error("Не указан id");
  return { id };
}

test("без id загрузка отклоняется", async () => {
  await expect(загрузитьПрофиль()).rejects.toThrow();
});