import { test, expect } from "@playwright/test";

test("главная страница открывается", async ({ page }) => {
  await page.goto("https://example.com/");
  await expect(page).toHaveTitle(/Example/);
});
