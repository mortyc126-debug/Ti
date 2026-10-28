import { beforeAll, test, expect } from "vitest";

let справочник;

beforeAll(() => {
  справочник = new Map([["ru", "Россия"]]);
});

test("страна найдена", () => {
  expect(справочник.get("ru")).toBe("Россия");
});
