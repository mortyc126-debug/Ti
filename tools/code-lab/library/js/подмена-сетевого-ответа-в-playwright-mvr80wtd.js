import { test, expect } from "@playwright/test";

test("список задач из подставных данных", async ({ page }) => {
  const данные = [{ id: 1, название: "Купить хлеб" }];
  await page.route("**/api/**", маршрут => маршрут.fulfill({ json: данные }));

  await page.goto("https://example.com/tasks");
  await expect(page.getByText("Купить хлеб")).toBeVisible();
});