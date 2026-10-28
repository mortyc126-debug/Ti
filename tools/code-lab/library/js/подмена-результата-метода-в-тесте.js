import { expect, it, vi } from "vitest";

const clock = {
  currentHour() {
    return new Date().getHours();
  },
};

function greeting() {
  return clock.currentHour() < 12 ? "Доброе утро" : "Добрый день";
}

it("утром здоровается по-утреннему", () => {
  vi.spyOn(clock, "currentHour").mockReturnValue(9);
  expect(greeting()).toBe("Доброе утро");
});

it("днём здоровается по-дневному", () => {
  vi.spyOn(clock, "currentHour").mockReturnValue(15);
  expect(greeting()).toBe("Добрый день");
});
