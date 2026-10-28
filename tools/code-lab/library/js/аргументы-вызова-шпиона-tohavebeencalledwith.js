import { expect, it, vi } from "vitest";

function notifyUser(sendMessage, user) {
  sendMessage(user.email, `Привет, ${user.name}!`);
}

it("письмо уходит с нужным адресом и текстом", () => {
  const sendMessage = vi.fn();

  notifyUser(sendMessage, { name: "Мира", email: "mira@example.com" });

  expect(sendMessage).toHaveBeenCalledWith("mira@example.com", "Привет, Мира!");
});
