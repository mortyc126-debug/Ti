import { expect, it } from "vitest";

function createUser(name) {
  return { id: 1, name };
}

it("форма объекта пользователя не меняется", () => {
  expect(createUser("Мира")).toMatchInlineSnapshot(`
    {
      "id": 1,
      "name": "Мира",
    }
  `);
});
