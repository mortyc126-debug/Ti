import { test } from "@playwright/test";

test("форма подписки", async ({ page }) => {
  await page.goto("https://example.com/subscribe");
  await page.getByLabel("email").fill("user@example.com");
});
