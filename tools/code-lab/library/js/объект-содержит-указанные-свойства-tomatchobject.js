import { expect, it } from "vitest";

it("ответ содержит нужные поля", () => {
  const response = { id: 7, name: "Мира", createdAt: "2026-01-01", role: "admin" };

  expect(response).toMatchObject({ id: 7, name: "Мира" });
});
