import { test, expect } from "@playwright/test";

test("сохранение уходит на сервер", async ({ page }) => {
  await page.goto("https://example.com/settings");

  const ожидание = page.waitForResponse(
    ответ => ответ.url().includes("/api") && ответ.ok()
  );
  await page.getByRole("button", { name: "Сохранить" }).click();
  const ответ = await ожидание;

  expect(ответ.status()).toBe(200);
});