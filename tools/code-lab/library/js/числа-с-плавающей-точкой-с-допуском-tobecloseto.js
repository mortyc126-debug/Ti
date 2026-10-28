import { expect, it } from "vitest";

it("0.1 + 0.2 близко к 0.3", () => {
  expect(0.1 + 0.2).not.toBe(0.3);
  expect(0.1 + 0.2).toBeCloseTo(0.3);
  expect(1 / 3).toBeCloseTo(0.333, 3);
});
