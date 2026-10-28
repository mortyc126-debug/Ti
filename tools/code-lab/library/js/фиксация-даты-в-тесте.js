import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function isNewYearDay(now = new Date()) {
  return now.getUTCMonth() === 0 && now.getUTCDate() === 1;
}

describe("isNewYearDay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("текущая дата зафиксирована", () => {
    expect(new Date().toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("в первый день года возвращает true", () => {
    expect(isNewYearDay()).toBe(true);
  });
});
