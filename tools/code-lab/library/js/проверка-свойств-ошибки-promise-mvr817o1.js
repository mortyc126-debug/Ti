import { expect, test } from "vitest";
test("ответ не найден", async () => {
  await expect(Promise.reject({ status: 404 })).rejects.toMatchObject({ status: 404 });
});