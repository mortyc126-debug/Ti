import { test, expect } from "vitest";

async function списатьДеньги(сумма) {
  if (сумма > 100) throw new Error("Недостаточно средств");
  return сумма;
}

test("большая сумма отклоняется с понятным текстом", async () => {
  await expect(списатьДеньги(500)).rejects.toThrow("Недостаточно средств");
});