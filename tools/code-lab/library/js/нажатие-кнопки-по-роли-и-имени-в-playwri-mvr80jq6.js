import { test } from "@playwright/test";

test("сохранение профиля", async ({ page }) => {
  await page.goto("https://example.com/profile");
  await page.getByRole("button", { name: "Save" }).click();
});