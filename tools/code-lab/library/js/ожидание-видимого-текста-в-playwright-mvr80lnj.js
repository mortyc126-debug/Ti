import { test, expect } from "@playwright/test";

test("после отправки видно подтверждение", async ({ page }) => {
  await page.goto("https://example.com/order");
  await page.getByRole("button", { name: "Оплатить" }).click();
  await expect(page.getByText("done")).toBeVisible();
});