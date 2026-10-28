import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

const server = setupServer(
  http.get("https://api.example.com/user", () => HttpResponse.json({ name: "Мира" }))
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

it("получает пользователя из подменённого API", async () => {
  const response = await fetch("https://api.example.com/user");
  const user = await response.json();

  expect(user.name).toBe("Мира");
});
