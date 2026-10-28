import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

const server = setupServer(
  http.get("https://api.example.com/user", () => HttpResponse.json({ name: "Мира" }))
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

it("сервер ответил ошибкой 500", async () => {
  server.use(
    http.get("https://api.example.com/user", () => new HttpResponse(null, { status: 500 }))
  );

  const response = await fetch("https://api.example.com/user");

  expect(response.status).toBe(500);
});
