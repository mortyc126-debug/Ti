import { test } from "@playwright/test";

test("скриншот главной", async ({ page }) => {
  await page.goto("https://example.com/");
  await page.screenshot({ path: "screen.png" });
});