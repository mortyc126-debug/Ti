import { afterEach, expect, it, vi } from "vitest";

async function loadUser(userId) {
  const response = await fetch(`/api/users/${userId}`);
  return response.json();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it("loadUser возвращает данные из ответа", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ id: 1, name: "Мира" })))
  );

  const user = await loadUser(1);

  expect(user.name).toBe("Мира");
  expect(fetch).toHaveBeenCalledWith("/api/users/1");
});
