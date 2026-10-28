import { test, expect } from "@playwright/test";

test("вход ведёт на панель управления", async ({ page }) => {
  await page.goto("https://example.com/login");
  await page.getByLabel("Пароль").fill("секрет");
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page).toHaveURL(/dashboard/);
});
