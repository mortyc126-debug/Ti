import { expect, it, vi } from "vitest";

const cart = {
  total(prices) {
    return prices.reduce((sum, price) => sum + price, 0);
  },
};

function checkout(prices) {
  return cart.total(prices) * 1.2;
}

it("checkout считает сумму через cart.total", () => {
  const totalSpy = vi.spyOn(cart, "total");

  expect(checkout([100, 200])).toBe(360);
  expect(totalSpy).toHaveBeenCalledTimes(1);
  expect(totalSpy).toHaveBeenCalledWith([100, 200]);

  totalSpy.mockRestore();
});
